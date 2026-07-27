import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { buildIndex, getWatchRoots, IndexedFile } from "./folderIndex";

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
  | { status: "matched"; file: IndexedFile }
  | { status: "ambiguous" }
  | { status: "none" };

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
const isArticle = (i: Zotero.Item) => ARTICLE_TYPES.has(itemType(i));
const isBook = (i: Zotero.Item) => BOOK_TYPES.has(itemType(i));
const isThesis = (i: Zotero.Item) => THESIS_TYPES.has(itemType(i));

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
  return await (Zotero.HTTP as any).request("GET", url, {
    responseType,
    timeout: 60000,
    successCodes: false,
  });
}

export async function fetchPdfBytes(url: string): Promise<Uint8Array | null> {
  try {
    const xhr = await httpGet(url, "arraybuffer");
    if (!xhr || !xhr.response) return null;
    const bytes = new Uint8Array(xhr.response as ArrayBuffer);
    return looksLikePDF(bytes) ? bytes : null;
  } catch (e) {
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
 * metadata. Fails "open" (returns true) when text cannot be extracted so we
 * never block a legitimately scanned/borderline PDF.
 */
async function contentMatches(
  item: Zotero.Item,
  attachmentID: number,
): Promise<boolean> {
  if (!getPref("pdf.validateContent")) return true;
  try {
    const res = await (Zotero as any).PDFWorker.getFullText(attachmentID, 5);
    const text: string = res?.text || "";
    if (text.replace(/\s/g, "").length < 50) return true; // no extractable text
    return scoreText(item, text) >= 0.6;
  } catch (e) {
    ztoolkit.log("content validation error", e);
    return true;
  }
}

/**
 * Download bytes from `url`, verify they are a real PDF, import as a child
 * attachment, and (unless `validate` is false) confirm the content matches
 * the item's metadata — deleting the attachment again if it does not.
 */
export async function downloadAndAttach(
  item: Zotero.Item,
  url: string,
  opts: { validate?: boolean } = {},
): Promise<unknown | null> {
  const bytes = await fetchPdfBytes(url);
  if (!bytes) return null;

  const tmpDir = (Zotero as any).getTempDirectory().path as string;
  const tmpPath = PathUtils.join(
    tmpDir,
    `pdffetch-${item.id}-${Date.now()}.pdf`,
  );
  let attachment: any = null;
  try {
    await IOUtils.write(tmpPath, bytes);
    attachment = await (Zotero.Attachments as any).importFromFile({
      file: tmpPath,
      libraryID: item.libraryID,
      parentItemID: item.id,
      title: getString("pdf-attachment-title"),
      contentType: "application/pdf",
    });
  } catch (e) {
    ztoolkit.log("importFromFile failed", e);
    return null;
  } finally {
    try {
      await IOUtils.remove(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
  }
  if (!attachment) return null;

  if (opts.validate !== false) {
    const ok = await contentMatches(item, attachment.id);
    if (!ok) {
      ztoolkit.log(`Rejected PDF (metadata mismatch) for ${item.id}`);
      try {
        await attachment.eraseTx();
      } catch (e) {
        ztoolkit.log("erase rejected attachment failed", e);
      }
      return null;
    }
  }
  return attachment;
}

export function getDOI(item: Zotero.Item): string {
  let doi = (item.getField("DOI") as string) || "";
  if (!doi) {
    const extra = (item.getField("extra") as string) || "";
    const m = extra.match(/^\s*DOI:\s*(\S+)/im);
    if (m) doi = m[1];
  }
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
}

// --------------------------------------------------------------------------
// Metadata check: fill in a missing DOI from Crossref before downloading
// --------------------------------------------------------------------------

export async function ensureDOI(item: Zotero.Item): Promise<string> {
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
    const foundDOI: string = found?.DOI || "";
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

  matchItem(
    item: Zotero.Item,
    index: IndexedFile[],
  ): LocalMatchResult {
    // 1) Exact DOI embedded in the filename.
    const doi = getDOI(item)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    if (doi.length > 8) {
      const byDOI = index.filter((f) => f.alnum.includes(doi));
      if (byDOI.length === 1) {
        return { status: "matched", file: byDOI[0] };
      }
      if (byDOI.length > 1) return { status: "ambiguous" };
    }

    // 2) Title CONTAINMENT: fraction of the item's title words present in the
    // filename. Filenames commonly add author/year/publisher, so a symmetric
    // similarity keeps the ratio low and never matches. We add author/year
    // bonuses, take the single best file, and bail out when two files tie
    // (ambiguous) to avoid associating the wrong edition.
    const rawTitle = (item.getField("title") as string) || "";
    const titleTokens = tokenize(rawTitle);
    if (!titleTokens.length) return { status: "none" };
    // Full token list INCLUDING short tokens/numbers (e.g. volume "1".."6"),
    // used only as a tie-breaker to tell near-identical names apart.
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
        // Eligible when the title is mostly contained, OR half the title is
        // contained AND the author surname also appears (rescues subtitle-heavy
        // titles like "X: bir giriş" without risking a wrong-book match, since
        // the author must agree too).
        const eligible = hit >= 0.7 || (hit >= 0.5 && authorMatch);
        let score = hit;
        if (authorMatch) score += 0.3;
        if (yearMatch) score += 0.2;
        const fine =
          titleTokensAll.filter((t) => words.has(t)).length /
          titleTokensAll.length;
        return { f, eligible, score, fine };
      })
      .filter((s) => s.eligible)
      .sort((a, b) => b.score - a.score || b.fine - a.fine);

    if (!scored.length) return { status: "none" };
    // Ambiguous only when the runner-up is coarse-close AND the fine score
    // (which includes volume numbers/short tokens) cannot separate them —
    // e.g. two genuine copies of the same file. If the fine score CAN tell
    // them apart (vol. 1 vs vol. 2), take the better one instead of skipping.
    if (
      scored[1] &&
      scored[0].score - scored[1].score < 0.15 &&
      scored[0].fine <= scored[1].fine
    ) {
      return { status: "ambiguous" };
    }
    return { status: "matched", file: scored[0].f };
  }
}

/** DOI / Open Access, via Zotero's own resolver (Unpaywall etc.). */
export class DOISource implements PDFSource {
  id = "doi";
  isEnabled() {
    return !!getPref("pdf.doiEnabled");
  }
  supportsItem() {
    return true;
  }
  async tryAttach(item: Zotero.Item) {
    try {
      const att = await (Zotero.Attachments as any).addAvailablePDF(item);
      return att || null;
    } catch (e) {
      ztoolkit.log("addAvailablePDF failed", e);
      return null;
    }
  }
}

/** arXiv — build the PDF URL directly from the item's arXiv id. */
export class ArxivSource implements PDFSource {
  id = "arxiv";
  isEnabled() {
    return !!getPref("pdf.arxivEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return isArticle(item);
  }
  async tryAttach(item: Zotero.Item) {
    const hay = `${item.getField("url")} ${item.getField("extra")}`;
    // Prefer an "arXiv"-anchored id; only accept a bare NNNN.NNNNN id when the
    // text actually references arxiv.org, so we don't mistake a date/page range.
    let id = "";
    const anchored = hay.match(/arxiv[:/]\s*([\w.-]+\/\d+|\d{4}\.\d{4,5})/i);
    if (anchored) id = anchored[1];
    else if (/arxiv\.org/i.test(hay))
      id = hay.match(/(\d{4}\.\d{4,5})/)?.[1] || "";
    if (!id) return null;
    return await downloadAndAttach(item, `https://arxiv.org/pdf/${id}`);
  }
}

/** PubMed Central — resolve a PMCID (from DOI/PMID) and fetch the OA PDF. */
export class PMCSource implements PDFSource {
  id = "pmc";
  isEnabled() {
    return !!getPref("pdf.pmcEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return isArticle(item);
  }
  async tryAttach(item: Zotero.Item) {
    let pmcid = this.findPMCID(item);
    if (!pmcid) {
      const key = getDOI(item) || this.findPMID(item);
      if (!key) return null;
      pmcid = await this.lookupPMCID(key);
    }
    if (!pmcid) return null;
    const url = `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${pmcid}&blobtype=pdf`;
    return await downloadAndAttach(item, url);
  }
  private findPMCID(item: Zotero.Item): string {
    const hay = `${item.getField("extra")} ${item.getField("url")}`;
    const m = hay.match(/PMC\d+/i);
    return m ? m[0].toUpperCase() : "";
  }
  private findPMID(item: Zotero.Item): string {
    const extra = (item.getField("extra") as string) || "";
    const m = extra.match(/PMID:\s*(\d+)/i);
    return m ? m[1] : "";
  }
  private async lookupPMCID(id: string): Promise<string> {
    try {
      const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(
        id,
      )}&format=json&tool=zotero-pdf&email=zotero@example.com`;
      const xhr = await httpGet(url, "text");
      const data = JSON.parse(xhr.responseText);
      return data?.records?.[0]?.pmcid || "";
    } catch (e) {
      ztoolkit.log("PMC id conversion failed", e);
      return "";
    }
  }
}

/** Semantic Scholar — ask the API for an open-access PDF link by DOI. */
export class SemanticScholarSource implements PDFSource {
  id = "s2";
  isEnabled() {
    return !!getPref("pdf.s2Enabled");
  }
  supportsItem(item: Zotero.Item) {
    return isArticle(item);
  }
  async tryAttach(item: Zotero.Item) {
    const doi = getDOI(item);
    if (!doi) return null;
    try {
      const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(
        doi,
      )}?fields=openAccessPdf`;
      const xhr = await httpGet(url, "text");
      const data = JSON.parse(xhr.responseText);
      const pdf = data?.openAccessPdf?.url;
      if (!pdf) return null;
      return await downloadAndAttach(item, pdf);
    } catch (e) {
      ztoolkit.log("Semantic Scholar failed", e);
      return null;
    }
  }
}

/** DergiPark (Turkish journals) — scrape the article page for the PDF link. */
export class DergiParkSource implements PDFSource {
  id = "dergipark";
  isEnabled() {
    return !!getPref("pdf.dergiparkEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return DERGIPARK_TYPES.has(itemType(item));
  }
  async tryAttach(item: Zotero.Item) {
    const url = (item.getField("url") as string) || "";

    // A) The item already points at a DergiPark page/file.
    if (/dergipark\.org\.tr/i.test(url)) {
      if (/\/download\/article-file\/\d+/i.test(url)) {
        const att = await downloadAndAttach(item, url);
        if (att) return att;
      }
      try {
        const html = (await httpGet(url)).responseText || "";
        const pdfURL = extractDergiParkPdfURL(html, url);
        if (pdfURL) {
          const att = await downloadAndAttach(item, pdfURL);
          if (att) return att;
        }
      } catch (e) {
        ztoolkit.log("DergiPark page scrape failed", e);
      }
    }

    // B) No usable URL → search DergiPark by title.
    const title = (item.getField("title") as string) || "";
    if (title) {
      try {
        return await searchDergiParkByTitle(item, title);
      } catch (e) {
        ztoolkit.log("DergiPark search failed", e);
      }
    }
    return null;
  }
}

function uniqueStrings(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/** Best title we can read from a scraped HTML page. */
function extractHtmlTitle(html: string): string {
  const m =
    html.match(
      /<meta[^>]+name=["']citation_title["'][^>]+content=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_title["']/i,
    ) ||
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    ) ||
    html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

/**
 * Search DergiPark by title, follow the first result whose page title matches,
 * and download its PDF. Title verification avoids attaching a wrong article.
 */
async function searchDergiParkByTitle(
  item: Zotero.Item,
  title: string,
): Promise<unknown | null> {
  const searchURL = `https://dergipark.org.tr/tr/search?q=${encodeURIComponent(
    title,
  )}&section=articles`;
  const html = (await httpGet(searchURL)).responseText || "";
  const links = uniqueStrings(
    [
      ...html.matchAll(
        /href="(\/tr\/pub\/[^"#?]+\/(?:article\/\d+|issue\/\d+\/\d+))"/gi,
      ),
    ].map((m) => m[1]),
  ).slice(0, 5);

  for (const rel of links) {
    const pageURL = absoluteURL("https://dergipark.org.tr/", rel);
    const pageHtml = (await httpGet(pageURL)).responseText || "";
    const pageTitle = extractHtmlTitle(pageHtml);
    if (pageTitle && !titleSimilar(title, pageTitle)) continue;
    const pdfURL = extractDergiParkPdfURL(pageHtml, pageURL);
    if (pdfURL) {
      const att = await downloadAndAttach(item, pdfURL);
      if (att) return att;
    }
  }
  return null;
}

export function extractDergiParkPdfURL(html: string, baseURL: string) {
  const citationMeta =
    html.match(
      /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["'][^>]*>/i,
    );
  if (citationMeta) return absoluteURL(baseURL, citationMeta[1]);

  const typedLink =
    html.match(
      /<(?:a|link)[^>]+(?:type=["']application\/pdf["']|rel=["'][^"']*alternate[^"']*["'])[^>]+href=["']([^"']*\/download\/article-file\/\d+[^"']*)["'][^>]*>/i,
    ) ||
    html.match(
      /<(?:a|link)[^>]+href=["']([^"']*\/download\/article-file\/\d+[^"']*)["'][^>]+(?:type=["']application\/pdf["']|rel=["'][^"']*alternate[^"']*["'])[^>]*>/i,
    );
  if (typedLink) return absoluteURL(baseURL, typedLink[1]);

  for (const match of html.matchAll(
    /<a[^>]+href=["']([^"']*\/download\/article-file\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (/tam\s*metin|full\s*text|pdf\s*(?:görüntüle|view|indir|download)/i.test(label)) {
      return absoluteURL(baseURL, match[1]);
    }
  }
  return "";
}

/** Sci-Hub — articles only. GET mirror/<doi>, extract embedded PDF URL. */
/** Default working mirrors, used when the preference is empty. */
const SCIHUB_MIRRORS = [
  "https://sci-hub.se/",
  "https://sci-hub.st/",
  "https://sci-hub.ru/",
];
const LIBGEN_MIRRORS = [
  "https://libgen.li/",
  "https://libgen.vg/",
  "https://libgen.la/",
  "https://libgen.bz/",
  "https://libgen.gl/",
];

/**
 * Parse a semicolon/newline-separated mirror list from a preference. Adds a
 * scheme and trailing slash, de-duplicates, and falls back to the built-in
 * list when the preference is empty. Multiple mirrors are tried in order so a
 * dead mirror (the usual failure mode) automatically fails over to the next.
 */
export function parseMirrors(raw: string, fallback: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of (raw || "").split(/[;\n\r]+/)) {
    let mirror = value.trim();
    if (!mirror) continue;
    if (!/^https?:\/\//i.test(mirror)) mirror = "https://" + mirror;
    if (!mirror.endsWith("/")) mirror += "/";
    const key = mirror.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mirror);
  }
  return out.length ? out : fallback;
}

export function isValidISBN(value: string): boolean {
  const isbn = String(value || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (isbn.length === 10) {
    const sum = isbn
      .split("")
      .reduce(
        (total, char, index) =>
          total + (char === "X" ? 10 : Number(char)) * (10 - index),
        0,
      );
    return sum % 11 === 0;
  }
  if (isbn.length === 13) {
    const sum = isbn
      .split("")
      .reduce(
        (total, char, index) =>
          total + Number(char) * (index % 2 === 0 ? 1 : 3),
        0,
      );
    return sum % 10 === 0;
  }
  return false;
}

export function buildLibGenQueries(item: Zotero.Item): string[] {
  const out: string[] = [];
  const doi = getDOI(item);
  if (doi) out.push(doi);
  const isbn = String(item.getField("ISBN") || "").replace(/[^0-9Xx]/g, "");
  if (isBook(item) && isValidISBN(isbn)) out.push(isbn);
  const title = String(item.getField("title") || "").trim();
  if (title) out.push(title);
  return Array.from(new Set(out));
}

export class SciHubSource implements PDFSource {
  id = "scihub";
  isEnabled() {
    return !!getPref("pdf.scihubEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return isArticle(item);
  }
  async tryAttach(item: Zotero.Item) {
    const doi = getDOI(item);
    if (!doi) return null;
    const mirrors = parseMirrors(
      getPref("pdf.scihubURL") as string,
      SCIHUB_MIRRORS,
    );
    for (const base of mirrors) {
      try {
        const pageURL = absoluteURL(base, encodeURIComponent(doi));
        const html = (await httpGet(pageURL)).responseText || "";
        const pdfURL = this.extractPdfURL(html, base);
        if (!pdfURL) continue;
        const att = await downloadAndAttach(item, pdfURL);
        if (att) return att;
      } catch (e) {
        ztoolkit.log(`Sci-Hub mirror ${base} failed`, e);
      }
    }
    return null;
  }
  private extractPdfURL(html: string, base: string): string | null {
    const m =
      html.match(/<embed[^>]+src="([^"]+\.pdf[^"]*)"/i) ||
      html.match(/<iframe[^>]+src="([^"]+\.pdf[^"]*)"/i) ||
      html.match(/<iframe[^>]+id="pdf"[^>]+src="([^"]+)"/i) ||
      html.match(/location\.href\s*=\s*['"]([^'"]+\.pdf[^'"]*)['"]/i) ||
      html.match(/href="([^"]+\.pdf[^"]*)"/i);
    return m ? absoluteURL(base, m[1]) : null;
  }
}

/** Library Genesis — articles and books. Picks the best-matching entry. */
export class LibGenSource implements PDFSource {
  id = "libgen";
  isEnabled() {
    return !!getPref("pdf.libgenEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return isArticle(item) || isBook(item);
  }
  async tryAttach(item: Zotero.Item) {
    const queries = buildLibGenQueries(item);
    if (!queries.length) return null;
    const mirrors = parseMirrors(
      getPref("pdf.libgenURL") as string,
      LIBGEN_MIRRORS,
    );
    let completedSearches = 0;
    const mirrorErrors: string[] = [];
    for (const base of mirrors) {
      for (const query of queries) {
        try {
          const att = await this.tryMirror(item, query, base);
          completedSearches++;
          if (att) return att;
        } catch (e) {
          ztoolkit.log(`LibGen mirror ${base} failed`, e);
          mirrorErrors.push(
            `${base}: ${e instanceof Error ? e.message : String(e)}`,
          );
          break; // mirror unreachable → skip its remaining queries
        }
      }
    }
    if (completedSearches === 0 && mirrorErrors.length) {
      throw new Error(
        `Tüm LibGen aynalarına erişilemedi (${mirrorErrors.length}/${mirrors.length})`,
      );
    }
    return null;
  }

  private async tryMirror(
    item: Zotero.Item,
    query: string,
    base: string,
  ): Promise<unknown | null> {
    const searchURL = absoluteURL(
      base,
      "index.php?req=" + encodeURIComponent(query),
    );
    const response = await httpGet(searchURL);
    const status = Number(response?.status || 0);
    if (status && (status < 200 || status >= 300)) {
      throw new Error(`HTTP ${status}`);
    }
    const html = response?.responseText || "";
    if (
      !html.trim() ||
      /(?:cloudflare|captcha|checking your browser|access denied)/i.test(html)
    ) {
      throw new Error("Arama sayfası alınamadı veya erişim engellendi");
    }
    const md5s = this.pickMd5s(html, item);

    for (const md5 of md5s) {
      let att = await downloadAndAttach(
        item,
        absoluteURL(base, "get.php?md5=" + md5),
      );
      if (att) return att;
      const pageHtml =
        (await httpGet(absoluteURL(base, "ads.php?md5=" + md5))).responseText ||
        "";
      const link = pageHtml.match(/href="([^"]*get\.php[^"]*)"/i);
      if (link) {
        att = await downloadAndAttach(item, absoluteURL(base, link[1]));
        if (att) return att;
      }
    }
    return null;
  }

  /**
   * Rank candidate md5 hashes by how well the surrounding table row matches
   * the item metadata (title/author/year), so we do not grab a same-title but
   * wrong edition. Falls back to raw order when nothing scores.
   */
  private pickMd5s(html: string, item: Zotero.Item): string[] {
    const rows = html.split(/<tr[\s>]/i);
    const scored: { md5: string; score: number }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const md5m = row.match(/[a-fA-F0-9]{32}/);
      if (!md5m) continue;
      const md5 = md5m[0];
      if (seen.has(md5)) continue;
      seen.add(md5);
      const text = row.replace(/<[^>]+>/g, " ");
      scored.push({ md5, score: scoreText(item, text) });
    }
    scored.sort((a, b) => b.score - a.score);
    const ranked = scored.map((s) => s.md5);
    return ranked.length ? ranked.slice(0, 3) : [];
  }
}

/** YÖKTEZ (tez.yok.gov.tr) — Turkish National Thesis Center. Best-effort. */
export class YokTezSource implements PDFSource {
  id = "yoktez";
  isEnabled() {
    return !!getPref("pdf.yoktezEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return isThesis(item);
  }
  async tryAttach(item: Zotero.Item) {
    const url = getYokRecordURL(item);
    if (url) {
      try {
        // Zotero records imported from YÖK commonly store TezGoster itself as
        // the item URL — already the PDF endpoint, not an HTML detail page.
        if (/\/TezGoster(?:\?|$)/i.test(url)) {
          const att = await downloadAndAttach(item, url);
          if (att) return att;
        } else {
          const direct = await downloadAndAttach(item, url);
          if (direct) return direct;
          const html = (await httpGet(url)).responseText || "";
          const pdfURL = extractYokPdfURL(html, url);
          if (pdfURL) {
            const att = await downloadAndAttach(item, pdfURL);
            if (att) return att;
          }
        }
      } catch (e) {
        ztoolkit.log("YÖKTEZ fetch failed", e);
      }
    }

    // No usable URL → search the thesis center by title (best-effort; YÖK
    // frequently gates results, so this may legitimately find nothing).
    const title = (item.getField("title") as string) || "";
    if (title) {
      try {
        return await searchYokTezByTitle(item, title);
      } catch (e) {
        ztoolkit.log("YÖKTEZ search failed", e);
      }
    }
    return null;
  }
}

async function searchYokTezByTitle(
  item: Zotero.Item,
  title: string,
): Promise<unknown | null> {
  const searchURL = `https://tez.yok.gov.tr/UlusalTezMerkezi/SearchTez?query=${encodeURIComponent(
    title,
  )}`;
  const html = (await httpGet(searchURL)).responseText || "";
  const links = uniqueStrings(
    [
      ...html.matchAll(
        /href="([^"']*(?:tezDetay|TezGoster)[^"']*)"/gi,
      ),
    ].map((m) => m[1]),
  ).slice(0, 5);

  for (const rel of links) {
    const pageURL = absoluteURL("https://tez.yok.gov.tr/", rel);
    if (/TezGoster/i.test(pageURL)) {
      const att = await downloadAndAttach(item, pageURL);
      if (att) return att;
      continue;
    }
    const pageHtml = (await httpGet(pageURL)).responseText || "";
    const pageTitle = extractHtmlTitle(pageHtml);
    if (pageTitle && !titleSimilar(title, pageTitle)) continue;
    const pdfURL = extractYokPdfURL(pageHtml, pageURL);
    if (pdfURL) {
      const att = await downloadAndAttach(item, pdfURL);
      if (att) return att;
    }
  }
  return null;
}

export function getYokRecordURL(item: Zotero.Item) {
  for (const field of ["url", "extra", "archiveLocation", "callNumber"]) {
    const value = String((item as any).getField(field) || "");
    const match = value.match(
      /https?:\/\/tez\.yok\.gov\.tr\/UlusalTezMerkezi\/[^\s<>"']+/i,
    );
    if (match) return match[0].replace(/[),.;]+$/g, "");
  }
  return "";
}

export function extractYokPdfURL(html: string, baseURL: string) {
  const match =
    html.match(/href\s*=\s*["']([^"']*TezGoster[^"']*)["']/i) ||
    html.match(/href\s*=\s*["']([^"']+\.pdf(?:\?[^"']*)?)["']/i) ||
    html.match(
      /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']*TezGoster[^"']*)["']/i,
    );
  return match ? absoluteURL(baseURL, match[1]) : "";
}

/** ProQuest Dissertations — best-effort; usually needs institutional access. */
export class ProQuestSource implements PDFSource {
  id = "proquest";
  isEnabled() {
    return !!getPref("pdf.proquestEnabled");
  }
  supportsItem(item: Zotero.Item) {
    return isThesis(item) || isArticle(item);
  }
  async tryAttach(item: Zotero.Item) {
    let url = (item.getField("url") as string) || "";
    if (!url || !/proquest\.com/i.test(url)) return null;
    // Route through the institutional proxy when configured (auth required).
    const proxy = ((getPref("pdf.proxyURL") as string) || "").trim();
    if (getPref("pdf.proxyEnabled") && proxy) url = proxy + url;
    try {
      let att = await downloadAndAttach(item, url);
      if (att) return att;
      const html = (await httpGet(url)).responseText || "";
      const m = html.match(/href="([^"]*fulltextPDF[^"]*|[^"]+\.pdf[^"]*)"/i);
      if (!m) return null;
      return await downloadAndAttach(item, absoluteURL(url, m[1]));
    } catch (e) {
      ztoolkit.log("ProQuest fetch failed", e);
      return null;
    }
  }
}

/** Institutional proxy (EZproxy-style) — wrap the item URL with a prefix. */
export class ProxySource implements PDFSource {
  id = "proxy";
  isEnabled() {
    return (
      !!getPref("pdf.proxyEnabled") && !!(getPref("pdf.proxyURL") as string)
    );
  }
  supportsItem() {
    return true;
  }
  async tryAttach(item: Zotero.Item) {
    const prefix = ((getPref("pdf.proxyURL") as string) || "").trim();
    const url = (item.getField("url") as string) || "";
    if (!prefix || !url) return null;
    return await downloadAndAttach(item, prefix + url);
  }
}

/** Registry of all known sources, keyed by id. */
export const ALL_SOURCES: Record<string, PDFSource> = {
  local: new LocalFolderSource(),
  doi: new DOISource(),
  arxiv: new ArxivSource(),
  pmc: new PMCSource(),
  s2: new SemanticScholarSource(),
  dergipark: new DergiParkSource(),
  scihub: new SciHubSource(),
  libgen: new LibGenSource(),
  yoktez: new YokTezSource(),
  proquest: new ProQuestSource(),
  proxy: new ProxySource(),
};
