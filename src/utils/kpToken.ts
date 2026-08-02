// @ajan: cursor · @etiket: katman-2, kp-token, dry, max-pdf
/**
 * Canonical KP###### helpers — mirrors K1 `kpRegistry.ts` / K3 `kpToken.ts`.
 * Keep regex + MAX in lockstep across the three XPIs (no shared package).
 */

/** Align with kitap_arsiv.context.MAX_LIBRARY_PDFS */
export const MAX_LIBRARY_PDFS = 99_999;

const KP_RE = /\bKP0*\d{1,6}\b/i;

export { normalizeKp, extractKpFromText };

function normalizeKp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).trim().toUpperCase().match(/\bKP0*(\d{1,6})\b/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 1 || num > MAX_LIBRARY_PDFS) return null;
  return `KP${String(num).padStart(6, "0")}`;
}

function extractKpFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(KP_RE);
  return m ? normalizeKp(m[0]) : null;
}
