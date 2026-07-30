// @ajan: cursor · @etiket: katman-2, prefs-migrate, metadata-only
/**
 * Strip metadata-only adapters from the PDF download cascade.
 *
 * doi / arxiv / s2 / proquest remain available via oa_pdf_search (role=metadata)
 * for lookup / validation; they must not appear in sourceOrder or download prefs.
 */
import { getPref, setPref } from "../utils/prefs";

const MIGRATE_KEY = "pdf.metadataOnlySourcesMigratedV1";

export const METADATA_ONLY_DOWNLOAD_IDS = [
  "doi",
  "arxiv",
  "s2",
  "proquest",
] as const;

export function migrateMetadataOnlyOutOfDownload(): void {
  if (getPref(MIGRATE_KEY)) return;

  setPref("pdf.doiEnabled", false);
  setPref("pdf.arxivEnabled", false);
  setPref("pdf.s2Enabled", false);
  setPref("pdf.proquestEnabled", false);

  const order = String(getPref("pdf.sourceOrder") || "");
  const skip = new Set<string>(METADATA_ONLY_DOWNLOAD_IDS);
  const ids = order
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((id) => !skip.has(id));
  if (ids.length) {
    setPref("pdf.sourceOrder", ids.join(","));
  } else {
    setPref(
      "pdf.sourceOrder",
      "local,dergipark,pmc,libgen,scihub,yoktez,proxy",
    );
  }

  setPref(MIGRATE_KEY, true);
}
