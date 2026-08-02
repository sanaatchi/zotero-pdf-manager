// @ajan: cursor · @etiket: katman-2, prefs-migrate, doi-unpaywall-auto
/**
 * Prefs migrates for download cascade source roles.
 *
 * - V1: strip arxiv/s2/proquest (and historically doi) from download prefs.
 * - V2: re-enable doi as Unpaywall CAPTCHA-free OA in auto cascade.
 */
import { getPref, setPref } from "../utils/prefs";

const MIGRATE_KEY = "pdf.metadataOnlySourcesMigratedV1";
const DOI_AUTO_KEY = "pdf.doiUnpaywallAutoMigratedV1";

/** Still excluded from download cascade. */
export const METADATA_ONLY_DOWNLOAD_IDS = ["arxiv", "s2", "proquest"] as const;

export function migrateMetadataOnlyOutOfDownload(): void {
  if (getPref(MIGRATE_KEY)) return;

  setPref("pdf.arxivEnabled", false);
  setPref("pdf.s2Enabled", false);
  setPref("pdf.proquestEnabled", false);
  // doi is download (Unpaywall) — do not force-disable here.

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
      "local,doi,dergipark,pmc,libgen,scihub,yoktez,proxy",
    );
  }

  setPref(MIGRATE_KEY, true);
}

/** Enable Unpaywall doi in cascade for installs that ran V1 (doi was disabled). */
export function migrateDoiUnpaywallIntoAutoCascade(): void {
  if (getPref(DOI_AUTO_KEY)) return;

  setPref("pdf.doiEnabled", true);

  const order = String(getPref("pdf.sourceOrder") || "");
  const ids = order
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.includes("doi")) {
    const localIdx = ids.indexOf("local");
    if (localIdx >= 0) ids.splice(localIdx + 1, 0, "doi");
    else ids.unshift("doi");
    setPref("pdf.sourceOrder", ids.join(","));
  }

  setPref(DOI_AUTO_KEY, true);
}
