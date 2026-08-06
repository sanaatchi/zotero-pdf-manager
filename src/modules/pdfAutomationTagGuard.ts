// @ajan: cursor · @etiket: katman-2, pdf-mismatch, tag-guard, user-clear, automation-audit
/**
 * After manual clear of automation tags, passive background paths (reconcile,
 * periodic local rematch) must not immediately re-apply #pdf-mismatch.
 */
import { getPref, setPref } from "../utils/prefs";

const PREF_KEY = "pdfAutomationTagsUserClearedAt";
const DEFAULT_SUPPRESS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** User-initiated validation/download — always allowed to tag mismatch. */
const EXPLICIT_MISMATCH_SOURCES = new Set([
  "content-audit",
  "match-attachment",
  "download-manual",
  "menu-download",
  "downloads-probe",
  "download-cascade",
]);

export type MismatchTagContext = {
  source: string;
  run?: string;
};

const clearedAtByItem = new Map<number, number>();
let loadedFromPref = false;
let explicitTagSessionDepth = 0;

function loadClearedMapFromPref(): void {
  if (loadedFromPref) return;
  loadedFromPref = true;
  try {
    const raw = getPref(PREF_KEY);
    if (typeof raw !== "string" || !raw.trim()) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    for (const [key, ts] of Object.entries(parsed)) {
      const id = Number(key);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
      if (now - ts > MAX_AGE_MS) continue;
      clearedAtByItem.set(id, ts);
    }
  } catch (e) {
    ztoolkit.log("pdfAutomationTagGuard: pref load failed", e);
  }
}

function persistClearedMap(): void {
  try {
    const now = Date.now();
    const out: Record<string, number> = {};
    const entries = [...clearedAtByItem.entries()]
      .filter(([, ts]) => now - ts <= MAX_AGE_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    for (const [id, ts] of entries) {
      out[String(id)] = ts;
    }
    clearedAtByItem.clear();
    for (const [id, ts] of entries) clearedAtByItem.set(id, ts);
    setPref(PREF_KEY, JSON.stringify(out));
  } catch (e) {
    ztoolkit.log("pdfAutomationTagGuard: pref save failed", e);
  }
}

export function isExplicitMismatchTagSource(source: string): boolean {
  if (EXPLICIT_MISMATCH_SOURCES.has(source)) return true;
  if (source.startsWith("federated-")) return true;
  if (source.startsWith("oa-search-")) return true;
  if (source.startsWith("download-manual-")) return true;
  return false;
}

export function wasPdfAutomationTagsUserClearedRecently(
  itemID: number,
  maxAgeMs = DEFAULT_SUPPRESS_MS,
): boolean {
  loadClearedMapFromPref();
  const ts = clearedAtByItem.get(itemID);
  if (!ts) return false;
  return Date.now() - ts <= maxAgeMs;
}

export function recordPdfAutomationTagsUserClear(itemID: number): void {
  loadClearedMapFromPref();
  clearedAtByItem.set(itemID, Date.now());
  persistClearedMap();
}

export function shouldSuppressPassiveMismatchTag(
  itemID: number,
  source: string,
  maxAgeMs = DEFAULT_SUPPRESS_MS,
): boolean {
  if (isExplicitMismatchTagSession()) return false;
  if (isExplicitMismatchTagSource(source)) return false;
  return wasPdfAutomationTagsUserClearedRecently(itemID, maxAgeMs);
}

/** User-initiated download/attach batch (menu cascade). */
export function runInExplicitMismatchTagSession<T>(fn: () => T): T {
  explicitTagSessionDepth++;
  try {
    return fn();
  } finally {
    explicitTagSessionDepth--;
  }
}

export async function runInExplicitMismatchTagSessionAsync<T>(
  fn: () => Promise<T>,
): Promise<T> {
  explicitTagSessionDepth++;
  try {
    return await fn();
  } finally {
    explicitTagSessionDepth--;
  }
}

export function isExplicitMismatchTagSession(): boolean {
  return explicitTagSessionDepth > 0;
}

/** @internal tests */
export function _resetPdfAutomationTagGuardForTests(): void {
  clearedAtByItem.clear();
  loadedFromPref = false;
  explicitTagSessionDepth = 0;
}

export function _setUserClearTimestampForTests(
  itemID: number,
  timestampMs: number,
): void {
  clearedAtByItem.set(itemID, timestampMs);
  loadedFromPref = true;
}
