// @ajan: cursor · @etiket: katman-2, prefs-migrate, mir-az
/**
 * One-time prefs migration: insert ``mir_az`` into legacy sourceOrder.
 * Creds stay empty — user fills Mir.az email/password in prefs.
 */
import { getPref, setPref } from "../utils/prefs";

const MIGRATE_KEY = "pdf.mirAzSourcesMigratedV1";

export function migrateMirAzPdfSource(): void {
  if (getPref(MIGRATE_KEY)) return;

  const order = String(getPref("pdf.sourceOrder") || "");
  const ids = order
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.includes("mir_az")) {
    let insertAt = ids.indexOf("dirzon");
    if (insertAt < 0) insertAt = ids.indexOf("pdfkitap");
    if (insertAt < 0) insertAt = ids.indexOf("libgen");
    if (insertAt >= 0) {
      ids.splice(insertAt + 1, 0, "mir_az");
    } else {
      ids.push("mir_az");
    }
    setPref("pdf.sourceOrder", ids.join(","));
  }

  setPref(MIGRATE_KEY, true);
}
