const CHECK_TIMEOUT_MS = 6_000;

export type ProbeMethod = "HEAD" | "GET";

export interface ProbeResult {
  alive: boolean;
  status: number | null;
}

export async function probeEndpoint(url: string, method: ProbeMethod): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "DiscordWatchBot/4.0 (+availability-check)",
        "Cache-Control": "no-cache",
        ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
      },
    });
    response.body?.cancel();

    return {
      // This bot checks whether an HTTP endpoint responds, not whether its content is correct.
      // 1xx-4xx therefore count as alive. 5xx, timeout and network failure are candidates for DOWN.
      alive: response.status < 500,
      status: response.status,
    };
  } catch {
    return { alive: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}
