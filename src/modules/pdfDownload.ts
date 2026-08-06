// @ajan: cursor · @etiket: katman-2, pdfDownload, mismatch-rematch, keep-mismatch, downloads-probe
import {
  ALL_SOURCES,
  downloadAndAttach,
  ensureDOI,
  isAttachStoppedError,
  isBook,
  isContentMismatchError,
  isThesis,
  LocalFolderSource,
  PDFSource,
} from "./pdfSources";
import { getPref } from "../utils/prefs";
import { maybeEmbedMetadata } from "./pdfMetadata";
import {
  openDownloadReport,
  ItemReport,
  SourceAttempt,
} from "./downloadReport";
import {
  buildIndex,
  getLastIndexBuildMeta,
  getWatchRoots,
  isFolderIndexComplete,
} from "./folderIndex";
import { throwIfRunAborted } from "../utils/cancelToken";
import { runInExplicitMismatchTagSessionAsync } from "./pdfAutomationTagGuard";
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
import { mapPool } from "../utils/downloadProgress";
import { buildOaSearchRequest, logOaCascadeMiss } from "./oaPdfBridge";
import {
  buildOaCascadeLogBody,
  cascadeMissKind,
  cascadeMissMessage,
  fallbackCascadeMessage,
  type CascadeMissHints,
} from "../utils/oaCascadeMiss";
import { resolveOaDownloadsDir } from "./oaDownloadPath";

const PDF_MISMATCH_TAG = "#pdf-mismatch";
/** Download report + cascade: OA landing folder probe before network. */
export const DOWNLOADS_PROBE_SOURCE_ID = "downloads";

declare const IOUtils: {
  exists: (path: string) => Promise<boolean>;
};

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
 * Automatic OA cascade (legal / CAPTCHA-free first).
 * Never: Sci-Hub/LibGen/proxy/yoktez/arxiv/s2/proquest.
 */
// Politika B (kilit): YÖKTez asla otomatik şelalede değil — yalnız manuel menü.
export const AUTOMATIC_ONLINE_SOURCE_IDS = ["doi", "dergipark", "pmc"] as const;

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

/** True when the parent already carries `#pdf-mismatch` (wrong PDF linked). */
export function itemHasPdfMismatchTag(item: Zotero.Item): boolean {
  try {
    return !!item.hasTag?.(PDF_MISMATCH_TAG);
  } catch {
    return false;
  }
}

/**
 * Successful attach gate for skip/cascade: any PDF counts as done **unless**
 * the parent still carries `#pdf-mismatch` (wrong PDF kept — allow rematch
 * from downloads / OA / Match Attachment without deleting the old file).
 */
export function hasAcceptedPdfAttachment(item: Zotero.Item): boolean {
  if (!hasPDFAttachment(item)) return false;
  if (itemHasPdfMismatchTag(item)) return false;
  return true;
}

/**
 * No-op: mismatch PDFs are never auto-detached (download or content-audit).
 * Kept for call-site compatibility.
 */
export async function detachMismatchPdfAttachments(
  _item: Zotero.Item,
): Promise<number> {
  return 0;
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
  if (hasAcceptedPdfAttachment(item)) return null;
  if (!isFolderIndexComplete()) {
    const meta = getLastIndexBuildMeta();
    ztoolkit.log(
      `Skipping automatic OA: folder index incomplete (${meta.truncateReason})`,
    );
    return null;
  }
  await ensureDOI(item);
  throwIfRunAborted();

  const sources = orderedAutomaticSourcesForItem(item);
  const attempts: SourceAttempt[] = [];
  const result = await cascadeAutomaticSources(
    item,
    sources as CascadeSourceLike[],
    {
      hasPDF: hasAcceptedPdfAttachment as (item: unknown) => boolean,
      throwIfAborted: throwIfRunAborted,
      afterAttach: async (parent, attachment, id) => {
        const next = attachment as Zotero.Item;
        await maybeEmbedMetadata(parent as Zotero.Item, next);
        return next;
      },
      onSourceError: (id, e) => {
        if (isContentMismatchError(e)) {
          attempts.push({
            source: id,
            outcome: "rejected",
            reason: e instanceof Error ? e.message : String(e),
          });
          return;
        }
        attempts.push({
          source: id,
          outcome: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
        ztoolkit.log(`Automatic OA source ${id} failed`, e);
      },
    },
  );
  if (!result) {
    const seen = new Set(attempts.map((a) => a.source));
    for (const src of sources) {
      if (!src.isEnabled() || !src.supportsItem(item)) continue;
      if (!seen.has(src.id)) {
        attempts.push({ source: src.id, outcome: "no-match" });
      }
    }
    queueCascadeMissLog(item, attempts, "auto-cascade");
  }
  return result as AutomaticOnlineResult | null;
}

function cascadeHintsForItem(item: Zotero.Item): CascadeMissHints {
  return {
    isTurkishJournal: isScientificJournalArticle(item) && looksTurkish(item),
    isBook: isBook(item),
    isThesis: isThesis(item),
  };
}

function failureHint(
  item: Zotero.Item,
  attempts: SourceAttempt[],
): string | undefined {
  const paywall = attempts.find((a) =>
    /paywall|ücretli|açık pdf yok/i.test(String(a.reason || "")),
  );
  if (paywall?.reason) return String(paywall.reason).trim();
  return cascadeMissMessage(cascadeHintsForItem(item), attempts);
}

function queueCascadeMissLog(
  item: Zotero.Item,
  attempts: SourceAttempt[],
  origin: "download-report" | "auto-cascade",
  note?: string,
) {
  const hints = cascadeHintsForItem(item);
  const message =
    (note && String(note).trim()) ||
    cascadeMissMessage(hints, attempts) ||
    fallbackCascadeMessage(attempts);
  const kind = cascadeMissKind(hints, attempts);
  let title = "";
  let doi = "";
  let isbn = "";
  let authors = "";
  let year = "";
  let language = "";
  let itemType = "";
  try {
    const req = buildOaSearchRequest("doi", item, 1);
    title = req.text || "";
    doi = req.doi || "";
    isbn = req.isbn || "";
    authors = req.authors || "";
    year = req.year || "";
    language = req.language || "";
    itemType = req.kind || "";
  } catch {
    try {
      title = String(item.getDisplayTitle() || "");
    } catch {
      title = "";
    }
  }
  const body = buildOaCascadeLogBody({
    kind,
    message,
    origin,
    title,
    doi,
    isbn,
    authors,
    year,
    language,
    itemType,
    attempts,
  });
  void logOaCascadeMiss(body);
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
 * Match/attach from `{watchRoot}/downloads/` only (P2-4). Uses the same
 * LocalFolderSource matching + finalizeLocalAttachment path as reconciliation.
 * Runs before the manual download cascade so freshly landed OA files attach
 * without a network round-trip.
 */
export async function tryAttachFromDownloadsFolder(
  item: Zotero.Item,
  tagCtx?: { source: string; run?: string },
): Promise<Zotero.Item | null> {
  const downloadsDir = resolveOaDownloadsDir(getWatchRoots());
  if (!downloadsDir) return null;
  try {
    if (!(await IOUtils.exists(downloadsDir))) return null;
  } catch {
    return null;
  }

  const index = await buildIndex(true, [downloadsDir], undefined, {
    ephemeral: true,
  });
  if (!index.length) return null;

  const local = new LocalFolderSource();
  const match = local.matchItem(item, index);
  if (match.status !== "matched" || !match.file) return null;
  return local.attachFile(item, match.file, match.via || "title", {
    source: tagCtx?.source || "downloads-probe",
    run: tagCtx?.run,
  });
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
  // Per-download ProgressWindow lines come from fetchOaPdfViaBridge (multi-job).
  // Keep a short summary toast for the batch result.
  notify(getString("pdf-start", { args: { count: items.length } }), "default");

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const reports: ItemReport[] = [];
  const CONCURRENCY = Math.min(3, Math.max(1, items.length));

  type ItemOutcome = {
    success?: boolean;
    skipped?: boolean;
    failed?: boolean;
    report: ItemReport;
  };

  const outcomes = await mapPool(items, CONCURRENCY, async (item) =>
    runInExplicitMismatchTagSessionAsync(async () => {
    const title = item.getDisplayTitle();
    if (skipExisting && hasAcceptedPdfAttachment(item)) {
      return {
        skipped: true,
        report: {
          itemID: item.id,
          title,
          result: "skipped" as const,
          note: "Zaten PDF eki var",
          attempts: [] as SourceAttempt[],
        },
      };
    }

    await ensureDOI(item);

    const attempts: SourceAttempt[] = [];
    let attached: unknown | null = null;
    let attachedSource: string | undefined;

    try {
      const fromDownloads = await tryAttachFromDownloadsFolder(item, {
        source: "downloads-probe",
      });
      if (fromDownloads) {
        attempts.push({
          source: DOWNLOADS_PROBE_SOURCE_ID,
          outcome: "attached",
        });
        attached = fromDownloads;
        attachedSource = DOWNLOADS_PROBE_SOURCE_ID;
      } else {
        attempts.push({
          source: DOWNLOADS_PROBE_SOURCE_ID,
          outcome: "no-match",
        });
      }
    } catch (e) {
      if (isAttachStoppedError(e)) {
        attempts.push({
          source: DOWNLOADS_PROBE_SOURCE_ID,
          outcome: e.reason === "review" ? "rejected" : "error",
          reason: e.reason,
        });
        const stopNote =
          e.reason === "review"
            ? isBook(item)
              ? "PDF doğrulanamadı — eklenti durdu (#pdf-review). Elle kontrol edin."
              : "PDF review quarantine — cascade stopped"
            : "Erase failed — cascade stopped; file kept";
        queueCascadeMissLog(item, attempts, "download-report", stopNote);
        return {
          failed: true,
          report: {
            itemID: item.id,
            title,
            result: "failed" as const,
            note: stopNote,
            attempts,
          },
        };
      }
      if (isContentMismatchError(e)) {
        attempts.push({
          source: DOWNLOADS_PROBE_SOURCE_ID,
          outcome: "rejected",
          reason: (e as Error).message,
        });
      } else {
        attempts.push({
          source: DOWNLOADS_PROBE_SOURCE_ID,
          outcome: "error",
          reason: (e as Error)?.message || String(e),
        });
        ztoolkit.log("Downloads folder probe failed", e);
      }
    }

    const sources = orderedSourcesForItem(item);
    for (const src of sources) {
      if (attached) break;
      if (!src.supportsItem(item)) {
        attempts.push({ source: src.id, outcome: "unsupported" });
        continue;
      }
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
          const stopNote =
            e.reason === "review"
              ? isBook(item)
                ? "PDF doğrulanamadı — eklenti durdu (#pdf-review). Elle kontrol edin."
                : "PDF review quarantine — cascade stopped"
              : "Erase failed — cascade stopped; file kept";
          queueCascadeMissLog(item, attempts, "download-report", stopNote);
          return {
            failed: true,
            report: {
              itemID: item.id,
              title,
              result: "failed" as const,
              note: stopNote,
              attempts,
            },
          };
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

    if (attached) {
      await maybeEmbedMetadata(item, attached as Zotero.Item);
      return {
        success: true,
        report: {
          itemID: item.id,
          title,
          result: "added" as const,
          attachedSource,
          attempts,
        },
      };
    }
    const note = failureHint(item, attempts);
    queueCascadeMissLog(item, attempts, "download-report", note);
    return {
      failed: true,
      report: {
        itemID: item.id,
        title,
        result: "failed" as const,
        attempts,
        note,
      },
    };
  }),
  );

  for (const o of outcomes as ItemOutcome[]) {
    reports.push(o.report);
    if (o.skipped) skipped++;
    else if (o.success) success++;
    else failed++;
  }

  notify(
    getString("pdf-done", { args: { success, skipped, failed } }),
    success > 0 ? "success" : "default",
  );

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
