import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { config } from "../../package.json";
import { ALL_SOURCES, downloadAndAttach, ensureDOI, PDFSource } from "./pdfSources";
import { maybeEmbedMetadata } from "./pdfMetadata";
import {
  openDownloadReport,
  ItemReport,
  SourceAttempt,
} from "./downloadReport";

export const AUTOMATIC_ONLINE_SOURCE_IDS = [
  "doi",
  "arxiv",
  "pmc",
  "s2",
  "dergipark",
] as const;

function orderedSources(): PDFSource[] {
  const order = ((getPref("pdf.sourceOrder") as string) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const list: PDFSource[] = [];
  for (const id of order) {
    const src = ALL_SOURCES[id];
    if (src && !seen.has(id) && src.isEnabled()) {
      list.push(src);
      seen.add(id);
    }
  }
  return list;
}

function hasPDFAttachment(item: Zotero.Item): boolean {
  return item.getAttachments().some((id: number) => {
    const att = Zotero.Items.get(id);
    return att && att.attachmentContentType === "application/pdf";
  });
}

/**
 * Automatic OA-only fallback. Deliberately excludes Sci-Hub, LibGen,
 * institutional proxies, YÖKTEZ and ProQuest even when those manual sources
 * are enabled.
 */
export async function tryAutomaticOnlineSources(item: Zotero.Item) {
  if (hasPDFAttachment(item)) return null;
  await ensureDOI(item);

  for (const id of AUTOMATIC_ONLINE_SOURCE_IDS) {
    const source = ALL_SOURCES[id];
    if (!source?.isEnabled() || !source.supportsItem(item)) continue;
    try {
      const attachment = await source.tryAttach(item);
      if (!attachment) continue;
      await maybeEmbedMetadata(item, attachment as Zotero.Item);
      return { attachment, source: id };
    } catch (e) {
      ztoolkit.log(`Automatic OA source ${id} failed`, e);
    }
  }
  return null;
}

function notify(text: string, type: "default" | "success" | "fail" = "default") {
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text, type })
    .show();
}

/**
 * Download and attach a PDF for every selected top-level regular item, trying
 * each enabled source (that supports the item's type) in priority order.
 */
export async function downloadPdfForSelectedItems() {
  const items = ZoteroPane.getSelectedItems().filter(
    (item) => item.isRegularItem() && !(item as any).isFeedItem,
  );
  if (items.length === 0) {
    notify(getString("pdf-no-items"));
    return;
  }
  const sources = orderedSources();
  if (sources.length === 0) {
    notify(getString("pdf-no-sources"));
    return;
  }

  const skipExisting = getPref("pdf.skipExisting") ?? true;
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  progress
    .createLine({
      text: getString("pdf-start", { args: { count: items.length } }),
      type: "default",
      progress: 0,
    })
    .show();

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const reports: ItemReport[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = item.getDisplayTitle();

    if (skipExisting && hasPDFAttachment(item)) {
      skipped++;
      reports.push({
        itemID: item.id,
        title,
        result: "skipped",
        note: "Zaten PDF eki var",
        attempts: [],
      });
      continue;
    }

    await ensureDOI(item);

    const attempts: SourceAttempt[] = [];
    let attached: unknown | null = null;
    let attachedSource: string | undefined;
    for (const src of sources) {
      if (!src.supportsItem(item)) {
        attempts.push({ source: src.id, outcome: "unsupported" });
        continue;
      }
      progress.changeLine({
        text: getString("pdf-trying", { args: { source: src.id, title } }),
        progress: Math.round((i / items.length) * 100),
      });
      try {
        const result = await src.tryAttach(item);
        if (result) {
          attempts.push({ source: src.id, outcome: "attached" });
          attached = result;
          attachedSource = src.id;
          break;
        }
        attempts.push({ source: src.id, outcome: "no-match" });
      } catch (e) {
        attempts.push({
          source: src.id,
          outcome: "error",
          reason: (e as Error)?.message || String(e),
        });
        ztoolkit.log(`Source ${src.id} failed`, e);
      }
    }

    if (attached) {
      await maybeEmbedMetadata(item, attached as Zotero.Item);
      success++;
      reports.push({
        itemID: item.id,
        title,
        result: "added",
        attachedSource,
        attempts,
      });
    } else {
      failed++;
      reports.push({ itemID: item.id, title, result: "failed", attempts });
    }
  }

  progress.changeLine({
    text: getString("pdf-done", { args: { success, skipped, failed } }),
    type: success > 0 ? "success" : "default",
    progress: 100,
  });
  progress.startCloseTimer(5000);

  await openDownloadReport(reports);
}

/**
 * Attach a PDF to the first selected item from a URL the user pastes.
 */
export async function attachPdfFromUrl() {
  const items = ZoteroPane.getSelectedItems().filter(
    (item) => item.isRegularItem() && !(item as any).isFeedItem,
  );
  if (items.length === 0) {
    notify(getString("pdf-no-items"));
    return;
  }
  const win = Zotero.getMainWindow();
  const url = win.prompt(getString("pdf-prompt-url"), "");
  if (!url || !url.trim()) return;

  // Manual URL is trusted by the user → skip metadata content validation.
  const attached = await downloadAndAttach(items[0], url.trim(), {
    validate: false,
  });
  if (attached) {
    await maybeEmbedMetadata(items[0], attached as Zotero.Item);
  }
  notify(
    getString(attached ? "pdf-attached" : "pdf-attach-failed"),
    attached ? "success" : "fail",
  );
}
