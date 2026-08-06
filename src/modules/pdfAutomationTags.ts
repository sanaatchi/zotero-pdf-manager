// @ajan: cursor · @etiket: katman-2, pdf-mismatch, automation-audit, tag-guard
import { appendAuditEvent } from "./automationAudit";
import {
  type MismatchTagContext,
  shouldSuppressPassiveMismatchTag,
} from "./pdfAutomationTagGuard";

export type TagItemFn = (item: Zotero.Item, tag: string) => Promise<void>;

/**
 * Apply #pdf-mismatch + #pdf-review with automation audit trail.
 * Passive sources respect recent manual clear (see pdfAutomationTagGuard).
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
  void appendAuditEvent({
    run: ctx.run || ctx.source,
    action: "pdf-mismatch-tag-applied",
    outcome: "failed",
    itemID: item.id,
    title,
    source: ctx.source,
    detail: "Tagged #pdf-mismatch + #pdf-review (attachment kept)",
  });
  return true;
}
