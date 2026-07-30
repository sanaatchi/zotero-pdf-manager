// @ajan: cursor · @etiket: katman-2, pdfSources, oa-pdf-bridge, book-validation
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  buildIndex,
  getWatchRoots,
  IndexedFile,
  registerDownloadedFile,
} from "./folderIndex";
import {
  ArxivSource,
  DergiParkSource,
  DOISource,
  LibGenSource,
  PMCSource,
  ProQuestSource,
  ProxySource,
  SciHubSource,
  SemanticScholarSource,
  YokTezSource,
} from "./pythonPdfSources";

import {
  buildOaDownloadBasename,
  oaPartialTempPath,
  releaseDownloadPathReservation,
  reserveUniqueDownloadPath,
  resolveOaDownloadsDir,
  shouldCleanupPersistedDownload,
} from "./oaDownloadPath";

import {
  abortable,
  getActiveAbortSignal,
  throwIfRunAborted,
} from "../utils/cancelToken";
import { normalizeDOI } from "../utils/metadataNormalize";
import {
  compareItemAgainstText,
  hasIdentifierConflict,
  hasIdentifierMatch,
  normalizeItemIdentifiers,
} from "./metadataCheck";

/** Stops further URL/source cascade after quarantine or erase-failed keep. */
export class AttachStoppedError extends Error {
  readonly name = "AttachStoppedError";
  constructor(
    readonly reason: "review" | "erase-failed",
    readonly attachment?: Zotero.Item | null,
  ) {
    super(`PDF attach stopped (${reason})`);
  }
}

export function isAttachStoppedError(e: unknown): e is AttachStoppedError {
  return (
    !!e &&
    typeof e === "object" &&
    ((e as Error).name === "AttachStoppedError" ||
      e instanceof AttachStoppedError)
  );
}

/** Re-throw cascade-stop / abort so URL/source loops do not swallow them. */
export function rethrowAttachControlFlow(e: unknown): void {
  if (isAttachStoppedError(e)) throw e;
  if ((e as Error)?.name === "RunAbortedError") throw e;
}
// Gecko globals available in the Zotero sandbox but not in the type defs.
declare const IOUtils: any;
declare const PathUtils: any;

/**
 * A download source. Given an item, it tries to obtain a PDF and attach it,
 * returning the created attachment (or `null` if it could not).
 *
 * `supportsItem` gates a source by item type (e.g. Sci-Hub only for articles,
 * YÖKTEZ/ProQuest only for theses) so we do not waste requests on the wrong
 * kind of reference.
 */
export interface PDFSource {
  id: string;
  isEnabled(): boolean;
  supportsItem(item: Zotero.Item): boolean;
  tryAttach(item: Zotero.Item): Promise<unknown | null>;
}

export type LocalMatchResult =
  | { status: "matched"; file: IndexedFile; score: number }
  | { status: "review"; file?: IndexedFile; score?: number; reason: string }
  | { status: "ambiguous"; score?: number }
  | { status: "none" };

/** Clamp and order match thresholds (P2-2). Defaults: attach 0.85, review 0.60. */
export function normalizeMatchThresholds(
  autoAttach: unknown,
  review: unknown,
): { autoAttach: number; review: number } {
  const parse = (value: unknown, fallback: number) => {
    const n =
      typeof value === "number" ? value : Number.parseFloat(`${value ?? ""}`);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  };
  let auto = parse(autoAttach, 0.85);
  let rev = parse(review, 0.6);
  if (rev > auto) {
    const swap = rev;
    rev = auto;
    auto = swap;
  }
  return { autoAttach: auto, review: rev };
}

/**
 * Classify a 0–1 confidence score against auto-attach / review thresholds.
 * Inspired by Attanger's safe-auto vs manual review split (AGPL selective).
 */
export function classifyMatchConfidence(
  score: number,
  autoAttach = 0.85,
  review = 0.6,
): "attach" | "review" | "skip" {
  const { autoAttach: hi, review: lo } = normalizeMatchThresholds(
    autoAttach,
    review,
  );
  if (!Number.isFinite(score) || score < lo) return "skip";
  if (score >= hi) return "attach";
  return "review";
}

function readMatchThresholds() {
  try {
    return normalizeMatchThresholds(
      getPref("pdf.autoAttachThreshold"),
      getPref("pdf.reviewThreshold"),
    );
  } catch {
    return normalizeMatchThresholds(0.85, 0.6);
  }
}

// --------------------------------------------------------------------------
// Item type groups
// --------------------------------------------------------------------------

const ARTICLE_TYPES = new Set([
  "journalArticle",
  "conferencePaper",
  "preprint",
  "report",
  "magazineArticle",
  "newspaperArticle",
]);
const BOOK_TYPES = new Set(["book", "bookSection"]);
const THESIS_TYPES = new Set(["thesis"]);
const DERGIPARK_TYPES = new Set(["journalArticle"]);

function itemType(item: Zotero.Item): string {
  try {
    return (Zotero.ItemTypes as any).getName(item.itemTypeID) as string;
  } catch {
    return "";
  }
}
export const isArticle = (i: Zotero.Item) => ARTICLE_TYPES.has(itemType(i));
export const isBook = (i: Zotero.Item) => BOOK_TYPES.has(itemType(i));
export const isThesis = (i: Zotero.Item) => THESIS_TYPES.has(itemType(i));

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

function looksLikePDF(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 4) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

export function absoluteURL(base: string, ref: string): string {
  ref = (ref || "").trim().replace(/&amp;/g, "&");
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith("//")) return "https:" + ref;
  const originMatch = base.match(/^(https?:\/\/[^/]+)/i);
  const origin = originMatch ? originMatch[1] : base.replace(/\/+$/, "");
  if (ref.startsWith("/")) return origin + ref;
  const basePath = base.replace(/[^/]*$/, "");
  return basePath + ref;
}

async function httpGet(
  url: string,
  responseType: "text" | "arraybuffer" = "text",
): Promise<any> {
  throwIfRunAborted();
  const signal = getActiveAbortSignal();
  const cancelRef: { fn: (() => void) | null } = { fn: null };
  const request = (Zotero.HTTP as any).request("GET", url, {
    responseType,
    timeout: 60000,
    successCodes: false,
    cancellerReceiver: (cancel: () => void) => {
      cancelRef.fn = cancel;
    },
  });
  const invokeCancel = () => {
    try {
      cancelRef.fn?.();
    } catch {
      /* ignore */
    }
  };
  try {
    const xhr = await abortable(request, signal, invokeCancel);
    throwIfRunAborted(signal);
    return xhr;
  } catch (e) {
    if ((e as Error)?.name === "RunAbortedError") invokeCancel();
    throw e;
  }
}

export async function fetchPdfBytes(url: string): Promise<Uint8Array | null> {
  try {
    throwIfRunAborted();
    const xhr = await httpGet(url, "arraybuffer");
    throwIfRunAborted();
    if (!xhr || !xhr.response) return null;
    const bytes = new Uint8Array(xhr.response as ArrayBuffer);
    return looksLikePDF(bytes) ? bytes : null;
  } catch (e) {
    if ((e as Error)?.name === "RunAbortedError") throw e;
    ztoolkit.log("fetchPdfBytes failed", url, e);
    return null;
  }
}

// --------------------------------------------------------------------------
// Metadata helpers (used for matching and content validation)
// --------------------------------------------------------------------------

export function normalizeSearchText(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

function tokenize(s: string): string[] {
  return normalizeSearchText(s)
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function titleSimilar(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  const tb = tokenize(b);
  if (ta.size === 0 || tb.length === 0) return false;
  const overlap = tb.filter((w) => ta.has(w)).length;
  return overlap / Math.max(ta.size, tb.length) >= 0.6;
}

function firstAuthorSurname(item: Zotero.Item): string {
  try {
    const creators = (item.getCreators() as any[]) || [];
    return normalizeSearchText(
      creators[0]?.lastName || creators[0]?.name || "",
    ).trim();
  } catch {
    return "";
  }
}

function itemYear(item: Zotero.Item): string {
  const date = (item.getField("date") as string) || "";
  const m = date.match(/\d{4}/);
  return m ? m[0] : "";
}

function itemPublisher(item: Zotero.Item): string {
  return normalizeSearchText(
    (item.getField("publisher") as string) ||
      (item.getField("publicationTitle") as string) ||
      "",
  ).trim();
}

/**
 * Score how well a blob of text matches the item's metadata.
 * Returns 0..~1.8 (title up to 1, author 0.5, year 0.3).
 */
function scoreText(item: Zotero.Item, rawText: string): number {
  // Normalize the haystack the SAME way as the tokens (NFKD + strip marks),
  // otherwise accented/Turkish titles (çalışma vs calisma) never match and a
  // correct PDF gets rejected by content validation.
  const text = normalizeSearchText(rawText);
  if (!text) return 0;
  let score = 0;

  const tokens = tokenize((item.getField("title") as string) || "");
  if (tokens.length) {
    const hit = tokens.filter((t) => text.includes(t)).length / tokens.length;
    score += hit;
  }
  const surname = firstAuthorSurname(item);
  if (surname && text.includes(surname)) score += 0.5;
  const year = itemYear(item);
  if (year && text.includes(year)) score += 0.3;
  const publisher = itemPublisher(item);
  if (publisher && publisher.length > 3 && text.includes(publisher))
    score += 0.2;
  return score;
}

/**
 * After a PDF is attached, read its text and confirm it matches the item's
 * metadata.
 *
 * - match: extractable text supports the item
 * - mismatch: extractable text conflicts — reject / erase
 * - unverifiable: no/short text, or book inconclusive — keep + #pdf-review
 * - skipped: validation pref off
 *
 * Books: ISBN/DOI conflict → erase. Strong title/author/year or ISBN match →
 * keep. Weak/inconclusive text → review (do not erase). Wrong title+author →
 * erase.
 */
export type ContentValidation =
  "match" | "mismatch" | "unverifiable" | "skipped";

/** Pure decision helper (unit-tested). */
export function decideContentValidation(input: {
  kind: "book" | "other";
  textChars: number;
  /** 0–1 share of title tokens found in PDF text */
  titleHit: number;
  /** Combined score from scoreText (title + author + year + publisher) */
  score: number;
  hasIdConflict: boolean;
  hasIdMatch: boolean;
  authorExpected: boolean;
  authorFound: boolean;
}): ContentValidation {
  if (input.textChars < 50) return "unverifiable";
  if (input.hasIdConflict) return "mismatch";
  if (input.hasIdMatch) return "match";
  if (input.score >= 0.6) return "match";

  if (input.kind === "book") {
    const clearlyWrong =
      input.titleHit < 0.2 &&
      ((input.authorExpected && !input.authorFound) || input.score < 0.25);
    if (clearlyWrong) return "mismatch";
    // Keep for manual review — scanned/TR OCR often scores low on correct files.
    return "unverifiable";
  }

  // Articles / other: keep stricter auto-reject.
  if (input.score >= 0.3 && input.titleHit >= 0.4) return "match";
  return "mismatch";
}

export function titleTokenHit(item: Zotero.Item, rawText: string): number {
  const text = normalizeSearchText(rawText);
  const tokens = tokenize((item.getField("title") as string) || "");
  if (!tokens.length || !text) return 0;
  return tokens.filter((t) => text.includes(t)).length / tokens.length;
}

export class ContentMismatchError extends Error {
  readonly name = "ContentMismatchError";
  constructor(message = "PDF içeriği künye metadata ile uyuşmadı") {
    super(message);
  }
}

export function isContentMismatchError(e: unknown): e is ContentMismatchError {
  return (
    !!e &&
    typeof e === "object" &&
    ((e as Error).name === "ContentMismatchError" ||
      e instanceof ContentMismatchError)
  );
}

export async function validateAttachmentContent(
  item: Zotero.Item,
  attachmentID: number,
): Promise<ContentValidation> {
  if (!getPref("pdf.validateContent")) return "skipped";
  try {
    const book = isBook(item);
    // Books often bury title after covers/front matter — read more pages.
    const pageLimit = book ? 20 : 5;
    const res = await (Zotero as any).PDFWorker.getFullText(
      attachmentID,
      pageLimit,
    );
    const text: string = res?.text || "";
    const textChars = text.replace(/\s/g, "").length;

    const structured = compareItemAgainstText(item, text);
    const surname = firstAuthorSurname(item);
    const authorFound =
      !!surname &&
      surname.length > 2 &&
      normalizeSearchText(text).includes(surname);

    return decideContentValidation({
      kind: book ? "book" : "other",
      textChars,
      titleHit: titleTokenHit(item, text),
      score: scoreText(item, text),
      hasIdConflict: hasIdentifierConflict(structured),
      hasIdMatch: hasIdentifierMatch(structured),
      authorExpected: surname.length > 2,
      authorFound,
    });
  } catch (e) {
    ztoolkit.log("content validation error", e);
    return "unverifiable";
  }
}

/** @deprecated Prefer validateAttachmentContent — boolean collapses unverifiable. */
export async function contentMatches(
  item: Zotero.Item,
  attachmentID: number,
): Promise<boolean> {
  const verdict = await validateAttachmentContent(item, attachmentID);
  return verdict === "match" || verdict === "skipped";
}

async function tagItem(item: Zotero.Item, tag: string): Promise<void> {
  try {
    const tags = (item.getTags() as { tag: string }[]) || [];
    if (tags.some((entry) => entry.tag === tag)) return;
    item.addTag(tag);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("tagItem failed", tag, e);
  }
}

async function removeAutomationTag(
  item: Zotero.Item,
  tag: string,
): Promise<void> {
  try {
    const tags = (item.getTags() as { tag: string }[]) || [];
    if (!tags.some((entry) => entry.tag === tag)) return;
    item.removeTag(tag);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("removeAutomationTag failed", tag, e);
  }
}

/**
 * Erase attachment first; only then remove the on-disk file this run created.
 * If erase fails, keep the file so Zotero does not keep a broken linked path.
 */
export async function cleanupRejectedAttachment(opts: {
  attachment: Zotero.Item;
  persistedPath?: string | null;
  finalCreatedByThisRun: boolean | null;
}): Promise<"cleaned" | "erase-failed"> {
  try {
    await opts.attachment.eraseTx();
  } catch (e) {
    ztoolkit.log("erase rejected/unverifiable attachment failed", e);
    return "erase-failed";
  }
  if (
    opts.persistedPath &&
    shouldCleanupPersistedDownload(opts.finalCreatedByThisRun === true)
  ) {
    try {
      await IOUtils.remove(opts.persistedPath);
    } catch {
      /* best-effort */
    }
  }
  return "cleaned";
}

/**
 * Download bytes from `url`, verify they are a real PDF, then either:
 * - **P2-4 downloads mode:** write under `{watchRoot}/downloads/`, link/import,
 *   register in folder index; or
 * - **legacy:** temp file + importFromFile (when no watch root / pref off).
 */
export async function downloadAndAttach(
  item: Zotero.Item,
  url: string,
  opts: { validate?: boolean; sourceId?: string; forceImport?: boolean } = {},
): Promise<unknown | null> {
  throwIfRunAborted();
  const bytes = await fetchPdfBytes(url);
  throwIfRunAborted();
  if (!bytes) return null;

  const persistDownloads =
    !opts.forceImport &&
    getPref("pdf.saveOaToDownloads") !== false &&
    getWatchRoots().length > 0;
  const downloadsDir = persistDownloads
    ? resolveOaDownloadsDir(getWatchRoots())
    : null;

  let attachment: any = null;
  let persistedPath: string | null = null;
  let tmpPath: string | null = null;
  let finalCreatedByThisRun = false;

  try {
    if (downloadsDir) {
      try {
        await IOUtils.makeDirectory(downloadsDir, {
          createAncestors: true,
          ignoreExisting: true,
        });
      } catch (e) {
        ztoolkit.log("Could not create OA downloads dir", downloadsDir, e);
      }
      const basename = buildOaDownloadBasename(
        {
          doi: getDOI(item),
          title: (item.getField("title") as string) || "",
          itemID: item.id,
        },
        opts.sourceId || "oa",
      );
      persistedPath = await reserveUniqueDownloadPath(
        downloadsDir,
        basename,
        async (p) => {
          // Fail-closed: exists probe must succeed and return false.
          return !!(await IOUtils.exists(p));
        },
      );
      const partial = oaPartialTempPath(persistedPath);
      try {
        await IOUtils.write(partial, bytes);
        // noOverwrite: never clobber an existing final PDF if reservation raced.
        await IOUtils.move(partial, persistedPath, { noOverwrite: true });
        finalCreatedByThisRun = true;
      } catch (e) {
        try {
          await IOUtils.remove(partial);
        } catch {
          /* best-effort */
        }
        throw e;
      } finally {
        releaseDownloadPathReservation(persistedPath);
      }
      const asLink = getPref("pdf.localAsLink") !== false;
      const method = asLink ? "linkFromFile" : "importFromFile";
      attachment = await (Zotero.Attachments as any)[method]({
        file: persistedPath,
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: getString("pdf-attachment-title"),
        contentType: "application/pdf",
      });
      if (attachment) {
        await registerDownloadedFile(persistedPath);
      }
    } else {
      const tmpDir = (Zotero as any).getTempDirectory().path as string;
      tmpPath = PathUtils.join(tmpDir, `pdffetch-${item.id}-${Date.now()}.pdf`);
      await IOUtils.write(tmpPath, bytes);
      attachment = await (Zotero.Attachments as any).importFromFile({
        file: tmpPath,
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: getString("pdf-attachment-title"),
        contentType: "application/pdf",
      });
    }
  } catch (e) {
    ztoolkit.log("downloadAndAttach failed", e);
    attachment = null;
  } finally {
    if (tmpPath) {
      try {
        await IOUtils.remove(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  if (!attachment) {
    if (
      persistedPath &&
      shouldCleanupPersistedDownload(finalCreatedByThisRun)
    ) {
      try {
        await IOUtils.remove(persistedPath);
      } catch {
        /* best-effort */
      }
    }
    return null;
  }

  if (opts.validate !== false) {
    const verdict = await validateAttachmentContent(item, attachment.id);
    if (verdict === "match" || verdict === "skipped") {
      await removeAutomationTag(item, "#pdf-review");
      await removeAutomationTag(item, "#pdf-quarantine");
      return attachment;
    }
    if (verdict === "unverifiable") {
      ztoolkit.log(
        `Unverifiable PDF content for ${item.id} — quarantine + #pdf-review`,
      );
      await tagItem(item, "#pdf-review");
      await tagItem(item, "#pdf-quarantine");
      // Keep attachment for review; stop all further source/URL cascade.
      throw new AttachStoppedError("review", attachment);
    }
    // mismatch — must erase before deleting the linked file
    ztoolkit.log(`Rejected PDF (metadata mismatch) for ${item.id}`);
    const cleaned = await cleanupRejectedAttachment({
      attachment,
      persistedPath,
      finalCreatedByThisRun,
    });
    if (cleaned === "erase-failed") {
      await tagItem(item, "#pdf-review");
      await tagItem(item, "#pdf-quarantine");
      throw new AttachStoppedError("erase-failed", attachment);
    }
    throw new ContentMismatchError(
      "PDF içeriği künye metadata ile uyuşmadı (doğrulama)",
    );
  }
  return attachment;
}

/**
 * After Zotero's addAvailablePDF (storage import), optionally copy the file
 * into `{watchRoot}/downloads/` and re-attach as a link (P2-4 / folder authority).
 */
export async function relocateImportedPdfToDownloads(
  item: Zotero.Item,
  attachment: Zotero.Item,
  sourceId = "doi",
): Promise<Zotero.Item | null> {
  if (getPref("pdf.saveOaToDownloads") === false) return attachment;
  const dir = resolveOaDownloadsDir(getWatchRoots());
  if (!dir) return attachment;

  let srcPath = "";
  try {
    srcPath =
      (await (attachment as any).getFilePathAsync?.()) ||
      (attachment as any).getFilePath?.() ||
      "";
  } catch {
    srcPath = "";
  }
  if (!srcPath) return attachment;

  try {
    await IOUtils.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch (e) {
    ztoolkit.log("relocate: makeDirectory failed", e);
    return attachment;
  }

  const basename = buildOaDownloadBasename(
    {
      doi: getDOI(item),
      title: (item.getField("title") as string) || "",
      itemID: item.id,
    },
    sourceId,
  );
  const dest = await reserveUniqueDownloadPath(
    dir,
    basename,
    async (p) => !!(await IOUtils.exists(p)),
  );

  try {
    await IOUtils.copy(srcPath, dest, { noOverwrite: true });
  } catch (e) {
    releaseDownloadPathReservation(dest);
    ztoolkit.log("relocate: copy failed", e);
    return attachment;
  }
  releaseDownloadPathReservation(dest);

  try {
    await attachment.eraseTx();
  } catch (e) {
    ztoolkit.log("relocate: erase imported attachment failed", e);
    try {
      await IOUtils.remove(dest);
    } catch {
      /* best-effort */
    }
    return attachment;
  }

  try {
    const asLink = getPref("pdf.localAsLink") !== false;
    const method = asLink ? "linkFromFile" : "importFromFile";
    const linked = await (Zotero.Attachments as any)[method]({
      file: dest,
      libraryID: item.libraryID,
      parentItemID: item.id,
      title: getString("pdf-attachment-title"),
      contentType: "application/pdf",
    });
    if (linked) {
      await registerDownloadedFile(dest);
      return linked as Zotero.Item;
    }
  } catch (e) {
    ztoolkit.log("relocate: re-attach failed", e);
  }
  return null;
}

export function getDOI(item: Zotero.Item): string {
  let doi = (item.getField("DOI") as string) || "";
  if (!doi) {
    const extra = (item.getField("extra") as string) || "";
    const m = extra.match(/^\s*DOI:\s*(\S+)/im);
    if (m) doi = m[1];
  }
  return normalizeDOI(doi);
}

// --------------------------------------------------------------------------
// Metadata check: fill in a missing DOI from Crossref before downloading
// --------------------------------------------------------------------------

export async function ensureDOI(item: Zotero.Item): Promise<string> {
  await normalizeItemIdentifiers(item);
  const existing = getDOI(item);
  if (existing) return existing;
  if (!getPref("pdf.metadataCheck")) return "";

  const title = (item.getField("title") as string) || "";
  if (!title) return "";

  try {
    const author = (item.getField("firstCreator") as string) || "";
    const q = encodeURIComponent(`${title} ${author}`.trim());
    const url = `https://api.crossref.org/works?query.bibliographic=${q}&rows=1`;
    const xhr = await httpGet(url, "text");
    const data = JSON.parse(xhr.responseText);
    const found = data?.message?.items?.[0];
    const foundDOI: string = normalizeDOI(found?.DOI || "");
    const foundTitle: string = found?.title?.[0] || "";
    if (foundDOI && titleSimilar(title, foundTitle)) {
      try {
        item.setField("DOI", foundDOI);
        await item.saveTx();
      } catch (e) {
        ztoolkit.log("Could not persist DOI", e);
      }
      return foundDOI;
    }
  } catch (e) {
    ztoolkit.log("Crossref lookup failed", e);
  }
  return "";
}

// --------------------------------------------------------------------------
// Sources
// --------------------------------------------------------------------------

/**
 * Local folders — check the on-disk (multi-root, persistent) index before
 * downloading. The folder scanning/caching lives in folderIndex.ts.
 */
export class LocalFolderSource implements PDFSource {
  id = "local";

  isEnabled() {
    return !!getPref("pdf.localEnabled") && getWatchRoots().length > 0;
  }
  supportsItem() {
    return true;
  }

  async tryAttach(item: Zotero.Item) {
    const index = await buildIndex();
    if (!index.length) return null;
    const result = this.matchItem(item, index);
    if (result.status !== "matched") return null;
    return this.attachFile(item, result.file);
  }

  async attachFile(item: Zotero.Item, match: IndexedFile) {
    const asLink = !!getPref("pdf.localAsLink");
    const method = asLink ? "linkFromFile" : "importFromFile";
    try {
      return await (Zotero.Attachments as any)[method]({
        file: match.path,
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: getString("pdf-attachment-title"),
        contentType: "application/pdf",
      });
    } catch (e) {
      ztoolkit.log("Local attach failed", e);
      return null;
    }
  }

  matchItem(item: Zotero.Item, index: IndexedFile[]): LocalMatchResult {
    const { autoAttach, review } = readMatchThresholds();

    // 1) Exact DOI — filename alnum or IndexedFile.doi (P2-1).
    const doi = getDOI(item)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    if (doi.length > 8) {
      const byDOI = index.filter((f) => {
        const field = (f.doi || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        return field === doi || f.alnum.includes(doi);
      });
      if (byDOI.length === 1) {
        return { status: "matched", file: byDOI[0], score: 1 };
      }
      if (byDOI.length > 1) {
        return { status: "ambiguous", score: 1 };
      }
    }

    // 1b) ISBN — IndexedFile.isbn or alnum (books).
    const isbn = String(item.getField("ISBN") || "")
      .replace(/[^0-9Xx]/g, "")
      .toUpperCase();
    if (isbn.length === 10 || isbn.length === 13) {
      const byISBN = index.filter((f) => {
        const field = (f.isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();
        return field === isbn || f.alnum.includes(isbn.toLowerCase());
      });
      if (byISBN.length === 1) {
        return { status: "matched", file: byISBN[0], score: 1 };
      }
      if (byISBN.length > 1) {
        return { status: "ambiguous", score: 1 };
      }
    }

    // 2) Title CONTAINMENT + author/year → 0–1 confidence, then thresholds.
    const rawTitle = (item.getField("title") as string) || "";
    const titleTokens = tokenize(rawTitle);
    if (!titleTokens.length) return { status: "none" };
    const titleTokensAll = normalizeSearchText(rawTitle)
      .split(/\s+/)
      .filter(Boolean);
    const surname = firstAuthorSurname(item);
    const year = itemYear(item);

    const scored = index
      .map((f) => {
        const words = new Set(f.norm.split(/\s+/).filter(Boolean));
        const hit =
          titleTokens.filter((t) => words.has(t)).length / titleTokens.length;
        const authorMatch =
          !!surname && surname.length > 2 && f.norm.includes(surname);
        const yearMatch = !!year && f.norm.includes(year);
        // 0–1 confidence: title containment dominates; author/year bonuses.
        let score = Math.min(
          1,
          hit + (authorMatch ? 0.15 : 0) + (yearMatch ? 0.1 : 0),
        );
        // Title from IndexedFile.pdfTitle can reinforce containment.
        if (f.pdfTitle) {
          const titleNorm = normalizeSearchText(f.pdfTitle);
          const titleWords = new Set(titleNorm.split(/\s+/).filter(Boolean));
          const titleHit =
            titleTokens.filter((t) => titleWords.has(t)).length /
            titleTokens.length;
          score = Math.min(
            1,
            Math.max(score, titleHit + (authorMatch ? 0.1 : 0)),
          );
        }
        const fine =
          titleTokensAll.filter((t) => words.has(t)).length /
          titleTokensAll.length;
        return { f, score, fine, hit, authorMatch };
      })
      .filter((s) => s.score >= review || s.hit >= 0.5)
      .sort((a, b) => b.score - a.score || b.fine - a.fine);

    if (!scored.length) return { status: "none" };
    if (
      scored[1] &&
      scored[0].score - scored[1].score < 0.15 &&
      scored[0].fine <= scored[1].fine
    ) {
      return {
        status: "ambiguous",
        score: scored[0].score,
      };
    }

    const best = scored[0];
    const decision = classifyMatchConfidence(best.score, autoAttach, review);
    if (decision === "attach") {
      return { status: "matched", file: best.f, score: best.score };
    }
    if (decision === "review") {
      return {
        status: "review",
        file: best.f,
        score: best.score,
        reason: `score ${best.score.toFixed(2)} below auto-attach ${autoAttach}`,
      };
    }
    return { status: "none" };
  }
}

// Online PDF sources live in pythonPdfSources.ts (oa_pdf_search over 8756).
// Class implementations above were removed; see imports at file top.

/** Registry of all known sources, keyed by id. */
export const ALL_SOURCES: Record<string, PDFSource> = {
  local: new LocalFolderSource(),
  doi: DOISource,
  arxiv: ArxivSource,
  pmc: PMCSource,
  s2: SemanticScholarSource,
  dergipark: DergiParkSource,
  scihub: SciHubSource,
  libgen: LibGenSource,
  yoktez: YokTezSource,
  proquest: ProQuestSource,
  proxy: new ProxySource(),
};
