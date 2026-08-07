// @ajan: cursor · @etiket: katman-2, pdf-mismatch, automation-audit, tag-guard, mismatch-reason, mismatch-note-clear, validated-pdf-lock
import { appendAuditEvent } from "./automationAudit";
import {
  type MismatchTagContext,
  shouldSuppressPassiveMismatchTag,
} from "./pdfAutomationTagGuard";
import { clearValidatedPdfLock } from "./pdfValidatedLock";

export type TagItemFn = (item: Zotero.Item, tag: string) => Promise<void>;

/** Extra line so the mismatch cause is visible on the item (not only in debug log). */
export const MISMATCH_REASON_PREFIX = "ZPDF-Mismatch-Reason:";

/**
 * Manual / batch resolution note left on Extra (e.g. cleared FP history).
 * Cleared together with Reason on a successful match so Extra stays clean.
 */
export const MISMATCH_NOTE_PREFIX = "ZPDF-Mismatch-Note:";

export function upsertExtraPrefixedLine(
  extra: string,
  prefix: string,
  value: string,
): string {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix) return String(extra || "");
  const lines = String(extra || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !l.trim().startsWith(cleanPrefix));
  const body = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (body) lines.push(`${cleanPrefix} ${body}`);
  return lines.join("\n");
}

export function clearExtraPrefixedLine(extra: string, prefix: string): string {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix) return String(extra || "");
  return String(extra || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !l.trim().startsWith(cleanPrefix))
    .join("\n");
}

/** Drop Reason + Note Extra lines (successful match cleanup). */
export function clearMismatchExtraLines(extra: string): string {
  return clearExtraPrefixedLine(
    clearExtraPrefixedLine(extra, MISMATCH_REASON_PREFIX),
    MISMATCH_NOTE_PREFIX,
  );
}

async function persistMismatchReason(
  item: Zotero.Item,
  reason: string | undefined,
): Promise<void> {
  const body = String(reason || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return;
  try {
    if (typeof (item as any)?.getField !== "function") return;
    const prev = String(item.getField("extra") || "");
    const next = upsertExtraPrefixedLine(prev, MISMATCH_REASON_PREFIX, body);
    if (next === prev) return;
    item.setField("extra", next);
    await item.saveTx();
  } catch (e) {
    try {
      ztoolkit.log("persistMismatchReason failed", e);
    } catch {
      /* test bundles may lack ztoolkit */
    }
  }
}

/** Clear Extra reason + note when mismatch tags are removed after a good match. */
export async function clearMismatchReasonExtra(
  item: Zotero.Item,
): Promise<void> {
  try {
    if (typeof (item as any)?.getField !== "function") return;
    const prev = String(item.getField("extra") || "");
    const next = clearMismatchExtraLines(prev);
    if (next === prev) return;
    item.setField("extra", next);
    await item.saveTx();
  } catch (e) {
    try {
      ztoolkit.log("clearMismatchReasonExtra failed", e);
    } catch {
      /* test bundles may lack ztoolkit */
    }
  }
}

/**
 * Apply #pdf-mismatch + #pdf-review with automation audit trail.
 * Passive sources respect recent manual clear (see pdfAutomationTagGuard).
 * When `ctx.reason` is set, it is stored in Extra + audit detail.
 */
export async function applyPdfMismatchTags(
  item: Zotero.Item,
  ctx: MismatchTagContext,
  tagItem: TagItemFn,
): Promise<boolean> {
  const title = String(item.getField("title") || `#${item.id}`);
  if (shouldSuppressPassiveMismatchTag(item.id, ctx.source)) {
    void appendAuditEvent({
      run: ctx.run || ctx.source,
      action: "pdf-mismatch-tag-suppressed",
      outcome: "info",
      itemID: item.id,
      title,
      source: ctx.source,
      detail:
        "Skipped passive #pdf-mismatch re-tag after user cleared automation tags",
    });
    ztoolkit.log("applyPdfMismatchTags suppressed", item.id, ctx.source);
    return false;
  }

  await tagItem(item, "#pdf-mismatch");
  await tagItem(item, "#pdf-review");
  await persistMismatchReason(item, ctx.reason);
  await clearValidatedPdfLock(item);
  const reason = String(ctx.reason || "")
    .replace(/\s+/g, " ")
    .trim();
  void appendAuditEvent({
    run: ctx.run || ctx.source,
    action: "pdf-mismatch-tag-applied",
    outcome: "failed",
    itemID: item.id,
    title,
    source: ctx.source,
    detail: reason
      ? `Tagged #pdf-mismatch — ${reason}`
      : "Tagged #pdf-mismatch + #pdf-review (attachment kept)",
  });
  return true;
}
