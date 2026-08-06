// @ajan: claude · @etiket: katman-2, p2, attachmentScanner, safe-regex, stale-mismatch-tag-fix, hash-prefix-normalize
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { compileUserRegex, safeRegexTest } from "../utils/safeRegex";
import { getWatchRoots } from "./folderIndex";
import {
  clearSuccessfulMatchTags,
  resolveAutomationTagOnItem,
} from "./pdfSources";

declare const IOUtils: any;

type ScanResult = {
  scanned: number;
  noSource: number;
  broken: number;
  duplicate: number;
  nonfile: number;
};

const emptyResult = (): ScanResult => ({
  scanned: 0,
  noSource: 0,
  broken: 0,
  duplicate: 0,
  nonfile: 0,
});

function scannerPref<T>(name: string, fallback: T): T {
  const value = getPref(`scanner.${name}`);
  return (value === undefined || value === null ? fallback : value) as T;
}

async function regularParent(item: Zotero.Item) {
  if (item?.isRegularItem()) return item;
  const parentID = item?.parentItemID || (item as any)?.parentID;
  return parentID ? await Zotero.Items.getAsync(parentID) : undefined;
}

async function setTag(item: Zotero.Item, tag: string, enabled: boolean) {
  if (!tag) return false;
  // `#`-prefix aware lookup — `tag` may come from a user pref
  // (scannerPref("tagBroken", "#broken") etc.) with no validation that it
  // actually starts with "#", so a raw hasTag(tag) could miss an
  // already-stored "#broken" and add a second, differently-spelled tag.
  const resolved = resolveAutomationTagOnItem(item, tag);
  if (enabled && !resolved) {
    item.addTag(tag);
    return true;
  }
  if (!enabled && resolved) {
    item.removeTag(resolved);
    return true;
  }
  return false;
}

export async function scanAttachmentState(
  sourceItem: Zotero.Item,
  allowCleanup = false,
) {
  const item = await regularParent(sourceItem);
  if (!item?.isRegularItem()) return undefined;
  await (item as any).loadAllData?.();

  let hasFile = false;
  let hasBroken = false;
  let hasNonfile = false;
  let hasPDF = false;
  let snapshot: Zotero.Item | undefined;
  const contentTypes = new Set<string>();
  let duplicate = false;
  const ignoredMasks = String(scannerPref("ignoredFileMasks", ""))
    .split(",")
    .map((mask) => mask.trim())
    .filter(Boolean)
    .flatMap((mask) => {
      const re = compileUserRegex(mask, "i");
      if (!re) {
        ztoolkit.log("Invalid or unsafe Attachment Scanner ignore mask", mask);
        return [];
      }
      return [re];
    });

  for (const attachmentID of item.getAttachments()) {
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (!attachment || attachment.isEmbeddedImageAttachment?.()) continue;
    if (attachment.isSnapshotAttachment?.()) {
      snapshot = attachment;
      continue;
    }
    if (attachment.isFileAttachment()) {
      hasFile = true;
      let exists = false;
      try {
        exists = await attachment.fileExists();
      } catch {
        exists = false;
      }
      if (!exists) {
        hasBroken = true;
        if (allowCleanup && scannerPref("removeBroken", false)) {
          await Zotero.Items.trashTx(attachmentID);
        }
      } else {
        hasPDF ||= Boolean(
          attachment.isPDFAttachment?.() ||
          (attachment as any).isEPUBAttachment?.(),
        );
        // Only files that actually exist count toward duplicate-type
        // detection; a broken link is a #broken problem, not a duplicate.
        const type = attachment.attachmentContentType || "unknown";
        const filename = attachment.attachmentFilename || "";
        if (!ignoredMasks.some((regex) => safeRegexTest(regex, filename))) {
          if (contentTypes.has(type)) duplicate = true;
          contentTypes.add(type);
        }
      }
    } else {
      const title = attachment.getDisplayTitle();
      if (
        allowCleanup &&
        scannerPref("removePubmedEntry", false) &&
        title === "PubMed entry"
      ) {
        await Zotero.Items.trashTx(attachmentID);
      } else {
        hasNonfile = true;
      }
    }
  }

  if (
    allowCleanup &&
    scannerPref("removeSnapshot", false) &&
    snapshot &&
    hasPDF
  ) {
    await Zotero.Items.trashTx(snapshot.id);
  }

  // Evaluate every setTag (do NOT use `||=`, which short-circuits and would
  // skip the remaining tag updates once one tag has already changed).
  let changed = false;
  if (await setTag(item, scannerPref("tagBroken", "#broken"), hasBroken)) {
    changed = true;
  }
  if (
    scannerPref("scanNoSource", true) &&
    (await setTag(item, scannerPref("tagNoSource", "#nosource"), !hasFile))
  ) {
    changed = true;
  }
  if (
    scannerPref("scanDuplicates", true) &&
    (await setTag(item, scannerPref("tagDuplicate", "#duplicate"), duplicate))
  ) {
    changed = true;
  }
  if (
    scannerPref("scanNonfiles", false) &&
    (await setTag(item, scannerPref("tagNonfile", "#nonfile"), hasNonfile))
  ) {
    changed = true;
  }
  if (changed) await item.saveTx();

  // `#pdf-mismatch` / `#pdf-review` / `#pdf-quarantine` claim "a PDF was
  // attached and it didn't match" — meaningless (and permanently unclearable
  // via the normal match flow, which only clears on a NEW successful match)
  // once the item has no file attachment left at all. Whatever removed the
  // last attachment (broken-link cleanup here, or an external process moving
  // files on disk) already leaves `#nosource`; don't also leave a stale
  // mismatch claim with nothing left to point at.
  if (!hasFile) {
    await clearSuccessfulMatchTags(item);
  }

  return {
    noSource: !hasFile,
    broken: hasBroken,
    duplicate,
    nonfile: hasNonfile,
  };
}

async function scanItems(items: Zotero.Item[], allowCleanup = true) {
  const result = emptyResult();
  const seen = new Set<number>();
  for (const source of items) {
    const item = await regularParent(source);
    if (!item?.isRegularItem() || seen.has(item.id)) continue;
    seen.add(item.id);
    const state = await scanAttachmentState(item, allowCleanup);
    if (!state) continue;
    result.scanned++;
    if (state.noSource) result.noSource++;
    if (state.broken) result.broken++;
    if (state.duplicate) result.duplicate++;
    if (state.nonfile) result.nonfile++;
  }
  showScanResult(result);
  return result;
}

function showScanResult(result: ScanResult) {
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 8000 })
    .createLine({
      text:
        `Scanned ${result.scanned}: ` +
        `${result.noSource} without files, ${result.broken} broken, ` +
        `${result.duplicate} duplicate types, ${result.nonfile} URL-only`,
      type: "default",
    })
    .show();
}

export async function scanSelectedAttachments() {
  return scanItems(ZoteroPane.getSelectedItems());
}

export async function monitorChangedAttachmentItems(ids: string[] | number[]) {
  if (!scannerPref("monitorAttachments", false)) return;
  const parents = new Map<number, Zotero.Item>();
  for (const id of ids) {
    const changed = await Zotero.Items.getAsync(Number(id));
    const parent = changed ? await regularParent(changed) : undefined;
    if (parent?.isRegularItem()) parents.set(parent.id, parent);
  }
  for (const parent of parents.values()) {
    await scanAttachmentState(parent, false);
  }
}

export async function scanAllAttachments() {
  const hidden = ["webpage", "attachment", "note", "annotation"]
    .map((name) => Zotero.ItemTypes.getID(name))
    .join(",");
  const rows =
    (await Zotero.DB.queryAsync(
      `SELECT itemID FROM items WHERE itemTypeID NOT IN (${hidden}) ` +
        `AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
    )) || [];
  const items: Zotero.Item[] = [];
  for (const row of rows) {
    const item = await Zotero.Items.getAsync(row.itemID);
    if (item) items.push(item);
  }
  return scanItems(items);
}

export async function removeDuplicateFileLinks() {
  if (
    !window.confirm(
      "Remove duplicate attachments that point to the exact same file?",
    )
  ) {
    return;
  }
  let removed = 0;
  for (const source of ZoteroPane.getSelectedItems()) {
    const item = await regularParent(source);
    if (!item?.isRegularItem()) continue;
    const paths = new Set<string>();
    for (const attachmentID of item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment?.isFileAttachment()) continue;
      const path = await attachment.getFilePathAsync().catch(() => "");
      if (!path) continue;
      const normalized = PathUtils.normalize(path).toLocaleLowerCase();
      if (paths.has(normalized)) {
        await Zotero.Items.trashTx(attachmentID);
        removed++;
      } else {
        paths.add(normalized);
      }
    }
  }
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
    .createLine({ text: `${removed} duplicate attachment(s) moved to trash` })
    .show();
}

export interface DirLister {
  getChildren(dir: string): Promise<string[]>;
  statType(path: string): Promise<"directory" | "file" | null>;
}

/**
 * Pure, dependency-injected version of the orphan-file walk, extracted so it
 * can be unit tested without a live Zotero/IOUtils environment. Behavior must
 * stay identical to what scanOrphanFiles() below wires it up to.
 *
 * Returns whether each visited directory contains anything at all
 * (recursively) — a referenced file, an orphan file, or a non-empty
 * subdirectory. This must NOT be conflated with "has a referenced file": a
 * directory holding only orphan PDFs previously got reported as "empty"
 * (since it had no Zotero-referenced file), which risked the user deleting a
 * folder the same report had just flagged as containing orphan files to
 * review.
 */
export async function classifyOrphanTree(
  roots: string[],
  referenced: Set<string>,
  lister: DirLister,
  normalizeKey: (path: string) => string,
  filename: (path: string) => string,
): Promise<{ orphanFiles: string[]; emptyDirs: string[] }> {
  const orphanFiles: string[] = [];
  const emptyDirs: string[] = [];
  const isIgnorableFile = (child: string) =>
    /^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(filename(child));
  const walk = async (dir: string): Promise<boolean> => {
    let hasContent = false;
    let children: string[] = [];
    try {
      children = await lister.getChildren(dir);
    } catch {
      return false;
    }
    for (const child of children) {
      const type = await lister.statType(child).catch(() => null);
      if (!type) continue;
      if (type === "directory") {
        if (await walk(child)) {
          hasContent = true;
        } else {
          emptyDirs.push(child);
        }
      } else if (isIgnorableFile(child)) {
        continue;
      } else if (referenced.has(normalizeKey(child))) {
        hasContent = true;
      } else {
        orphanFiles.push(child);
        hasContent = true;
      }
    }
    return hasContent;
  };
  for (const root of roots) {
    await walk(root);
  }
  return { orphanFiles, emptyDirs };
}

export async function scanOrphanFiles() {
  // Use the SAME roots as the PDF Manager's own local-folder matching/index
  // (pdf.watchRoots, falling back to the legacy single pdf.localFolder) —
  // not the unrelated Attanger "source directory" used by the old move/rename
  // feature. Scanning a different folder than the one the user actually
  // configured for PDFs would silently report nothing useful. The old
  // sourceDir/baseAttachmentPath is kept as a last-resort fallback only for
  // users who never set up watchRoots at all.
  const watchRoots = getWatchRoots();
  const legacyRoot = String(
    getPref("sourceDir") ||
      Zotero.Prefs.get("extensions.zotero.baseAttachmentPath", true) ||
      "",
  );
  const candidateRoots = watchRoots.length
    ? watchRoots
    : legacyRoot
      ? [legacyRoot]
      : [];

  const roots: string[] = [];
  for (const candidate of candidateRoots) {
    if (await IOUtils.exists(candidate)) roots.push(candidate);
  }
  if (!roots.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
      .createLine({
        text:
          "No attachment root directory found — check Watched PDF roots " +
          "(PDF Downloader settings) or the source directory (General settings)",
      })
      .show();
    return;
  }

  const referenced = new Set<string>();
  const rows =
    (await Zotero.DB.queryAsync(
      `SELECT itemID FROM items WHERE itemTypeID=${Zotero.ItemTypes.getID("attachment")} ` +
        `AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
    )) || [];
  for (const row of rows) {
    const attachment = await Zotero.Items.getAsync(row.itemID);
    if (!attachment?.isFileAttachment()) continue;
    const path = await attachment.getFilePathAsync().catch(() => "");
    if (path)
      referenced.add(PathUtils.normalize(path).normalize("NFC").toLowerCase());
  }

  const { orphanFiles, emptyDirs } = await classifyOrphanTree(
    roots,
    referenced,
    {
      getChildren: (dir) => IOUtils.getChildren(dir),
      statType: async (path) => {
        const stat = await IOUtils.stat(path).catch(() => null);
        return stat?.type ?? null;
      },
    },
    (path) => PathUtils.normalize(path).normalize("NFC").toLowerCase(),
    (path) => PathUtils.filename(path),
  );

  const report =
    `Attachment root(s): ${roots.join("; ")}\n` +
    `Orphan files (${orphanFiles.length}):\n${orphanFiles.join("\n")}\n\n` +
    `Empty directories (${emptyDirs.length}):\n${emptyDirs.join("\n")}`;
  Components.classes["@mozilla.org/widget/clipboardhelper;1"]
    .getService(Components.interfaces.nsIClipboardHelper)
    .copyString(report);
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 8000 })
    .createLine({
      text: `${orphanFiles.length} orphan files, ${emptyDirs.length} empty directories — report copied`,
    })
    .show();
}
