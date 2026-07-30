// @ajan: cursor · @etiket: katman-2, pdfDownload, yoktez-only-thesis
import {
  ALL_SOURCES,
  downloadAndAttach,
  ensureDOI,
  isAttachStoppedError,
  isBook,
  isContentMismatchError,
  isThesis,
  PDFSource,
} from "./pdfSources";
import { getPref } from "../utils/prefs";
import { maybeEmbedMetadata } from "./pdfMetadata";
import {
  openDownloadReport,
  ItemReport,
  SourceAttempt,
} from "./downloadReport";
import { getLastIndexBuildMeta, isFolderIndexComplete } from "./folderIndex";
import { throwIfRunAborted } from "../utils/cancelToken";
import {
  cascadeAutomaticSources,
  type CascadeSourceLike,
} from "../utils/oaCascade";
import { getString } from "../utils/locale";
import { config } from "../../package.json";
import {
  ARTICLE_DATABASE_IDS,
  isScientificJournalArticle,
  looksTurkish,
  prioritizeSourcesForItem,
} from "./sourcePriority";

export {
  resolveOaDownloadsDir,
  buildOaDownloadBasename,
  sanitizeDownloadBasename,
  uniqueDownloadPath,
  reserveUniqueDownloadPath,
  releaseDownloadPathReservation,
  oaPartialTempPath,
  shouldCleanupPersistedDownload,
} from "./oaDownloadPath";

export { cascadeAutomaticSources } from "../utils/oaCascade";
export {
  ARTICLE_DATABASE_IDS,
  prioritizeSourcesForItem,
  looksTurkish,
  itemHasDOI,
  isScientificJournalArticle,
} from "./sourcePriority";

/**
 * Automatic OA: downloadable article DBs only.
 * Never: Sci-Hub/LibGen/proxy, or metadata-only doi/arxiv/s2/proquest.
 */
export const AUTOMATIC_ONLINE_SOURCE_IDS = ["dergipark", "pmc"] as const;

export type AutomaticOnlineResult =
  | { attachment: Zotero.Item; source: string; stopped?: undefined }
  | { stopped: "review" | "erase-failed"; attachment?: Zotero.Item | null };

type OnlineSourceLike = {
  id: string;
  isEnabled: () => boolean;
  supportsItem: (item: Zotero.Item) => boolean;
  tryAttach: (item: Zotero.Item) => Promise<unknown | null>;
};

let automaticSourcesForTests: OnlineSourceLike[] | null = null;

/** @internal */
export function __setAutomaticOnlineSourcesForTests(
  sources: OnlineSourceLike[] | null,
) {
  automaticSourcesForTests = sources;
}

function orderedAutomaticSources(): OnlineSourceLike[] {
  if (automaticSourcesForTests) return automaticSourcesForTests;
  const list: OnlineSourceLike[] = [];
  for (const id of AUTOMATIC_ONLINE_SOURCE_IDS) {
    const source = ALL_SOURCES[id];
    if (source) list.push(source);
  }
  return list;
}

function orderedAutomaticSourcesForItem(item: Zotero.Item): OnlineSourceLike[] {
  if (automaticSourcesForTests) return automaticSourcesForTests;
  const enabled = AUTOMATIC_ONLINE_SOURCE_IDS.filter((id) => {
    const src = ALL_SOURCES[id];
    return !!src && src.isEnabled();
  });
  const ids = prioritizeSourcesForItem([...enabled], item);
  return ids.map((id) => ALL_SOURCES[id]).filter(Boolean) as OnlineSourceLike[];
}

/**
 * Resolve the download cascade: prefer `sourceOrder` prefs, then append any
 * other enabled sources missing from that list (so enabling LibGen/Sci-Hub
 * checkboxes works even when older prefs omit them from sourceOrder).
 */
export function mergeEnabledSourceOrder(
  orderCsv: string,
  available: Record<string, { isEnabled: () => boolean }>,
): string[] {
  const order = (orderCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const list: string[] = [];
  for (const id of order) {
    const src = available[id];
    if (src && !seen.has(id) && src.isEnabled()) {
      list.push(id);
      seen.add(id);
    }
  }
  for (const id of Object.keys(available)) {
    if (seen.has(id)) continue;
    const src = available[id];
    if (src && src.isEnabled()) {
      list.push(id);
      seen.add(id);
    }
  }
  return list;
}

function orderedSources(): PDFSource[] {
  const ids = mergeEnabledSourceOrder(
    (getPref("pdf.sourceOrder") as string) || "",
    ALL_SOURCES,
  );
  return ids.map((id) => ALL_SOURCES[id]).filter(Boolean);
}

/** Per-item cascade: base prefs order, then article/book/DOI/language boosts. */
export function orderedSourcesForItem(item: Zotero.Item): PDFSource[] {
  const base = mergeEnabledSourceOrder(
    (getPref("pdf.sourceOrder") as string) || "",
    ALL_SOURCES,
  );
  const ids = prioritizeSourcesForItem(base, item);
  return ids.map((id) => ALL_SOURCES[id]).filter(Boolean);
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
 * are enabled. P2-4: successful downloads land under watch-root/downloads/.
 */
export async function tryAutomaticOnlineSources(
  item: Zotero.Item,
): Promise<AutomaticOnlineResult | null> {
  throwIfRunAborted();
  if (hasPDFAttachment(item)) return null;
  if (!isFolderIndexComplete()) {
    const meta = getLastIndexBuildMeta();
    ztoolkit.log(
      `Skipping automatic OA: folder index incomplete (${meta.truncateReason})`,
    );
    return null;
  }
  await ensureDOI(item);
  throwIfRunAborted();

  const result = await cascadeAutomaticSources(
    item,
    orderedAutomaticSourcesForItem(item) as CascadeSourceLike[],
    {
      hasPDF: hasPDFAttachment as (item: unknown) => boolean,
      throwIfAborted: throwIfRunAborted,
      afterAttach: async (parent, attachment, id) => {
        const next = attachment as Zotero.Item;
        await maybeEmbedMetadata(parent as Zotero.Item, next);
        return next;
      },
      onSourceError: (id, e) => {
        ztoolkit.log(`Automatic OA source ${id} failed`, e);
      },
    },
  );
  return result as AutomaticOnlineResult | null;
}

function failureHint(
  item: Zotero.Item,
  attempts: SourceAttempt[],
): string | undefined {
  const tried = new Set(attempts.map((a) => a.source));
  if (isScientificJournalArticle(item) && looksTurkish(item)) {
    if (!tried.has("dergipark")) {
      return (
        "Türkçe makale: yalnızca DergiPark denenir. " +
        "Tercihler → PDF Manager → DergiPark’ı açın."
      );
    }
    return "Türkçe makale: DergiPark’ta bulunamadı (başka kaynak aranmaz).";
  }
  if (isBook(item) && !tried.has("libgen")) {
    return (
      "Kitap: LibGen denenmedi. Tercihler → PDF Manager → LibGen’i açın " +
      "(veya eklentiyi yeniden yükleyin; LibGen varsayılan açılır)."
    );
  }
  if (isThesis(item) && !tried.has("yoktez")) {
    return (
      "Tez: yalnızca YÖKTez denenir. " +
      "Tercihler → PDF Manager → YÖKTez’i açın."
    );
  }
  if (isThesis(item)) {
    const yok = attempts.find((a) => a.source === "yoktez" && a.reason);
    if (yok?.reason) return yok.reason;
    return "Tez: YÖKTez’te bulunamadı (başka kaynak aranmaz).";
  }
  return undefined;
}

function notify(
  text: string,
  type: "default" | "success" | "fail" = "default",
) {
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
  if (orderedSources().length === 0) {
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
    const sources = orderedSourcesForItem(item);
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
        if (isAttachStoppedError(e)) {
          attempts.push({
            source: src.id,
            outcome: e.reason === "review" ? "rejected" : "error",
            reason: e.reason,
          });
          failed++;
          reports.push({
            itemID: item.id,
            title,
            result: "failed",
            note:
              e.reason === "review"
                ? isBook(item)
                  ? "PDF doğrulanamadı — eklenti durdu (#pdf-review). Elle kontrol edin."
                  : "PDF review quarantine — cascade stopped"
                : "Erase failed — cascade stopped; file kept",
            attempts,
          });
          attached = "stopped";
          break;
        }
        if (isContentMismatchError(e)) {
          attempts.push({
            source: src.id,
            outcome: "rejected",
            reason: (e as Error).message,
          });
          continue;
        }
        attempts.push({
          source: src.id,
          outcome: "error",
          reason: (e as Error)?.message || String(e),
        });
        ztoolkit.log(`Source ${src.id} failed`, e);
      }
    }

    if (attached === "stopped") {
      // already counted in failed + reports
    } else if (attached) {
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
      reports.push({
        itemID: item.id,
        title,
        result: "failed",
        attempts,
        note: failureHint(item, attempts),
      });
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
