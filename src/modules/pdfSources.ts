// @ajan: cursor · @etiket: katman-2, pdf-sources, bridge-guard, ocr-haystack, content-validate, nosource-sync, pdf-candidate-split, mismatch-reason, encoding-gate, re-ocr-validate, tr-i-fold, sentence-tr-override, author-line-gate, no-validate-subtitle-enrich, title-length-aware, isbn-conflict-soft, tr-pdf-encoding, medium-cov-soft, medium-author-noyear, field-weights-score, validated-pdf-lock, pdfkitap, dirzon, review-reason-coverage, zero-threshold-default, pathutils-safe
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { safePathKey } from "../utils/safePath";
import {
  CONTENT_SCORE,
  contentScoreKind,
  weightedKindScore,
} from "./fieldWeights";
import {
  buildIndex,
  getWatchRoots,
  IndexedFile,
  registerDownloadedFile,
} from "./folderIndex";
import {
  CoreSource,
  DergiParkSource,
  DirzonSource,
  DOISource,
  InternetArchiveSource,
  LibGenSource,
  OpenAireSource,
  PdfKitapSource,
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
import {
  applyPdfMismatchTags,
  clearMismatchReasonExtra,
} from "./pdfAutomationTags";
import type { MismatchTagContext } from "./pdfAutomationTagGuard";
import {
  clearValidatedPdfLock,
  lockValidatedAttachment,
  persistValidatedPdfLock,
} from "./pdfValidatedLock";

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

/** Clamp and order match thresholds (P2-2). Defaults: attach 0.85, review 0.60.
 * Stored `0` is treated as unset (floor-corruption from ensureNumberPref) — never
 * mass-attach with score≥0.
 */
export function normalizeMatchThresholds(
  autoAttach: unknown,
  review: unknown,
): { autoAttach: number; review: number } {
  const parse = (value: unknown, fallback: number) => {
    const n =
      typeof value === "number" ? value : Number.parseFloat(`${value ?? ""}`);
    if (!Number.isFinite(n)) return fallback;
    // Exact 0 with positive fallback = corrupted / unset (B2).
    if (n === 0 && fallback > 0) return fallback;
    if (n < 0 || n > 1) return fallback;
    return n;
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

/**
 * Repair common Turkish PDF encoding corruption before fold.
 * - Font-sub: Đ/Ġ for İ; ġ for ş
 * - CP1254 bytes misread as CP1252: Ý/ý/ð/Ð/þ/Þ → İ/ı/ğ/Ğ/ş/Ş
 * - C0 controls that punch holes in titles (N→\x0f in some DergiPark PDFs)
 */
export function repairTurkishPdfEncoding(s: string): string {
  return String(s || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\u0110/g, "İ") // Đ
    .replace(/\u0111/g, "i") // đ
    .replace(/\u0120/g, "İ") // Ġ
    .replace(/\u0121/g, "ş") // ġ
    .replace(/\u00dd/g, "İ") // Ý
    .replace(/\u00fd/g, "ı") // ý
    .replace(/\u00f0/g, "ğ") // ð
    .replace(/\u00d0/g, "Ğ") // Ð
    .replace(/\u00fe/g, "ş") // þ
    .replace(/\u00de/g, "Ş"); // Þ
}

export function normalizeSearchText(s: string): string {
  // NFKD+strip turns İ→I. Turkish locale then maps I→ı (dotless). Remap
  // ı/İ→i *after* locale lower so «İşlenen» and «işlenen» fold identically
  // (Python match_util._fold uses casefold I→i; same end state).
  // Hyphens glue (Resim-İş → resimis) so title tokens match PDF compounds.
  return repairTurkishPdfEncoding(s || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("tr")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .replace(/[\u2010-\u2015\u2212-]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

/** OCR haystack: doubled dots / stray punctuation before title-token search. */
export function normalizeOcrHaystack(s: string): string {
  return normalizeSearchText(s)
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Long extract that is mostly unreadable (CID / glyph-map mojibake).
 * Title-absence mismatch is unreliable when this is true (Afacan 2014 case).
 */
export function looksLikeGarbledPdfText(text: string): boolean {
  const sample = String(text || "").slice(0, 5000);
  if (sample.length < 120) return false;
  const nons = [...sample].filter((c) => !/\s/.test(c));
  if (nons.length < 80) return false;
  const ctrl = nons.filter((c) => c.charCodeAt(0) < 32).length;
  if (ctrl / nons.length >= 0.015) return true;
  const letters = nons.filter((c) => /\p{L}/u.test(c)).length;
  if (letters / nons.length < 0.42) return true;
  const words = sample.match(/[A-Za-zÀ-ÿÇĞİÖŞÜçğıöşüÂÎÛâîû]{3,}/g) || [];
  if (nons.length >= 400 && words.length < 18) return true;
  const dollars = (sample.match(/\$/g) || []).length;
  if (dollars >= 12 && letters / nons.length < 0.62) return true;
  return false;
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

/**
 * Word-count bands for title matching policy (titles are never rewritten).
 * Short extreme: 1 word («Gece», «Renk»). Long extreme: ≥21 words
 * (library also has a 41-word bilingual outlier — still long band).
 * Medium (4–20): legacy absolute distinctiveCoverage === 1.
 */
export const TITLE_LENGTH = {
  /** Inclusive upper bound for short band (1–3 words). */
  SHORT_MAX_WORDS: 3,
  /** Inclusive lower bound for long band (≥21 words). */
  LONG_MIN_WORDS: 21,
  /** Long titles: soft floor when authorFound or high titleHit. */
  LONG_COVERAGE_SOFT: 0.85,
  /** Long titles: titleHit floor for soft coverage without author. */
  LONG_TITLE_HIT_SOFT: 0.85,
  /** Medium articles: soft floor when author corroborates (OCR/encoding). */
  MEDIUM_COVERAGE_SOFT: 0.5,
  /** Medium bilingual: lower cov + titleHit when author (+ year|strong titleHit). */
  MEDIUM_BILINGUAL_COVERAGE_SOFT: 0.2,
  /** Medium bilingual: titleHit floor paired with bilingual coverage soft. */
  MEDIUM_BILINGUAL_TITLE_HIT_SOFT: 0.35,
  /**
   * Medium bilingual without year in PDF body: require stronger titleHit
   * (TR journal PDFs often omit the künye year in extracted text).
   */
  MEDIUM_NOYEAR_TITLE_HIT_SOFT: 0.5,
} as const;

export type TitleLengthBand = "short" | "medium" | "long";

/**
 * Whitespace-separated word count — anchors short=1 and long≥21.
 * Punctuation-only tokens are ignored; letters/digits keep the word.
 */
export function titleWordCount(title: string): number {
  return String(title || "")
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Classify title into short (1–3) / medium (4–20) / long (≥21) word bands. */
export function classifyTitleLength(title: string): TitleLengthBand {
  const words = titleWordCount(title);
  if (words >= TITLE_LENGTH.LONG_MIN_WORDS) return "long";
  if (words >= 1 && words <= TITLE_LENGTH.SHORT_MAX_WORDS) return "short";
  return "medium";
}

/**
 * Article distinctive-coverage gate — length-aware.
 * Medium: coverage 1.0, or soft when author + (cov≥0.5 with year |
 * bilingual band with year|strong titleHit).
 * Year optional only in the bilingual band (cov 0.2–0.5): TR journal bodies
 * often omit the künye year (Demir 2005). High coverage with a truly missing
 * distinctive stem still needs year — otherwise wrong-PDF soft-matches.
 * Long: coverage ≥ LONG_COVERAGE_SOFT + (authorFound | titleHit ≥ soft).
 * Short: coverage still 1.0 when distinctive tokens exist (corroboration
 * is a separate gate).
 */
export function articleDistinctiveCoverageOk(input: {
  titleLengthBand: TitleLengthBand;
  distinctiveCoverage: number;
  authorFound: boolean;
  titleHit: number;
  yearFound?: boolean;
}): boolean {
  const cov = input.distinctiveCoverage;
  if (cov >= 1) return true;
  if (input.titleLengthBand === "long") {
    if (cov < TITLE_LENGTH.LONG_COVERAGE_SOFT) return false;
    return (
      input.authorFound || input.titleHit >= TITLE_LENGTH.LONG_TITLE_HIT_SOFT
    );
  }
  if (input.titleLengthBand === "medium") {
    if (!input.authorFound) return false;
    if (cov >= TITLE_LENGTH.MEDIUM_COVERAGE_SOFT) {
      // Half+ distinctive tokens still need year (or full cov==1 above).
      return !!input.yearFound;
    }
    if (
      cov < TITLE_LENGTH.MEDIUM_BILINGUAL_COVERAGE_SOFT ||
      input.titleHit < TITLE_LENGTH.MEDIUM_BILINGUAL_TITLE_HIT_SOFT
    ) {
      return false;
    }
    return (
      !!input.yearFound ||
      input.titleHit >= TITLE_LENGTH.MEDIUM_NOYEAR_TITLE_HIT_SOFT
    );
  }
  return false;
}

/**
 * Short titles (1–3 words, e.g. «Gece»): title-alone is not enough —
 * need author, year, or ISBN/DOI in the PDF (books and articles).
 */
export function shortTitleCorroborationOk(input: {
  titleLengthBand: TitleLengthBand;
  authorFound: boolean;
  yearFound: boolean;
  hasIdMatch: boolean;
}): boolean {
  if (input.titleLengthBand !== "short") return true;
  return input.authorFound || input.yearFound || input.hasIdMatch;
}

/** @deprecated Prefer shortTitleCorroborationOk (applies to books too). */
export function articleShortCorroborationOk(input: {
  titleLengthBand: TitleLengthBand;
  authorFound: boolean;
  yearFound: boolean;
  hasIdMatch: boolean;
}): boolean {
  return shortTitleCorroborationOk(input);
}

/** Title core before colon/dash — subtitle tokens need not appear in PDF body. */
function titleCoreForDistinctive(title: string): string {
  const raw = String(title || "").trim();
  if (!raw) return "";
  const head = raw.split(/\s*[:;–—|/]\s+|\s+-\s+/)[0]?.trim();
  return head || raw;
}

/**
 * Locale fold WITHOUT ı→i remap — reproduces the pre-fix TR I trap
 * (İşlenen→ıslenen vs işlenen→islenen) so we can detect İ-ı-only misses.
 */
function normalizeSearchTextKeepDotlessI(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

function unifyTurkishI(s: string): string {
  return String(s || "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i");
}

/**
 * Diacritic/İ-ı-insensitive title↔haystack token overlap (sentence-level).
 * ≥ ~0.9 with a near-full distinctive miss → Turkish-char false mismatch.
 */
export function titleSentenceSimilarity(
  title: string,
  rawText: string,
): number {
  const tokens = tokenize(title);
  if (!tokens.length) return 1;
  const text = normalizeSearchText(rawText);
  if (!text) return 0;
  const phrase = tokens.join(" ");
  if (text.includes(phrase)) return 1;
  return tokens.filter((t) => text.includes(t)).length / tokens.length;
}

/**
 * True when distinctive tokens missing under the old TR-I fold are found
 * once ı/İ are unified with i — classic «İşlenen» vs «işlenen» pattern.
 */
export function missingDistinctiveAreTurkishIVariants(
  title: string,
  rawText: string,
): boolean {
  const titleFolded = normalizeSearchTextKeepDotlessI(title);
  const need = titleFolded
    .split(/\s+/)
    .filter((t) => t.length >= 7 && !CONTENT_TITLE_STOP.has(unifyTurkishI(t)));
  if (!need.length) return false;
  const hay = normalizeSearchTextKeepDotlessI(rawText);
  if (!hay) return false;
  const missing = need.filter((t) => !hay.includes(t));
  // One (or at most two) distinctive token(s) — not a wholly different title.
  if (missing.length === 0 || missing.length > 2) return false;
  const hayUni = unifyTurkishI(hay);
  return missing.every((t) => hayUni.includes(unifyTurkishI(t)));
}

export type DistinctiveCoverageDetail = {
  coverage: number;
  /** Sentence-level override fired for TR İ-ı / diacritic false miss. */
  turkishCharNormalization?: boolean;
};

export function distinctiveTitleCoverageDetail(
  title: string,
  rawText: string,
): DistinctiveCoverageDetail {
  const needAll = distinctiveTitleTokens(title);
  if (!needAll.length) return { coverage: 1 };
  const text = normalizeSearchText(rawText);
  if (!text) return { coverage: 0 };
  const hitAll = needAll.filter((t) => text.includes(t)).length;
  let coverage = hitAll / needAll.length;
  // Colon subtitles (YÖK tez: «… Sanat: Dönüşümler») often appear only on the
  // cover line, not in body text — do not fail when the shared core matches.
  const core = titleCoreForDistinctive(title);
  if (core && core !== title.trim()) {
    const needCore = distinctiveTitleTokens(core);
    if (needCore.length) {
      const hitCore = needCore.filter((t) => text.includes(t)).length;
      if (hitCore === needCore.length) {
        coverage = Math.max(coverage, 1);
      }
    }
  }
  const iVariantMiss = missingDistinctiveAreTurkishIVariants(title, rawText);
  if (coverage >= 1) {
    // Fold fix already matched; still flag when the old TR-I trap would have
    // missed so Extra/reason can name «Türkçe karakter / İ-ı…».
    return {
      coverage: 1,
      turkishCharNormalization: iVariantMiss || undefined,
    };
  }
  // Sentence-level safety: high TR-folded title overlap + the only miss(es)
  // under the pre-fix locale fold are İ-ı/I-i variants → not a wrong work.
  if (
    coverage >= 0.85 &&
    titleSentenceSimilarity(title, rawText) >= 0.9 &&
    iVariantMiss
  ) {
    return { coverage: 1, turkishCharNormalization: true };
  }
  return { coverage };
}

export function distinctiveTitleCoverage(
  title: string,
  rawText: string,
): number {
  return distinctiveTitleCoverageDetail(title, rawText).coverage;
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
 * Score PDF text vs item metadata with the standard 100-point field table
 * (``fieldWeights`` / ``oa_pdf_search/field_weights.json``) as 0..1.
 *
 * Replaces additive titleHit+0.5+0.3 (~1.8 max) that ignored the OA kind table.
 */
export function scoreText(
  item: Zotero.Item,
  rawText: string,
  opts?: { kind?: string; bookLike?: boolean },
): number {
  const text = normalizeOcrHaystack(rawText);
  if (!text) return 0;

  const tokens = tokenize((item.getField("title") as string) || "");
  let titleHit = 0;
  if (tokens.length) {
    titleHit = tokens.filter((t) => text.includes(t)).length / tokens.length;
  }

  const qualities: Record<string, number> = {};
  if (tokens.length) qualities.title = titleHit;

  if (anyAuthorSurnameFound(item, rawText)) {
    qualities.authors = 1;
  } else {
    const surname = firstAuthorSurname(item);
    if (surname && text.includes(surname)) qualities.authors = 1;
  }

  const year = itemYear(item);
  // Year alone is noisy (bibliographies); only credit with some title evidence.
  if (year && text.includes(year) && titleHit >= 0.25) {
    qualities.year = 1;
  }

  const publisher = itemPublisher(item);
  if (publisher && publisher.length > 3 && text.includes(publisher)) {
    qualities.publisher = 1;
  }

  const publication = String(
    (item.getField("publicationTitle") as string) || "",
  ).trim();
  if (publication.length > 3) {
    const pubToks = tokenize(publication);
    if (pubToks.length) {
      const hit =
        pubToks.filter((t) => text.includes(t)).length / pubToks.length;
      if (hit >= 0.5) qualities.publication = hit;
    }
  }

  const kind = contentScoreKind({
    itemType: opts?.kind || itemType(item),
    bookLike: opts?.bookLike,
  });
  return weightedKindScore(kind, qualities);
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
  /** Combined score from scoreText — 0..1 via field_weights table */
  score: number;
  hasIdConflict: boolean;
  hasIdMatch: boolean;
  authorExpected: boolean;
  authorFound: boolean;
  /**
   * 0–1 share of distinctive title tokens (≥7, not stop) found in PDF.
   * Articles: medium softens with author+year; long softens to ≥0.85;
   * short still needs 1.0 when tokens exist + author/year/id.
   */
  distinctiveCoverage?: number;
  /** short | medium | long — defaults to medium (legacy absolute coverage). */
  titleLengthBand?: TitleLengthBand;
  /** Year digit string found in PDF (short-title corroboration). */
  yearFound?: boolean;
}): ContentValidation {
  if (input.textChars < 50) return "unverifiable";
  // Hard ISBN/DOI conflict → mismatch, unless title+author already strongly
  // corroborate (set-ISBN / phone-as-ISBN noise with matching künye elsewhere
  // is cleared in metadataCheck; this soft gate is the safety net).
  if (input.hasIdConflict) {
    const softIdNoise =
      input.titleHit >= 0.85 &&
      input.authorFound &&
      input.score >= CONTENT_SCORE.SOFT;
    if (!softIdNoise) return "mismatch";
  }
  if (input.hasIdMatch) return "match";
  // Books: missing author alone used to force mismatch and erase *correct*
  // scans (surname OCR miss / translator listed first). Only kill when title
  // evidence in the PDF is also weak — strong titleHit+score keeps the file.
  if (input.kind === "book" && input.authorExpected && !input.authorFound) {
    const strongTitle =
      input.titleHit >= 0.65 && input.score >= CONTENT_SCORE.STRONG_PAIR;
    if (!strongTitle) {
      return "mismatch";
    }
  }

  const band = input.titleLengthBand ?? "medium";
  const cov = input.distinctiveCoverage ?? 1;
  const yearFound = !!input.yearFound;
  const articleDistinctiveOk =
    input.kind === "book" ||
    articleDistinctiveCoverageOk({
      titleLengthBand: band,
      distinctiveCoverage: cov,
      authorFound: input.authorFound,
      titleHit: input.titleHit,
      yearFound,
    });
  // Short band (1–3 words): books and articles need author/year/id.
  const shortOk = shortTitleCorroborationOk({
    titleLengthBand: band,
    authorFound: input.authorFound,
    yearFound,
    hasIdMatch: input.hasIdMatch,
  });

  if (input.score >= CONTENT_SCORE.HIGH) {
    if (!articleDistinctiveOk || !shortOk) return "mismatch";
    return "match";
  }

  if (input.kind === "book") {
    // Solid title evidence → keep; short titles still need corroboration.
    if (input.titleHit >= 0.5 && input.score >= CONTENT_SCORE.SOFT && shortOk) {
      return "match";
    }
    return "mismatch";
  }

  // Articles / other: length-aware distinctive coverage + short corroboration.
  if (!articleDistinctiveOk || !shortOk) return "mismatch";
  if (input.score >= CONTENT_SCORE.SOFT && input.titleHit >= 0.5)
    return "match";
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
  titleLengthBand?: TitleLengthBand;
  yearFound?: boolean;
  bridgeVia?: string;
  bridgeReason?: string;
  bridgeForcedMismatch?: boolean;
  encodingUnreliable?: boolean;
  /** Sentence/fold override: İ-ı-only title miss, not a wrong PDF. */
  turkishCharNormalization?: boolean;
}): string {
  const band = input.titleLengthBand ?? "medium";
  const pts = Math.round(Math.min(1, Math.max(0, input.score)) * 100);
  const stats = `titleHit=${input.titleHit.toFixed(2)} score=${input.score.toFixed(2)} (${pts}/100) author=${
    input.authorFound ? "yes" : "no"
  } year=${input.yearFound ? "yes" : "no"} band=${band}`;
  if (input.verdict === "unverifiable") {
    if (input.textChars < 50) {
      return `unverifiable: too little PDF text (${input.textChars} chars)`;
    }
    // OCR-fallback outcome (encoding-gate-no-ocr / -ocr-failed / -ocr-empty /
    // -ocr-garbled / -ocr-unverifiable) — surface the Python bridge's exact
    // reason (e.g. "encoding-garbled; OCR unavailable…") on #pdf-review.
    if (input.bridgeReason) {
      const via = input.bridgeVia || "bridge";
      const why = String(input.bridgeReason)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280);
      return `bridge(${via}): ${why} | ${stats}`;
    }
    if (input.encodingUnreliable) {
      return `unverifiable: PDF text encoding unreliable | ${stats}`;
    }
    return `unverifiable: ${stats}`;
  }
  if (input.verdict === "skipped") return "validation skipped (pref off)";
  if (input.verdict === "match") {
    if (input.turkishCharNormalization) {
      return `match: Türkçe karakter / İ-ı normalizasyon farkı | ${stats}`;
    }
    if (input.hasIdMatch) return `match: ISBN/DOI found in PDF | ${stats}`;
    if (
      band === "long" &&
      (input.distinctiveCoverage ?? 1) < 1 &&
      (input.distinctiveCoverage ?? 0) >= TITLE_LENGTH.LONG_COVERAGE_SOFT
    ) {
      return `match: long-title soft distinctive coverage (${(
        input.distinctiveCoverage ?? 0
      ).toFixed(2)}) | ${stats}`;
    }
    if (
      band === "medium" &&
      (input.distinctiveCoverage ?? 1) < 1 &&
      input.authorFound &&
      input.yearFound
    ) {
      return `match: medium-title soft distinctive coverage (${(
        input.distinctiveCoverage ?? 0
      ).toFixed(2)}; author+year) | ${stats}`;
    }
    return `match: ${stats}`;
  }
  // mismatch
  if (input.bridgeForcedMismatch && (input.bridgeReason || input.bridgeVia)) {
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
    const strongTitle =
      input.titleHit >= 0.65 && input.score >= CONTENT_SCORE.STRONG_PAIR;
    if (!strongTitle) {
      return `book: author missing and title evidence weak | ${stats}`;
    }
  }
  if (
    !shortTitleCorroborationOk({
      titleLengthBand: band,
      authorFound: input.authorFound,
      yearFound: !!input.yearFound,
      hasIdMatch: input.hasIdMatch,
    })
  ) {
    return `short title needs author/year/id corroboration | ${stats}`;
  }
  if (input.kind !== "book") {
    const cov = input.distinctiveCoverage ?? 1;
    if (
      !articleDistinctiveCoverageOk({
        titleLengthBand: band,
        distinctiveCoverage: cov,
        authorFound: input.authorFound,
        titleHit: input.titleHit,
        yearFound: !!input.yearFound,
      })
    ) {
      return `article: incomplete distinctive title tokens (${cov.toFixed(
        2,
      )}) | ${stats}`;
    }
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
  if (
    input.titleHit >= 0.5 &&
    input.authorFound &&
    input.score >= CONTENT_SCORE.SOFT
  ) {
    return true;
  }
  if (input.titleHit >= 0.65 && input.score >= CONTENT_SCORE.STRONG_PAIR)
    return true;
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

/**
 * Whether this validation path may spend OCR cost on encoding recovery.
 * Content-audit (`force`) and explicit attach/validate (`allowOcr`) do;
 * passive reconcile/notifier leave both unset → gate-only unverifiable.
 */
export function shouldAllowValidateOcr(opts: {
  force?: boolean;
  allowOcr?: boolean;
}): boolean {
  return opts.allowOcr === true || opts.force === true;
}

export async function validateAttachmentContentDetailed(
  item: Zotero.Item,
  attachmentID: number,
  opts: { force?: boolean; hitTitle?: string; allowOcr?: boolean } = {},
): Promise<{
  verdict: ContentValidation;
  pdfText: string;
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
  // Validate = content match/mismatch/unverifiable only — never mutate
  // künye title (no subtitle enrichment on this path).
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

    const structured = compareItemAgainstText(item, text);
    const surname = firstAuthorSurname(item);
    const authorFound = anyAuthorSurnameFound(item, text);
    const titleHit = titleTokenHit(item, text);
    const score = scoreText(item, text);
    const hasIdMatch = hasIdentifierMatch(structured);
    const hasIdConflict = hasIdentifierConflict(structured);
    const itemTitle = String(item.getField("title") || "");
    const titleLengthBand = classifyTitleLength(itemTitle);
    const year = itemYear(item);
    const yearFound = !!(year && normalizeOcrHaystack(text).includes(year));
    const distinctiveDetail = distinctiveTitleCoverageDetail(itemTitle, text);
    const distinctiveCoverage = distinctiveDetail.coverage;
    const turkishCharNormalization =
      !!distinctiveDetail.turkishCharNormalization;
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
      titleLengthBand,
      yearFound,
    });

    const strongHeuristicMatch = isStrongHeuristicContentMatch({
      titleHit,
      score,
      authorFound,
      hasIdMatch,
    });

    // Encoding/CID mojibake: titleHit=0 is not evidence of a wrong PDF.
    const encodingUnreliable =
      !hasIdConflict &&
      !hasIdMatch &&
      titleHit < 0.2 &&
      looksLikeGarbledPdfText(text);
    const wouldMismatchLowTitle =
      heuristic === "mismatch" &&
      !hasIdConflict &&
      !hasIdMatch &&
      titleHit < 0.2 &&
      textChars >= 400;
    if (heuristic === "mismatch" && encodingUnreliable) {
      heuristic = "unverifiable";
      ztoolkit.log(
        "Content mismatch downgraded — PDF text encoding unreliable",
        item.id,
      );
    }

    const allowOcr = shouldAllowValidateOcr(opts);
    const needsOcrRecovery =
      allowOcr && (encodingUnreliable || wouldMismatchLowTitle);

    let bridgeVia = "";
    let bridgeReason = "";
    let bridgeForcedMismatch = false;

    // Resolve path once — OCR needs absolute disk path under watch roots.
    let attachmentPath = "";
    if (needsOcrRecovery || getPref("pdf.validateContentLlm") !== false) {
      try {
        const att = await Zotero.Items.getAsync(attachmentID);
        attachmentPath = String(
          (await (att as any)?.getFilePathAsync?.()) ||
            (att as any)?.getFilePath?.() ||
            "",
        );
      } catch {
        attachmentPath = "";
      }
    }

    const applyBridgeVerdict = (
      llm: {
        verdict?: string | null;
        via?: string;
        reason?: string;
      },
      ocrPath: boolean,
    ) => {
      const via = String(llm?.via || "");
      const ocrFailVia =
        via.startsWith("encoding-gate-") || via === "encoding-gate";
      if (llm?.verdict === "match" && (ocrPath || heuristic !== "mismatch")) {
        heuristic = "match";
        bridgeVia = via;
        bridgeReason = String(llm.reason || "");
        ztoolkit.log(
          `Bridge content validation → match (${via || "bridge"})`,
          llm.reason || "",
        );
        return;
      }
      if (llm?.verdict === "mismatch" && via.startsWith("ocr-")) {
        // OCR recovered readable text and still disagrees — real mismatch.
        if (!strongHeuristicMatch) {
          heuristic = "mismatch";
          bridgeForcedMismatch = true;
          bridgeVia = via;
          bridgeReason = String(llm.reason || "");
          ztoolkit.log(
            `Bridge OCR validation → mismatch (${via})`,
            llm.reason || "",
          );
        }
        return;
      }
      if (llm?.verdict === "mismatch" && ocrFailVia) {
        heuristic = "unverifiable";
        bridgeVia = via;
        bridgeReason = String(llm.reason || "");
        return;
      }
      if (llm?.verdict === "mismatch" && !strongHeuristicMatch && !ocrFailVia) {
        heuristic = "mismatch";
        bridgeForcedMismatch = true;
        bridgeVia = via;
        bridgeReason = String(llm.reason || "");
        ztoolkit.log(
          `Bridge content validation → mismatch (${via || "bridge"})`,
          llm.reason || "",
        );
        return;
      }
      if (llm?.verdict === "mismatch" && strongHeuristicMatch) {
        ztoolkit.log(
          "Bridge said mismatch but strong heuristic match — keeping PDF",
          via ? `${via}: ` : "",
          llm.reason || "",
        );
        return;
      }
      if (llm?.verdict === "unverifiable" && heuristic === "match") {
        return;
      }
      if (llm?.verdict === "unverifiable" || ocrFailVia) {
        heuristic = "unverifiable";
        bridgeVia = via;
        bridgeReason = String(llm.reason || "");
        return;
      }
      if (llm?.verdict === "match" && heuristic === "mismatch") {
        ztoolkit.log(
          "Bridge said match but heuristic mismatch — keeping mismatch",
          llm.reason || "",
        );
      }
    };

    // Encoding / low-title Validate path: re-OCR via bridge before tagging.
    if (needsOcrRecovery) {
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
          pdfPath: attachmentPath,
          allowOcr: true,
        });
        if (llm) {
          applyBridgeVerdict(llm, true);
        } else if (encodingUnreliable || wouldMismatchLowTitle) {
          // Bridge down: prefer review over false mismatch.
          heuristic = "unverifiable";
          bridgeVia = "encoding-gate-no-ocr";
          bridgeReason = "bridge unreachable during OCR recovery";
        }
      } catch (e) {
        ztoolkit.log("Bridge OCR validation unavailable; unverifiable", e);
        heuristic = "unverifiable";
        bridgeVia = "encoding-gate-no-ocr";
        bridgeReason = String((e as Error)?.message || e).slice(0, 120);
      }
    } else if (
      getPref("pdf.validateContentLlm") !== false &&
      textChars >= 50 &&
      heuristic !== "skipped" &&
      !encodingUnreliable &&
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
          pdfPath: attachmentPath,
          allowOcr: false,
        });
        // Ignore enriched_title from bridge — validate must not mutate title.
        if (llm) applyBridgeVerdict(llm, false);
      } catch (e) {
        ztoolkit.log(
          "Bridge content validation unavailable; heuristic only",
          e,
        );
      }
    } else if (encodingUnreliable) {
      ztoolkit.log(
        "Passive path: encoding unreliable → unverifiable (no OCR)",
        item.id,
      );
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
      titleLengthBand,
      yearFound,
      bridgeVia,
      bridgeReason,
      bridgeForcedMismatch,
      encodingUnreliable:
        encodingUnreliable || String(bridgeVia).startsWith("encoding-gate"),
      turkishCharNormalization,
    });

    if (heuristic === "match") {
      await clearSuccessfulMatchTags(item);
      await lockValidatedAttachment(item, attachmentID);
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
  const wantKey = safePathKey(String(filePath || ""));
  if (!wantKey) return null;
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
      const got = safePathKey(String(p));
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
      await validateAttachmentContentDetailed(item, attachment.id, {
        allowOcr: true,
      });
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
    await clearValidatedPdfLock(item);
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
      { allowOcr: true },
    );
    if (shouldClearMatchTags(detailed.verdict, via)) {
      await clearSuccessfulMatchTags(item);
      await purgeMissingSiblingPdfAttachments(item, attachment.id);
      // Yerinde link alone left files under downloads/ or inbox names —
      // relocate to künye filename + configured library dest when prefs allow.
      const relocated = await relocateAfterSuccessfulMatch(attachment);
      // Validate stamped the pre-move path; refresh Extra to the final path.
      await clearValidatedPdfLock(item, diskPath);
      await persistValidatedPdfLock(item, relocated || attachment);
      return relocated;
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
    await clearValidatedPdfLock(item, diskPath);
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
    const titleBand = classifyTitleLength(rawTitle);
    if (titleBand === "short" && !best.authorMatch) {
      return {
        status: "review",
        file: best.f,
        score: best.score,
        reason: "short title without author match",
      };
    }
    let decision = classifyMatchConfidence(best.score, autoAttach, review);
    // Auto-attach: medium/short need full distinctive coverage; long titles
    // allow soft floor (≥0.85) so one OCR/variant miss does not block attach.
    const distRatio = best.distRatio ?? 1;
    const distOk =
      distRatio >= 1 ||
      (titleBand === "long" &&
        distRatio >= TITLE_LENGTH.LONG_COVERAGE_SOFT &&
        (best.authorMatch || best.hit >= TITLE_LENGTH.LONG_TITLE_HIT_SOFT));
    const demotedForCoverage = decision === "attach" && !distOk;
    if (demotedForCoverage) {
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
        reason: demotedForCoverage
          ? `distinctive coverage ${(distRatio ?? 0).toFixed(2)} below auto-attach gate (score ${best.score.toFixed(2)})`
          : `score ${best.score.toFixed(2)} below auto-attach ${autoAttach}`,
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
  pdfkitap: PdfKitapSource,
  dirzon: DirzonSource,
  yoktez: YokTezSource,
  proxy: new ProxySource(),
  zenodo: ZenodoSource,
  archive: InternetArchiveSource,
  openaire: OpenAireSource,
  core: CoreSource,
};

/** Lookup / validate only — not PDF download cascade. */
export const METADATA_ONLY_SOURCE_IDS = ["arxiv", "s2", "proquest"] as const;
