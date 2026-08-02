// @ajan: cursor · @etiket: katman-2, b5-dup-report, item-duplicate
/**
 * Report duplicate-item candidates in the current selection (read-only).
 * Master merge stays with companion Zoplicate XPI.
 */

import { getString } from "../utils/locale";
import { extractKpToken } from "../utils/duplicateItemReport";
import {
  findDuplicateGroups,
  formatDuplicateReportLines,
  type DupItemSnap,
} from "../utils/duplicateItemReport";

export { reportDuplicateItemsForSelection };

function alertDialog(message: string) {
  ztoolkit.getGlobal("alert")(message);
}

function snapFromItem(item: Zotero.Item): DupItemSnap {
  const title = String(item.getField("title") || "");
  const extra = String(item.getField("extra") || "");
  const kp =
    extractKpToken(extra) ||
    extractKpToken(title) ||
    extractKpToken(String(item.getField("callNumber") || ""));
  return {
    itemId: item.id,
    title: title || `#${item.id}`,
    doi: String(item.getField("DOI") || ""),
    isbn: String(item.getField("ISBN") || ""),
    kp: kp || undefined,
  };
}

async function reportDuplicateItemsForSelection(): Promise<void> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const items =
    pane?.getSelectedItems?.()?.filter((i: Zotero.Item) => i.isRegularItem()) ??
    [];
  if (!items.length) {
    alertDialog(getString("pdf-dup-report-empty"));
    return;
  }
  if (items.length < 2) {
    alertDialog(getString("pdf-dup-report-need-two"));
    return;
  }

  const snaps = items.map(snapFromItem);
  const groups = findDuplicateGroups(snaps);
  const lines = formatDuplicateReportLines(groups);
  const header = getString("pdf-dup-report-title", {
    args: { selected: items.length, groups: groups.length },
  });
  alertDialog([header, "", ...lines].join("\n"));
}
