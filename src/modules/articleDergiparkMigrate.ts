// @ajan: cursor · @etiket: katman-2, prefs-migrate, dergipark-articles
/**
 * One-time prefs: enable DergiPark; place it early in sourceOrder.
 * Turkish journal articles use DergiPark exclusively via sourcePriority.
 */
import { getPref, setPref } from "../utils/prefs";

const MIGRATE_KEY = "pdf.articleDergiparkMigratedV1";

export function migrateArticleDergiparkPriority(): void {
  if (getPref(MIGRATE_KEY)) return;

  setPref("pdf.dergiparkEnabled", true);

  const order = String(getPref("pdf.sourceOrder") || "");
  const ids = order
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((id) => id !== "dergipark");
  const localIdx = ids.indexOf("local");
  if (localIdx >= 0) {
    ids.splice(localIdx + 1, 0, "dergipark");
  } else {
    ids.unshift("dergipark");
  }
  setPref("pdf.sourceOrder", ids.join(","));

  setPref(MIGRATE_KEY, true);
}
