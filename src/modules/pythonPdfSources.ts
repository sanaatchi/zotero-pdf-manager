// @ajan: cursor · @etiket: katman-2, python-pdf-sources, yoktez-status
/**
 * Online PDF sources backed by Kutuphane `oa_pdf_search` (8756 bridge).
 * Old in-plugin scrape/mirror logic was removed — discovery is Python-only.
 */
import { getPref } from "../utils/prefs";
import {
  buildOaSearchRequest,
  filterTrustedHits,
  fetchOaPdfViaBridge,
  hitNeedsBridgeFetch,
  searchOaPdfBridge,
} from "./oaPdfBridge";
import type { OaPdfHit } from "./oaPdfBridge";
import type { PDFSource } from "./pdfSources";

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

function itemTypeName(item: Zotero.Item): string {
  try {
    return (Zotero.ItemTypes as any).getName(item.itemTypeID) as string;
  } catch {
    return "";
  }
}

const isArticle = (i: Zotero.Item) => ARTICLE_TYPES.has(itemTypeName(i));
const isBook = (i: Zotero.Item) => BOOK_TYPES.has(itemTypeName(i));
const isThesis = (i: Zotero.Item) => THESIS_TYPES.has(itemTypeName(i));

type Gate = (item: Zotero.Item) => boolean;

function prefEnabled(key: string): boolean {
  return !!getPref(key);
}

/** Human message when YÖK lists the thesis but PDF is not downloadable. */
export function yoktezUnavailableMessage(hit: OaPdfHit): string {
  const ex = (hit.extra || {}) as Record<string, unknown>;
  const no =
    ex.display_no != null && String(ex.display_no).trim()
      ? ` (Tez No: ${ex.display_no})`
      : "";
  const name = String(ex.asset_status_name || "").toUpperCase();
  const code = String(ex.asset_status ?? "");
  const info = String(ex.info_message || "").trim();
  const tag = `${name} ${code}`;
  if (/NO_PERMIT|\b3\b/.test(tag) || /izin bulunmamaktadır/i.test(info)) {
    return (
      `Tez YÖKTez’de bulundu${no}, ancak çevrimiçi PDF izni yok` +
      (info ? ` — ${info}` : " (TÜBESS / üniversite kütüphanesi).")
    );
  }
  if (/UNDER_EMBARGO|\b2\b/.test(tag) || /embargo/i.test(info)) {
    return (
      `Tez YÖKTez’de bulundu${no}, ancak embargolu` +
      (info ? ` — ${info}` : ".")
    );
  }
  if (/PREPARING|\b4\b/.test(tag)) {
    return `Tez YÖKTez’de bulundu${no}, ancak PDF henüz hazır değil.`;
  }
  return (
    `Tez YÖKTez’de bulundu${no}, ancak indirilebilir PDF yok` +
    (info ? ` — ${info}` : ".")
  );
}

export class OaPdfPythonSource implements PDFSource {
  constructor(
    readonly id: string,
    private readonly prefKey: string,
    private readonly gate: Gate = () => true,
  ) {}

  isEnabled() {
    return prefEnabled(this.prefKey);
  }

  supportsItem(item: Zotero.Item) {
    return this.gate(item);
  }

  async tryAttach(item: Zotero.Item) {
    const pdfSources = await import("./pdfSources");
    const {
      downloadAndAttach,
      rethrowAttachControlFlow,
      isContentMismatchError,
    } = pdfSources;
    const req = buildOaSearchRequest(this.id, item, 5);
    if (
      !req.text &&
      !req.doi &&
      !req.isbn &&
      !req.arxivId &&
      !req.pmid &&
      !req.pmcid
    ) {
      return null;
    }
    let hits;
    try {
      hits = await searchOaPdfBridge(req);
    } catch (e) {
      rethrowAttachControlFlow(e);
      throw e;
    }

    // YÖK often finds the record with NO_PERMIT / embargo (no pdfUrl).
    // Do not report that as "bulunamadı".
    if (this.id === "yoktez" && hits.length) {
      const downloadable = hits.filter((h) => String(h.pdfUrl || "").trim());
      if (!downloadable.length) {
        throw new Error(yoktezUnavailableMessage(hits[0]));
      }
    }

    const trusted = filterTrustedHits(hits, {
      title: String(item.getField("title") || ""),
      doi: req.doi || "",
      sourceId: this.id,
    });
    if (!trusted.length) {
      ztoolkit.log(`oa_pdf ${this.id}: no trusted hits after title/DOI gate`);
      return null;
    }
    let mismatchRejects = 0;
    let attempted = 0;
    for (const hit of trusted) {
      const url = String(hit.pdfUrl || "").trim();
      if (!url) continue;
      attempted++;
      try {
        let bytes: Uint8Array | null = null;
        if (hitNeedsBridgeFetch(hit, this.id)) {
          bytes = await fetchOaPdfViaBridge({
            source: this.id,
            pdfUrl: url,
            extra: (hit.extra || {}) as Record<string, unknown>,
          });
          if (!bytes) {
            ztoolkit.log(`oa_pdf ${this.id} bridge fetch empty`, url);
            continue;
          }
        }
        const att = await downloadAndAttach(item, url, {
          sourceId: this.id,
          bytes,
        });
        if (att) return att;
      } catch (e) {
        rethrowAttachControlFlow(e);
        if (isContentMismatchError(e)) {
          mismatchRejects++;
          ztoolkit.log(`oa_pdf ${this.id} rejected by metadata check`, e);
          continue;
        }
        ztoolkit.log(`oa_pdf ${this.id} attach failed`, e);
      }
    }
    if (mismatchRejects > 0 && mismatchRejects >= attempted) {
      throw new pdfSources.ContentMismatchError(
        `${this.id}: ${mismatchRejects} aday PDF künye ile uyuşmadı`,
      );
    }
    return null;
  }
}

/** Institutional proxy — still local (URL prefix); not an oa_pdf_search adapter. */
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
    const { downloadAndAttach } = await import("./pdfSources");
    const prefix = ((getPref("pdf.proxyURL") as string) || "").trim();
    const url = (item.getField("url") as string) || "";
    if (!prefix || !url) return null;
    return await downloadAndAttach(item, prefix + url, { sourceId: "proxy" });
  }
}

export const DOISource = new OaPdfPythonSource("doi", "pdf.doiEnabled");
export const ArxivSource = new OaPdfPythonSource(
  "arxiv",
  "pdf.arxivEnabled",
  isArticle,
);
export const PMCSource = new OaPdfPythonSource(
  "pmc",
  "pdf.pmcEnabled",
  isArticle,
);
export const SemanticScholarSource = new OaPdfPythonSource(
  "s2",
  "pdf.s2Enabled",
  isArticle,
);
export const DergiParkSource = new OaPdfPythonSource(
  "dergipark",
  "pdf.dergiparkEnabled",
  // DergiPark: yalnızca bilimsel dergi makalesi (journalArticle).
  (item) => itemTypeName(item) === "journalArticle",
);
export const SciHubSource = new OaPdfPythonSource(
  "scihub",
  "pdf.scihubEnabled",
  isArticle,
);
export const LibGenSource = new OaPdfPythonSource(
  "libgen",
  "pdf.libgenEnabled",
  // Books + foreign articles (LibGen is book-heavy but holds many non-TR papers).
  // Turkish articles stay on DergiPark/PMC/… via prioritizeSourcesForItem.
  (item) => isBook(item) || isArticle(item),
);
export const YokTezSource = new OaPdfPythonSource(
  "yoktez",
  "pdf.yoktezEnabled",
  isThesis,
);
/** Metadata-only — not registered in ALL_SOURCES download cascade. */
export const ProQuestSource = new OaPdfPythonSource(
  "proquest",
  "pdf.proquestEnabled",
  (item) => isThesis(item) || isArticle(item),
);
