// @ajan: cursor · @etiket: katman-2, b1-delete-att, delitemwithatt
/**
 * Selective delitemwithatt behavior: remove attachments and optionally
 * unlink LINKED_FILE paths on disk. Stored/imported files: trash only.
 *
 * Attribution: redleafnew/delitemwithatt (GPL-3.0) — behavior-adapted;
 * see THIRD_PARTY_NOTICES.md.
 */

import { getString } from "../utils/locale";
import { config } from "../../package.json";
import {
  formatDeleteConfirmLines,
  planAttachmentDeletion,
  type AttachmentDeleteRow,
} from "../utils/attachmentDeletePlan";

export {
  collectAttachmentRowsFromSelection,
  deleteAttachmentsForSelectedItems,
  deleteAttachmentsAndItemsForSelection,
};

function alertDialog(message: string) {
  ztoolkit.getGlobal("alert")(message);
}

function confirmDialog(message: string): boolean {
  return Boolean(ztoolkit.getGlobal("confirm")(message));
}

function progressDone(text: string) {
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text, type: "success", progress: 100 })
    .show();
}

async function collectAttachmentRowsFromSelection(): Promise<
  AttachmentDeleteRow[]
> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const selected = pane?.getSelectedItems?.() ?? [];
  const rows: AttachmentDeleteRow[] = [];
  const seen = new Set<number>();

  const pushAtt = async (att: Zotero.Item) => {
    if (!att?.isAttachment?.() || seen.has(att.id)) return;
    seen.add(att.id);
    let path: string | null = null;
    try {
      path = (await att.getFilePathAsync()) || null;
    } catch {
      path = null;
    }
    rows.push({
      attachmentId: att.id,
      parentItemId: att.parentItemID || null,
      linkMode: Number(att.attachmentLinkMode),
      path,
      contentType: String(att.attachmentContentType || ""),
    });
  };

  for (const item of selected) {
    if (item.isAttachment()) {
      await pushAtt(item);
      continue;
    }
    if (!item.isRegularItem()) continue;
    for (const id of item.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (att) await pushAtt(att);
    }
  }
  return rows;
}

async function unlinkLinkedPaths(paths: string[]): Promise<{
  removed: number;
  failed: number;
}> {
  let removed = 0;
  let failed = 0;
  for (const file of paths) {
    try {
      const exists = await IOUtils.exists(file);
      if (exists) {
        await (Zotero.File as any).removeIfExists(file);
        removed += 1;
      }
      try {
        const parent = PathUtils.parent(file);
        if (parent) {
          // Best-effort empty dir cleanup (delitemwithatt OS.File.removeEmptyDir).
          await (IOUtils as any).remove?.(parent, { recursive: false });
        }
      } catch {
        /* non-empty or missing — ignore */
      }
    } catch (error) {
      ztoolkit.log("linked file delete failed", file, error);
      failed += 1;
    }
  }
  return { removed, failed };
}

async function trashAttachments(ids: number[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const att = Zotero.Items.get(id);
    if (!att) continue;
    try {
      att.deleted = true;
      await att.saveTx();
      n += 1;
    } catch (error) {
      ztoolkit.log("attachment trash failed", id, error);
    }
  }
  return n;
}

async function deleteAttachmentsForSelectedItems(opts: {
  deleteLinkedFiles: boolean;
}): Promise<void> {
  const rows = await collectAttachmentRowsFromSelection();
  if (!rows.length) {
    alertDialog(getString("pdf-delete-att-empty"));
    return;
  }
  const plan = planAttachmentDeletion(rows, {
    deleteLinkedFiles: opts.deleteLinkedFiles,
  });
  const confirmLines = formatDeleteConfirmLines(plan, {
    deleteLinkedFiles: opts.deleteLinkedFiles,
  });
  const title = opts.deleteLinkedFiles
    ? getString("pdf-delete-att-files-confirm-title")
    : getString("pdf-delete-att-keep-confirm-title");
  if (
    !confirmDialog(
      [title, ...confirmLines, getString("pdf-delete-att-confirm-footer")].join(
        "\n",
      ),
    )
  ) {
    return;
  }

  let unlinked = { removed: 0, failed: 0 };
  if (opts.deleteLinkedFiles && plan.unlinkPaths.length) {
    unlinked = await unlinkLinkedPaths(plan.unlinkPaths);
  }
  const trashed = await trashAttachments(plan.trashAttachmentIds);
  progressDone(
    getString("pdf-delete-att-done", {
      args: {
        trashed,
        unlinked: unlinked.removed,
        failed: unlinked.failed,
      },
    }),
  );
}

async function deleteAttachmentsAndItemsForSelection(): Promise<void> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const selected =
    pane
      ?.getSelectedItems?.()
      ?.filter((i: Zotero.Item) => i.isRegularItem()) ?? [];
  if (!selected.length) {
    alertDialog(getString("pdf-delete-att-empty"));
    return;
  }
  const rows = await collectAttachmentRowsFromSelection();
  const plan = planAttachmentDeletion(rows, { deleteLinkedFiles: true });
  const confirmLines = formatDeleteConfirmLines(plan, {
    deleteLinkedFiles: true,
  });
  if (
    !confirmDialog(
      [
        getString("pdf-delete-item-att-confirm-title", {
          args: { count: selected.length },
        }),
        ...confirmLines,
        getString("pdf-delete-att-confirm-footer"),
      ].join("\n"),
    )
  ) {
    return;
  }
  const unlinked = await unlinkLinkedPaths(plan.unlinkPaths);
  await trashAttachments(plan.trashAttachmentIds);
  let items = 0;
  for (const item of selected) {
    try {
      item.deleted = true;
      await item.saveTx();
      items += 1;
    } catch (error) {
      ztoolkit.log("item trash failed", item.id, error);
    }
  }
  progressDone(
    getString("pdf-delete-item-att-done", {
      args: {
        items,
        unlinked: unlinked.removed,
        failed: unlinked.failed,
      },
    }),
  );
}
