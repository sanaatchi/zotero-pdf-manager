// @ajan: cursor · @etiket: katman-2, oa-pdf-bridge, python
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
  return (value || "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
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

export type HitTrustContext = {
  title?: string;
  doi?: string;
  /** Source id — scihub is DOI-keyed and skips title gate when DOI matches. */
  sourceId?: string;
};

/**
 * Drop low-confidence OA hits before download.
 * Keep when: DOI matches, or title overlap ≥ 0.45, or scihub+DOI on item.
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
    const ov = titleOverlap(itemTitle, String(hit.title || ""));
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
