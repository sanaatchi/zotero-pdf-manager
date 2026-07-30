// @ajan: cursor · @etiket: katman-2, prefs-migrate, libgen-books
/**
 * One-time prefs migration so book downloads actually try LibGen.
 *
 * Older installs used sourceOrder without `libgen` and kept libgenEnabled=false.
 * Manual download then only hit local/doi + article OA → every book failed with
 * "tür desteklenmiyor" on arxiv/pmc/s2.
 */
import { getPref, setPref } from "../utils/prefs";

const MIGRATE_KEY = "pdf.bookSourcesMigratedV2";

export function migrateBookPdfSources(): void {
  if (getPref(MIGRATE_KEY)) return;

  // Opt users who never opened LibGen into the book path (still manual cascade;
  // never added to AUTOMATIC_ONLINE_SOURCE_IDS).
  setPref("pdf.libgenEnabled", true);
  setPref("pdf.yoktezEnabled", true);

  const order = String(getPref("pdf.sourceOrder") || "");
  const ids = order
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.includes("libgen")) {
    let insertAt = ids.indexOf("dergipark");
    if (insertAt < 0) insertAt = ids.indexOf("s2");
    if (insertAt >= 0) {
      ids.splice(insertAt + 1, 0, "libgen");
    } else {
      ids.push("libgen");
    }
    setPref("pdf.sourceOrder", ids.join(","));
  }

  setPref(MIGRATE_KEY, true);
}
