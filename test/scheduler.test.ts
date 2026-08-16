import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { MonitorScheduler } from "../src/scheduler";

type SchedulerStub = DurableObjectStub<MonitorScheduler>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dynamic alarm scheduler", () => {
  it("deletes the alarm when there are no monitors", async () => {
    const stub = scheduler("empty");
    await initialize(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("uses three requests for three healthy monitors", async () => {
    const stub = scheduler("three-healthy");
    await seed(stub, 3);
    const fetchSpy = healthyFetch();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await expectState(stub, { cursor_id: 0, pending_monitor_id: null, pending_stage: null });
  });

  it("completes exactly 50 healthy monitors in one alarm", async () => {
    const stub = scheduler("fifty-healthy");
    await seed(stub, 50);
    const fetchSpy = healthyFetch();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(50);
    await expectState(stub, { cursor_id: 0, pending_monitor_id: null, pending_stage: null });
  });

  it("continues after 50 of 51 healthy monitors", async () => {
    const stub = scheduler("fifty-one-healthy");
    await seed(stub, 51);
    const fetchSpy = healthyFetch();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(50);
    await expectState(stub, { cursor_id: 50, pending_monitor_id: null, pending_stage: null });
  });

  it("spends all 50 requests on 25 double probes", async () => {
    const stub = scheduler("twenty-five-double");
    await seed(stub, 25, 1);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(50);
    await expectState(stub, { cursor_id: 0, pending_monitor_id: null, pending_stage: null });
  });

  it("stores pending confirm after 49 healthy HEAD requests and one failed HEAD", async () => {
    const stub = scheduler("pending-confirm");
    await seed(stub, 50);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(null, { status: fetchSpy.mock.calls.length <= 49 ? 200 : 503 });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(50);
    await expectState(stub, {
      cursor_id: 49,
      pending_monitor_id: 50,
      pending_stage: "confirm",
    });
  });

  it("stores pending notify after 48 healthy probes and one double failure", async () => {
    const stub = scheduler("pending-notify");
    await seed(stub, 49);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(null, { status: fetchSpy.mock.calls.length <= 48 ? 200 : 503 });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(50);
    await expectState(stub, {
      cursor_id: 48,
      pending_monitor_id: 49,
      pending_stage: "notify",
    });
  });

  it("notifies once, stays silent while down, clears on recovery, and notifies on a later down", async () => {
    const stub = scheduler("down-transitions");
    await seed(stub, 1);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    mockNewDown(fetchSpy);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await expectDownState(stub, 1);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expectDownState(stub, 1);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expectDownState(stub, 0);

    fetchSpy.mockReset();
    mockNewDown(fetchSpy);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await expectDownState(stub, 1);
  });

  it("keeps a notify continuation and honors Retry-After on Discord 429", async () => {
    const stub = scheduler("discord-429");
    await seed(stub, 1);
    const startedAt = Date.now();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (fetchSpy.mock.calls.length <= 2) return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ retry_after: 99 }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "7" },
      });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expectState(stub, { cursor_id: 0, pending_monitor_id: 1, pending_stage: "notify" });
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm as number).toBeGreaterThanOrEqual(startedAt + 6_900);
      expect(alarm as number).toBeLessThanOrEqual(Date.now() + 7_500);
    });
  });

  it.each(["500", "network"])("retries a Discord %s infrastructure failure", async (kind) => {
    const stub = scheduler(`discord-${kind}`);
    await seed(stub, 1);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (fetchSpy.mock.calls.length <= 2) return new Response(null, { status: 503 });
      if (kind === "network") throw new Error("network unavailable");
      return new Response(null, { status: 500 });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expectState(stub, { cursor_id: 0, pending_monitor_id: 1, pending_stage: "notify" });
    await expectDownState(stub, 0);
  });

  it("does not create an immediate retry loop for Discord 403", async () => {
    const stub = scheduler("discord-403");
    await seed(stub, 1);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (fetchSpy.mock.calls.length <= 2) return new Response(null, { status: 503 });
      return new Response(null, { status: 403 });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expectState(stub, { cursor_id: 0, pending_monitor_id: null, pending_stage: null });
    await expectDownState(stub, 0);
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm as number).toBeGreaterThan(Date.now() + 21 * 60 * 60 * 1_000);
    });
  });

  it("drops a pending alert when that monitor was removed", async () => {
    const stub = scheduler("removed-pending");
    await initialize(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      insertMonitor(state, 1);
      insertMonitor(state, 2);
      state.storage.sql.exec("DELETE FROM monitors WHERE id = 1");
      state.storage.sql.exec(
        `UPDATE scheduler_state
            SET cursor_id = 0, pending_monitor_id = 1, pending_stage = 'notify', cycle_started_at = ?
          WHERE singleton = 1`,
        Date.now(),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const fetchSpy = healthyFetch();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("monitor-2.example");
  });
});

describe("monitor storage limits", () => {
  it("rejects an eleventh monitor in one guild and duplicate name or URL", async () => {
    const stub = scheduler("guild-limit");
    for (let index = 1; index <= 10; index += 1) {
      expect((await add(stub, "guild-1", index)).ok).toBe(true);
    }
    expect((await add(stub, "guild-1", 11)).ok).toBe(false);

    const duplicateName = await add(stub, "guild-2", 1, "name-1", "https://unique.example");
    expect(duplicateName.ok).toBe(true);
    expect((await add(stub, "guild-2", 2, "name-1", "https://other.example")).ok).toBe(false);
    expect((await add(stub, "guild-2", 3, "other", "https://unique.example")).ok).toBe(false);
  });

  it("rejects the 1001st monitor globally", async () => {
    const stub = scheduler("global-limit");
    await initialize(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      for (let id = 1; id <= 1_000; id += 1) insertMonitor(state, id);
    });

    const result = await add(stub, "overflow-guild", 1001);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Bot全体");
  });

  it("deletes the alarm when the last monitor is removed", async () => {
    const stub = scheduler("last-remove");
    expect((await add(stub, "guild-1", 1)).ok).toBe(true);
    const response = await stub.fetch("https://scheduler.internal/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", name: "name-1" }),
    });
    expect((await response.json<{ ok: boolean }>()).ok).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

function scheduler(name: string): SchedulerStub {
  const testEnv = env as unknown as {
    MONITOR_SCHEDULER: DurableObjectNamespace<MonitorScheduler>;
  };
  return testEnv.MONITOR_SCHEDULER.get(testEnv.MONITOR_SCHEDULER.idFromName(name));
}

async function initialize(stub: SchedulerStub): Promise<void> {
  const response = await stub.fetch("https://scheduler.internal/list?guildId=init");
  expect(response.ok).toBe(true);
}

async function seed(stub: SchedulerStub, count: number, downNotified = 0): Promise<void> {
  await initialize(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    for (let id = 1; id <= count; id += 1) insertMonitor(state, id, downNotified);
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

function insertMonitor(state: DurableObjectState, id: number, downNotified = 0): void {
  state.storage.sql.exec(
    `INSERT INTO monitors (id, guild_id, channel_id, name, url, down_notified)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    `guild-${Math.ceil(id / 10)}`,
    `channel-${id}`,
    `name-${id}`,
    `https://monitor-${id}.example/health`,
    downNotified,
  );
}

async function add(
  stub: SchedulerStub,
  guildId: string,
  id: number,
  name = `name-${id}`,
  url = `https://monitor-${id}.example/health`,
): Promise<{ ok: boolean; error?: string }> {
  const response = await stub.fetch("https://scheduler.internal/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guildId, channelId: `channel-${id}`, name, url }),
  });
  return response.json<{ ok: boolean; error?: string }>();
}

function healthyFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
}

function mockNewDown(fetchSpy: MockInstance<typeof fetch>): void {
  fetchSpy.mockImplementation(async (input) => {
    const url = String(input);
    return new Response(null, { status: url.startsWith("https://discord.com/") ? 200 : 503 });
  });
}

async function expectState(
  stub: SchedulerStub,
  expected: { cursor_id: number; pending_monitor_id: number | null; pending_stage: string | null },
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql
      .exec<{
        cursor_id: number;
        pending_monitor_id: number | null;
        pending_stage: string | null;
      }>(
        "SELECT cursor_id, pending_monitor_id, pending_stage FROM scheduler_state WHERE singleton = 1",
      )
      .one();
    expect(row).toEqual(expected);
  });
}

async function expectDownState(stub: SchedulerStub, expected: number): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql
      .exec<{ down_notified: number }>("SELECT down_notified FROM monitors WHERE id = 1")
      .one();
    expect(row.down_notified).toBe(expected);
  });
}
