// @ajan: cursor · @etiket: katman-2, loopback, oa-bridge, ssrf
/**
 * Loopback-only URL gate for pdf.oaBridgeUrl (align with K1/K3 SSRF policy).
 */

export const DEFAULT_OA_BRIDGE_URL = "http://127.0.0.1:8756";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when URL is http(s) to loopback only. */
export function isAllowedOaBridgeUrl(baseUrl: string): boolean {
  try {
    const trimmed = String(baseUrl || "")
      .trim()
      .replace(/\/+$/, "");
    if (!trimmed) return false;
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return LOOPBACK.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Normalize pref/raw bridge base. Non-loopback → safe default (no remote SSRF).
 */
export function normalizeOaBridgeUrl(
  raw: string | null | undefined,
): string {
  const url = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  const candidate = url || DEFAULT_OA_BRIDGE_URL;
  if (!isAllowedOaBridgeUrl(candidate)) return DEFAULT_OA_BRIDGE_URL;
  return candidate;
}
