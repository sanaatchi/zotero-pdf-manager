// @ajan: cursor · @etiket: katman-2, python-pdf-sources, oa-pdf-bridge
/**
 * Online PDF sources backed by Kutuphane `oa_pdf_search` (8756 bridge).
 * Old in-plugin scrape/mirror logic was removed — discovery is Python-only.
 */
import { getPref } from "../utils/prefs";
import {
  buildOaSearchRequest,
  pdfUrlsFromHits,
  searchOaPdfBridge,
} from "./oaPdfBridge";
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
    const urls = pdfUrlsFromHits(hits);
    let mismatchRejects = 0;
    for (const url of urls) {
      try {
        const att = await downloadAndAttach(item, url, { sourceId: this.id });
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
    if (mismatchRejects > 0 && mismatchRejects >= urls.length) {
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
  (item) => isArticle(item) || isBook(item),
);
export const YokTezSource = new OaPdfPythonSource(
  "yoktez",
  "pdf.yoktezEnabled",
  isThesis,
);
export const ProQuestSource = new OaPdfPythonSource(
  "proquest",
  "pdf.proquestEnabled",
  (item) => isThesis(item) || isArticle(item),
);
