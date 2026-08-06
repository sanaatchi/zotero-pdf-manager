// @ajan: cursor · @etiket: katman-2, pdf-sources, bridge-guard, ocr-haystack, content-validate, nosource-sync, pdf-candidate-split, mismatch-reason
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  buildIndex,
  getWatchRoots,
  IndexedFile,
  registerDownloadedFile,
} from "./folderIndex";
import {
  CoreSource,
  DergiParkSource,
  DOISource,
  InternetArchiveSource,
  LibGenSource,
  OpenAireSource,
  PMCSource,
  ProxySource,
  SciHubSource,
  YokTezSource,
  ZenodoSource,
} from "./pythonPdfSources";
// arxiv / s2 / proquest → not in ALL_SOURCES auto/manual download cascade
// (doi is download via Unpaywall; registered below).

import {
  buildOaDownloadBasename,
  oaPartialTempPath,
  releaseDownloadPathReservation,
  reserveUniqueDownloadPath,
  resolveOaDownloadsDir,
  sanitizeDownloadBasename,
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
import { resolveSubtitleEnrichment } from "./oaPdfBridge";
import {
  applyPdfMismatchTags,
  clearMismatchReasonExtra,
} from "./pdfAutomationTags";
import type { MismatchTagContext } from "./pdfAutomationTagGuard";

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
  | {
      status: "matched";
      file: IndexedFile;
      score: number;
      /** How the index row was chosen — unverifiable keep only for id matches. */
      via?: "doi" | "isbn" | "title";
    }
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
  opts: {
    onProgress?: (loaded: number, total: number) => void;
  } = {},
): Promise<any> {
  throwIfRunAborted();
  const signal = getActiveAbortSignal();
  const cancelRef: { fn: (() => void) | null } = { fn: null };
  const { reportDownloadProgress } = await import("../utils/downloadProgress");
  const request = (Zotero.HTTP as any).request("GET", url, {
    responseType,
    timeout: 60000,
    successCodes: false,
    cancellerReceiver: (cancel: () => void) => {
      cancelRef.fn = cancel;
    },
    requestObserver: (xhr: XMLHttpRequest) => {
      if (responseType !== "arraybuffer") return;
      try {
        xhr.addEventListener("progress", (ev: ProgressEvent) => {
          const loaded = Number(ev.loaded || 0);
          const total = ev.lengthComputable ? Number(ev.total || 0) : 0;
          reportDownloadProgress(loaded, total);
          opts.onProgress?.(loaded, total);
        });
      } catch {
        /* ignore */
      }
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

export async function fetchPdfBytes(
  url: string,
  opts: { onProgress?: (loaded: number, total: number) => void } = {},
): Promise<Uint8Array | null> {
  try {
    throwIfRunAborted();
    const xhr = await httpGet(url, "arraybuffer", opts);
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
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

/** OCR haystack: doubled dots / stray punctuation before title-token search. */
export function normalizeOcrHaystack(s: string): string {
  return normalizeSearchText(s)
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return normalizeSearchText(s)
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

/** Generic words ignored when judging distinctive title evidence in PDF text. */
const CONTENT_TITLE_STOP = new Set([
  "interview",
  "conversation",
  "research",
  "analysis",
  "study",
  "article",
  "review",
  "about",
  "with",
  "from",
  "into",
  "upon",
  "between",
  "that",
  "this",
  "uzerine",
  "hakkinda",
  "icinde",
  "arasinda",
  "through",
  "towards",
  "against",
]);

/**
 * Distinctive title tokens (≥7 chars, not stop) that must appear in PDF text
 * for an article "match" — prevents another Golub essay matching via name only.
 */
export function distinctiveTitleTokens(title: string): string[] {
  return tokenize(title).filter(
    (t) => t.length >= 7 && !CONTENT_TITLE_STOP.has(t),
  );
}

/** Title core before colon/dash — subtitle tokens need not appear in PDF body. */
function titleCoreForDistinctive(title: string): string {
  const raw = String(title || "").trim();
  if (!raw) return "";
  const head = raw.split(/\s*[:;–—|/]\s+|\s+-\s+/)[0]?.trim();
  return head || raw;
}

export function distinctiveTitleCoverage(
  title: string,
  rawText: string,
): number {
  const needAll = distinctiveTitleTokens(title);
  if (!needAll.length) return 1;
  const text = normalizeSearchText(rawText);
  if (!text) return 0;
  const hitAll = needAll.filter((t) => text.includes(t)).length;
  const coverageAll = hitAll / needAll.length;
  // Colon subtitles (YÖK tez: «… Sanat: Dönüşümler») often appear only on the
  // cover line, not in body text — do not fail when the shared core matches.
  const core = titleCoreForDistinctive(title);
  if (core && core !== title.trim()) {
    const needCore = distinctiveTitleTokens(core);
    if (needCore.length) {
      const hitCore = needCore.filter((t) => text.includes(t)).length;
      if (hitCore === needCore.length) {
        return Math.max(coverageAll, 1);
      }
    }
  }
  return coverageAll;
}

function titleSimilar(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (!inter) return false;
  // Jaccard — Crossref DOI fill must be high-confidence.
  return inter / new Set([...ta, ...tb]).size >= 0.75;
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

/** True when any listed creator surname appears in PDF text (not only first). */
function anyAuthorSurnameFound(item: Zotero.Item, rawText: string): boolean {
  const text = normalizeOcrHaystack(rawText);
  if (!text) return false;
  try {
    const creators = (item.getCreators() as any[]) || [];
    for (const c of creators.slice(0, 8)) {
      const sn = normalizeSearchText(
        String(c?.lastName || c?.name || ""),
      ).trim();
      if (sn.length > 2 && text.includes(sn)) return true;
    }
  } catch {
    return false;
  }
  return false;
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
  const text = normalizeOcrHaystack(rawText);
  if (!text) return 0;
  let score = 0;

  const tokens = tokenize((item.getField("title") as string) || "");
  let titleHit = 0;
  if (tokens.length) {
    titleHit = tokens.filter((t) => text.includes(t)).length / tokens.length;
    score += titleHit;
  }
  const surname = firstAuthorSurname(item);
  if (surname && text.includes(surname)) score += 0.5;
  const year = itemYear(item);
  // Year alone is noisy (bibliographies); only credit with some title evidence.
  if (year && text.includes(year) && titleHit >= 0.25) score += 0.3;
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
 * - mismatch: extractable text conflicts — **keep** attachment; tag
 *   `#pdf-mismatch` + `#pdf-review` (never auto-detach / erase)
 * - unverifiable: too little extractable text / PDFWorker failure — **keep**
 *   attachment and tag `#pdf-review`
 * - skipped: validation pref off
 *
 * Books: ISBN/DOI conflict → mismatch. Strong title/score or ISBN match → keep.
 * Manual content-audit menu tags already-linked wrong files (no detach).
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
  /**
   * 0–1 share of distinctive title tokens (≥7, not stop) found in PDF.
   * Articles require 1.0 so a different Golub paper cannot match on name alone.
   */
  distinctiveCoverage?: number;
}): ContentValidation {
  if (input.textChars < 50) return "unverifiable";
  if (input.hasIdConflict) return "mismatch";
  if (input.hasIdMatch) return "match";
  // Books: missing author alone used to force mismatch and erase *correct*
  // scans (surname OCR miss / translator listed first). Only kill when title
  // evidence in the PDF is also weak — strong titleHit+score keeps the file.
  if (input.kind === "book" && input.authorExpected && !input.authorFound) {
    const strongTitle = input.titleHit >= 0.65 && input.score >= 0.55;
    if (!strongTitle) {
      return "mismatch";
    }
  }
  if (input.score >= 0.6) {
    if (input.kind !== "book" && (input.distinctiveCoverage ?? 1) < 1) {
      return "mismatch";
    }
    return "match";
  }

  if (input.kind === "book") {
    // Solid title evidence → keep; otherwise erase wrong catalogs/books.
    if (input.titleHit >= 0.5 && input.score >= 0.45) return "match";
    return "mismatch";
  }

  // Articles / other: require full distinctive-token coverage + title evidence.
  if ((input.distinctiveCoverage ?? 1) < 1) return "mismatch";
  if (input.score >= 0.45 && input.titleHit >= 0.5) return "match";
  return "mismatch";
}

/**
 * Human-readable why content validation chose match/mismatch/unverifiable.
 * Surfaced on Extra (`ZPDF-Mismatch-Reason:`) + automation audit detail.
 */
export function formatContentValidationReason(input: {
  verdict: ContentValidation;
  kind: "book" | "other";
  textChars: number;
  titleHit: number;
  score: number;
  hasIdConflict: boolean;
  hasIdMatch: boolean;
  authorExpected: boolean;
  authorFound: boolean;
  distinctiveCoverage?: number;
  bridgeVia?: string;
  bridgeReason?: string;
  bridgeForcedMismatch?: boolean;
}): string {
  const stats = `titleHit=${input.titleHit.toFixed(2)} score=${input.score.toFixed(2)} author=${
    input.authorFound ? "yes" : "no"
  }`;
  if (input.verdict === "unverifiable") {
    return input.textChars < 50
      ? `unverifiable: too little PDF text (${input.textChars} chars)`
      : `unverifiable: ${stats}`;
  }
  if (input.verdict === "skipped") return "validation skipped (pref off)";
  if (input.verdict === "match") {
    if (input.hasIdMatch) return `match: ISBN/DOI found in PDF | ${stats}`;
    return `match: ${stats}`;
  }
  // mismatch
  if (
    input.bridgeForcedMismatch &&
    (input.bridgeReason || input.bridgeVia)
  ) {
    const via = input.bridgeVia || "bridge";
    const why = String(input.bridgeReason || "mismatch")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    return `bridge(${via}): ${why} | ${stats}`;
  }
  if (input.hasIdConflict) {
    return `ISBN/DOI conflict in PDF | ${stats}`;
  }
  if (input.kind === "book" && input.authorExpected && !input.authorFound) {
    const strongTitle = input.titleHit >= 0.65 && input.score >= 0.55;
    if (!strongTitle) {
      return `book: author missing and title evidence weak | ${stats}`;
    }
  }
  if (input.kind !== "book" && (input.distinctiveCoverage ?? 1) < 1) {
    return `article: incomplete distinctive title tokens (${(
      input.distinctiveCoverage ?? 0
    ).toFixed(2)}) | ${stats}`;
  }
  if (input.kind === "book") {
    return `book: title/score below match threshold | ${stats}`;
  }
  return `title/score below match threshold | ${stats}`;
}

/** Bridge/LLM must not downgrade a strong local book match (OCR-noisy PDFs). */
export function isStrongHeuristicContentMatch(input: {
  titleHit: number;
  score: number;
  authorFound: boolean;
  hasIdMatch: boolean;
}): boolean {
  if (input.hasIdMatch) return true;
  if (input.titleHit >= 0.5 && input.authorFound && input.score >= 0.45) {
    return true;
  }
  if (input.titleHit >= 0.65 && input.score >= 0.55) return true;
  return false;
}

/** Skip bridge when local heuristic already proves title+author in PDF. */
export function shouldSkipBridgeContentValidation(input: {
  heuristic: ContentValidation;
  titleHit: number;
  authorFound: boolean;
  hasIdMatch: boolean;
}): boolean {
  if (input.heuristic !== "match") return false;
  if (input.hasIdMatch) return true;
  return input.titleHit >= 0.5 && input.authorFound;
}

export function titleTokenHit(item: Zotero.Item, rawText: string): number {
  const text = normalizeOcrHaystack(rawText);
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

/** Zotero may store tags with or without leading `#` in getTags(). */
function tagKey(tag: string): string {
  return String(tag || "")
    .replace(/^#/, "")
    .toLowerCase();
}

function listTagNames(item: Zotero.Item): string[] {
  const raw = (item.getTags?.() as unknown[]) || [];
  return raw
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : String((entry as { tag?: string })?.tag ?? ""),
    )
    .filter(Boolean);
}

/** Exact tag string as stored on the item (for removeTag), or null. */
function resolveTagOnItem(item: Zotero.Item, tag: string): string | null {
  const want = tagKey(tag);
  if (typeof item.hasTag === "function") {
    if (item.hasTag(tag)) return tag;
    const alt = tag.startsWith("#") ? tag.slice(1) : `#${tag}`;
    if (item.hasTag(alt)) return alt;
  }
  for (const name of listTagNames(item)) {
    if (tagKey(name) === want) return name;
  }
  return null;
}

async function tagItem(item: Zotero.Item, tag: string): Promise<void> {
  try {
    if (resolveTagOnItem(item, tag)) return;
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
    const resolved = resolveTagOnItem(item, tag);
    if (!resolved) return;
    item.removeTag(resolved);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("removeAutomationTag failed", tag, e);
  }
}

/** Tags cleared after content match / manual recovery (automationAudit parity). */
export const PDF_AUTOMATION_CLEAR_ON_MATCH = [
  "#pdf-review",
  "#pdf-quarantine",
  "#pdf-mismatch",
  "#pdf-candidate",
] as const;

/** Remove `#pdf-mismatch` / `#pdf-review` / `#pdf-quarantine` / `#pdf-candidate` after a good attach. */
export async function clearSuccessfulMatchTags(
  item: Zotero.Item,
): Promise<void> {
  try {
    await (item as any).loadAllData?.();
    let changed = false;
    for (const tag of PDF_AUTOMATION_CLEAR_ON_MATCH) {
      const resolved = resolveTagOnItem(item, tag);
      if (!resolved) continue;
      item.removeTag(resolved);
      changed = true;
    }
    if (changed) await item.saveTx();
    await clearMismatchReasonExtra(item);
  } catch (e) {
    ztoolkit.log("clearSuccessfulMatchTags failed", e);
  }
}

/** @internal — unit tests (hash / getTags parity) */
export function resolveAutomationTagOnItem(
  item: Zotero.Item,
  tag: string,
): string | null {
  return resolveTagOnItem(item, tag);
}

export async function validateAttachmentContent(
  item: Zotero.Item,
  attachmentID: number,
  opts: { force?: boolean } = {},
): Promise<ContentValidation> {
  const detailed = await validateAttachmentContentDetailed(
    item,
    attachmentID,
    opts,
  );
  return detailed.verdict;
}

export async function validateAttachmentContentDetailed(
  item: Zotero.Item,
  attachmentID: number,
  opts: { force?: boolean; hitTitle?: string } = {},
): Promise<{
  verdict: ContentValidation;
  pdfText: string;
  enrichedTitle?: string;
  reason?: string;
}> {
  // Manual content-audit menus pass force=true so prefs off still scan.
  if (!opts.force && !getPref("pdf.validateContent")) {
    return {
      verdict: "skipped",
      pdfText: "",
      reason: "validation skipped (pref off)",
    };
  }
  // A validated attachmentID is by contract a real, existing attachment —
  // #nosource must be false here regardless of caller (download, local
  // finalize, or the manual "Validate attached PDF content" menu).
  await removeAutomationTag(item, "#nosource");
  try {
    // Theses are long-form like books — not article-style distinctive kill.
    const book = isBook(item) || isThesis(item);
    const pageLimit = book ? 20 : 5;
    const res = await (Zotero as any).PDFWorker.getFullText(
      attachmentID,
      pageLimit,
    );
    const text: string = res?.text || "";
    const textChars = text.replace(/\s/g, "").length;

    // Subtitle-only gap → enrich künye title, treat as match, clear mismatch tag.
    const itemTitle = String(item.getField("title") || "");
    let fallbackTitle = String(opts.hitTitle || "").trim();
    if (!fallbackTitle) {
      try {
        const att = await Zotero.Items.getAsync(attachmentID);
        const path = String(
          (att as any)?.getFilePath?.() ||
            (att as any)?.attachmentFilename ||
            "",
        );
        const base = path.split(/[/\\]/).pop() || "";
        fallbackTitle = base
          .replace(/\.pdf$/i, "")
          .replace(/[_]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        /* ignore */
      }
    }
    const authorOk = firstAuthorSurname(item).length > 2;
    const enriched = resolveSubtitleEnrichment(itemTitle, {
      pdfText: text,
      fallbackTitle,
      authorOk,
    });
    if (enriched) {
      try {
        item.setField("title", enriched);
        await item.saveTx();
      } catch (e) {
        ztoolkit.log("subtitle enrichment save failed", e);
      }
      await clearSuccessfulMatchTags(item);
      ztoolkit.log(
        `Subtitle enrichment for ${item.id}: "${itemTitle}" → "${enriched}"`,
      );
      return {
        verdict: "match",
        pdfText: text,
        enrichedTitle: enriched,
        reason: `match: subtitle enrichment → "${enriched}"`,
      };
    }

    const structured = compareItemAgainstText(item, text);
    const surname = firstAuthorSurname(item);
    const authorFound = anyAuthorSurnameFound(item, text);
    const titleHit = titleTokenHit(item, text);
    const score = scoreText(item, text);
    const hasIdMatch = hasIdentifierMatch(structured);
    const hasIdConflict = hasIdentifierConflict(structured);
    const distinctiveCoverage = distinctiveTitleCoverage(
      String(item.getField("title") || ""),
      text,
    );
    const kind = book ? "book" : "other";
    const authorExpected = surname.length > 2 || authorFound;

    let heuristic = decideContentValidation({
      kind,
      textChars,
      titleHit,
      score,
      hasIdConflict,
      hasIdMatch,
      authorExpected,
      authorFound,
      distinctiveCoverage,
    });

    const strongHeuristicMatch = isStrongHeuristicContentMatch({
      titleHit,
      score,
      authorFound,
      hasIdMatch,
    });

    let bridgeVia = "";
    let bridgeReason = "";
    let bridgeForcedMismatch = false;

    // Local LLM (Ollama via 8756 bridge) when enabled and text is usable.
    if (
      getPref("pdf.validateContentLlm") !== false &&
      textChars >= 50 &&
      heuristic !== "skipped" &&
      !shouldSkipBridgeContentValidation({
        heuristic,
        titleHit,
        authorFound,
        hasIdMatch,
      })
    ) {
      try {
        const { validateContentViaBridge } = await import("./oaPdfBridge");
        const llm = await validateContentViaBridge({
          title: String(item.getField("title") || ""),
          creators: ((item.getCreators() as any[]) || [])
            .slice(0, 6)
            .map((c) =>
              `${c.firstName || ""} ${c.lastName || c.name || ""}`.trim(),
            )
            .filter(Boolean)
            .join("; "),
          year: itemYear(item),
          doi: getDOI(item),
          isbn: String(item.getField("ISBN") || "").replace(/[^0-9Xx]/g, ""),
          itemType: itemType(item),
          pdfText: normalizeOcrHaystack(text).slice(0, 8000),
        });
        // Bridge may also propose subtitle enrichment (Python parity).
        const bridgeEnriched = String(
          (llm as any)?.enriched_title || (llm as any)?.enrichedTitle || "",
        ).trim();
        if (bridgeEnriched && llm?.verdict === "match") {
          try {
            item.setField("title", bridgeEnriched);
            await item.saveTx();
          } catch (e) {
            ztoolkit.log("bridge subtitle enrichment save failed", e);
          }
          await clearSuccessfulMatchTags(item);
          return {
            verdict: "match",
            pdfText: text,
            enrichedTitle: bridgeEnriched,
            reason: `match: bridge subtitle enrichment → "${bridgeEnriched}"`,
          };
        }
        // Fail-closed for upgrading mismatch→match. Do NOT let bridge/LLM erase a
        // strong heuristic match (false "mismatch" → #pdf-mismatch loop).
        const via = String(llm?.via || "");
        if (llm?.verdict === "mismatch" && !strongHeuristicMatch) {
          heuristic = "mismatch";
          bridgeForcedMismatch = true;
          bridgeVia = via;
          bridgeReason = String(llm.reason || "");
          ztoolkit.log(
            `Bridge content validation → mismatch (${via || "bridge"})`,
            llm.reason || "",
          );
        } else if (llm?.verdict === "mismatch" && strongHeuristicMatch) {
          ztoolkit.log(
            "Bridge said mismatch but strong heuristic match — keeping PDF",
            via ? `${via}: ` : "",
            llm.reason || "",
          );
        } else if (llm?.verdict === "match" && heuristic !== "mismatch") {
          heuristic = "match";
          bridgeVia = via;
          bridgeReason = String(llm.reason || "");
          ztoolkit.log(
            `Bridge content validation → match (${via || "bridge"})`,
            llm.reason || "",
          );
        } else if (llm?.verdict === "unverifiable" && heuristic === "match") {
          // Soft: don't erase a heuristic match solely from LLM doubt
        } else if (llm?.verdict === "unverifiable") {
          heuristic = "unverifiable";
          bridgeVia = via;
          bridgeReason = String(llm.reason || "");
        } else if (llm?.verdict === "match" && heuristic === "mismatch") {
          ztoolkit.log(
            "Bridge said match but heuristic mismatch — keeping mismatch",
            llm.reason || "",
          );
        }
      } catch (e) {
        ztoolkit.log(
          "Bridge content validation unavailable; heuristic only",
          e,
        );
      }
    } else if (
      getPref("pdf.validateContentLlm") !== false &&
      heuristic === "match" &&
      shouldSkipBridgeContentValidation({
        heuristic,
        titleHit,
        authorFound,
        hasIdMatch,
      })
    ) {
      ztoolkit.log(
        "Skipping bridge content validation — strong local title+author match",
      );
    }

    const reason = formatContentValidationReason({
      verdict: heuristic,
      kind,
      textChars,
      titleHit,
      score,
      hasIdConflict,
      hasIdMatch,
      authorExpected,
      authorFound,
      distinctiveCoverage,
      bridgeVia,
      bridgeReason,
      bridgeForcedMismatch,
    });

    if (heuristic === "match") {
      await clearSuccessfulMatchTags(item);
    }
    return { verdict: heuristic, pdfText: text, reason };
  } catch (e) {
    ztoolkit.log("content validation error", e);
    return {
      verdict: "unverifiable",
      pdfText: "",
      reason: `unverifiable: PDF text extract failed (${String((e as Error)?.message || e).slice(0, 120)})`,
    };
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

/**
 * After a successful attach: clear mismatch/review when content matched, or
 * when validation was skipped but the local hit was DOI/ISBN-exact.
 * Title-only + skipped keeps existing tags (content not proven).
 */
export function shouldClearMatchTags(
  verdict: ContentValidation,
  via: "doi" | "isbn" | "title" = "title",
): boolean {
  if (verdict === "match") return true;
  if (verdict === "skipped" && (via === "doi" || via === "isbn")) return true;
  return false;
}

/**
 * Menu registers rename+move (destDir / autoMove) so local path-link success
 * relocates to the library destination without a menu↔pdfSources import cycle.
 * Mismatch / unverifiable paths must not register a relocate.
 */
type MatchedAttachmentRelocateFn = (
  attachment: Zotero.Item,
) => Promise<Zotero.Item | undefined | void>;

let matchedAttachmentRelocate: MatchedAttachmentRelocateFn | null = null;

export function registerMatchedAttachmentRelocate(
  fn: MatchedAttachmentRelocateFn | null,
): void {
  matchedAttachmentRelocate = fn;
}

/** @internal — tests */
export function __getMatchedAttachmentRelocateForTests(): MatchedAttachmentRelocateFn | null {
  return matchedAttachmentRelocate;
}

async function relocateAfterSuccessfulMatch(
  attachment: Zotero.Item,
): Promise<Zotero.Item> {
  if (!matchedAttachmentRelocate) return attachment;
  try {
    const next = await matchedAttachmentRelocate(attachment);
    return next || attachment;
  } catch (e) {
    ztoolkit.log("post-match rename/move failed", e);
    return attachment;
  }
}

/**
 * Detach rejected PDF from the Zotero item (erase attachment / link only).
 * Keep the on-disk PDF and rename it so orphan import can recreate a source
 * from labelled filename metadata (title=/author=/year=).
 * Storage (imported) attachments are copied into downloads/ before erase so
 * the bytes are never lost with Zotero's storage file.
 */
export async function cleanupRejectedAttachment(opts: {
  attachment: Zotero.Item;
  persistedPath?: string | null;
  finalCreatedByThisRun: boolean | null;
  /** PDF text used to build an orphan-ready filename. */
  pdfText?: string;
}): Promise<"cleaned" | "erase-failed"> {
  let diskPath =
    (opts.persistedPath || "").trim() ||
    ((await opts.attachment.getFilePathAsync?.()) as string) ||
    "";

  // Imported/storage attach: rescue a copy under downloads/ before eraseTx
  // deletes Zotero's storage blob.
  if (diskPath && !opts.persistedPath) {
    try {
      const roots = getWatchRoots();
      const dir = resolveOaDownloadsDir(roots);
      if (dir && (await IOUtils.exists(diskPath))) {
        await IOUtils.makeDirectory(dir, {
          createAncestors: true,
          ignoreExisting: true,
        });
        const stem = sanitizeDownloadBasename(
          (PathUtils.split(diskPath).pop() as string)?.replace(/\.pdf$/i, "") ||
            `rejected-item-${opts.attachment.id || "x"}`,
        );
        const dest = await reserveUniqueDownloadPath(
          dir,
          `${stem}-rejected`,
          async (p) => !!(await IOUtils.exists(p)),
        );
        try {
          await IOUtils.copy(diskPath, dest);
          diskPath = dest;
          releaseDownloadPathReservation(dest);
        } catch (e) {
          releaseDownloadPathReservation(dest);
          ztoolkit.log("rejected storage PDF rescue copy failed", e);
        }
      }
    } catch (e) {
      ztoolkit.log("rejected storage PDF rescue skipped", e);
    }
  }

  if (diskPath && (opts.pdfText || "").trim()) {
    try {
      const { renameRejectedPdfOnDisk } = await import("./rejectedPdfRename");
      const { registerDownloadedFile } = await import("./folderIndex");
      diskPath = await renameRejectedPdfOnDisk(diskPath, opts.pdfText || "");
      if (diskPath) {
        try {
          await registerDownloadedFile(diskPath);
        } catch {
          /* index best-effort */
        }
      }
    } catch (e) {
      ztoolkit.log("rejected PDF rename failed", e);
    }
  }

  try {
    await opts.attachment.eraseTx();
  } catch (e) {
    ztoolkit.log("erase rejected/unverifiable attachment failed", e);
    return "erase-failed";
  }
  // Never IOUtils.remove the PDF — file stays for orphan / manual re-import.
  void opts.finalCreatedByThisRun;
  return "cleaned";
}

/** True when Zotero can resolve the attachment to an on-disk file. */
export async function attachmentFileAccessible(
  attachment: Zotero.Item,
): Promise<boolean> {
  try {
    return !!(await (attachment as any).fileExists?.());
  } catch {
    return false;
  }
}

/**
 * Remove sibling PDF attachments whose files are missing (dimmed/ghost icons).
 * Keeps `keepAttachmentID` and any missing-file attachment that still has
 * annotations/notes (user data). Content-mismatch PDFs with real files are
 * never touched — only non-functional stubs.
 */
export async function purgeMissingSiblingPdfAttachments(
  item: Zotero.Item,
  keepAttachmentID?: number | null,
): Promise<number> {
  let purged = 0;
  for (const attachmentID of item.getAttachments()) {
    if (keepAttachmentID && attachmentID === keepAttachmentID) continue;
    const att = Zotero.Items.get(attachmentID) as Zotero.Item | undefined;
    if (!att) continue;
    try {
      const isPdf =
        (att as any).isPDFAttachment?.() ||
        att.attachmentContentType === "application/pdf";
      if (!isPdf) continue;
      if (await attachmentFileAccessible(att)) continue;
      const hasUserData =
        ((att as any).getAnnotations?.(false) || []).length > 0 ||
        ((att as any).getNotes?.(false) || []).length > 0;
      if (hasUserData) continue;
      await att.eraseTx();
      purged++;
    } catch (e) {
      ztoolkit.log("purge missing sibling PDF failed", attachmentID, e);
    }
  }
  return purged;
}

/**
 * Find an existing PDF attachment on `item` that already links to `filePath`
 * and whose file is actually accessible. Ghost/dimmed links (path stored but
 * file missing) are skipped so callers create a fresh working link instead of
 * "succeeding" with a non-functional stub.
 */
export async function findParentLinkedPdfByPath(
  item: Zotero.Item,
  filePath: string,
): Promise<Zotero.Item | null> {
  const want = PathUtils.normalize(String(filePath || ""));
  if (!want) return null;
  const wantKey = want.replace(/\\/g, "/").toLowerCase();
  for (const attachmentID of item.getAttachments()) {
    const att = Zotero.Items.get(attachmentID) as Zotero.Item | undefined;
    if (!att) continue;
    try {
      if (!(att as any).isPDFAttachment?.() && !(att as any).isAttachment?.()) {
        continue;
      }
      const p =
        (await (att as any).getFilePathAsync?.()) ||
        (att as any).getFilePath?.() ||
        "";
      if (!p) continue;
      const got = PathUtils.normalize(String(p))
        .replace(/\\/g, "/")
        .toLowerCase();
      if (got !== wantKey) continue;
      // Path match alone is not enough — OneDrive placeholders / broken
      // linked_file rows still report a path while fileExists() is false.
      if (!(await attachmentFileAccessible(att))) continue;
      return att;
    } catch {
      /* ignore */
    }
  }
  return null;
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
  opts: {
    validate?: boolean;
    sourceId?: string;
    forceImport?: boolean;
    /** Pre-fetched PDF bytes (e.g. YÖK via bridge session). */
    bytes?: Uint8Array | null;
    onProgress?: (loaded: number, total: number) => void;
    mismatchTagSource?: string;
    mismatchTagRun?: string;
  } = {},
): Promise<unknown | null> {
  throwIfRunAborted();
  const bytes =
    opts.bytes && opts.bytes.length
      ? looksLikePDF(opts.bytes)
        ? opts.bytes
        : null
      : await fetchPdfBytes(url, { onProgress: opts.onProgress });
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
        Date.now(),
        { reuseExisting: true },
      );
      const partial = oaPartialTempPath(persistedPath);
      try {
        await IOUtils.write(partial, bytes);
        // Never unlink the primary path before the new bytes are in place —
        // linked attachments point at that path; remove-then-move made the
        // PDF "disappear" from Zotero mid-download / on retry.
        if (await IOUtils.exists(persistedPath)) {
          try {
            await IOUtils.write(persistedPath, bytes);
            try {
              await IOUtils.remove(partial);
            } catch {
              /* best-effort */
            }
            finalCreatedByThisRun = true;
          } catch (writeErr) {
            // File locked (open in reader) — never spawn stem-<ts>.pdf twin.
            // Keep the existing disk file and re-link / reuse it below.
            ztoolkit.log(
              "OA in-place overwrite failed; reuse existing path (no copy)",
              writeErr,
            );
            try {
              await IOUtils.remove(partial);
            } catch {
              /* best-effort */
            }
            finalCreatedByThisRun = false;
          }
        } else {
          await IOUtils.move(partial, persistedPath, { noOverwrite: true });
          finalCreatedByThisRun = true;
        }
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
      // Reuse an existing link to the same path (retry / same-item download).
      const existingLinked = await findParentLinkedPdfByPath(
        item,
        persistedPath,
      );
      if (existingLinked) {
        attachment = existingLinked;
      } else {
        // Watch-root OA files: always link — importFromFile would copy into storage.
        attachment = await (Zotero.Attachments as any).linkFromFile({
          file: persistedPath,
          libraryID: item.libraryID,
          parentItemID: item.id,
          title: getString("pdf-attachment-title"),
          contentType: "application/pdf",
        });
        if (
          attachment &&
          !(await attachmentFileAccessible(attachment as Zotero.Item))
        ) {
          ztoolkit.log(
            "downloadAndAttach: linked attachment inaccessible; removing stub",
            persistedPath,
          );
          try {
            await (attachment as Zotero.Item).eraseTx();
          } catch (e) {
            ztoolkit.log(
              "downloadAndAttach: erase inaccessible stub failed",
              e,
            );
          }
          attachment = null;
        }
      }
      if (attachment) {
        await registerDownloadedFile(persistedPath);
        await purgeMissingSiblingPdfAttachments(
          item,
          (attachment as Zotero.Item).id,
        );
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
    // Keep downloads/ file even if attach failed — never auto-delete disk PDFs.
    return null;
  }
  // A file attachment now exists, whatever the content verdict turns out to
  // be below — #nosource must clear here, not wait for the next manual
  // "Scan library" run (see attachmentScanner.ts's own `!hasFile` branch,
  // the mirror of this for the opposite direction).
  await removeAutomationTag(item, "#nosource");

  if (opts.validate !== false) {
    const { verdict, pdfText, reason } =
      await validateAttachmentContentDetailed(item, attachment.id);
    if (verdict === "match" || verdict === "skipped") {
      await clearSuccessfulMatchTags(item);
      return attachment;
    }
    // Scanned / image-only / PDFWorker failure: keep the downloaded PDF.
    if (verdict === "unverifiable") {
      ztoolkit.log(
        `PDF content unverifiable for ${item.id} — keeping attachment (#pdf-review)`,
        reason || "",
      );
      await tagItem(item, "#pdf-review");
      return attachment;
    }
    // mismatch: keep attachment; tag for review (no auto erase/detach).
    ztoolkit.log(
      `PDF content mismatch for ${item.id} — keeping attachment (#pdf-mismatch)`,
      reason || "",
    );
    const mismatchSource =
      opts.mismatchTagSource ||
      (opts.sourceId ? `download-${opts.sourceId}` : "download-attach");
    await applyPdfMismatchTags(
      item,
      {
        source: mismatchSource,
        run: opts.mismatchTagRun,
        reason,
      },
      tagItem,
    );
    void pdfText;
    void persistedPath;
    void finalCreatedByThisRun;
    return attachment;
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
    Date.now(),
    { reuseExisting: true },
  );

  try {
    if (!(await IOUtils.exists(dest))) {
      await IOUtils.copy(srcPath, dest, { noOverwrite: true });
    }
    // dest already present → reuse; never remove+re-copy (second disk twin).
  } catch (e) {
    releaseDownloadPathReservation(dest);
    ztoolkit.log("relocate: copy failed", e);
    return attachment;
  }
  releaseDownloadPathReservation(dest);

  // Always link (or reuse) BEFORE erasing the imported storage copy.
  // Erase-then-link left parents with a missing-file / dimmed stub when
  // linkFromFile failed after the storage blob was already gone.
  if (!(await IOUtils.exists(dest))) {
    ztoolkit.log("relocate: dest missing after copy; keep imported", dest);
    return attachment;
  }

  const already = await findParentLinkedPdfByPath(item, dest);
  if (already) {
    try {
      if (already.id !== attachment.id) await attachment.eraseTx();
    } catch (e) {
      ztoolkit.log("relocate: erase imported (already linked) failed", e);
    }
    await registerDownloadedFile(dest);
    await purgeMissingSiblingPdfAttachments(item, already.id);
    return already;
  }

  let linked: Zotero.Item | null = null;
  try {
    linked = (await (Zotero.Attachments as any).linkFromFile({
      file: dest,
      libraryID: item.libraryID,
      parentItemID: item.id,
      title: getString("pdf-attachment-title"),
      contentType: "application/pdf",
    })) as Zotero.Item | null;
  } catch (e) {
    ztoolkit.log("relocate: re-attach failed; keeping imported", e);
    return attachment;
  }

  if (!linked || !(await attachmentFileAccessible(linked))) {
    if (linked) {
      try {
        await linked.eraseTx();
      } catch (e) {
        ztoolkit.log("relocate: erase inaccessible linked stub failed", e);
      }
    }
    ztoolkit.log("relocate: linked attachment not accessible; keep imported");
    return attachment;
  }

  try {
    await attachment.eraseTx();
  } catch (e) {
    ztoolkit.log("relocate: erase imported after successful link failed", e);
  }
  await registerDownloadedFile(dest);
  await purgeMissingSiblingPdfAttachments(item, linked.id);
  return linked;
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
    const surname = firstAuthorSurname(item);
    const q = encodeURIComponent(`${title} ${author}`.trim());
    const url = `https://api.crossref.org/works?query.bibliographic=${q}&rows=3`;
    const xhr = await httpGet(url, "text");
    const data = JSON.parse(xhr.responseText);
    const items = (data?.message?.items || []) as any[];
    for (const found of items) {
      const foundDOI: string = normalizeDOI(found?.DOI || "");
      const foundTitle: string = found?.title?.[0] || "";
      if (!foundDOI || !titleSimilar(title, foundTitle)) continue;
      if (surname && surname.length > 2) {
        const authors = (found?.author || []) as {
          family?: string;
          name?: string;
        }[];
        const families = authors
          .map((a) => normalizeSearchText(a.family || a.name || ""))
          .filter(Boolean);
        if (families.length && !families.some((f) => f.includes(surname))) {
          continue;
        }
      }
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
    return this.attachFile(item, result.file, result.via || "title");
  }

  async attachFile(
    item: Zotero.Item,
    match: IndexedFile,
    via: "doi" | "isbn" | "title" = "title",
    tagCtx?: MismatchTagContext,
  ) {
    // Same disk file must never get a second attachment on this parent
    // (and never be import-copied into Zotero storage from the watch root).
    // findParentLinkedPdfByPath only returns accessible files — ghosts skipped.
    const existing = await findParentLinkedPdfByPath(item, match.path);
    if (existing) {
      return this.finalizeLocalAttachment(
        item,
        existing,
        match.path,
        via,
        tagCtx,
      );
    }
    try {
      // Refuse to create a dimmed link to a missing / online-only stub.
      if (!(await IOUtils.exists(match.path))) {
        ztoolkit.log("Local attach skipped: path missing", match.path);
        return null;
      }
      const attachment = await (Zotero.Attachments as any).linkFromFile({
        file: match.path,
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: getString("pdf-attachment-title"),
        contentType: "application/pdf",
      });
      if (!attachment) return null;
      if (!(await attachmentFileAccessible(attachment))) {
        ztoolkit.log(
          "Local attach created inaccessible link; removing stub",
          match.path,
        );
        try {
          await attachment.eraseTx();
        } catch (e) {
          ztoolkit.log("Local attach: erase inaccessible stub failed", e);
        }
        return null;
      }
      return this.finalizeLocalAttachment(
        item,
        attachment,
        match.path,
        via,
        tagCtx,
      );
    } catch (e) {
      rethrowAttachControlFlow(e);
      if (isContentMismatchError(e)) throw e;
      ztoolkit.log("Local attach failed", e);
      return null;
    }
  }

  /**
   * Filename match is not proof of content. Mismatch / unverifiable title:
   * keep the link and tag for review — auto-detach cancelled (no rename/move).
   * Match (or skipped + DOI/ISBN exact) clears `#pdf-mismatch` / `#pdf-review`
   * then rename+move into destDir (autoMove) via registered handler.
   */
  private async finalizeLocalAttachment(
    item: Zotero.Item,
    attachment: Zotero.Item,
    diskPath: string,
    via: "doi" | "isbn" | "title" = "title",
    tagCtx?: MismatchTagContext,
  ): Promise<Zotero.Item | null> {
    // `attachment` is already attached by the caller — #nosource must clear
    // now, independent of whatever content verdict follows below.
    await removeAutomationTag(item, "#nosource");
    // Pref off → validate returns "skipped"; still clear tags for DOI/ISBN.
    const detailed = await validateAttachmentContentDetailed(
      item,
      attachment.id,
    );
    if (shouldClearMatchTags(detailed.verdict, via)) {
      await clearSuccessfulMatchTags(item);
      await purgeMissingSiblingPdfAttachments(item, attachment.id);
      // Yerinde link alone left files under downloads/ or inbox names —
      // relocate to künye filename + configured library dest when prefs allow.
      return relocateAfterSuccessfulMatch(attachment);
    }
    if (detailed.verdict === "skipped") {
      // Title-only attach with validation disabled — leave existing tags.
      await purgeMissingSiblingPdfAttachments(item, attachment.id);
      return attachment;
    }
    if (detailed.verdict === "unverifiable") {
      ztoolkit.log(
        `Local PDF unverifiable for ${item.id} via=${via} — keeping (#pdf-review)`,
        diskPath,
      );
      await tagItem(item, "#pdf-review");
      await purgeMissingSiblingPdfAttachments(item, attachment.id);
      return attachment;
    }
    ztoolkit.log(
      `Local PDF mismatch for ${item.id} — keeping attachment (#pdf-mismatch)`,
      diskPath,
      detailed.reason || "",
    );
    const mismatchSource = tagCtx?.source || "local-finalize-passive";
    await applyPdfMismatchTags(
      item,
      {
        source: mismatchSource,
        run: tagCtx?.run,
        reason: detailed.reason || tagCtx?.reason,
      },
      tagItem,
    );
    // Keep the real (mismatch) file; only drop other missing-file ghosts.
    await purgeMissingSiblingPdfAttachments(item, attachment.id);
    return attachment;
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
        if (field && field === doi) return true;
        // Filename alnum: require full DOI token (avoid short substring collisions).
        if (doi.length < 12) return false;
        return (
          f.alnum.includes(doi) &&
          (f.alnum.includes(`doi${doi}`) ||
            f.alnum.startsWith(doi) ||
            f.alnum.endsWith(doi) ||
            new RegExp(`(?:^|[^a-z0-9])${doi}(?:$|[^a-z0-9])`).test(f.alnum))
        );
      });
      if (byDOI.length === 1) {
        return { status: "matched", file: byDOI[0], score: 1, via: "doi" };
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
        return { status: "matched", file: byISBN[0], score: 1, via: "isbn" };
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
        const distinctive = distinctiveTitleTokens(rawTitle);
        const distHit = distinctive.filter(
          (t) => words.has(t) || f.norm.includes(t),
        ).length;
        const distRatio = distinctive.length ? distHit / distinctive.length : 1;
        // <50% distinctive → reject (e.g. name-only Golub PDF).
        if (distRatio < 0.5) {
          return {
            f,
            score: 0,
            fine: 0,
            hit: 0,
            authorMatch: false,
            distRatio,
            skip: true,
          };
        }
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
        return {
          f,
          score,
          fine,
          hit,
          authorMatch,
          distRatio,
          skip: false,
        };
      })
      .filter((s) => !s.skip && (s.score >= review || s.hit >= 0.5))
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
    // Short titles ("Gece", "Sürgün"): containment alone matches many files —
    // require author token in the filename before auto-attach.
    const shortTitle = titleTokens.filter((t) => t.length >= 3).length <= 2;
    if (shortTitle && !best.authorMatch) {
      return {
        status: "review",
        file: best.f,
        score: best.score,
        reason: "short title without author match",
      };
    }
    let decision = classifyMatchConfidence(best.score, autoAttach, review);
    // Auto-attach only when every distinctive title token is present.
    if (decision === "attach" && (best.distRatio ?? 1) < 1) {
      decision = "review";
    }
    if (decision === "attach") {
      return {
        status: "matched",
        file: best.f,
        score: best.score,
        via: "title",
      };
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

/**
 * Download cascade registry.
 * Metadata-only leftovers: arxiv / s2 / proquest (not registered here).
 * doi = Unpaywall CAPTCHA-free OA download.
 */
export const ALL_SOURCES: Record<string, PDFSource> = {
  local: new LocalFolderSource(),
  doi: DOISource,
  pmc: PMCSource,
  dergipark: DergiParkSource,
  scihub: SciHubSource,
  libgen: LibGenSource,
  yoktez: YokTezSource,
  proxy: new ProxySource(),
  zenodo: ZenodoSource,
  archive: InternetArchiveSource,
  openaire: OpenAireSource,
  core: CoreSource,
};

/** Lookup / validate only — not PDF download cascade. */
export const METADATA_ONLY_SOURCE_IDS = ["arxiv", "s2", "proquest"] as const;
