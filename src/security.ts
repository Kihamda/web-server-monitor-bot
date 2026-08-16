function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function verifyDiscordRequest(
  request: Request,
  publicKeyHex: string,
  body: string,
): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

export function validateMonitorUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URLが不正です。");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("HTTP/HTTPS URLのみ登録できます。");
  }
  if (url.username || url.password) {
    throw new Error("URLにユーザー名やパスワードを含めることはできません。");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    throw new Error("ローカル・プライベートネットワーク宛てURLは登録できません。");
  }

  url.hash = "";
  return url;
}

function isBlockedHostname(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    /^(?:0:){5}ffff:/.test(host) ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89a-f]/.test(host) ||
    host.startsWith("ff") ||
    host.startsWith("2001:db8:")
  ) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (!ipv4) return false;
  const [a, b] = ipv4;
  if (a === undefined || b === undefined) return true;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && (b === 0 || b === 2)) ||
    (a === 192 && b === 88) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return null;
  return parts;
}
