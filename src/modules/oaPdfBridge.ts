// @ajan: cursor · @etiket: katman-2, oa-pdf-bridge, distinctive-title-trust
/**
 * Katman-2 → Kutuphane köprü (8756) `oa_pdf_search` client.
 * Online PDF discovery runs in Python; this module only POSTs queries.
 * LibGen book PDFs: long fetch timeout (keys refresh + multi-minute download).
 * Bridge base URL is loopback-only (same SSRF policy as K1/K3).
 */
import { getPref } from "../utils/prefs";
import { normalizeDOI } from "../utils/metadataNormalize";
import {
  DEFAULT_OA_BRIDGE_URL,
  isAllowedOaBridgeUrl,
  normalizeOaBridgeUrl,
} from "../utils/oaBridgeUrl";

export { DEFAULT_OA_BRIDGE_URL, isAllowedOaBridgeUrl, normalizeOaBridgeUrl };

export type OaPdfHit = {
  source: string;
  title: string;
  pdfUrl?: string | null;
  landingUrl?: string | null;
  doi?: string | null;
  year?: string | null;
  authors?: string | null;
  extra?: Record<string, unknown>;
};

export type OaPdfSearchRequest = {
  source: string;
  text?: string;
  doi?: string;
  isbn?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  authors?: string;
  limit?: number;
};

export type OaPdfSearchResponse = {
  ok?: boolean;
  source?: string;
  hits?: OaPdfHit[];
  detail?: string;
  /** Soft-fail reason from bridge_api.search_payload — set when the source
   * genuinely errored (network/API), distinct from a legitimate zero-result
   * search where this is absent. */
  error?: string;
};

function itemDOI(item: Zotero.Item): string {
  let doi = (item.getField("DOI") as string) || "";
  if (!doi) {
    const extra = (item.getField("extra") as string) || "";
    const m = extra.match(/^\s*DOI:\s*(\S+)/im);
    if (m) doi = m[1];
  }
  return normalizeDOI(doi);
}

export function resolveOaBridgeUrl(): string {
  return normalizeOaBridgeUrl(String(getPref("pdf.oaBridgeUrl") || ""));
}

/** Build search fields from a Zotero item for one oa_pdf_search source id. */
export function buildOaSearchRequest(
  sourceId: string,
  item: Zotero.Item,
  limit = 5,
): OaPdfSearchRequest {
  const title = String(item.getField("title") || "").trim();
  const doi = itemDOI(item);
  const isbn = String(item.getField("ISBN") || "").replace(/[^0-9Xx]/g, "");
  const extra = String(item.getField("extra") || "");
  const urlField = String(item.getField("url") || "");
  const hay = `${urlField}\n${extra}`;

  let arxivId = "";
  const arxivAnchored = hay.match(/arxiv[:/]\s*([\w.-]+\/\d+|\d{4}\.\d{4,5})/i);
  if (arxivAnchored) arxivId = arxivAnchored[1];
  else if (/arxiv\.org/i.test(hay))
    arxivId = hay.match(/(\d{4}\.\d{4,5})/)?.[1] || "";

  const pmcid = (hay.match(/PMC\d+/i)?.[0] || "").toUpperCase();
  const pmid =
    extra.match(/^\s*PMID:\s*(\d+)/im)?.[1] ||
    hay.match(/\bpmid[=:\s]+(\d+)/i)?.[1] ||
    "";

  const yokNo =
    extra.match(/YÖK\s*Tez\s*No\s*:\s*(\d{5,})/i)?.[1] ||
    extra.match(/Tez\s*No\s*:\s*(\d{5,})/i)?.[1] ||
    "";

  let text =
    sourceId === "yoktez" && yokNo && !title.includes(yokNo)
      ? `${title} ${yokNo}`.trim()
      : title;

  let authors = "";
  try {
    const creators = item.getCreators() as Array<{
      lastName?: string;
      firstName?: string;
      name?: string;
    }>;
    authors = (creators || [])
      .slice(0, 3)
      .map((c) =>
        String(
          c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
        ).trim(),
      )
      .filter(Boolean)
      .join("; ");
  } catch {
    /* ignore */
  }

  // LibGen: core title before colon + author surnames (long subtitles miss catalog).
  if (sourceId === "libgen" && title) {
    const colon = title.search(/\s*[:—–]\s*/);
    if (colon >= 8) {
      text = title.slice(0, colon).trim();
    }
  }

  return {
    source: sourceId,
    text,
    doi,
    isbn,
    arxivId,
    pmid,
    pmcid,
    authors,
    limit,
  };
}

export async function searchOaPdfBridge(
  req: OaPdfSearchRequest,
): Promise<OaPdfHit[]> {
  const base = resolveOaBridgeUrl();
  const endpoint = `${base}/pdf-search`;
  let xhr: any;
  try {
    xhr = await (Zotero.HTTP as any).request("POST", endpoint, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: req.source,
        text: req.text || "",
        doi: req.doi || "",
        isbn: req.isbn || "",
        arxivId: req.arxivId || "",
        pmid: req.pmid || "",
        pmcid: req.pmcid || "",
        authors: req.authors || "",
        limit: req.limit ?? 5,
      }),
      responseType: "text",
      timeout: 120000,
      successCodes: false,
    });
  } catch (e) {
    throw new Error(
      `oa_pdf köprü kapalı (${base}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const status = Number(xhr?.status || 0);
  const raw = String(xhr?.responseText || "");
  let body: OaPdfSearchResponse = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    throw new Error(`oa_pdf köprü geçersiz JSON (HTTP ${status})`);
  }
  if (status && (status < 200 || status >= 300)) {
    const detail = body.detail || raw.slice(0, 200) || `HTTP ${status}`;
    throw new Error(`oa_pdf ${req.source}: ${detail}`);
  }
  const hits = Array.isArray(body.hits) ? body.hits : [];
  // 0 hits + error → the source genuinely failed (network/API), not a real
  // "not found". Distinguishable in logs from a legitimate empty search.
  if (!hits.length && body.error) {
    ztoolkit.log(`oa_pdf ${req.source}: soft-fail — ${body.error}`);
  }
  return hits;
}

export function pdfUrlsFromHits(hits: OaPdfHit[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits || []) {
    const url = String(hit.pdfUrl || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function normTokens(value: string): string[] {
  return (
    (value || "")
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      // Turkish ı / İ → i so Sebastıan ≈ Sebastian (matches Python match_util).
      .replace(/\u0131/g, "i")
      .replace(/\u0130/g, "i")
      .toLocaleLowerCase("tr")
      .replace(/['`´\u2019]/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function titleOverlap(a: string, b: string): number {
  const ta = new Set(normTokens(a));
  const tb = new Set(normTokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (!inter) return 0;
  return inter / new Set([...ta, ...tb]).size;
}

/** Share of needle tokens found in haystack (asymmetric). */
function titleContainment(needle: string, haystack: string): number {
  const na = new Set(normTokens(needle));
  const hb = new Set(normTokens(haystack));
  if (!na.size || !hb.size) return 0;
  let inter = 0;
  for (const t of na) if (hb.has(t)) inter++;
  return inter / na.size;
}

/**
 * Best of Jaccard and containment (Python match_util parity).
 * Reverse containment(b→a) only when candidate b is ≥ as token-rich as a —
 * blocks short encyclopedia titles ("Golub, Leon") matching long queries.
 */
function titleMatchScore(a: string, b: string): number {
  const jac = titleOverlap(a, b);
  const cAb = titleContainment(a, b);
  const ta = normTokens(a);
  const tb = normTokens(b);
  const cBa =
    tb.length && ta.length && tb.length >= ta.length
      ? titleContainment(b, a)
      : 0;
  return Math.max(jac, cAb, cBa);
}

/** Generic words that must not alone justify a mid-band title match. */
const TITLE_STOP = new Set([
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
  "uzerine",
  "hakkinda",
  "icinde",
  "arasinda",
  "through",
  "towards",
  "against",
]);

/**
 * Mid-band scores (0.45–0.8) need every distinctive query token (≥7, not stop)
 * present in the hit title — blocks "Interview with Todd Golub" and Turkish
 * Golub essays that only share the artist name.
 */
function titleTrustOk(itemTitle: string, hitTitle: string): boolean {
  const ov = titleMatchScore(itemTitle, hitTitle);
  if (ov < 0.45) return false;
  const hitToks = new Set(normTokens(hitTitle));
  const distinctive = normTokens(itemTitle).filter(
    (t) => t.length >= 7 && !TITLE_STOP.has(t),
  );
  if (!distinctive.length) return ov >= 0.6;
  // ALL distinctive tokens required (e.g. "mercenaries" must appear).
  if (!distinctive.every((t) => hitToks.has(t))) return false;
  return ov >= 0.45;
}

export type HitTrustContext = {
  title?: string;
  doi?: string;
  /** Source id — scihub is DOI-keyed and skips title gate when DOI matches. */
  sourceId?: string;
};

/**
 * Drop low-confidence OA hits before download.
 * Keep when: DOI matches, or title match ≥ 0.45, or scihub+DOI on item.
 */
export function filterTrustedHits(
  hits: OaPdfHit[],
  ctx: HitTrustContext,
): OaPdfHit[] {
  const itemDoi = normalizeDOI(ctx.doi || "");
  const itemTitle = ctx.title || "";
  const scored: { hit: OaPdfHit; rank: number }[] = [];
  for (const hit of hits || []) {
    const url = String(hit.pdfUrl || "").trim();
    if (!url) continue;
    const hitDoi = normalizeDOI(String(hit.doi || ""));
    const doiMatch = !!(itemDoi && hitDoi && itemDoi === hitDoi);
    const hitTitle = String(hit.title || "");
    const ov = titleMatchScore(itemTitle, hitTitle);
    // DOI match is not enough alone: a wrong DOI on the item (or Unpaywall
    // returning another Golub paper) must still pass the title gate.
    if (doiMatch) {
      if (itemTitle && hitTitle && !titleTrustOk(itemTitle, hitTitle)) {
        continue;
      }
      scored.push({ hit, rank: 1 + ov });
      continue;
    }
    // Sci-Hub is DOI-keyed; still require title when both sides have one.
    if (ctx.sourceId === "scihub" && itemDoi) {
      if (itemTitle && hitTitle && !titleTrustOk(itemTitle, hitTitle)) {
        continue;
      }
      scored.push({ hit, rank: 0.9 });
      continue;
    }
    // LibGen historically set hit.title = query (always matches item title).
    // Require Python title_overlap (row vs query) when titles look identical.
    if (
      (ctx.sourceId === "libgen" || hit.source === "libgen") &&
      itemTitle &&
      String(hit.title || "")
        .trim()
        .toLowerCase() === itemTitle.trim().toLowerCase()
    ) {
      const ovExtra = Number(
        (hit.extra as Record<string, unknown> | undefined)?.title_overlap,
      );
      if (!(ovExtra >= 0.5)) {
        continue;
      }
    }
    if (itemTitle && titleTrustOk(itemTitle, String(hit.title || ""))) {
      scored.push({ hit, rank: ov });
      continue;
    }
    // Identifier-only LibGen hits often reuse the query string as title.
    if (
      itemDoi &&
      /10\.\d{4,9}\//i.test(String(hit.title || "")) &&
      normalizeDOI(String(hit.title || "")) === itemDoi
    ) {
      scored.push({ hit, rank: 0.95 });
    }
  }
  scored.sort((a, b) => b.rank - a.rank);
  return scored.map((s) => s.hit);
}

/** Trusted hits → unique PDF URLs (DOI/title gated). */
export function trustedPdfUrlsFromHits(
  hits: OaPdfHit[],
  ctx: HitTrustContext,
): string[] {
  return pdfUrlsFromHits(filterTrustedHits(hits, ctx));
}

/**
 * Fetch PDF bytes through the Kutuphane bridge for every oa_pdf_search
 * download source (YÖK session, DergiPark, PMC, Sci-Hub, LibGen, …).
 */
/** LibGen scanned books can take several minutes (md5 key refresh + stream). */
const OA_FETCH_TIMEOUT_MS = 180_000;
const OA_FETCH_TIMEOUT_LIBGEN_MS = 600_000;

export async function fetchOaPdfViaBridge(opts: {
  source: string;
  pdfUrl?: string;
  extra?: Record<string, unknown>;
}): Promise<Uint8Array | null> {
  const base = resolveOaBridgeUrl();
  const endpoint = `${base}/pdf-fetch`;
  const src = String(opts.source || "").toLowerCase();
  const timeout =
    src === "libgen" ? OA_FETCH_TIMEOUT_LIBGEN_MS : OA_FETCH_TIMEOUT_MS;
  let xhr: any;
  try {
    xhr = await (Zotero.HTTP as any).request("POST", endpoint, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: opts.source,
        pdfUrl: opts.pdfUrl || "",
        extra: opts.extra || {},
      }),
      responseType: "arraybuffer",
      timeout,
      successCodes: false,
    });
  } catch (e) {
    throw new Error(
      `oa_pdf köprü fetch kapalı (${base}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const status = Number(xhr?.status || 0);
  if (status && (status < 200 || status >= 300)) {
    let detail = "";
    try {
      const text =
        typeof xhr.responseText === "string"
          ? xhr.responseText
          : xhr.response
            ? new TextDecoder().decode(new Uint8Array(xhr.response))
            : "";
      detail = JSON.parse(text || "{}").detail || text.slice(0, 200);
    } catch {
      detail = `HTTP ${status}`;
    }
    throw new Error(`oa_pdf fetch ${opts.source}: ${detail}`);
  }
  if (!xhr?.response) return null;
  const bytes = new Uint8Array(xhr.response as ArrayBuffer);
  if (bytes.length < 5) return null;
  // %PDF
  if (
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46
  ) {
    return null;
  }
  return bytes;
}

export function hitNeedsBridgeFetch(hit: OaPdfHit, sourceId?: string): boolean {
  // All oa_pdf_search download hits use POST /pdf-fetch (YÖK session +
  // DergiPark/PMC/Sci-Hub/LibGen UA and %PDF gate). Never bare Zotero GET.
  void sourceId;
  return !!(
    String(hit.pdfUrl || "").trim() ||
    (hit.extra && hit.extra.fetchViaBridge)
  );
}

export type ContentValidateRequest = {
  title?: string;
  creators?: string;
  year?: string;
  doi?: string;
  isbn?: string;
  itemType?: string;
  pdfText?: string;
};

export type ContentValidateResult = {
  ok?: boolean;
  verdict?: "match" | "mismatch" | "unverifiable" | null;
  confidence?: number;
  reason?: string;
  error?: string;
  via?: string;
};

/** Local Ollama content check via Kutuphane bridge POST /pdf-validate-content. */
export async function validateContentViaBridge(
  req: ContentValidateRequest,
): Promise<ContentValidateResult | null> {
  const base = resolveOaBridgeUrl();
  const endpoint = `${base}/pdf-validate-content`;
  let xhr: any;
  try {
    xhr = await (Zotero.HTTP as any).request("POST", endpoint, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: req.title || "",
        creators: req.creators || "",
        year: req.year || "",
        doi: req.doi || "",
        isbn: req.isbn || "",
        itemType: req.itemType || "",
        pdfText: req.pdfText || "",
      }),
      responseType: "json",
      timeout: 120000,
      successCodes: false,
    });
  } catch (e) {
    ztoolkit.log("pdf-validate-content bridge unreachable", e);
    return null;
  }
  const status = Number(xhr?.status || 0);
  if (status && (status < 200 || status >= 300)) {
    ztoolkit.log("pdf-validate-content HTTP", status);
    return null;
  }
  const body = (xhr?.response || {}) as ContentValidateResult;
  if (!body || body.ok === false) return body || null;
  return body;
}
