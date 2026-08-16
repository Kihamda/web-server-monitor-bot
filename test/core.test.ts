import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalRequestBudget, MAX_EXTERNAL_SUBREQUESTS } from "../src/budget";
import { handleMonitorCommand } from "../src/commands";
import worker from "../src/index";
import { probeEndpoint } from "../src/monitoring";
import { verifyDiscordRequest } from "../src/security";
import { validateMonitorUrl } from "../src/security";
import type { Env, Interaction } from "../src/types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("external request budget", () => {
  it("allows exactly 50 requests and never becomes negative", () => {
    const budget = new ExternalRequestBudget();
    expect(MAX_EXTERNAL_SUBREQUESTS).toBe(50);
    for (let index = 0; index < 50; index += 1) expect(budget.tryTake()).toBe(true);
    expect(budget.tryTake()).toBe(false);
    expect(budget.remaining).toBe(0);
    expect(budget.used).toBe(50);
  });
});

describe("endpoint classification", () => {
  for (const status of [200, 204, 301, 401, 403, 404, 429]) {
    it(`treats HTTP ${status} as alive`, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status }));

      await expect(probeEndpoint("https://example.com/health", "HEAD")).resolves.toEqual({
        alive: true,
        status,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/health",
        expect.objectContaining({ method: "HEAD", redirect: "manual" }),
      );
    });
  }

  for (const status of [500, 503]) {
    it(`treats HTTP ${status} as a failure candidate`, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
      await expect(probeEndpoint("https://example.com/health", "HEAD")).resolves.toEqual({
        alive: false,
        status,
      });
    });
  }

  it("uses a one-byte range for confirmation GET", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await probeEndpoint("https://example.com/health", "GET");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/health",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({ Range: "bytes=0-0" }),
      }),
    );
  });

  it("treats network errors as failure candidates", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    await expect(probeEndpoint("https://example.com/health", "HEAD")).resolves.toEqual({
      alive: false,
      status: null,
    });
  });

  it("aborts a probe after six seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    const probe = probeEndpoint("https://example.com/health", "HEAD");
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(probe).resolves.toEqual({ alive: false, status: null });
  });
});

describe("Discord interactions", () => {
  it("verifies a valid Ed25519 signature and rejects a changed one", async () => {
    const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const publicKeyHex = bytesToHex(new Uint8Array(publicKey));
    const timestamp = "1750000000";
    const body = JSON.stringify({ type: 1 });
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keyPair.privateKey,
      new TextEncoder().encode(timestamp + body),
    );
    const request = new Request("https://worker.example/interactions", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": bytesToHex(new Uint8Array(signature)),
        "X-Signature-Timestamp": timestamp,
      },
    });

    await expect(verifyDiscordRequest(request, publicKeyHex, body)).resolves.toBe(true);
    await expect(verifyDiscordRequest(request, publicKeyHex, `${body} `)).resolves.toBe(false);
  });

  it("returns PONG for a valid signed PING", async () => {
    const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKeyHex = bytesToHex(
      new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
    );
    const timestamp = "1750000001";
    const body = JSON.stringify({ type: 1 });
    const signature = bytesToHex(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          keyPair.privateKey,
          new TextEncoder().encode(timestamp + body),
        ),
      ),
    );
    const request = new Request("https://worker.example/interactions", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    const env = {
      DISCORD_PUBLIC_KEY: publicKeyHex,
      DISCORD_TOKEN: "unused",
      MONITOR_SCHEDULER: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
      },
    } satisfies Env;

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("returns 401 for an invalid signature", async () => {
    const env = {
      DISCORD_PUBLIC_KEY: "00".repeat(32),
      DISCORD_TOKEN: "unused",
      MONITOR_SCHEDULER: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
      },
    } satisfies Env;
    const response = await worker.fetch(
      new Request("https://worker.example/interactions", {
        method: "POST",
        headers: {
          "X-Signature-Ed25519": "00".repeat(64),
          "X-Signature-Timestamp": "1",
        },
        body: JSON.stringify({ type: 1 }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects DM use and missing Manage Guild permission", async () => {
    const env = schedulerEnv();
    const dm = await handleMonitorCommand(monitorInteraction({ guild: false }), env);
    expect(await interactionContent(dm)).toContain("サーバー内");

    const unprivileged = await handleMonitorCommand(
      monitorInteraction({ memberPermissions: "0" }),
      env,
    );
    expect(await interactionContent(unprivileged)).toContain("サーバーの管理");
  });

  it("rejects add when the bot cannot post and keeps responses mention-safe", async () => {
    const response = await handleMonitorCommand(
      monitorInteraction({ appPermissions: "0" }),
      schedulerEnv(),
    );
    const payload = (await response.json()) as {
      data: { content: string; allowed_mentions: { parse: string[] } };
    };
    expect(payload.data.content).toContain("権限がBotにありません");
    expect(payload.data.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("monitor URL validation", () => {
  it.each([
    "http://localhost/",
    "http://10.0.0.1/",
    "http://127.0.0.1/",
    "http://169.254.1.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
  ])("rejects local or special-use address %s", (url) => {
    expect(() => validateMonitorUrl(url)).toThrow("ローカル・プライベート");
  });

  it("accepts a public HTTPS URL and strips its fragment", () => {
    expect(validateMonitorUrl("https://example.com/health#details").toString()).toBe(
      "https://example.com/health",
    );
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function schedulerEnv(): Env {
  return {
    DISCORD_PUBLIC_KEY: "unused",
    DISCORD_TOKEN: "unused",
    MONITOR_SCHEDULER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => Response.json({ ok: true, monitors: [] }) }),
    },
  };
}

function monitorInteraction(
  options: { guild?: boolean; memberPermissions?: string; appPermissions?: string } = {},
): Interaction {
  return {
    type: 2,
    ...(options.guild === false ? {} : { guild_id: "guild-1", channel_id: "channel-1" }),
    app_permissions: options.appPermissions ?? String(1n << 11n),
    member: { permissions: options.memberPermissions ?? String(1n << 5n) },
    data: {
      name: "monitor",
      options: [
        {
          name: "add",
          type: 1,
          options: [
            { name: "name", type: 3, value: "API" },
            { name: "url", type: 3, value: "https://example.com/health" },
          ],
        },
      ],
    },
  };
}

async function interactionContent(response: Response): Promise<string> {
  const payload = (await response.json()) as { data: { content: string } };
  return payload.data.content;
}
