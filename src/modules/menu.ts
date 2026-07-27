/*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
import { getString } from "../utils/locale";
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { waitUntil, waitUtilAsync } from "../utils/wait";
import comparison from "string-comparison";
import {
  registerShortcut,
  isShortcutEnabled,
  getShortcutText,
} from "../utils/shortcut";
import { downloadPdfForSelectedItems, attachPdfFromUrl } from "./pdfDownload";
import {
  embedMetadataForSelectedItems,
  embedMetadataForFailedOrMissingSelectedItems,
  maybeEmbedMetadata,
} from "./pdfMetadata";
import { cleanMetadataForSelectedItems } from "./metadataClean";
import { checkMetadataForSelectedItems } from "./metadataCheck";
import { fillMetadataFromSelectedPDFFilenames } from "./filenameMetadata";
import { mergeDuplicatePDFAttachments } from "./duplicateAttachmentMerger";
import { researchMetadataForSelectedPDFs } from "./pdfContentMetadata";
import {
  monitorChangedAttachmentItems,
  removeDuplicateFileLinks,
  scanAllAttachments,
  scanOrphanFiles,
  scanSelectedAttachments,
} from "./attachmentScanner";

const filenameExtRE = /\.[^.]+$/;
const ATTANGER_MENU_ID = "zpdfmanager-menu";
const ATTACH_NEW_FILE_MENU_ID = "zpdfmanager-attach-new-file";
const MATCH_ATTACHMENT_MENU_ID = "zpdfmanager-match-attachment";
const RENAME_MENU_ID = "zpdfmanager-rename-attachment";
const RENAME_MOVE_MENU_ID = "zpdfmanager-rename-move-attachment";
const MOVE_MENU_ID = "zpdfmanager-move-attachment";
const UNDO_MOVE_MENU_ID = "zpdfmanager-undo-move-attachment";

/**
 * 菜单项后缀显示的快捷键提示，如 " (Ctrl + I)"；快捷键未启用或未设置时为空
 */
function getShortcutHint(shortcutPref: string) {
  if (!isShortcutEnabled(shortcutPref)) return "";
  const shortcut = getShortcutText(shortcutPref);
  return shortcut ? ` (${shortcut})` : "";
}

/**
 * 避免因为选中A操作移动，移动过程中点击了B分类
 */
let selectedCollection: Zotero.Collection | undefined;

/** 正在被 moveFile 处理的源文件路径集合，防止并发重复调用 */
const movingPaths = new Set<string>();
/** Attanger 正在修改的附件，避免自身 saveTx 再次触发自动重命名 */
const attachmentMutationInFlight = new Set<number>();
export default class Menu {
  private notifierID?: string;
  private pendingAddedItemIDs = new Set<number>();
  private cancelledAutomaticItemIDs = new Set<number>();
  private autoProcessTimer?: number;
  private autoProcessRunning = false;
  private autoRenameOnModifyTimers = new Map<number, number>();
  private autoRenameOnModifyTokens = new Map<number, number>();
  private disposed = false;

  constructor() {
    addon.data.menu?.dispose();
    addon.data.menu = this;
    this.notifierID = registerNotify(
      ["item"],
      async (
        event: _ZoteroTypes.Notifier.Event,
        type: _ZoteroTypes.Notifier.Type,
        ids: string[] | number[],
      ) => {
        if (type == "item" && (event == "trash" || event == "delete")) {
          this.cancelAutomaticProcessing(ids, event);
          return;
        }
        if (type == "item" && event == "add") {
          this.queueAddedItems(ids);
        }
        if (type == "item" && event == "modify") {
          await this.queueLinkedAttachmentRenameOnModify(ids);
        }
        if (type == "item" && (event == "add" || event == "modify")) {
          void monitorChangedAttachmentItems(ids);
        }
      },
    );
    addon.data.notifierID = this.notifierID;
    this.init();
    this.register();
  }

  public dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.autoProcessTimer !== undefined) {
      window.clearTimeout(this.autoProcessTimer);
      this.autoProcessTimer = undefined;
    }
    this.pendingAddedItemIDs.clear();
    this.cancelledAutomaticItemIDs.clear();
    for (const timer of this.autoRenameOnModifyTimers.values()) {
      window.clearTimeout(timer);
    }
    this.autoRenameOnModifyTimers.clear();
    this.autoRenameOnModifyTokens.clear();
    if (this.notifierID) {
      unregisterNotify(this.notifierID);
      if (addon.data.notifierID === this.notifierID) {
        addon.data.notifierID = "";
      }
      this.notifierID = undefined;
    }
  }

  private queueAddedItems(ids: string[] | number[]) {
    if (this.disposed) return;
    for (const id of ids) {
      const numericID = Number(id);
      if (Number.isInteger(numericID)) {
        this.pendingAddedItemIDs.add(numericID);
      }
    }
    if (this.autoProcessTimer !== undefined) {
      window.clearTimeout(this.autoProcessTimer);
    }
    // Connector saves the parent and its attachments in separate add events.
    this.autoProcessTimer = window.setTimeout(() => {
      this.autoProcessTimer = undefined;
      void this.flushAddedItems();
    }, 1000);
  }

  private cancelAutomaticProcessing(
    ids: string[] | number[],
    event: "trash" | "delete",
  ) {
    const itemIDs = new Set(
      ids.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
    );
    for (const itemID of [...itemIDs]) {
      if (event == "delete" && attachmentMutationInFlight.has(itemID)) {
        itemIDs.delete(itemID);
        continue;
      }
      const item = Zotero.Items.get(itemID);
      if (item?.isTopLevelItem() && item.isRegularItem()) {
        for (const attachmentID of item.getAttachments()) {
          itemIDs.add(attachmentID);
        }
      }
    }
    for (const itemID of itemIDs) {
      this.pendingAddedItemIDs.delete(itemID);
      this.cancelLinkedAttachmentRenameOnModify(itemID);
      if (this.autoProcessRunning) {
        this.cancelledAutomaticItemIDs.add(itemID);
      }
    }
    if (
      this.pendingAddedItemIDs.size === 0 &&
      this.autoProcessTimer !== undefined
    ) {
      window.clearTimeout(this.autoProcessTimer);
      this.autoProcessTimer = undefined;
    }
  }

  private isAutomaticProcessingCancelled(item: Zotero.Item) {
    return (
      this.disposed ||
      this.cancelledAutomaticItemIDs.has(item.id) ||
      item.deleted ||
      Boolean(item.parentItem?.deleted)
    );
  }

  private async flushAddedItems() {
    if (this.disposed || this.autoProcessRunning) return;
    this.autoProcessRunning = true;
    try {
      while (!this.disposed && this.pendingAddedItemIDs.size > 0) {
        const ids = [...this.pendingAddedItemIDs];
        this.pendingAddedItemIDs.clear();
        await this.processAddedItems(ids);
      }
    } finally {
      this.autoProcessRunning = false;
      this.cancelledAutomaticItemIDs.clear();
    }
  }

  private async processAddedItems(ids: number[]) {
    const attachments = new Map<number, Zotero.Item>();
    for (const item of Zotero.Items.get(ids)) {
      try {
        if (!item || this.isAutomaticProcessingCancelled(item)) continue;
        if (item.isAttachment() && (await item.fileExists())) {
          if (!this.isAutomaticProcessingCancelled(item)) {
            attachments.set(item.id, item);
          }
        } else if (item.isTopLevelItem() && item.isRegularItem()) {
          for (const attachmentID of item.getAttachments()) {
            const attachment = Zotero.Items.get(attachmentID);
            if (
              attachment &&
              !this.isAutomaticProcessingCancelled(attachment) &&
              attachment.isAttachment() &&
              (await attachment.fileExists())
            ) {
              if (!this.isAutomaticProcessingCancelled(attachment)) {
                attachments.set(attachment.id, attachment);
              }
            }
          }
        }
      } catch (e) {
        ztoolkit.log("Failed to inspect added item", item?.id, e);
      }
    }

    for (const attachment of attachments.values()) {
      if (this.isAutomaticProcessingCancelled(attachment)) continue;
      await this.processAddedAttachment(attachment);
    }
  }

  private async processAddedAttachment(att: Zotero.Item) {
    try {
      if (this.isAutomaticProcessingCancelled(att)) return;
      const canProcess = checkFileType(att);
      const filenameNoExt = canProcess
        ? await getAttachmentFilenameNoExt(att)
        : null;
      if (this.isAutomaticProcessingCancelled(att)) return;
      if (isFilenameMatched("filenameSkipAutoMoveRenameRules", filenameNoExt)) {
        showAttachmentItem(att);
        return;
      }
      if (
        canProcess &&
        att.isImportedAttachment() &&
        getPref("autoMove") &&
        getPref("attachType") == "linking"
      ) {
        const sourceAttachment = att;
        const moved = await moveFile(att, {
          silent: true,
          shouldCancel: () =>
            this.isAutomaticProcessingCancelled(sourceAttachment),
        });
        if (!moved) return;
        att = moved;
      }
      if (this.isAutomaticProcessingCancelled(att)) return;
      if (canProcess && Zotero.Prefs.get("autoRenameFiles")) {
        this.cancelLinkedAttachmentRenameOnModify(att.id);
        await renameFile(att);
      }
    } catch (e) {
      ztoolkit.log(e);
    }
    showAttachmentItem(att);
  }

  private async queueLinkedAttachmentRenameOnModify(ids: string[] | number[]) {
    if (this.disposed || !getPref("autoRenameOnModify")) return;
    const numericIDs = ids
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id));
    const attachmentIDs = this.collectLinkedAttachmentsForModify(numericIDs);
    for (const attachmentID of attachmentIDs) {
      this.scheduleLinkedAttachmentRenameOnModify(attachmentID);
    }
  }

  private collectLinkedAttachmentsForModify(ids: number[]) {
    const attachmentIDs = new Set<number>();
    for (const item of Zotero.Items.get(ids)) {
      if (!item) continue;
      if (item.isAttachment()) {
        if (
          !attachmentMutationInFlight.has(item.id) &&
          isAutoRenameLinkedAttachmentCandidate(item)
        ) {
          attachmentIDs.add(item.id);
        }
        continue;
      }
      if (!item.isTopLevelItem() || !item.isRegularItem()) continue;
      for (const attachmentID of item.getAttachments()) {
        const attachment = Zotero.Items.get(attachmentID);
        if (
          attachment &&
          !attachmentMutationInFlight.has(attachment.id) &&
          isAutoRenameLinkedAttachmentCandidate(attachment)
        ) {
          attachmentIDs.add(attachment.id);
        }
      }
    }
    return [...attachmentIDs];
  }

  private scheduleLinkedAttachmentRenameOnModify(attachmentID: number) {
    const previousTimer = this.autoRenameOnModifyTimers.get(attachmentID);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }
    const token = (this.autoRenameOnModifyTokens.get(attachmentID) || 0) + 1;
    this.autoRenameOnModifyTokens.set(attachmentID, token);
    const debounceMs = getPref("autoRenameOnModifyDebounceEnabled")
      ? getNonNegativeIntegerPref("autoRenameOnModifyDebounceMs", 1000)
      : 0;
    const timer = window.setTimeout(async () => {
      this.autoRenameOnModifyTimers.delete(attachmentID);
      try {
        const delayMs = getPref("autoRenameOnModifyDelayEnabled")
          ? getNonNegativeIntegerPref("autoRenameOnModifyDelayMs", 0)
          : 0;
        if (delayMs > 0) {
          await Zotero.Promise.delay(delayMs);
        }
        if (
          this.disposed ||
          this.autoRenameOnModifyTokens.get(attachmentID) !== token
        ) {
          return;
        }
        await this.runLinkedAttachmentRenameOnModify(attachmentID);
      } catch (e) {
        ztoolkit.log("Auto rename on modify failed", attachmentID, e);
      } finally {
        if (this.autoRenameOnModifyTokens.get(attachmentID) === token) {
          this.autoRenameOnModifyTokens.delete(attachmentID);
        }
      }
    }, debounceMs);
    this.autoRenameOnModifyTimers.set(attachmentID, timer);
  }

  private cancelLinkedAttachmentRenameOnModify(attachmentID: number) {
    const timer = this.autoRenameOnModifyTimers.get(attachmentID);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.autoRenameOnModifyTimers.delete(attachmentID);
    }
    this.autoRenameOnModifyTokens.delete(attachmentID);
  }

  private async runLinkedAttachmentRenameOnModify(attachmentID: number) {
    if (
      this.disposed ||
      !getPref("autoRenameOnModify") ||
      attachmentMutationInFlight.has(attachmentID)
    ) {
      return;
    }
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (!attachment || !(await canAutoRenameLinkedAttachment(attachment))) {
      return;
    }
    const filenameNoExt = await getAttachmentFilenameNoExt(attachment);
    if (isFilenameMatched("filenameSkipAutoMoveRenameRules", filenameNoExt)) {
      return;
    }
    try {
      await renameFile(attachment);
    } catch (e) {
      ztoolkit.log(e);
      showLinkedAttachmentRenameError(attachment);
    }
  }

  private init() {
    for (const name in addon.data.icons) {
      ztoolkit.ProgressWindow.setIconURI(name, addon.data.icons[name]);
    }
  }

  private getMoveMenuStringKey(moveKey: string, copyKey: string) {
    return getPref("moveWithoutDeleting") ? copyKey : moveKey;
  }

  public refreshItemMenu() {
    for (const win of Zotero.getMainWindows()) {
      const setLabel = (
        id: string,
        stringKey: string,
        shortcutPref?: string,
      ) => {
        win.document
          .getElementById(id)
          ?.setAttribute(
            "label",
            getString(stringKey) +
              (shortcutPref ? getShortcutHint(shortcutPref) : ""),
          );
      };
      setLabel(
        ATTACH_NEW_FILE_MENU_ID,
        "attach-new-file",
        "attachNewFile.shortcut",
      );
      setLabel(
        MATCH_ATTACHMENT_MENU_ID,
        "match-attachment",
        "matchAttachment.shortcut",
      );
      setLabel(
        RENAME_MENU_ID,
        "rename-attachment",
        "renameAttachment.shortcut",
      );
      setLabel(
        RENAME_MOVE_MENU_ID,
        this.getMoveMenuStringKey(
          "rename-move-attachment",
          "rename-copy-attachment",
        ),
        "renameMoveAttachment.shortcut",
      );
      setLabel(
        MOVE_MENU_ID,
        this.getMoveMenuStringKey("move-attachment", "copy-attachment"),
        "moveAttachment.shortcut",
      );
      setLabel(
        UNDO_MOVE_MENU_ID,
        this.getMoveMenuStringKey(
          "undo-move-attachment",
          "undo-copy-attachment",
        ),
      );
    }
  }

  private register() {
    const attachNewFileCallback = async () => {
      // 与菜单项的 getVisibility 条件保持一致，快捷键触发时同样需要校验
      const item = ZoteroPane.getSelectedItems()[0];
      if (!item || !item.isTopLevelItem() || !item.isRegularItem()) {
        ztoolkit.log(
          "attachNewFile skipped: no top-level regular item selected",
        );
        return;
      }
      await attachNewFile({
        libraryID: item.libraryID,
        parentItemID: item.id,
        collections: undefined,
      });
    };

    const renameMoveAttachmentCallback = async () => {
      selectedCollection = ZoteroPane.getSelectedCollection();
      const attachmentItems = getAttachmentItems(false);
      if (!attachmentItems.length) {
        showMoveMessage("No attachment selected.");
        return;
      }
      for (const item of attachmentItems) {
        try {
          const movedItem = (await moveFile(item)) as Zotero.Item;
          if (!movedItem) {
            showMoveMessage(
              `Move skipped or failed: ${item.getDisplayTitle()}`,
            );
            continue;
          }
          const renamedItem = await renameFile(movedItem);
          showAttachmentItem(renamedItem || movedItem);
        } catch (e) {
          ztoolkit.log(e);
          showMoveMessage(`Move error: ${(e as Error).message || e}`);
        }
      }
    };

    const renameAttachmentCallback = async () => {
      const attachmentItems = getAttachmentItems();
      if (!attachmentItems.length) {
        showRenameMessage(
          "No child attachment selected. Select a regular item or a child attachment with a parent item.",
        );
        return;
      }
      for (const item of attachmentItems) {
        try {
          const attItem = await renameFile(item);
          if (attItem) {
            showAttachmentItem(attItem);
          } else {
            showRenameMessage(
              `Rename skipped or failed: ${item.getDisplayTitle()}`,
            );
          }
        } catch (e) {
          ztoolkit.log(e);
          showRenameMessage(`Rename error: ${(e as Error).message || e}`);
        }
      }
    };

    const moveAttachmentCallback = async () => {
      selectedCollection = ZoteroPane.getSelectedCollection();
      for (const item of getAttachmentItems(false)) {
        try {
          const attItem = await moveFile(item);
          attItem && showAttachmentItem(attItem);
        } catch (e) {
          ztoolkit.log(e);
        }
      }
    };

    ztoolkit.Menu.register("item", {
      tag: "menu",
      id: ATTANGER_MENU_ID,
      label: "Attanger",
      icon: addon.data.icons.favicon,
      children: [
        // 附加新文件
        {
          tag: "menuitem",
          id: ATTACH_NEW_FILE_MENU_ID,
          label:
            getString("attach-new-file") +
            getShortcutHint("attachNewFile.shortcut"),
          icon: addon.data.icons.attachNewFile,
          getVisibility: () => {
            // 只选择一个父级条目
            const items = ZoteroPane.getSelectedItems();
            return (
              items.length == 1 &&
              items[0].isTopLevelItem() &&
              items[0].isRegularItem()
            );
          },
          commandListener: async () => {
            await attachNewFileCallback();
          },
        },
        // 重命名并移动
        {
          tag: "menuitem",
          id: RENAME_MOVE_MENU_ID,
          label:
            getString(
              this.getMoveMenuStringKey(
                "rename-move-attachment",
                "rename-copy-attachment",
              ),
            ) + getShortcutHint("renameMoveAttachment.shortcut"),
          icon: addon.data.icons.renameMoveAttachment,
          commandListener: async (_ev) => {
            await renameMoveAttachmentCallback();
          },
        },
        { tag: "menuseparator" },
        // 匹配附件
        {
          tag: "menuitem",
          id: MATCH_ATTACHMENT_MENU_ID,
          label:
            getString("match-attachment") +
            getShortcutHint("matchAttachment.shortcut"),
          icon: addon.data.icons.matchAttachment,
          getVisibility: () => {
            const items = ZoteroPane.getSelectedItems();
            return items.some(
              (i) =>
                (i.isTopLevelItem() && i.isRegularItem()) ||
                (i.isAttachment() && Boolean(i.parentItemID)),
            );
          },
          commandListener: async (_ev) => {
            await matchAttachment();
          },
        },
        // 精确匹配附件(匹配插件自己生成的附件)
        {
          tag: "menuitem",
          label: getString("match-attanger-attachment"),
          icon: addon.data.icons.matchAttachment,
          getVisibility: () => {
            const items = ZoteroPane.getSelectedItems();
            return items.some((i) => i.isTopLevelItem() && i.isRegularItem());
          },
          commandListener: async (_ev) => {
            await matchAttangerAttachment();
          },
        },
        { tag: "menuseparator" },
        {
          tag: "menuitem",
          id: RENAME_MENU_ID,
          label:
            getString("rename-attachment") +
            getShortcutHint("renameAttachment.shortcut"),
          icon: addon.data.icons.renameAttachment,
          commandListener: async (_ev) => {
            await renameAttachmentCallback();
          },
        },
        {
          tag: "menuitem",
          id: MOVE_MENU_ID,
          label:
            getString(
              this.getMoveMenuStringKey("move-attachment", "copy-attachment"),
            ) + getShortcutHint("moveAttachment.shortcut"),
          icon: addon.data.icons.moveFile,
          commandListener: async (_ev) => {
            await moveAttachmentCallback();
          },
        },
        {
          tag: "menuitem",
          id: UNDO_MOVE_MENU_ID,
          label: getString(
            this.getMoveMenuStringKey(
              "undo-move-attachment",
              "undo-copy-attachment",
            ),
          ),
          icon: addon.data.icons.undoMoveFile,
          commandListener: async () => {
            await ZoteroPane.convertLinkedFilesToStoredFiles();
          },
        },
        { tag: "menuseparator" },
        // Download & attach PDF
        {
          tag: "menuitem",
          label: getString("pdf-download-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () => {
            const items = ZoteroPane.getSelectedItems();
            return items.some((i) => i.isTopLevelItem() && i.isRegularItem());
          },
          commandListener: async () => {
            await downloadPdfForSelectedItems();
          },
        },
        // Attach PDF from URL
        {
          tag: "menuitem",
          label: getString("pdf-download-url-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () => {
            const items = ZoteroPane.getSelectedItems();
            return items.some((i) => i.isTopLevelItem() && i.isRegularItem());
          },
          commandListener: async () => {
            await attachPdfFromUrl();
          },
        },
        {
          tag: "menuitem",
          label: getString("pdf-embed-metadata-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            getAttachmentItems(false).some(
              (item) => item.attachmentContentType === "application/pdf",
            ),
          commandListener: async () => {
            await embedMetadataForSelectedItems();
          },
        },
        {
          tag: "menuitem",
          label: getString("pdf-embed-metadata-missing-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            getAttachmentItems(false).some(
              (item) => item.attachmentContentType === "application/pdf",
            ),
          commandListener: async () => {
            await embedMetadataForFailedOrMissingSelectedItems();
          },
        },
        {
          tag: "menuitem",
          label: getString("clean-metadata-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            ZoteroPane.getSelectedItems().some(
              (item) =>
                item.isRegularItem() ||
                (item.isAttachment() && Boolean(item.parentItemID)),
            ),
          commandListener: async () => {
            await cleanMetadataForSelectedItems();
          },
        },
        {
          tag: "menuitem",
          label: getString("pdf-check-metadata-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            getAttachmentItems(false).some(
              (item) => item.attachmentContentType === "application/pdf",
            ),
          commandListener: async () => {
            await checkMetadataForSelectedItems();
          },
        },
        {
          tag: "menuitem",
          label: getString("pdf-filename-metadata-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            getAttachmentItems(false).some(
              (item) => item.attachmentContentType === "application/pdf",
            ),
          commandListener: async () => {
            await fillMetadataFromSelectedPDFFilenames();
          },
        },
        {
          tag: "menuitem",
          label: getString("pdf-merge-duplicates-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            ZoteroPane.getSelectedItems().some(
              (item) =>
                item.isRegularItem() ||
                (item.isAttachment() && Boolean(item.parentItemID)),
            ),
          commandListener: async () => {
            await mergeDuplicatePDFAttachments();
          },
        },
        {
          tag: "menuitem",
          label: getString("pdf-content-metadata-menu"),
          icon: addon.data.icons.downloadPdf,
          getVisibility: () =>
            ZoteroPane.getSelectedItems().some(
              (item) =>
                item.isAttachment() &&
                item.attachmentContentType === "application/pdf",
            ),
          commandListener: async () => {
            await researchMetadataForSelectedPDFs();
          },
        },
        { tag: "menuseparator" },
        {
          tag: "menuitem",
          label: getString("scanner-scan-selected"),
          commandListener: async () => {
            await scanSelectedAttachments();
          },
        },
        {
          tag: "menuitem",
          label: getString("scanner-scan-library"),
          commandListener: async () => {
            await scanAllAttachments();
          },
        },
        {
          tag: "menuitem",
          label: getString("scanner-scan-orphans"),
          commandListener: async () => {
            await scanOrphanFiles();
          },
        },
        {
          tag: "menuitem",
          label: getString("scanner-remove-same-file"),
          commandListener: async () => {
            await removeDuplicateFileLinks();
          },
        },
      ],
    });
    // 分隔符
    // ztoolkit.Menu.register("item", {
    //   tag: "menuseparator",
    //   getVisibility: () => {
    //     const items = ZoteroPane.getSelectedItems();
    //     return items.some((i) => i.isTopLevelItem() || i.isAttachment());
    //   },
    // });
    // 匹配附件
    // ztoolkit.Menu.register("item", {
    //   tag: "menuitem",
    //   label: getString("match-attachment"),
    //   icon: addon.data.icons.matchAttachment,
    //   getVisibility: () => {
    //     const items = ZoteroPane.getSelectedItems();
    //     return items.some((i) => i.isTopLevelItem() && i.isRegularItem());
    //   },
    //   commandListener: async (_ev) => {
    //     await matchAttachment();
    //   },
    // });
    registerShortcut("matchAttachment.shortcut", async () => {
      await matchAttachment();
    });
    // 精确匹配附件(匹配插件自己生成的附件)
    // ztoolkit.Menu.register("item", {
    //   tag: "menuitem",
    //   label: getString("match-attanger-attachment"),
    //   icon: addon.data.icons.matchAttachment,
    //   getVisibility: () => {
    //     const items = ZoteroPane.getSelectedItems();
    //     return items.some((i) => i.isTopLevelItem() && i.isRegularItem());
    //   },
    //   commandListener: async (_ev) => {
    //     await matchAttangerAttachment();
    //   },
    // });
    // ztoolkit.Menu.register("item", {
    //   tag: "menuitem",
    //   label: getString("attach-new-file"),
    //   icon: addon.data.icons.attachNewFile,
    //   getVisibility: () => {
    //     // 只选择一个父级条目
    //     const items = ZoteroPane.getSelectedItems();
    //     return (
    //       items.length == 1 &&
    //       items[0].isTopLevelItem() &&
    //       items[0].isRegularItem()
    //     );
    //   },
    //   commandListener: async () => {
    //     await attachNewFileCallback();
    //   },
    // });
    registerShortcut("attachNewFile.shortcut", async () => {
      await attachNewFileCallback();
    });
    // 重命名附件
    registerShortcut("renameAttachment.shortcut", async () => {
      await renameAttachmentCallback();
    });
    // 重命名并移动/复制附件
    registerShortcut("renameMoveAttachment.shortcut", async () => {
      await renameMoveAttachmentCallback();
    });
    // 移动/复制附件
    registerShortcut("moveAttachment.shortcut", async () => {
      await moveAttachmentCallback();
    });
    // 分类
    ztoolkit.Menu.register("collection", {
      tag: "menuitem",
      label: getString("attach-new-file"),
      icon: addon.data.icons.attachNewFile,
      getVisibility: () => {
        return ZoteroPane.getCollectionTreeRow()?.isCollection();
      },
      commandListener: async (_ev) => {
        const collection =
          ZoteroPane.getSelectedCollection() as Zotero.Collection;
        await attachNewFile({
          libraryID: collection.libraryID,
          parentItemID: undefined,
          collections: [collection.id],
        });
      },
    });
    this.refreshItemMenu();
    // 附件管理
    // ztoolkit.Menu.register("item", {
    //   tag: "menu",
    //   getVisibility: () => {
    //     return getAttachmentItems(false).length > 0;
    //   },
    //   label: getString("attachment-manager"),
    //   icon: addon.data.icons.favicon,
    //   children: [
    //     {
    //       tag: "menuitem",
    //       label: getString("rename-move-attachment"),
    //       icon: addon.data.icons.renameMoveAttachment,
    //       commandListener: async (_ev) => {
    //         for (const item of getAttachmentItems(false)) {
    //           try {
    //             const attItem = (await renameFile(item)) as Zotero.Item;
    //             attItem && (await moveFile(attItem));
    //             attItem && showAttachmentItem(attItem);
    //           } catch (e) {
    //             ztoolkit.log(e);
    //           }
    //         }
    //       },
    //     },
    //     { tag: "menuseparator" },
    //     {
    //       tag: "menuitem",
    //       label: getString("rename-attachment"),
    //       icon: addon.data.icons.renameAttachment,
    //       commandListener: async (_ev) => {
    //         for (const item of getAttachmentItems()) {
    //           try {
    //             const attItem = await renameFile(item);
    //             attItem && showAttachmentItem(attItem);
    //           } catch (e) {
    //             ztoolkit.log(e);
    //           }
    //         }
    //       },
    //     },
    //     {
    //       tag: "menuitem",
    //       label: getString("move-attachment"),
    //       icon: addon.data.icons.moveFile,
    //       commandListener: async (_ev) => {
    //         for (const item of getAttachmentItems(false)) {
    //           try {
    //             const attItem = await moveFile(item);
    //             attItem && showAttachmentItem(attItem);
    //           } catch (e) {
    //             ztoolkit.log(e);
    //           }
    //         }
    //       },
    //     },

    //     {
    //       tag: "menuitem",
    //       label: getString("undo-move-attachment"),
    //       icon: addon.data.icons.undoMoveFile,
    //       commandListener: async () => {
    //         await ZoteroPane.convertLinkedFilesToStoredFiles();
    //       },
    //     },
    //   ],
    // });
    // 打开方式
    const fileHandlerArr = JSON.parse(
      (Zotero.Prefs.get(`${config.addonRef}.openUsing`) as string) || "[]",
    );
    const setPref = (fileHandlerArr: string[]) => {
      window.setTimeout(async () => {
        Zotero.Prefs.set(
          `${config.addonRef}.openUsing`,
          JSON.stringify(fileHandlerArr),
        );
        await ztoolkit.Menu.unregisterAll();
        new Menu();
      });
    };
    ztoolkit.Menu.register("item", {
      tag: "menu",
      getVisibility: () => getAttachmentItems(false).length > 0,
      label: getString("open-using"),
      icon: addon.data.icons.openUsing,
      children: [
        {
          tag: "menuitem",
          label: "Zotero",
          commandListener: async (_ev) => {
            // 第二个参数应该从文件分析得出，默认pdf
            openUsing("", "pdf");
          },
        },
        {
          tag: "menuitem",
          label: "System",
          commandListener: async (_ev) => {
            openUsing("system", "pdf");
          },
        },
        ...fileHandlerArr.map((fileHandler: string) => {
          return {
            tag: "menuitem",
            label: fileHandler.split(/(?:\\|\/)/).slice(-1)[0],

            commandListener: async (ev: MouseEvent) => {
              if (ev.button == 2) {
                if (window.confirm("Delete?")) {
                  const _fileHandlerArr = fileHandlerArr.filter(
                    (i: string) => i != fileHandler,
                  ) as string[];
                  setPref(_fileHandlerArr);
                }
              } else {
                openUsing(fileHandler, "pdf");
              }
            },
          };
        }),
        // ...((() => {
        //   const children = [];
        //   for (const fileHandler of fileHandlerArr) {
        //     children.push({
        //       tag: "menuitem",
        //       label: PathUtils.filename(fileHandler),
        //       commandListener: async (ev: MouseEvent) => {
        //         if (ev.button == 2) {
        //           if (window.confirm("Delete?")) {
        //             const _fileHandlerArr = fileHandlerArr.filter(
        //               (i: string) => i != fileHandler,
        //             ) as string[];
        //             setPref(_fileHandlerArr);
        //           }
        //         } else {
        //           openUsing(fileHandler, "pdf");
        //         }
        //       },
        //     });
        //   }
        //   return children;
        // })() as any),
        {
          tag: "menuitem",
          label: getString("choose-other-app"),
          commandListener: async (_ev) => {
            // @ts-ignore window
            const fp = new window.FilePicker();
            fp.init(window, "Select Destination Directory", fp.modeOpen);
            fp.appendFilters(fp.filterApps);
            if ((await fp.show()) != fp.returnOK) {
              return false;
            }
            const filename = PathUtils.normalize(fp.file);
            // #42 Multiple extensions may be included, separated by a semicolon and a space.
            // const filename = await new ztoolkit.FilePicker(
            //   "Select Application",
            //   "open",
            //   [["Application", "*.exe; *.app"]], // support windows .exe and macOS .app both.
            // ).open();
            if (filename && fileHandlerArr.indexOf(filename) == -1) {
              fileHandlerArr.push(filename);
              setPref(fileHandlerArr);
              openUsing(filename, "pdf");
            }
          },
        },
      ],
    });
  }
}

/**
 * 获取所有附件条目
 */
function getAttachmentItems(hasParent = true) {
  const attachmentItems = [];
  for (const item of ZoteroPane.getSelectedItems()) {
    if (item.isAttachment() && (hasParent ? !item.isTopLevelItem() : true)) {
      attachmentItems.push(item);
    } else if (item.isRegularItem()) {
      item
        .getAttachments()
        .map((id) => Zotero.Items.get(id))
        .filter((item) => item.isAttachment())
        .forEach((item) => attachmentItems.push(item));
    }
  }

  return attachmentItems;
}

async function matchAttachment() {
  const parentItems = new Map<number, Zotero.Item>();
  const selectedAttachmentIDs = new Set<number>();
  for (const selectedItem of ZoteroPane.getSelectedItems()) {
    if (selectedItem.isTopLevelItem() && selectedItem.isRegularItem()) {
      parentItems.set(selectedItem.id, selectedItem);
    } else if (selectedItem.isAttachment() && selectedItem.parentItemID) {
      selectedAttachmentIDs.add(selectedItem.id);
      const parentItem =
        selectedItem.parentItem || Zotero.Items.get(selectedItem.parentItemID);
      if (parentItem?.isRegularItem()) {
        parentItems.set(parentItem.id, parentItem);
      }
    }
  }
  const items = [...parentItems.values()].sort(
    (a, b) => getPlainTitle(a).length - getPlainTitle(b).length,
  );
  ztoolkit.log(
    "item titles: ",
    items.map((i) => i.getDisplayTitle()),
  );
  const sourceDir = await checkDir("sourceDir", "source path");
  if (!sourceDir) return;
  let files = await collectMatchAttachmentFiles(sourceDir);
  ztoolkit.log(
    "found pdf files:",
    files.map((f) => f.path),
  );
  if (!files.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
      .createLine({
        text: `No PDF files found under ${sourceDir}`,
        type: "default",
      })
      .show();
    return;
  }
  const readPDFTitle = getPref("readPDFtitle") as string;
  ztoolkit.log("read PDF title: ", readPDFTitle);
  for (const item of items) {
    const itemtitle = getPlainTitle(item);
    if (await hasAccessiblePDFAttachment(item)) {
      ztoolkit.log(
        "Match Attachment skipped: accessible PDF already exists",
        item.id,
        itemtitle,
      );
      continue;
    }
    ztoolkit.log("processing item: ", itemtitle);
    const rankedFiles = files
      .map((file) => ({
        file,
        match: scoreAttachmentMetadata(item, file.name),
      }))
      .sort((a, b) => b.match.score - a.match.score);

    // Reading every PDF is prohibitively expensive for large, nested libraries.
    // Use filenames to shortlist likely matches, then inspect only those PDFs.
    const candidates =
      readPDFTitle === "never"
        ? rankedFiles.slice(0, 5)
        : rankedFiles.slice(0, 20);
    const scoredCandidates: Array<{
      file: OS.File.Entry;
      match: AttachmentMetadataMatch;
    }> = [];
    for (const candidate of candidates) {
      const { file } = candidate;
      const evidence = [file.name];

      /* 尝试从PDF元数据或文本中读取标题 */
      try {
        if (readPDFTitle === "never") {
          throw new Error("PDF title reading disabled");
        }
        if (!/pdf/i.test(Zotero.File.getExtension(file.path))) {
          throw new Error("This is not a PDF file.");
        }
        ztoolkit.log("check file:", file.name + ": ");
        const data: any = await getPDFData(file.path);
        const lines: Array<any> = [];
        data.pages.forEach((page: Array<any>) => {
          page[page.length - 1][0][0][0][4].forEach(
            (line: Array<Array<Array<any>>>) => {
              const lineObj = { fontSize: 0, text: "" };
              line[0].forEach((word) => {
                lineObj.fontSize += word[4];
                lineObj.text +=
                  word[word.length - 1] + (word[5] > 0 ? " " : "");
              });
              lineObj.fontSize /= line[0].length;
              // ztoolkit.log(lineObj);
              lines.push(lineObj);
            },
          );
        });
        const optTitle =
          data?.metadata?.title ||
          data?.metadata?.Title ||
          lines
            .reduce(
              (max, cur) => {
                if (cur.fontSize > max.fontSize) {
                  return cur;
                } else if (cur.fontSize == max.fontSize) {
                  max.text += ` ${cur.text}`;
                }
                return max;
              },
              { fontSize: -Infinity, text: "" },
            )
            .text.replace(/\s?([\u4e00-\u9fff])\s?/g, "$1");
        ztoolkit.log("optical title: ", optTitle);
        if (optTitle) evidence.push(cleanLigature(optTitle));
        const firstPageEvidence = lines
          .slice(0, 100)
          .map((line) => line.text)
          .filter(Boolean)
          .join(" ");
        if (firstPageEvidence) evidence.push(cleanLigature(firstPageEvidence));
        if (data?.metadata) evidence.push(JSON.stringify(data.metadata));
      } catch (e: any) {
        if (readPDFTitle !== "never") ztoolkit.log(e);
      }
      const match = scoreAttachmentMetadata(item, evidence.join(" "));
      scoredCandidates.push({ file, match });
      ztoolkit.log("metadata match", itemtitle, file.path, match);
    }

    scoredCandidates.sort((a, b) => b.match.score - a.match.score);
    const best = scoredCandidates[0];
    const second = scoredCandidates[1];
    const ambiguous =
      second &&
      second.match.accepted &&
      best.match.score - second.match.score < 0.15;
    const matchedFile =
      best?.match.accepted && !ambiguous ? best.file : undefined;

    if (!matchedFile) {
      ztoolkit.log(
        "No safe metadata match",
        itemtitle,
        best?.match,
        second?.match,
      );
      new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
        .createLine({
          text: ambiguous
            ? `No attachment added for “${itemtitle}”: multiple PDFs match too closely`
            : `No attachment added for “${itemtitle}”: title/author/year check failed`,
          type: "default",
        })
        .show();
      continue;
    }

    if (matchedFile) {
      ztoolkit.log("==>", itemtitle, matchedFile.path, best.match);
      try {
        const existingAttachment = await reuseOrRepairMatchedAttachment(
          item,
          matchedFile,
          selectedAttachmentIDs,
        );
        if (existingAttachment) {
          await maybeEmbedMetadata(item, existingAttachment);
          showAttachmentItem(existingAttachment);
          await ZoteroPane.selectItem(existingAttachment.id);
          files = files.filter((file) => file !== matchedFile);
          continue;
        }

        const attItem = await Zotero.Attachments.importFromFile({
          file: matchedFile.path,
          libraryID: item.libraryID,
          parentItemID: item.id,
        });

        // Never treat a top-level import as a successful match. Explicitly
        // attach it to the selected bibliographic item and verify the result
        // before removing the source file.
        if (attItem.parentItemID !== item.id) {
          ztoolkit.log(
            "Imported attachment has wrong parent; correcting it",
            attItem.id,
            attItem.parentItemID,
            item.id,
          );
          attItem.parentItemID = item.id;
          await attItem.saveTx();
        }
        if (attItem.parentItemID !== item.id) {
          throw new Error(
            `Attachment ${attItem.id} could not be linked to item ${item.id}`,
          );
        }

        await maybeEmbedMetadata(item, attItem);
        showAttachmentItem(attItem);
        await ZoteroPane.selectItem(attItem.id);
        removeFile(matchedFile.path);
        files = files.filter((file) => file !== matchedFile);
      } catch (error) {
        ztoolkit.log(
          "Failed to attach matched file",
          matchedFile.path,
          String(error),
          error,
        );
        new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
          .createLine({
            text: `Found ${matchedFile.name}, but could not attach it to “${itemtitle}”`,
            type: "default",
          })
          .show();
      }
    }
  }
}

async function hasAccessiblePDFAttachment(item: Zotero.Item) {
  for (const attachmentID of item.getAttachments()) {
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment || attachment.attachmentContentType !== "application/pdf") {
      continue;
    }
    try {
      if (await attachment.fileExists()) return true;
    } catch (error) {
      ztoolkit.log(
        "Match Attachment could not inspect existing PDF",
        attachmentID,
        error,
      );
    }
  }
  return false;
}

type AttachmentMetadataMatch = {
  score: number;
  titleCoverage: number;
  authorMatched: boolean;
  yearMatched: boolean;
  yearConflict: boolean;
  identifierMatched: boolean;
  identifierConflict: boolean;
  accepted: boolean;
};

function scoreAttachmentMetadata(
  item: Zotero.Item,
  rawEvidence: string,
): AttachmentMetadataMatch {
  const evidence = normalizeAttachmentMatchName(rawEvidence);
  const normalizedItemTitle = normalizeAttachmentMatchName(
    (item.getField("title") as string) || getPlainTitle(item),
  );
  const titleTokens = normalizedItemTitle
    .split(" ")
    .filter((token) => token.length >= 2);
  const significantTitleTokens = titleTokens.filter(
    (token) =>
      ![
        "bir",
        "ve",
        "ile",
        "için",
        "icin",
        "the",
        "and",
        "for",
        "from",
        "study",
      ].includes(token),
  );
  const tokens = significantTitleTokens.length
    ? significantTitleTokens
    : titleTokens;
  const evidenceTokens = new Set(evidence.split(" ").filter(Boolean));
  const titleHits = tokens.filter((token) => evidenceTokens.has(token)).length;
  const titleCoverage = tokens.length ? titleHits / tokens.length : 0;
  const exactTitle =
    Boolean(normalizedItemTitle) &&
    (evidence === normalizedItemTitle ||
      evidence.startsWith(`${normalizedItemTitle} `) ||
      evidence.endsWith(` ${normalizedItemTitle}`));

  const creators = ((item as any).getCreators?.() || []) as Array<{
    lastName?: string;
    name?: string;
  }>;
  const surnames = creators
    .map((creator) => creator.lastName || creator.name || "")
    .flatMap((name) => normalizeAttachmentMatchName(name).split(" "))
    .filter((name) => name.length >= 3);
  const authorMatched = surnames.some((surname) => evidence.includes(surname));

  const date = String(item.getField("date") || "");
  const year = date.match(/\b(1[5-9]\d{2}|20\d{2}|2100)\b/)?.[1] || "";
  const yearMatched = Boolean(year && evidence.includes(year));
  const evidenceYears = [
    ...rawEvidence.matchAll(/\b(1[5-9]\d{2}|20\d{2}|2100)\b/g),
  ].map((match) => match[1]);
  const yearConflict = Boolean(
    year && evidenceYears.length && !evidenceYears.includes(year),
  );

  const itemDOI = extractMatchDOI(String((item as any).getField("DOI") || ""));
  const itemISBN = extractMatchISBN(
    String((item as any).getField("ISBN") || ""),
  );
  const evidenceDOIs = [
    ...rawEvidence.matchAll(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi),
  ].map((match) => extractMatchDOI(match[0]));
  const evidenceISBNs = [
    ...rawEvidence.matchAll(/(?:97[89][\d\s-]{10,16}|\d[\dXx\s-]{8,16})/g),
  ]
    .map((match) => extractMatchISBN(match[0]))
    .filter((isbn) => isbn.length === 10 || isbn.length === 13);
  const identifierMatched =
    Boolean(itemDOI && evidenceDOIs.includes(itemDOI)) ||
    Boolean(itemISBN && evidenceISBNs.includes(itemISBN));
  const identifierConflict =
    Boolean(
      itemDOI && evidenceDOIs.length && !evidenceDOIs.includes(itemDOI),
    ) ||
    Boolean(
      itemISBN && evidenceISBNs.length && !evidenceISBNs.includes(itemISBN),
    );

  const score =
    titleCoverage * 0.65 +
    (authorMatched ? 0.15 : 0) +
    (yearMatched ? 0.1 : 0) +
    (identifierMatched ? 0.1 : 0);
  const shortTitleNeedsCorroboration =
    tokens.length <= 2 && !authorMatched && !yearMatched;
  const hasMetadataCorroboration =
    identifierMatched ||
    authorMatched ||
    yearMatched ||
    (exactTitle && tokens.length >= 3);
  const accepted =
    !identifierConflict &&
    !yearConflict &&
    titleCoverage >= 0.78 &&
    score >= 0.65 &&
    hasMetadataCorroboration &&
    !shortTitleNeedsCorroboration;

  return {
    score,
    titleCoverage,
    authorMatched,
    yearMatched,
    yearConflict,
    identifierMatched,
    identifierConflict,
    accepted,
  };
}

function extractMatchDOI(value: string) {
  return (value.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i)?.[0] || "")
    .replace(/[),.;]+$/g, "")
    .toLowerCase();
}

function extractMatchISBN(value: string) {
  return (value.match(/(?:97[89][\d\s-]{10,16}|\d[\dXx\s-]{8,16})/)?.[0] || "")
    .replace(/[^\dX]/gi, "")
    .toUpperCase();
}

async function reuseOrRepairMatchedAttachment(
  parentItem: Zotero.Item,
  matchedFile: OS.File.Entry,
  preferredAttachmentIDs: Set<number> = new Set(),
) {
  const matchedName = normalizeAttachmentMatchName(matchedFile.name);
  const brokenCandidates: Array<{
    attachment: Zotero.Item;
    distance: number;
  }> = [];

  const attachments = parentItem
    .getAttachments()
    .map((attachmentID) => Zotero.Items.get(attachmentID))
    .filter((attachment): attachment is Zotero.Item => Boolean(attachment));

  // Do not create a duplicate when the item already has an accessible PDF
  // whose filename/content passes the same conservative metadata checks used
  // for new candidates. This covers both stored and linked attachments.
  for (const attachment of attachments) {
    if (
      attachment.attachmentContentType !== "application/pdf" ||
      !(await attachment.fileExists())
    ) {
      continue;
    }
    const existingPath = await attachment.getFilePathAsync();
    const attachmentName =
      attachment.attachmentFilename || attachment.getField("title") || "";
    if (
      attachment.isLinkedFileAttachment() &&
      existingPath &&
      normalizeAttachmentMatchName(String(attachmentName)) === matchedName &&
      PathUtils.normalize(existingPath) ===
        PathUtils.normalize(matchedFile.path)
    ) {
      ztoolkit.log("Matched file is already attached", attachment.id);
      return attachment;
    }

    let evidence = String(attachmentName);
    try {
      const result = await (Zotero as any).PDFWorker.getFullText(
        attachment.id,
        5,
      );
      const text = String(result?.text || "");
      if (text.replace(/\s/g, "").length >= 50) {
        evidence += ` ${text}`;
      }
    } catch (error) {
      ztoolkit.log(
        "Could not validate existing PDF attachment",
        attachment.id,
        error,
      );
    }
    const existingMatch = scoreAttachmentMetadata(parentItem, evidence);
    if (existingMatch.accepted) {
      ztoolkit.log(
        "Matching accessible PDF already exists; skipping duplicate",
        attachment.id,
        existingMatch,
      );
      return attachment;
    }
  }

  for (const attachment of attachments) {
    if (!attachment?.isLinkedFileAttachment()) continue;

    const attachmentName = normalizeAttachmentMatchName(
      attachment.attachmentFilename || attachment.getField("title") || "",
    );
    const distance = comparison.metricLcs.distance(attachmentName, matchedName);

    if (await attachment.fileExists()) continue;

    brokenCandidates.push({
      attachment,
      distance: preferredAttachmentIDs.has(attachment.id) ? -1 : distance,
    });
  }

  brokenCandidates.sort((a, b) => a.distance - b.distance);
  const bestBroken = brokenCandidates[0];
  const maxRepairDistance = Math.max(8, Math.ceil(matchedName.length * 0.4));
  if (
    bestBroken &&
    (bestBroken.distance === -1 || bestBroken.distance <= maxRepairDistance)
  ) {
    const attachment = bestBroken.attachment;
    ztoolkit.log(
      "Repairing broken linked attachment",
      attachment.id,
      attachment.attachmentPath,
      matchedFile.path,
    );
    attachment.attachmentPath = matchedFile.path;
    await attachment.saveTx();
    if (!(await attachment.fileExists())) {
      throw new Error(
        `Linked attachment ${attachment.id} still cannot resolve ${matchedFile.path}`,
      );
    }
    return attachment;
  }

  return undefined;
}

function normalizeAttachmentMatchName(name: string) {
  return name
    .replace(/\.pdf$/i, "")
    .replace(/\[[^\]]*]/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function collectMatchAttachmentFiles(
  rootDir: string,
): Promise<OS.File.Entry[]> {
  const files: OS.File.Entry[] = [];
  const pendingDirs = [rootDir];
  const visitedDirs = new Set<string>();

  while (pendingDirs.length) {
    const dir = pendingDirs.pop() as string;
    const normalizedDir = PathUtils.normalize(dir);
    if (visitedDirs.has(normalizedDir)) continue;
    visitedDirs.add(normalizedDir);

    let children: string[];
    try {
      children = await IOUtils.getChildren(normalizedDir);
    } catch (error) {
      ztoolkit.log(
        "Cannot read Match Attachment directory",
        normalizedDir,
        error,
      );
      continue;
    }

    for (const childPath of children) {
      let stat: Awaited<ReturnType<typeof IOUtils.stat>>;
      try {
        stat = await IOUtils.stat(childPath);
      } catch (error) {
        ztoolkit.log("Cannot inspect Match Attachment path", childPath, error);
        continue;
      }

      if (stat.type === "directory") {
        pendingDirs.push(childPath);
      } else {
        const name = PathUtils.filename(childPath);
        if (/\.pdf$/i.test(name)) {
          files.push({
            isDir: false,
            name,
            path: childPath,
          } as OS.File.Entry);
        }
      }
    }
  }

  return files;
}

function getMatchFilename(file: OS.File.Entry) {
  return cleanLigature(file.name.replace(/\..+?$/, ""));
}

async function matchAttangerAttachment() {
  const sourceDir = await checkDir("sourceDir", "source path");
  if (!sourceDir) {
    ztoolkit.log("source dir is empty, exit");
    return;
  }
  const fileTypes = getPref("fileTypes") as string;
  const fileTypeList = fileTypes.split(",");
  // ztoolkit.log('match attanger attachments for these file types: ', fileTypeList);

  const items = ZoteroPane.getSelectedItems()
    .filter((i) => i.isTopLevelItem() && i.isRegularItem())
    .sort((a, b) => getPlainTitle(a).length - getPlainTitle(b).length);

  for (const item of items) {
    // 使用 getCollectionPathsOfItem 获取条目所在的分类路径
    // let collectionPath = getCollectionPathsOfItem(item);
    // if (collectionPath === undefined) collectionPath = ''

    const existAttachments = item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .filter((item) => item.isAttachment())
      .map((item) => item.getField("title"));

    const subfolder = getSubfolderPath(item);

    const realRoot = PathUtils.joinRelative(sourceDir, subfolder); // 拼接出实际文件目录路径
    const attachmentBaseName = Zotero.Attachments.getFileBaseNameFromItem(item);

    ztoolkit.log("item: ", item.getDisplayTitle());
    ztoolkit.log("|  realRoot:", realRoot);
    ztoolkit.log("|  exist attachments:", existAttachments);

    for (const ext of fileTypeList) {
      const fullpath = PathUtils.joinRelative(
        realRoot,
        `${attachmentBaseName}.${ext}`,
      );
      const file = Zotero.File.pathToFile(fullpath);
      const basename = file.leafName;
      // Check if the file exists before attempting to import
      if (file.exists()) {
        if (!existAttachments.includes(basename)) {
          try {
            const attItem = await Zotero.Attachments.linkFromFile({
              file: fullpath,
              parentItemID: item.id,
            });

            showAttachmentItem(attItem);
            ztoolkit.log("|  Imported attachment:", attItem.getDisplayTitle());
          } catch (error) {
            ztoolkit.log("|  Error importing attachment:", error);
          }
        } else {
          ztoolkit.log("|  skip exists:", basename);
        }
      }
    }
  }
}

async function openUsing(fileHandler: string, fileType = "pdf") {
  const selectedItems = ZoteroPane.getSelectedItems();
  const ids: number[] = [];

  await Promise.all(
    selectedItems.map(async (item: Zotero.Item) => {
      if (item.isAttachment()) {
        ids.push(item.id);
      } else {
        ids.push((await item.getBestAttachments())[0].id);
      }
    }),
  );
  const _fileHandler = Zotero.Prefs.get(`fileHandler.${fileType}`) as string;
  Zotero.Prefs.set(`fileHandler.${fileType}`, fileHandler);
  try {
    await ZoteroPane.viewAttachment(ids);
  } catch {
    ztoolkit.log("error when ZoteroPane.viewAttachment(ids)");
  }

  Zotero.Prefs.set(`fileHandler.${fileType}`, _fileHandler);
}

/**
 * Get the last modified file from directory
 * @param  {string} path Path to directory
 * @return {string}      Path to last modified file in folder or undefined.
 */
function getLastFileInFolder(path: string) {
  const dir = Zotero.File.pathToFile(path);
  const files = dir.directoryEntries;
  let lastmod = { lastModifiedTime: 0, path: undefined };
  while (files.hasMoreElements()) {
    // get next file
    const file = files.getNext().QueryInterface(Components.interfaces.nsIFile);
    // skip if directory, hidden file or certain file types
    if (file.isDirectory() || file.isHidden()) {
      continue;
    }
    // check modification time
    if (file.isFile() && file.lastModifiedTime > lastmod.lastModifiedTime) {
      lastmod = file;
    }
  }
  // return sorted directory entries
  return lastmod.path;
}

function getRuleList(prefName: string) {
  return ((getPref(prefName) as string) || "").split(/,\s*/).filter(Boolean);
}

function isFilenameMatched(prefName: string, filenameNoExt: string | null) {
  if (!filenameNoExt) return false;
  const rules = getRuleList(prefName);
  if (rules.length === 0) return false;
  return rules.some((rule: string) => {
    try {
      return new RegExp(rule).test(filenameNoExt);
    } catch (e) {
      ztoolkit.log("Invalid filename matching rule", prefName, rule, e);
      return false;
    }
  });
}

async function getAttachmentFilenameNoExt(attItem: Zotero.Item) {
  const file = (await attItem.getFilePathAsync()) as string;
  if (!file) return null;
  const origFilename = PathUtils.split(file).pop() as string;
  return origFilename.replace(filenameExtRE, "");
}

function getNonNegativeIntegerPref(key: string, fallback: number) {
  const value = getPref(key);
  const parsed =
    typeof value === "number" ? value : Number.parseInt(`${value ?? ""}`, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function isAutoRenameLinkedAttachmentCandidate(attItem: Zotero.Item) {
  return (
    !attItem.deleted &&
    !attItem.parentItem?.deleted &&
    attItem.isAttachment() &&
    attItem.isLinkedFileAttachment() &&
    checkFileType(attItem)
  );
}

async function canAutoRenameLinkedAttachment(attItem: Zotero.Item) {
  if (!isAutoRenameLinkedAttachmentCandidate(attItem)) {
    return false;
  }
  try {
    return await attItem.fileExists();
  } catch (e) {
    ztoolkit.log("Failed to inspect linked attachment", attItem.id, e);
    return false;
  }
}

function showLinkedAttachmentRenameError(attItem: Zotero.Item) {
  new ztoolkit.ProgressWindow("Attanger", {
    closeTime: 5000,
    closeOtherProgressWindows: true,
  })
    .createLine({
      text: getString("rename-linked-attachment-error", {
        args: { title: attItem.getField("title") as string },
      }),
      icon: addon.data.icons.renameAttachment,
    })
    .show();
}

async function renameAttachmentFile(attItem: Zotero.Item, newName: string) {
  const renameAttachment = attItem.renameAttachmentFile as any;
  if (renameAttachment.length <= 1) {
    return await renameAttachment.call(attItem, newName, {
      overwrite: false,
      unique: true,
      updateTitle: false,
      out: {},
    });
  }
  return await renameAttachment.call(attItem, newName, false, true);
}

function getCreatorTypeID(name: string) {
  try {
    const id = Zotero.CreatorTypes.getID(name);
    return typeof id === "number" ? id : undefined;
  } catch (_e) {
    return undefined;
  }
}

function getPreferredCreatorFileBaseName(
  item: Zotero.Item,
  attachmentTitle: string,
) {
  const parentTitle = String(
    item.getField("title") || item.getDisplayTitle() || "",
  ).trim();
  const safeAttachmentTitle = /^(?:pdf|pdf\.pdf)$/i.test(
    String(attachmentTitle || "").trim(),
  )
    ? parentTitle
    : attachmentTitle;
  const options = { attachmentTitle: safeAttachmentTitle } as any;
  let baseName = Zotero.Attachments.getFileBaseNameFromItem(item, options);
  if (/^(?:pdf|pdf\.pdf)$/i.test(String(baseName || "").trim())) {
    baseName = parentTitle;
  }
  const creators = ((item as any).getCreators?.() || []) as Array<{
    creatorTypeID?: number;
  }>;

  let primaryCreatorTypeID: number | undefined;
  try {
    const id = Zotero.CreatorTypes.getPrimaryIDForType(
      (item as any).itemTypeID,
    );
    primaryCreatorTypeID = typeof id === "number" ? id : undefined;
  } catch (_e) {
    // Keep Zotero's normal result if creator type metadata is unavailable.
  }
  if (
    primaryCreatorTypeID !== undefined &&
    creators.some((creator) => creator.creatorTypeID === primaryCreatorTypeID)
  ) {
    return baseName;
  }

  const editorTypeIDs = new Set(
    [getCreatorTypeID("editor"), getCreatorTypeID("seriesEditor")].filter(
      (id): id is number => id !== undefined,
    ),
  );
  if (
    !editorTypeIDs.size ||
    !creators.some((creator) => editorTypeIDs.has(creator.creatorTypeID!))
  ) {
    return baseName;
  }

  const editorName = Zotero.Attachments.getFileBaseNameFromItem(item, {
    attachmentTitle,
    formatString: '{{ editors max="1" }}',
  } as any);
  if (!editorName || baseName.includes(editorName)) {
    return baseName;
  }

  const firstCreator = String(
    (item as any).getField?.("firstCreator", true, true) || "",
  ).trim();
  if (firstCreator && baseName.includes(firstCreator)) {
    return baseName.replace(firstCreator, editorName);
  }

  return `${editorName} - ${baseName}`;
}

/**
 * 重命名文件，但不重命名Zotero内显示的名称 - 来自Zotero官方代码
 * @param item
 * @returns
 */
async function renameFile(attItem: Zotero.Item, retry = 0) {
  const ownsMutationLock = !attachmentMutationInFlight.has(attItem.id);
  if (ownsMutationLock) {
    attachmentMutationInFlight.add(attItem.id);
  }
  try {
    return await renameFileInternal(attItem, retry);
  } finally {
    if (ownsMutationLock) {
      attachmentMutationInFlight.delete(attItem.id);
    }
  }
}

async function renameFileInternal(attItem: Zotero.Item, retry = 0) {
  const file = (await attItem.getFilePathAsync()) as string;
  if (!file) {
    ztoolkit.log("renameFile skipped: attachment file not found", attItem);
    return;
  }
  const origFilename = PathUtils.split(file).pop() as string;
  if (!checkFileType(attItem, origFilename)) {
    ztoolkit.log("renameFile skipped: unsupported file type", origFilename);
    return;
  }
  const parentItemID = attItem.parentItemID as number;
  // 无父元素不进行重命名
  if (!parentItemID) {
    ztoolkit.log("renameFile skipped: attachment has no parent item", attItem);
    return attItem;
  }
  const parentItem = await Zotero.Items.getAsync(parentItemID);
  // getFileBaseNameFromItem
  let newName = getPreferredCreatorFileBaseName(
    parentItem,
    attItem.getField("title") as string,
  );
  if (!newName || /^(?:pdf|pdf\.pdf)$/i.test(newName.trim())) {
    ztoolkit.log(
      "renameFile skipped: unsafe generic PDF filename",
      attItem.id,
      newName,
    );
    return attItem;
  }

  const ext = origFilename.match(filenameExtRE);
  if (ext) {
    newName = newName + ext[0];
  }
  newName = getOneDriveSafeFilename(newName);
  // fix https://github.com/MuiseDestiny/zotero-attanger/issues/263
  const origFilenameNoExt = origFilename.replace(filenameExtRE, "");
  if (isFilenameMatched("filenameSkipRenameRules", origFilenameNoExt)) {
    return attItem;
  }
  if (isFilenameMatched("filenameAsPrefixRules", origFilenameNoExt)) {
    newName = origFilenameNoExt + "_" + newName;
  }
  const origTitle = attItem.getField("title") as string;
  const shouldUpdateTitle =
    getPref("syncAttachmentTitle") === true ||
    shouldSyncAttachmentTitle(
      attItem,
      origTitle,
      origFilename,
      origFilenameNoExt,
    );
  if (newName === origFilename) {
    if (shouldUpdateTitle && origTitle !== origFilename) {
      attItem.setField("title", origFilename);
      await attItem.saveTx();
    }
    return attItem;
  }
  ztoolkit.log({ newName });
  const renamed = await renameAttachmentFile(attItem, newName);
  if (renamed !== true) {
    ztoolkit.log("renamed = " + renamed, "newName", newName);
    await Zotero.Promise.delay(3e3);
    if (retry < 5) {
      return await renameFileInternal(attItem, retry + 1);
    }
    return;
  }
  const renamedFile = (await attItem.getFilePathAsync()) as string;
  const actualFilename = renamedFile
    ? (PathUtils.split(renamedFile).pop() as string)
    : newName;
  if (shouldUpdateTitle) {
    ztoolkit.log("renameFile sync attachment title", {
      origTitle,
      actualFilename,
    });
    attItem.setField("title", actualFilename);
  }
  await attItem.saveTx();
  return attItem;
}

function shouldSyncAttachmentTitle(
  attItem: Zotero.Item,
  title: string,
  filename: string,
  filenameNoExt: string,
) {
  if (title === filename || title === filenameNoExt) {
    return true;
  }
  return title === "PDF" && attItem.attachmentContentType === "application/pdf";
}

/**
 * 得到附件的中间路径(对于subfolderFormat进行格式化)
 * @param item Item
 */
export function getSubfolderPath(item: Zotero.Item) {
  let subfolder = "";
  const subfolderFormat = getPref("subfolderFormat") as string;
  if (subfolderFormat.length > 0) {
    // Zotero.Attachments.getFileBaseNameFromItem 补充不支持的变量
    // 3. 得到最终路径
    // @ts-ignore 未添加属性
    const _getValidFileName = Zotero.File.getValidFileName;
    // @ts-ignore 未添加属性
    Zotero.File.getValidFileName = (fileName) =>
      fileName.replace(/[?*:|"<>]/g, "");

    subfolder = subfolderFormat
      .split(/(?<=\}\})\/(?=\{\{)/)
      .map((formatString: string) => {
        // ztoolkit.log(formatString);
        if (formatString == "{{collection}}") {
          return getCollectionPathsOfItem(item);
        } else {
          return getValidFolderName(
            Zotero.Attachments.getFileBaseNameFromItem(item, {
              formatString,
            } as any),
          );
        }
      })
      .join(addon.data.folderSep);
    if (Zotero.isWin) {
      subfolder = subfolder.replace(/[/]/g, "\\");
    } else {
      subfolder = subfolder.replace(/[\\]/g, "/");
    }
    // @ts-ignore 未添加属性
    Zotero.File.getValidFileName = _getValidFileName;
  }
  if (!subfolder) return "";
  return subfolder
    .split(/[\\/]/)
    .map((segment) => getOneDriveSafeSegment(segment, 100))
    .join(addon.data.folderSep);
}

/**
 * 移动文件
 * @param item Attachment Item
 */
type MoveFileOptions = {
  silent?: boolean;
  shouldCancel?: () => boolean;
};

export async function moveFile(
  attItem: any,
  { silent = false, shouldCancel = () => false }: MoveFileOptions = {},
) {
  const isCancelled = () => attItem.deleted || shouldCancel();
  if (isCancelled()) return;
  const attachType = getPref("attachType");
  if (attachType != "linking") {
    ztoolkit.log("moveFile skipped: attach type is not linking", attachType);
    return;
  }
  let destDir = await checkDir("destDir", "destination directory", silent);
  if (isCancelled()) return;
  // 1. 目标根路径
  if (!destDir) return;
  // 2. 中间路径 (计算过程放入函数getSubfolderPath，其被多次复用)
  const subfolder = getSubfolderPath(attItem.topLevelItem);
  ztoolkit.log(destDir, subfolder);
  if (subfolder.length > 0) {
    destDir = PathUtils.joinRelative(destDir, subfolder);
  }
  const sourcePath = (await attItem.getFilePathAsync()) as string;
  if (!sourcePath || isCancelled()) return;
  // 防止两个并发 handler 对同一个源文件重复执行 moveFile
  if (movingPaths.has(sourcePath)) {
    ztoolkit.log("moveFile skipped: concurrent call for same path", sourcePath);
    return;
  }
  movingPaths.add(sourcePath);
  try {
    return await _moveFile(attItem, sourcePath, destDir, isCancelled);
  } finally {
    movingPaths.delete(sourcePath);
  }
}

async function _moveFile(
  attItem: any,
  sourcePath: string,
  destDir: string,
  shouldCancel: () => boolean,
) {
  if (shouldCancel()) return;
  const filename = PathUtils.filename(sourcePath);
  if (!checkFileType(attItem, filename)) {
    ztoolkit.log("moveFile skipped: unsupported file type", filename);
    return;
  }
  let destPath = PathUtils.joinRelative(
    destDir,
    getOneDriveSafeFilename(filename),
  );
  if (sourcePath == destPath) {
    ztoolkit.log("moveFile skipped: source already at destination", sourcePath);
    return attItem;
  }
  if (await pathExists(destPath)) {
    if (shouldCancel()) return;
    ztoolkit.log("目标目录存在", file2md5(sourcePath), file2md5(destPath));
    if (file2md5(sourcePath) != file2md5(destPath)) {
      ztoolkit.log("不是同一个文件");
      const popupWin = new ztoolkit.ProgressWindow("Attanger", {
        closeTime: -1,
        closeOtherProgressWindows: true,
      })
        .createLine({
          text: "The target file already exists; a numeric suffix will be automatically added to the filename.",
          icon: addon.data.icons.moveFile,
        })
        .show();
      popupWin.addDescription(
        `<a href="https://zotero.org">Click to enter a specified suffix.</a>`,
      );
      await waitUtilAsync(() =>
        // @ts-ignore oriate
        Boolean(popupWin.lines && popupWin.lines[0]._itemText),
      );
      const lock = Zotero.Promise.defer();
      const timer = window.setTimeout(() => {
        popupWin.close();
        lock.resolve();
      }, 3e3);
      // @ts-ignore private
      popupWin.lines[0]._hbox.ownerDocument
        .querySelector("label[href]")
        .addEventListener("click", async (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
          window.clearTimeout(timer);
          popupWin.close();
          const suffix = window.prompt("Suffix") as string;
          destPath = await addSuffixToFilename(destPath, suffix);
          lock.resolve();
        });

      await lock.promise;
      if (shouldCancel()) return;
      destPath = await addSuffixToFilename(destPath);
    } else {
      // Reuse an existing identical file without creating a second linked item.
      const parentItem = attItem.parentItemID
        ? Zotero.Items.get(attItem.parentItemID)
        : null;
      const alreadyLinked = parentItem
        ? await getLinkedAttachmentAtPath(parentItem, destPath, attItem.id)
        : undefined;
      if (alreadyLinked) {
        ztoolkit.log(
          "moveFile skipped: linked attachment already exists for parent",
          destPath,
        );
        return alreadyLinked;
      }
      if (shouldCancel()) return;
      ztoolkit.log(
        "moveFile: file already at destination, creating linked item without copy",
        destPath,
      );
      return await replaceWithLinkedAttachment(
        attItem,
        destPath,
        sourcePath,
        true,
      );
    }
  }
  // 创建中间路径
  if (!(await createDirectoryPath(destDir))) {
    return;
  }
  if (shouldCancel()) return;
  // 移动文件到目标文件夹
  try {
    if (!(await movePath(sourcePath, destPath, shouldCancel))) {
      return;
    }
  } catch (e) {
    ztoolkit.log(e);
    return;
  }
  if (shouldCancel()) {
    await rollbackCancelledMove(sourcePath, destPath);
    return;
  }
  return await replaceWithLinkedAttachment(attItem, destPath, sourcePath);
}

async function getLinkedAttachmentAtPath(
  parentItem: Zotero.Item,
  path: string,
  excludeItemID: number,
) {
  const normalizedPath = PathUtils.normalize(path);
  for (const attachmentID of parentItem.getAttachments()) {
    if (attachmentID === excludeItemID) continue;
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment?.isLinkedFileAttachment()) continue;
    const attachmentPath = await attachment.getFilePathAsync();
    if (
      attachmentPath &&
      PathUtils.normalize(attachmentPath) === normalizedPath
    ) {
      return attachment;
    }
  }
  return undefined;
}

async function replaceWithLinkedAttachment(
  attItem: Zotero.Item,
  destPath: string,
  sourcePath: string,
  removeSourceFile = false,
) {
  let newAttItem: Zotero.Item | undefined;
  attachmentMutationInFlight.add(attItem.id);
  try {
    const json = attItem.toJSON() as any;
    json.linkMode = "linked_file";
    json.path = destPath;
    delete json.filename;
    newAttItem = new Zotero.Item("attachment" as any);
    newAttItem.libraryID = attItem.libraryID;
    newAttItem.fromJSON(json);
    await newAttItem.saveTx();
    attachmentMutationInFlight.add(newAttItem.id);
    await transferItem(attItem, newAttItem);
    if (removeSourceFile && !getPref("moveWithoutDeleting")) {
      try {
        await IOUtils.remove(sourcePath);
      } catch (e) {
        ztoolkit.log("Failed to remove imported source file", sourcePath, e);
      }
    }
    await attItem.eraseTx();
    await removeEmptyFolder(PathUtils.parent(sourcePath) as string);
    return newAttItem;
  } finally {
    attachmentMutationInFlight.delete(attItem.id);
    if (newAttItem?.id) {
      attachmentMutationInFlight.delete(newAttItem.id);
    }
  }
}

async function attachNewFile(options: {
  libraryID: number;
  parentItemID: number | undefined;
  collections: number[] | undefined;
}) {
  const sourceDir = await checkDir("sourceDir", "source path");
  if (!sourceDir) return;
  const path = getLastFileInFolder(sourceDir);
  if (!path) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: "No File Found", type: "default" })
      .show();
  } else {
    const attItem = await Zotero.Attachments.importFromFile({
      file: path,
      ...options,
    });
    showAttachmentItem(attItem);
    if (!attItem.parentItemID) {
      Zotero.RecognizeDocument.recognizeItems([attItem]);
    }
    removeFile(path);
  }
}

function removeFile(file: any) {
  // 勾选“移动但不删除原文件”时，保留源文件，不做任何删除
  if (getPref("moveWithoutDeleting")) {
    return;
  }
  if (ZoteroPane.getSelectedLibraryID() != 1) {
    return;
  }
  file = Zotero.File.pathToFile(file);
  if (!file.exists()) return;
  try {
    ztoolkit.log("remove file", file.path);
    // remove file
    if (!file.isDirectory()) {
      ztoolkit.log("removeFile", file.path);
      file.remove(false);
    }
    // ... for directories, remove them if no non-hidden files are inside
    else {
      const files = file.directoryEntries;
      while (files.hasMoreElements()) {
        const f = files.getNext().QueryInterface(Components.interfaces.nsIFile);
        if (!f.isHidden()) return;
      }
      file.remove(true);
    }
  } catch (err) {
    ztoolkit.log(err);
  }
}

function file2md5(filepath: string) {
  return Zotero.Utilities.Internal.md5(Zotero.File.pathToFile(filepath));
}
/**
 * 获取Item的分类路径
 * @param item
 * @returns
 */
function getCollectionPathsOfItem(item: Zotero.Item) {
  const getCollectionPath = function (collectionID: number): string {
    const collection = Zotero.Collections.get(
      collectionID,
    ) as Zotero.Collection;
    if (!collection.parentID) {
      return collection.name;
    }
    return (
      getCollectionPath(collection.parentID) +
      addon.data.folderSep +
      collection.name
    );
  };
  const itemCollections = item.getCollections().map(getCollectionPath);
  if (selectedCollection) {
    const preferredCollection = [selectedCollection.id].map(
      getCollectionPath,
    )[0] as string;
    ztoolkit.log({ preferredCollection, itemCollections });
    const isExist = itemCollections.find((i) => i == preferredCollection);
    if (isExist) {
      return preferredCollection;
    }
    return itemCollections[0] || "";
  } else {
    ztoolkit.log({ itemCollections });
    return itemCollections[0] || "";
  }
  // fix https://github.com/MuiseDestiny/zotero-attanger/issues/264
  // if (selectedCollection) {
  //   return [selectedCollection.id].map(getCollectionPath)[0];
  // } else {
  //   return item.getCollections().map(getCollectionPath).slice(0, 1)[0];
  // }
}

/**
 * 从文件名中删除非法字符
 * Modified from Zotero.File.getValidFileName
 * @param folderName
 * @returns
 */
function getValidFolderName(folderName: string): string {
  // Replace illegal folder name characters
  if (getPref("slashAsSubfolderDelimiter")) {
    folderName = folderName.replace(/[\\:*?"<>|]/g, "");
  } else {
    // eslint-disable-next-line no-useless-escape
    folderName = folderName.replace(/[\/\\:*?"<>|]/g, "");
  }
  // Replace newlines and tabs (which shouldn't be in the string in the first place) with spaces
  folderName = folderName.replace(/[\r\n\t]+/g, " ");
  // Replace various thin spaces
  folderName = folderName.replace(/[\u2000-\u200A]/g, " ");
  // Replace zero-width spaces
  folderName = folderName.replace(/[\u200B-\u200E]/g, "");
  // Strip characters not valid in XML, since they won't sync and they're probably unwanted
  // eslint-disable-next-line no-control-regex
  folderName = folderName.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/g,
    "",
  );
  // Normalize to NFC
  folderName = folderName.normalize();
  // Replace bidi isolation control characters
  folderName = folderName.replace(/[\u2068\u2069]/g, "");
  // Don't allow hidden files
  folderName = folderName.replace(/^\./, "");
  // Don't allow blank or illegal names
  if (!folderName || folderName == "." || folderName == "..") {
    folderName = "_";
  }
  return folderName;
}

const windowsReservedNameRE =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function getOneDriveSafeSegment(value: string, maxLength: number) {
  let safe = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[#%"*:<>?\\/|]/g, "-")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/[ .]+$/g, "");

  safe = [...safe]
    .slice(0, maxLength)
    .join("")
    .replace(/[ .]+$/g, "");
  if (!safe || safe === "." || safe === "..") safe = "Adsız";
  if (windowsReservedNameRE.test(safe)) safe = `${safe}-dosya`;
  return safe;
}

export function getOneDriveSafeFilename(filename: string) {
  const extensionMatch = filename.match(/(\.[^.]+)$/);
  const extension = extensionMatch
    ? getOneDriveSafeSegment(extensionMatch[1], 20)
    : "";
  const base = extensionMatch
    ? filename.slice(0, -extensionMatch[1].length)
    : filename;
  const safeBase = getOneDriveSafeSegment(base, 180 - extension.length);
  return `${safeBase}${extension}`;
}

function checkFileType(attItem: Zotero.Item, filename?: string) {
  if (!attItem) return false;
  const fileTypes = getPref("fileTypes") as string;
  if (!fileTypes) return true;
  const attachmentFilename = filename || attItem.attachmentFilename || "";
  const pos = attachmentFilename.lastIndexOf("."),
    fileType =
      pos == -1 ? "" : attachmentFilename.substring(pos + 1).toLowerCase(),
    regex = fileTypes.toLowerCase().replace(/,/gi, "|");
  // return value
  return fileType.search(new RegExp(regex)) >= 0 ? true : false;
}

function showRenameMessage(text: string) {
  new ztoolkit.ProgressWindow("Attanger", {
    closeTime: 5000,
    closeOtherProgressWindows: true,
  })
    .createLine({
      text,
      icon: addon.data.icons.renameAttachment,
    })
    .show();
}

function showMoveMessage(text: string) {
  new ztoolkit.ProgressWindow("Attanger", {
    closeTime: 5000,
    closeOtherProgressWindows: true,
  })
    .createLine({
      text,
      icon: addon.data.icons.renameMoveAttachment,
    })
    .show();
}

/**
 * 向popupWin添加附件行
 * @param attItem
 * @param type
 */
function showAttachmentItem(attItem: Zotero.Item) {
  ztoolkit.log("showAttachmentItem", attItem);
  if (!attItem) {
    return;
  }
  const popupWin = new ztoolkit.ProgressWindow("Attanger", {
    closeTime: -1,
    closeOtherProgressWindows: true,
  });
  // 显示父行
  if (attItem && attItem.isTopLevelItem()) {
    popupWin
      .createLine({
        text: (ZoteroPane.getSelectedCollection() as Zotero.Collection).name,
        icon: addon.data.icons.collection,
      })
      .show();
  } else {
    const parentItem = attItem.parentItem as Zotero.Item;
    popupWin
      .createLine({
        text: parentItem.getField("title") as string,
        icon: parentItem.getImageSrc(),
      })
      .show();
  }
  // 显示附件行
  popupWin.createLine({
    text: attItem.getField("title") as string,
    icon: attItem.getImageSrc().replace("pdflink", "pdf-link"),
  });
  // 设置透明度 调整缩进
  // @ts-ignore lines私有变量
  const lines = popupWin.lines;
  waitUntil(
    () => lines?.[1]?._hbox,
    () => {
      const hbox = lines?.[1]?._hbox;
      if (hbox) {
        hbox.style.opacity = "1";
        hbox.style.marginLeft = "2em";
      }
    },
    10,
  );
  popupWin.startCloseTimer(3000);
}

/**
 * Remove empty folders recursively within zotfile directories
 * @param  {String|nsIFile} path Folder as nsIFile.
 * @return {void}
 */
async function removeEmptyFolder(path: string | nsIFile) {
  if (!getPref("autoRemoveEmptyFolder") as boolean) {
    return false;
  }
  if (!path as boolean) {
    return false;
  }
  const folder = Zotero.File.pathToFile(path);
  let rootFolders = [Zotero.getStorageDirectory().path];
  const source_dir = getPref("sourceDir") as string;
  const dest_dir = getPref("destDir") as string;
  if (source_dir != "") {
    rootFolders.push(source_dir);
  }
  if (dest_dir != "") {
    rootFolders.push(dest_dir);
  }
  rootFolders = rootFolders.map((path) => PathUtils.normalize(path));
  // 不属于插件相关根目录，不处理
  if (!rootFolders.find((dir) => folder.path.startsWith(dir))) {
    return false;
  }
  const files = folder.directoryEntries;
  let fileCount = 0;
  while (files.hasMoreElements()) {
    const f = files.getNext().QueryInterface(Components.interfaces.nsIFile);
    fileCount++;
    if (f.leafName !== ".DS_Store" && f.leafName !== "Thumbs.db") {
      return true;
    } else if (fileCount > 1) {
      break;
    }
  }
  ztoolkit.log("Remove empty folder: ", folder.path);
  removeFile(folder);
  return await removeEmptyFolder(PathUtils.parent(folder.path) as string);
}

/**
 * 迁移数据
 */
async function transferItem(
  originalItem: Zotero.Item,
  targetItem: Zotero.Item,
) {
  ztoolkit.log("迁移标注");
  await Zotero.DB.executeTransaction(async function () {
    await Zotero.Items.moveChildItems(originalItem, targetItem);
  });
  // 迁移相关
  ztoolkit.log("迁移相关");
  await Zotero.Relations.copyObjectSubjectRelations(originalItem, targetItem);
  // 迁移索引
  ztoolkit.log("迁移索引");
  await Zotero.DB.executeTransaction(async function () {
    await Zotero.Fulltext.transferItemIndex(originalItem, targetItem);
  });
  // 迁移标签
  ztoolkit.log("迁移标签");
  targetItem.setTags(originalItem.getTags());
  // 迁移PDF笔记
  ztoolkit.log("迁移PDF笔记");
  targetItem.setNote(originalItem.getNote());
  await targetItem.saveTx();
}

/**
 * 为文件添加后缀，如果存在
 * @param filename
 * @returns
 */
async function addSuffixToFilename(filename: string, suffix?: string) {
  let incr = 0;
  let destPath, destName;

  // 提取文件名（不含扩展名）和扩展名
  const [root, ext] = (() => {
    const parts = filename.split(".");
    const ext = parts.length > 1 ? parts.pop() : "";
    return [parts.join("."), ext];
  })();
  if (suffix) {
    // 直接返回不在考虑是否存在
    return ext ? `${root}_${suffix}.${ext}` : `${root}_${suffix}`;
  }
  while (true) {
    // 如果存在数字后缀，则添加它
    if (incr) {
      destName = ext ? `${root}_${incr}.${ext}` : `${root}_${incr}`;
    } else {
      destName = filename;
    }

    destPath = destName; // 假设 destPath 是目标文件路径

    // 检查文件是否存在
    if (await pathExists(destPath)) {
      incr++;
    } else {
      return destPath;
    }
  }
}

async function checkDir(prefName: string, prefDisplay: string, silent = false) {
  let dir = getPref(prefName);
  if (typeof dir !== "string" || !(await pathExists(dir, "directory"))) {
    if (silent) {
      new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
        .createLine({
          text: getString(`dir-not-set-${prefName}`),
          type: "default",
        })
        .show();
      return false;
    }
    // @ts-ignore window
    const fp = new window.FilePicker();

    fp.init(window, `Select ${prefDisplay}`, fp.modeGetFolder);
    fp.appendFilters(fp.filterAll);
    if ((await fp.show()) != fp.returnOK) {
      return false;
    }
    dir = PathUtils.normalize(fp.file);

    if (typeof dir === "string") {
      setPref(prefName, dir);
      return dir;
    } else {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({ text: "No valid path set", type: "default" })
        .show();
      return false;
    }
  }
  return dir;
}

type PathKind = "file" | "directory";

async function pathExists(path: string, kind?: PathKind) {
  try {
    if (await IOUtils.exists(path)) {
      if (!kind) {
        return true;
      }
      return pathMatchesKind(path, kind);
    }
  } catch (e) {
    ztoolkit.log("IOUtils.exists failed", path, e);
  }

  try {
    const file = Zotero.File.pathToFile(path) as any;
    const exists = file.exists();
    const isDirectory = getNsIFileKind(file, "directory");
    const isFile = getNsIFileKind(file, "file");
    if (!kind) {
      return exists || isDirectory || isFile;
    }
    // Some Windows mount-point roots report exists() as false while
    // isDirectory() still correctly identifies the target as a directory.
    return kind === "directory" ? isDirectory : isFile;
  } catch (e) {
    ztoolkit.log("nsIFile exists fallback failed", path, e);
    return false;
  }
}

function pathMatchesKind(path: string, kind: PathKind) {
  try {
    const file = Zotero.File.pathToFile(path) as any;
    return kind === "directory" ? file.isDirectory() : file.isFile();
  } catch (e) {
    ztoolkit.log("nsIFile type check failed", path, e);
    return false;
  }
}

async function movePath(
  sourcePath: string,
  destPath: string,
  shouldCancel: () => boolean = () => false,
) {
  const moveWithoutDeleting = getPref("moveWithoutDeleting") as boolean;
  // 先复制：跨盘 / 跨文件系统安全，同时保留 Windows 兼容性修复
  try {
    await IOUtils.copy(sourcePath, destPath);
  } catch (e) {
    ztoolkit.log("IOUtils.copy failed; retrying with nsIFile.copyTo", e);
    const sourceFile = Zotero.File.pathToFile(sourcePath) as any;
    const destFile = Zotero.File.pathToFile(destPath) as any;
    sourceFile.copyTo(destFile.parent, destFile.leafName);
  }
  if (shouldCancel()) {
    await removeCopiedDestination(destPath);
    return false;
  }
  // 默认语义是“移动”：复制成功后删除原文件；勾选“移动但不删除”时则保留（即复制）
  if (moveWithoutDeleting) {
    return true;
  }
  // 删源前确认目标已写入，避免误删
  if (!(await pathExists(destPath, "file"))) {
    ztoolkit.log("movePath: dest missing after copy, keep source", destPath);
    return false;
  }
  try {
    await IOUtils.remove(sourcePath);
  } catch (e) {
    ztoolkit.log("IOUtils.remove failed; retrying with nsIFile.remove", e);
    const sourceFile = Zotero.File.pathToFile(sourcePath) as any;
    sourceFile.remove(false);
  }
  return true;
}

async function removeCopiedDestination(destPath: string) {
  if (!(await pathExists(destPath, "file"))) return;
  try {
    await IOUtils.remove(destPath);
  } catch (e) {
    ztoolkit.log("Failed to remove cancelled move destination", destPath, e);
    const destFile = Zotero.File.pathToFile(destPath) as any;
    destFile.remove(false);
  }
}

async function rollbackCancelledMove(sourcePath: string, destPath: string) {
  if (!(await pathExists(destPath, "file"))) return;
  if (!(await pathExists(sourcePath, "file"))) {
    try {
      await IOUtils.copy(destPath, sourcePath);
    } catch (e) {
      ztoolkit.log("Failed to restore cancelled move source", sourcePath, e);
      const destFile = Zotero.File.pathToFile(destPath) as any;
      const sourceFile = Zotero.File.pathToFile(sourcePath) as any;
      destFile.copyTo(sourceFile.parent, sourceFile.leafName);
    }
  }
  if (await pathExists(sourcePath, "file")) {
    await removeCopiedDestination(destPath);
  }
}

function getNsIFileKind(file: any, kind: PathKind) {
  try {
    return kind === "directory" ? file.isDirectory() : file.isFile();
  } catch {
    return false;
  }
}

async function createDirectoryPath(destDir: string) {
  if (await pathExists(destDir, "directory")) {
    return true;
  }

  const create: string[] = [];
  let current: string | null = destDir;
  while (current && !(await pathExists(current, "directory"))) {
    if (await pathExists(current, "file")) {
      showPathConflict(current);
      return false;
    }
    create.push(current);
    current = PathUtils.parent(current) as string | null;
  }

  await Promise.all(
    create
      .reverse()
      .map(async (f) => await Zotero.File.createDirectoryIfMissingAsync(f)),
  );
  return true;
}

function showPathConflict(path: string) {
  ztoolkit.log("Cannot create directory because a file already exists", path);
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({
      text: `Cannot create directory because a file already exists: ${path}`,
      type: "default",
    })
    .show();
}

/**
 * 清除文件名中的格式标记，返回纯文本的标题。
 * 虽然通常用于与文件名进行比较，但并不调用Zotero.File.getValidFileName进行规范化。
 */
function getPlainTitle(item: Zotero.Item) {
  return item
    .getDisplayTitle()
    .replace(/<(?:i|b|sub|sub)>(.+?)<\/(?:i|b|sub|sub)>/g, "$1");
}

function cleanLigature(filename: string) {
  let result = filename;
  interface StringMap {
    [key: string]: string;
  }
  const ligature: StringMap = {
    æ: "ae",
    Æ: "AE",
    œ: "oe",
    Œ: "OE",
    ﬀ: "ff",
    ﬁ: "fi",
    ﬂ: "fl",
    ﬃ: "ffi",
    ﬄ: "ffl",
  };
  Object.keys(ligature).forEach((key) => {
    result = result.replace(new RegExp(key, "g"), ligature[key]);
  });
  return result;
}

/**
 * 对Zotero.PDFWorker.getRecognizerData的重写，以便支持直接给出路径。
 */
async function getPDFData(path: string) {
  return Zotero.PDFWorker._enqueue(async () => {
    const buf = new Uint8Array(await IOUtils.read(path)).buffer;
    let result = {};
    try {
      result = await Zotero.PDFWorker._query("getRecognizerData", { buf }, [
        buf,
      ]);
    } catch (e: any) {
      const error = new Error(
        `Worker 'getRecognizerData' failed: ${JSON.stringify({
          error: e.message,
        })}`,
      );
      try {
        error.name = JSON.parse(e.message).name;
      } catch (e: any) {
        ztoolkit.log(e);
      }
      ztoolkit.log(error);
      throw error;
    }

    ztoolkit.log(`Extracted PDF recognizer data for path ${path}`);

    return result;
  }, false);
}

function unregisterNotify(notifyID: string) {
  Zotero.Notifier.unregisterObserver(notifyID);
}

export function registerNotify(
  types: _ZoteroTypes.Notifier.Type[],
  onNotify: _ZoteroTypes.Notifier.Notify,
) {
  const callback = {
    notify: async (...data: Parameters<_ZoteroTypes.Notifier.Notify>) => {
      if (!addon?.data.alive) {
        unregisterNotify(notifyID);
        return;
      }
      await onNotify(...data);
    },
  };

  const notifyID = Zotero.Notifier.registerObserver(callback, types);
  return notifyID;
}
