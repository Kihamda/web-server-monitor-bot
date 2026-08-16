export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
} as const;

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
} as const;

const EPHEMERAL = 1 << 6;
const SUPPRESS_EMBEDS = 1 << 2;

export function interactionMessage(content: string, ephemeral = true): Response {
  return Response.json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      content,
      flags: ephemeral ? EPHEMERAL : 0,
      allowed_mentions: { parse: [] },
    },
  });
}

export type AlertResult =
  | { kind: "sent" }
  | { kind: "retryable"; retryAfterMs: number }
  | { kind: "permanent"; status: number };

export async function sendDownAlert(
  token: string,
  channelId: string,
  monitorId: number,
  name: string,
  url: string,
): Promise<AlertResult> {
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `🔴 **DOWN**\n**${escapeMarkdown(name)}**\n<${url}>`,
        nonce: `dw-${monitorId}`,
        enforce_nonce: true,
        flags: SUPPRESS_EMBEDS,
        allowed_mentions: { parse: [] },
      }),
    });

    if (response.ok) return { kind: "sent" };

    if (response.status === 429) {
      const retryAfterMs = await parseRetryAfterMs(response);
      return { kind: "retryable", retryAfterMs };
    }

    if (response.status >= 500) {
      return { kind: "retryable", retryAfterMs: 60_000 };
    }

    return { kind: "permanent", status: response.status };
  } catch {
    return { kind: "retryable", retryAfterMs: 60_000 };
  }
}

async function parseRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampRetry(seconds * 1_000);
    }
  }

  try {
    const body = (await response.json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
      return clampRetry(body.retry_after * 1_000);
    }
  } catch {
    // Ignore malformed or empty rate-limit bodies.
  }

  return 60_000;
}

function clampRetry(ms: number): number {
  return Math.min(Math.max(Math.ceil(ms), 1_000), 15 * 60_000);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, "\\$&");
}
