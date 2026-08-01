// @ajan: cursor · @etiket: katman-2, oa-pdf-bridge, libgen-trust
/**
 * Katman-2 → Kutuphane köprü (8756) `oa_pdf_search` client.
 * Online PDF discovery runs in Python; this module only POSTs queries.
 */
import { getPref } from "../utils/prefs";
import { normalizeDOI } from "../utils/metadataNormalize";

export const DEFAULT_OA_BRIDGE_URL = "http://127.0.0.1:8756";

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
  limit?: number;
};

export type OaPdfSearchResponse = {
  ok?: boolean;
  source?: string;
  hits?: OaPdfHit[];
  detail?: string;
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
  const raw = String(getPref("pdf.oaBridgeUrl") || "").trim();
  const url = (raw || DEFAULT_OA_BRIDGE_URL).replace(/\/+$/, "");
  return url || DEFAULT_OA_BRIDGE_URL;
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

  const text =
    sourceId === "yoktez" && yokNo && !title.includes(yokNo)
      ? `${title} ${yokNo}`.trim()
      : title;

  return {
    source: sourceId,
    text,
    doi,
    isbn,
    arxivId,
    pmid,
    pmcid,
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
  return Array.isArray(body.hits) ? body.hits : [];
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

/** Best of Jaccard and either-direction containment (matches Python match_util). */
function titleMatchScore(a: string, b: string): number {
  return Math.max(
    titleOverlap(a, b),
    titleContainment(a, b),
    titleContainment(b, a),
  );
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
    const ov = titleMatchScore(itemTitle, String(hit.title || ""));
    if (doiMatch) {
      scored.push({ hit, rank: 1 + ov });
      continue;
    }
    // Sci-Hub pages are DOI-addressed; trust when the item already has a DOI
    // (wrong DOI is a separate ensureDOI problem).
    if (ctx.sourceId === "scihub" && itemDoi) {
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
    if (ov >= 0.45) {
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
export async function fetchOaPdfViaBridge(opts: {
  source: string;
  pdfUrl?: string;
  extra?: Record<string, unknown>;
}): Promise<Uint8Array | null> {
  const base = resolveOaBridgeUrl();
  const endpoint = `${base}/pdf-fetch`;
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
      timeout: 180000,
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
