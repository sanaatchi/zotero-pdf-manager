// @ajan: cursor · @etiket: katman-2, oa-pdf-bridge, fetch-502-header
/**
 * Katman-2 → Kutuphane köprü (8756) `oa_pdf_search` client.
 * Online PDF discovery runs in Python; this module only POSTs queries.
 * LibGen book PDFs: long fetch timeout (keys refresh + multi-minute download).
 * Bridge base URL is loopback-only (same SSRF policy as K1/K3).
 * Manual OA Search sends allowWebSearch=true (DergiPark DDG last-resort).
 * Download & attach embeds kind criteria from the Zotero item automatically.
 */
import { getPref, setPref } from "../utils/prefs";
import { normalizeDOI } from "../utils/metadataNormalize";
import {
  DEFAULT_OA_BRIDGE_URL,
  isAllowedOaBridgeUrl,
  normalizeOaBridgeUrl,
} from "../utils/oaBridgeUrl";
import { kindFromZoteroItemType } from "./oaSearchCriteria";

export { DEFAULT_OA_BRIDGE_URL, isAllowedOaBridgeUrl, normalizeOaBridgeUrl };

export type OaPdfHit = {
  source: string;
  title: string;
  pdfUrl?: string | null;
  landingUrl?: string | null;
  doi?: string | null;
  year?: string | null;
  authors?: string | null;
  score?: number;
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
  /** Federated (source=all): subset of adapters; omit → profile. */
  sources?: string[];
  profile?: "full" | "auto";
  totalLimit?: number;
  /** Manual/user-triggered search only (OA Search window) — never set from
   * the automatic add-item cascade. Unlocks fragile last-resort discovery
   * (e.g. DergiPark's DuckDuckGo fallback) that must not fire unattended. */
  allowWebSearch?: boolean;
  /** book | journalArticle | bookSection | thesis */
  kind?: string;
  year?: string;
  language?: string;
  translator?: string;
  publication?: string;
  editors?: string;
  bookTitle?: string;
  publisher?: string;
  thesisType?: string;
  university?: string;
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
  errors?: Record<string, string>;
  sourcesQueried?: string[];
  profile?: string;
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

export function safeItemField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as any) || "").trim();
  } catch {
    return "";
  }
}

export function yearFromItemDate(raw: string): string {
  const s = String(raw || "").trim();
  const m = s.match(/\b(1[4-9]\d{2}|20\d{2})\b/);
  return m ? m[1]! : "";
}

function creatorsByType(item: Zotero.Item, types: string[], limit = 4): string {
  try {
    const want = new Set(types.map((t) => t.toLowerCase()));
    const creators = item.getCreators() as Array<{
      lastName?: string;
      firstName?: string;
      name?: string;
      creatorType?: string;
    }>;
    return (creators || [])
      .filter((c) => want.has(String(c.creatorType || "author").toLowerCase()))
      .slice(0, limit)
      .map((c) =>
        String(
          c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
        ).trim(),
      )
      .filter(Boolean)
      .join("; ");
  } catch {
    return "";
  }
}

/** Build search fields from a Zotero item for one oa_pdf_search source id. */
export function buildOaSearchRequest(
  sourceId: string,
  item: Zotero.Item,
  limit = 5,
): OaPdfSearchRequest {
  const title = safeItemField(item, "title");
  const doi = itemDOI(item);
  const isbn = safeItemField(item, "ISBN").replace(/[^0-9Xx]/g, "");
  const extra = safeItemField(item, "extra");
  const urlField = safeItemField(item, "url");
  const hay = `${urlField}\n${extra}`;

  let itemTypeName = "";
  try {
    itemTypeName = String(
      (Zotero.ItemTypes as any)?.getName?.(item.itemTypeID) || "",
    );
  } catch {
    itemTypeName = "";
  }
  const resolvedKind = kindFromZoteroItemType(itemTypeName);

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

  const authors = creatorsByType(item, ["author"], 4);
  const editors = creatorsByType(item, ["editor"], 4);
  const translator = creatorsByType(item, ["translator"], 3);
  const year = yearFromItemDate(safeItemField(item, "date"));
  const language = safeItemField(item, "language");
  const publication = safeItemField(item, "publicationTitle");
  const bookTitle = safeItemField(item, "bookTitle");
  const publisher = safeItemField(item, "publisher");
  const thesisType = safeItemField(item, "thesisType");
  const university = safeItemField(item, "university");

  // LibGen: core title before colon + author surnames (long subtitles miss catalog).
  if (sourceId === "libgen" && title) {
    const colon = title.search(/\s*[:—–]\s*/);
    if (colon >= 8) {
      text = title.slice(0, colon).trim();
    }
  }

  // Book section: include container book title in remote text (parity with
  // Python compose_remote_text).
  if (resolvedKind === "bookSection" && bookTitle && text) {
    if (!text.toLowerCase().includes(bookTitle.toLowerCase())) {
      text = `${text} ${bookTitle}`.trim();
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
    kind: resolvedKind,
    year,
    language,
    translator,
    publication,
    editors,
    bookTitle,
    publisher,
    thesisType,
    university,
  };
}

export async function searchOaPdfBridge(
  req: OaPdfSearchRequest,
): Promise<OaPdfHit[]> {
  const body = await searchOaPdfBridgeDetailed(req);
  return Array.isArray(body.hits) ? body.hits : [];
}

/** Full bridge response (federated errors / sourcesQueried included). */
export async function searchOaPdfBridgeDetailed(
  req: OaPdfSearchRequest,
): Promise<OaPdfSearchResponse> {
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
        sources: req.sources || [],
        profile: req.profile || "full",
        totalLimit: req.totalLimit ?? 25,
        allowWebSearch: req.allowWebSearch ?? false,
        kind: req.kind || "",
        year: req.year || "",
        language: req.language || "",
        translator: req.translator || "",
        publication: req.publication || "",
        editors: req.editors || "",
        bookTitle: req.bookTitle || "",
        publisher: req.publisher || "",
        thesisType: req.thesisType || "",
        university: req.university || "",
      }),
      responseType: "text",
      timeout: 180000,
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
  if (!hits.length && body.error) {
    ztoolkit.log(`oa_pdf ${req.source}: soft-fail — ${body.error}`);
  }
  return body;
}

/** Fire-and-forget cascade / download-report miss → ``POST /pdf-search-log``. */
export async function logOaCascadeMiss(
  body: Record<string, unknown>,
): Promise<boolean> {
  const base = resolveOaBridgeUrl();
  const endpoint = `${base}/pdf-search-log`;
  try {
    const xhr = await (Zotero.HTTP as any).request("POST", endpoint, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      responseType: "text",
      timeout: 4000,
      successCodes: false,
    });
    const status = Number(xhr?.status || 0);
    return status >= 200 && status < 300;
  } catch (e) {
    try {
      ztoolkit.log("oa_pdf cascade log failed", e);
    } catch {
      /* tests / headless */
    }
    return false;
  }
}

/** Pref keys for federated download adapters (excludes local/proxy). */
export const FEDERATED_SOURCE_PREF: Record<string, string> = {
  doi: "pdf.doiEnabled",
  dergipark: "pdf.dergiparkEnabled",
  pmc: "pdf.pmcEnabled",
  arxiv: "pdf.arxivEnabled",
  s2: "pdf.s2Enabled",
  yoktez: "pdf.yoktezEnabled",
  scihub: "pdf.scihubEnabled",
  libgen: "pdf.libgenEnabled",
  zenodo: "pdf.zenodoEnabled",
  archive: "pdf.archiveEnabled",
  openaire: "pdf.openaireEnabled",
  core: "pdf.coreEnabled",
};

/** Display labels for OA Search source picker (stable ids). */
export const FEDERATED_SOURCE_LABEL: Record<string, string> = {
  doi: "DOI",
  dergipark: "DergiPark",
  pmc: "PMC",
  arxiv: "arXiv",
  s2: "S2",
  yoktez: "YÖK Tez",
  scihub: "Sci-Hub",
  libgen: "LibGen",
  zenodo: "Zenodo",
  archive: "Internet Archive",
  openaire: "OpenAIRE",
  core: "CORE",
};

export function allFederatedSourceIds(): string[] {
  return Object.keys(FEDERATED_SOURCE_PREF);
}

/** Enabled OA download source ids for federated search (prefs filter). */
export function enabledFederatedSourceIds(): string[] {
  const out: string[] = [];
  for (const [id, pref] of Object.entries(FEDERATED_SOURCE_PREF)) {
    try {
      if (getPref(pref)) out.push(id);
    } catch {
      /* ignore */
    }
  }
  return out;
}

const OA_SEARCH_SOURCES_PREF = "pdf.oaSearchSources";

/** Last OA Search window source selection (comma-separated ids). */
export function loadOaSearchSourceSelection(): string[] {
  const known = new Set(allFederatedSourceIds());
  try {
    const raw = String(getPref(OA_SEARCH_SOURCES_PREF) || "").trim();
    if (raw) {
      const picked = raw
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((id) => known.has(id));
      if (picked.length) return [...new Set(picked)];
    }
  } catch {
    /* ignore */
  }
  const enabled = enabledFederatedSourceIds();
  return enabled.length ? enabled : allFederatedSourceIds();
}

export function saveOaSearchSourceSelection(ids: string[]): void {
  const known = new Set(allFederatedSourceIds());
  const cleaned = [
    ...new Set(
      (ids || [])
        .map((s) =>
          String(s || "")
            .trim()
            .toLowerCase(),
        )
        .filter((id) => known.has(id)),
    ),
  ];
  try {
    setPref(OA_SEARCH_SOURCES_PREF, cleaned.join(","));
  } catch {
    /* ignore */
  }
}

/**
 * Federated search across prefs-enabled download adapters.
 * Does not change automatic cascade policy.
 */
export async function searchAllOaSources(
  item: Zotero.Item,
  opts: { profile?: "full" | "auto"; totalLimit?: number } = {},
): Promise<OaPdfSearchResponse> {
  const sources = enabledFederatedSourceIds();
  const base = buildOaSearchRequest("doi", item, 5);
  return searchAllOaSourcesByQuery(
    {
      text: base.text,
      doi: base.doi,
      isbn: base.isbn,
      arxivId: base.arxivId,
      pmid: base.pmid,
      pmcid: base.pmcid,
      authors: base.authors,
      kind: base.kind,
      year: base.year,
      language: base.language,
      translator: base.translator,
      publication: base.publication,
      editors: base.editors,
      bookTitle: base.bookTitle,
      publisher: base.publisher,
      thesisType: base.thesisType,
      university: base.university,
    },
    {
      profile: opts.profile || "full",
      totalLimit: opts.totalLimit ?? 25,
      sources,
    },
  );
}

/** Federated search from free-form / kind-structured query fields. */
export async function searchAllOaSourcesByQuery(
  query: {
    text?: string;
    doi?: string;
    isbn?: string;
    authors?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
    kind?: string;
    year?: string;
    language?: string;
    translator?: string;
    publication?: string;
    editors?: string;
    bookTitle?: string;
    publisher?: string;
    thesisType?: string;
    university?: string;
  },
  opts: {
    profile?: "full" | "auto";
    totalLimit?: number;
    /** Omit / empty → bridge uses full download profile. */
    sources?: string[];
  } = {},
): Promise<OaPdfSearchResponse> {
  const sources =
    opts.sources !== undefined ? opts.sources : enabledFederatedSourceIds();
  const req: OaPdfSearchRequest = {
    source: "all",
    text: String(query.text || "").trim(),
    doi: String(query.doi || "").trim(),
    isbn: String(query.isbn || "")
      .replace(/[^0-9Xx]/g, "")
      .trim(),
    arxivId: String(query.arxivId || "").trim(),
    pmid: String(query.pmid || "").trim(),
    pmcid: String(query.pmcid || "").trim(),
    authors: String(query.authors || "").trim(),
    kind: String(query.kind || "").trim(),
    year: String(query.year || "").trim(),
    language: String(query.language || "").trim(),
    translator: String(query.translator || "").trim(),
    publication: String(query.publication || "").trim(),
    editors: String(query.editors || "").trim(),
    bookTitle: String(query.bookTitle || "").trim(),
    publisher: String(query.publisher || "").trim(),
    thesisType: String(query.thesisType || "").trim(),
    university: String(query.university || "").trim(),
    limit: 5,
    profile: opts.profile || "full",
    totalLimit: opts.totalLimit ?? 25,
    // Both callers (searchAllOaSources item menu, OA Search popup) are
    // user-triggered — safe to unlock the DuckDuckGo last-resort fallback.
    allowWebSearch: true,
  };
  // Only send sources when non-empty so bridge falls back to full profile.
  if (sources.length) req.sources = sources;
  try {
    return await searchOaPdfBridgeDetailed(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Stale bridge (pre-federated) rejects source=all — fan out per source.
    if (!/Unknown source ['"]?all/i.test(msg)) throw e;
    ztoolkit.log(
      "OA federated source=all rejected by bridge — client fan-out fallback",
      msg,
    );
    return fanOutOaSourcesByQuery(query, {
      sources: sources.length ? sources : enabledFederatedSourceIds(),
      totalLimit: opts.totalLimit ?? 25,
      perSourceLimit: req.limit ?? 5,
    });
  }
}

/** Client-side federated fallback when bridge lacks source=all. */
export async function fanOutOaSourcesByQuery(
  query: {
    text?: string;
    doi?: string;
    isbn?: string;
    authors?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
  },
  opts: {
    sources: string[];
    totalLimit?: number;
    perSourceLimit?: number;
  },
): Promise<OaPdfSearchResponse> {
  const sourceIds = (opts.sources || []).filter(Boolean);
  const totalLimit = opts.totalLimit ?? 25;
  const perSourceLimit = opts.perSourceLimit ?? 5;
  const errors: Record<string, string> = {};
  const hits: OaPdfHit[] = [];
  const seen = new Set<string>();

  await Promise.all(
    sourceIds.map(async (sid) => {
      try {
        const body = await searchOaPdfBridgeDetailed({
          source: sid,
          text: String(query.text || "").trim(),
          doi: String(query.doi || "").trim(),
          isbn: String(query.isbn || "")
            .replace(/[^0-9Xx]/g, "")
            .trim(),
          arxivId: String(query.arxivId || "").trim(),
          pmid: String(query.pmid || "").trim(),
          pmcid: String(query.pmcid || "").trim(),
          authors: String(query.authors || "").trim(),
          limit: perSourceLimit,
          // Only reachable from user-triggered federated search paths.
          allowWebSearch: true,
        });
        if (body.error) errors[sid] = String(body.error);
        for (const hit of body.hits || []) {
          const key = `${hit.source}|${hit.pdfUrl || hit.landingUrl || hit.title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push(hit);
        }
      } catch (e) {
        errors[sid] = e instanceof Error ? e.message : String(e);
      }
    }),
  );

  // Single-source /pdf-search responses never carry a top-level `score`
  // (only federated `source=all` payloads do) — sorting by it here was a
  // no-op (always 0-0), leaving results in network-completion order
  // instead of relevance order. Fall back to the per-hit rank the source
  // adapters already compute into `extra`.
  const hitScore = (h: OaPdfHit): number =>
    Number(
      h.score ?? (h.extra as any)?.rank ?? (h.extra as any)?.title_overlap ?? 0,
    );
  hits.sort((a, b) => hitScore(b) - hitScore(a));
  return {
    ok: true,
    source: "all",
    profile: "full",
    sourcesQueried: sourceIds,
    hits: hits.slice(0, totalLimit),
    errors: Object.keys(errors).length ? errors : undefined,
  };
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
 * Mid-band scores need required query tokens present in the hit title.
 * Soft typo: edit-distance ≤1 on tokens ≥6 (eğitimi ↔ eğilimi) — not 2
 * (Turkish morphology: toplumda ≉ toplumsal).
 * Short titles (≤3 content tokens or ≤1 distinctive ≥7): every content
 * token + score ≥0.75 (blocks "sahteciliği"-only forgery matches).
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return 99;
  if (!la || !lb) return Math.max(la, lb);
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 0; i < la; i++) {
    const cur = [i + 1];
    for (let j = 0; j < lb; j++) {
      const ins = cur[j]! + 1;
      const del = prev[j + 1]! + 1;
      const sub = prev[j]! + (a[i] === b[j] ? 0 : 1);
      cur.push(Math.min(ins, del, sub));
    }
    prev = cur;
  }
  return prev[lb]!;
}

function tokenInFuzzy(needle: string, haystack: Set<string>): boolean {
  if (haystack.has(needle)) return true;
  if (needle.length < 6) return false;
  for (const h of haystack) {
    if (Math.abs(h.length - needle.length) > 1) continue;
    if (editDistance(needle, h) <= 1) return true;
  }
  return false;
}

const TITLE_STOP_TRUST = new Set([
  ...TITLE_STOP,
  "calismasi",
  "calisma",
  "iliskisi",
  "arasindaki",
  "incelenmesi",
  "degerlendirme",
]);

function titleTrustOk(itemTitle: string, hitTitle: string): boolean {
  const ov = titleMatchScore(itemTitle, hitTitle);
  if (ov < 0.45) return false;
  const qToks = normTokens(itemTitle).filter((t) => !TITLE_STOP_TRUST.has(t));
  let need = normTokens(itemTitle).filter(
    (t) => t.length >= 7 && !TITLE_STOP_TRUST.has(t),
  );
  const shortQuery = qToks.length <= 3 || need.length <= 1;
  if (shortQuery) {
    need = qToks.length ? qToks : normTokens(itemTitle);
    if (ov < 0.75) return false;
  }
  if (!need.length) return ov >= 0.6;
  const hitToks = new Set(normTokens(hitTitle));
  if (need.every((t) => tokenInFuzzy(t, hitToks))) return true;
  if (shortQuery || ov < 0.85) return false;
  const misses = need.filter((t) => !tokenInFuzzy(t, hitToks));
  if (misses.length !== 1) return false;
  const m = misses[0]!;
  if (m.length < 8) return false;
  for (const h of hitToks) {
    if (Math.abs(h.length - m.length) > 2) continue;
    if (editDistanceAllow2(m, h) <= 2) return true;
  }
  return false;
}

function editDistanceAllow2(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return 99;
  if (!la || !lb) return Math.max(la, lb);
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 0; i < la; i++) {
    const cur = [i + 1];
    for (let j = 0; j < lb; j++) {
      const ins = cur[j]! + 1;
      const del = prev[j + 1]! + 1;
      const sub = prev[j]! + (a[i] === b[j] ? 0 : 1);
      cur.push(Math.min(ins, del, sub));
    }
    prev = cur;
  }
  return prev[lb]!;
}

export type HitTrustContext = {
  title?: string;
  doi?: string;
  /** Source id — scihub is DOI-keyed and skips title gate when DOI matches. */
  sourceId?: string;
  /** Soft year gate (Download & attach / OA criteria). */
  year?: string;
};

function yearToken(raw: string): string {
  const m = String(raw || "")
    .trim()
    .match(/\b(1[4-9]\d{2}|20\d{2})\b/);
  return m ? m[1]! : "";
}

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
  const wantYear = yearToken(ctx.year || "");
  const scored: { hit: OaPdfHit; rank: number }[] = [];
  for (const hit of hits || []) {
    const url = String(hit.pdfUrl || "").trim();
    if (!url) continue;
    if (wantYear) {
      const hitYear = yearToken(
        String(hit.year || "") || String((hit.extra as any)?.year || ""),
      );
      if (hitYear) {
        const delta = Math.abs(Number(wantYear) - Number(hitYear));
        if (delta > 1) continue;
      }
    }
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
  onProgress?: (loaded: number, total: number) => void;
  /** ProgressWindow line label (item title). */
  label?: string;
  /** Isolate concurrent downloads; auto-generated when omitted. */
  progressJob?: string;
}): Promise<Uint8Array | null> {
  const base = resolveOaBridgeUrl();
  const endpoint = `${base}/pdf-fetch`;
  const src = String(opts.source || "").toLowerCase();
  const timeout =
    src === "libgen" ? OA_FETCH_TIMEOUT_LIBGEN_MS : OA_FETCH_TIMEOUT_MS;

  const {
    startBridgeFetchProgressPoll,
    reportDownloadProgress,
    newDownloadJobId,
    registerDownloadJob,
    finishDownloadJob,
  } = await import("../utils/downloadProgress");
  const jobId = String(opts.progressJob || "").trim() || newDownloadJobId();
  registerDownloadJob(jobId, {
    source: src || "oa",
    title: String(opts.label || opts.pdfUrl || "").trim(),
  });
  const stopPoll = startBridgeFetchProgressPoll(
    base,
    (p) => {
      opts.onProgress?.(p.loaded, p.total);
    },
    { jobId },
  );

  let xhr: any;
  try {
    xhr = await (Zotero.HTTP as any).request("POST", endpoint, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: opts.source,
        pdfUrl: opts.pdfUrl || "",
        extra: opts.extra || {},
        progressJob: jobId,
      }),
      responseType: "arraybuffer",
      timeout,
      successCodes: false,
      requestObserver: (req: XMLHttpRequest) => {
        try {
          req.addEventListener("progress", (ev: ProgressEvent) => {
            const loaded = Number(ev.loaded || 0);
            const total = ev.lengthComputable ? Number(ev.total || 0) : 0;
            reportDownloadProgress(loaded, total, jobId);
            opts.onProgress?.(loaded, total);
          });
        } catch {
          /* ignore */
        }
      },
    });
  } catch (e) {
    stopPoll();
    finishDownloadJob(jobId, { ok: false });
    throw new Error(
      `oa_pdf köprü fetch kapalı (${base}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  stopPoll();
  const status = Number(xhr?.status || 0);
  if (status && (status < 200 || status >= 300)) {
    let detail = "";
    try {
      const raw = xhr?.response;
      let text = "";
      if (typeof xhr?.responseText === "string" && xhr.responseText) {
        text = xhr.responseText;
      } else if (typeof raw === "string") {
        text = raw;
      } else if (raw != null) {
        const bytes =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : raw instanceof Uint8Array
              ? raw
              : new Uint8Array(raw);
        text = new TextDecoder().decode(bytes);
      }
      text = String(text || "").trim();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { detail?: unknown };
          const d = parsed?.detail;
          if (typeof d === "string" && d.trim()) detail = d.trim();
          else if (Array.isArray(d))
            detail = d
              .map((x) =>
                typeof x === "string"
                  ? x
                  : x && typeof x === "object" && "msg" in x
                    ? String((x as any).msg)
                    : JSON.stringify(x),
              )
              .filter(Boolean)
              .join("; ");
          else if (d != null) detail = String(d);
        } catch {
          detail = text.slice(0, 300);
        }
      }
    } catch {
      detail = "";
    }
    if (!detail) {
      try {
        const hdr =
          xhr?.getResponseHeader?.("X-OA-Fetch-Error") ||
          xhr?.getResponseHeader?.("x-oa-fetch-error");
        if (hdr && String(hdr).trim()) detail = String(hdr).trim();
      } catch {
        /* ignore */
      }
    }
    if (!detail) {
      detail = `köprü PDF indirme başarısız (HTTP ${status})`;
    }
    finishDownloadJob(jobId, { ok: false });
    throw new Error(`oa_pdf fetch ${opts.source}: ${detail}`);
  }
  if (!xhr?.response) {
    finishDownloadJob(jobId, { ok: false });
    return null;
  }
  const bytes = new Uint8Array(xhr.response as ArrayBuffer);
  if (bytes.length < 5) {
    finishDownloadJob(jobId, { ok: false });
    return null;
  }
  // %PDF
  if (
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46
  ) {
    finishDownloadJob(jobId, { ok: false });
    return null;
  }
  reportDownloadProgress(bytes.length, bytes.length, jobId);
  finishDownloadJob(jobId, { ok: true });
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
