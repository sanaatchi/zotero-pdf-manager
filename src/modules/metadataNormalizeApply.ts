// @ajan: cursor · @etiket: katman-2, format-metadata, b4-lint, normalize-apply, pages-range, creators-case, extra-order
/**
 * Apply selective format-metadata field normalizations to selected items.
 * Includes pages-range (PDF length), creators-case, Extra reorder (B4c).
 */

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  planFieldNormalizations,
  shouldExpandPagesFromPdf,
  generatePagesRange,
  normalizeCreatorCase,
  reorderExtraField,
  type CreatorNameParts,
} from "../utils/metadataNormalize";

export { normalizeMetadataForSelectedItems };

function progressDone(text: string) {
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text, type: "success", progress: 100 })
    .show();
}

async function pdfPageCountForItem(item: Zotero.Item): Promise<number | null> {
  try {
    const attachment = await item.getBestAttachment();
    if (!attachment) return null;
    if (attachment.attachmentContentType !== "application/pdf") return null;
    const pages = await (Zotero.Fulltext as any).getPages?.(attachment.id);
    const total = Number(pages?.total);
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

function readCreators(item: Zotero.Item): CreatorNameParts[] {
  const raw = (item.getCreators?.() || []) as Array<{
    fieldMode?: number;
    firstName?: string;
    lastName?: string;
  }>;
  return raw.map((c) => ({
    fieldMode: Number(c.fieldMode || 0),
    firstName: c.firstName || "",
    lastName: c.lastName || "",
  }));
}

function creatorsChanged(
  before: CreatorNameParts[],
  after: CreatorNameParts[],
): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    if (
      before[i].firstName !== after[i].firstName ||
      before[i].lastName !== after[i].lastName ||
      before[i].fieldMode !== after[i].fieldMode
    ) {
      return true;
    }
  }
  return false;
}

async function normalizeMetadataForSelectedItems(): Promise<void> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const items =
    pane?.getSelectedItems?.()?.filter((i: Zotero.Item) => i.isRegularItem()) ??
    [];
  if (!items.length) {
    ztoolkit.getGlobal("alert")(getString("pdf-normalize-empty"));
    return;
  }

  let updated = 0;
  let patchCount = 0;
  for (const item of items) {
    const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
    let pagesValue = String(item.getField("pages") || "");
    const patches = planFieldNormalizations({
      title: String(item.getField("title") || ""),
      language: String(item.getField("language") || ""),
      pages: pagesValue,
      issue: String(item.getField("issue") || ""),
      volume: String(item.getField("volume") || ""),
      doi: String(item.getField("DOI") || ""),
      thesisType: String(item.getField("thesisType") || ""),
      itemType,
    });

    // Pages-range: expand single start page using PDF page count (journalArticle).
    const pagesAfterPlan =
      patches.find((p) => p.field === "pages")?.to ?? pagesValue;
    if (
      itemType === "journalArticle" &&
      shouldExpandPagesFromPdf(pagesAfterPlan)
    ) {
      const total = await pdfPageCountForItem(item);
      if (total) {
        const ranged = generatePagesRange(pagesAfterPlan, total);
        if (ranged && ranged !== pagesValue) {
          const existing = patches.find((p) => p.field === "pages");
          if (existing) existing.to = ranged;
          else patches.push({ field: "pages", from: pagesValue, to: ranged });
        }
      }
    }

    const extraRaw = String(item.getField("extra") || "");
    const extraNext = reorderExtraField(extraRaw);

    const creatorsBefore = readCreators(item);
    const creatorsAfter = normalizeCreatorCase(creatorsBefore);
    const creatorDirty = creatorsChanged(creatorsBefore, creatorsAfter);

    if (!patches.length && !extraNext && !creatorDirty) continue;

    try {
      for (const p of patches) {
        item.setField(p.field as any, p.to);
      }
      if (extraNext) {
        item.setField("extra", extraNext);
        patchCount += 1;
      }
      if (creatorDirty) {
        const current = item.getCreators() as unknown as Array<
          Record<string, unknown>
        >;
        const next = current.map((c, i) => ({
          ...c,
          firstName: creatorsAfter[i]?.firstName ?? c.firstName,
          lastName: creatorsAfter[i]?.lastName ?? c.lastName,
        }));
        item.setCreators(next as any);
        patchCount += 1;
      }
      await item.saveTx();
      updated += 1;
      patchCount += patches.length;
    } catch (error) {
      ztoolkit.log("normalize metadata failed", item.id, error);
    }
  }
  progressDone(
    getString("pdf-normalize-done", {
      args: { items: updated, patches: patchCount },
    }),
  );
}
