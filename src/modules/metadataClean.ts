import { config } from "../../package.json";
import { getString } from "../utils/locale";

/** Zotero fields (and pseudo-fields) the clean dialog can wipe. */
export const CLEANABLE_KEYS = [
  "title",
  "creators",
  "abstractNote",
  "date",
  "publisher",
  "publicationTitle",
  "DOI",
  "ISBN",
  "ISSN",
  "url",
  "pages",
  "volume",
  "issue",
  "place",
  "language",
  "series",
  "edition",
  "extra",
  "rights",
  "tags",
] as const;

export type CleanableKey = (typeof CLEANABLE_KEYS)[number];

function fieldLabel(key: CleanableKey): string {
  if (key === "creators") return getString("clean-metadata-field-creators");
  if (key === "tags") return getString("clean-metadata-field-tags");
  try {
    const localized = (Zotero as any).ItemFields?.getLocalizedString?.(key);
    if (localized) return String(localized);
  } catch {
    // Fall through to the raw schema name.
  }
  return key;
}

function getSelectedRegularItems(): Zotero.Item[] {
  const map = new Map<number, Zotero.Item>();
  for (const selected of ZoteroPane.getSelectedItems()) {
    if (selected.isRegularItem()) {
      map.set(selected.id, selected);
      continue;
    }
    if (selected.isAttachment() && selected.parentItemID) {
      const parent =
        selected.parentItem || Zotero.Items.get(selected.parentItemID);
      if (parent?.isRegularItem()) map.set(parent.id, parent);
    }
  }
  return [...map.values()];
}

/**
 * Checkbox dialog — returns the keys the user ticked, or null if cancelled.
 * Defaults are all unchecked; nothing is persisted to prefs.
 */
async function showCleanFieldsDialog(): Promise<CleanableKey[] | null> {
  const keys = [...CLEANABLE_KEYS];
  const cols = 2;
  const fieldRows = Math.ceil(keys.length / cols);
  const dialogData: Record<string, any> = {
    _lastButtonId: "",
  };
  for (const key of keys) {
    dialogData[`field_${key}`] = false;
  }

  const dialog = new ztoolkit.Dialog(fieldRows + 1, cols);
  dialog.addCell(
    0,
    0,
    {
      tag: "p",
      properties: { innerHTML: getString("clean-metadata-dialog-intro") },
      styles: {
        margin: "0 8px 8px 0",
        maxWidth: "280px",
      },
    },
    false,
  );

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const row = Math.floor(i / cols) + 1;
    const col = i % cols;
    dialog.addCell(
      row,
      col,
      {
        tag: "hbox",
        attributes: { align: "center" },
        styles: { margin: "2px 8px 2px 0" },
        children: [
          {
            tag: "input",
            namespace: "html",
            id: `clean-field-${key}`,
            attributes: {
              type: "checkbox",
              "data-bind": `field_${key}`,
              "data-prop": "checked",
            },
          },
          {
            tag: "label",
            namespace: "html",
            attributes: { for: `clean-field-${key}` },
            properties: { innerHTML: fieldLabel(key) },
            styles: { marginLeft: "6px" },
          },
        ],
      },
      false,
    );
  }

  dialog
    .addButton(getString("clean-metadata-confirm"), "confirm")
    .addButton(getString("clean-metadata-cancel"), "cancel")
    .setDialogData(dialogData)
    .open(getString("clean-metadata-dialog-title"), {
      centerscreen: true,
      resizable: true,
      fitContent: true,
    });

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "confirm") return null;
  return keys.filter((key) => Boolean(dialogData[`field_${key}`]));
}

function clearFieldsOnItem(item: Zotero.Item, keys: CleanableKey[]): string[] {
  const cleared: string[] = [];
  for (const key of keys) {
    try {
      if (key === "creators") {
        (item as any).setCreators([]);
        cleared.push(key);
        continue;
      }
      if (key === "tags") {
        if (typeof (item as any).setTags === "function") {
          (item as any).setTags([]);
        } else {
          const tags = (((item as any).getTags?.() || []) as any[]).map(
            (tag) => (typeof tag === "string" ? tag : tag.tag),
          );
          for (const tag of tags) {
            if (tag) (item as any).removeTag(tag);
          }
        }
        cleared.push(key);
        continue;
      }
      // Base-mapped names clear the type-specific field too (publicationTitle
      // → bookTitle, publisher → university, …).
      (item as any).setField(key, "");
      cleared.push(key);
    } catch (error) {
      ztoolkit.log(`Could not clear ${key} on item ${item.id}`, error);
    }
  }
  return cleared;
}

export async function cleanMetadataForSelectedItems() {
  const items = getSelectedRegularItems();
  if (!items.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
      .createLine({
        text: getString("clean-metadata-no-items"),
        type: "default",
      })
      .show();
    return;
  }

  const selectedKeys = await showCleanFieldsDialog();
  if (selectedKeys === null) return;
  if (!selectedKeys.length) {
    window.alert(getString("clean-metadata-none-selected"));
    return;
  }

  const labels = selectedKeys.map(fieldLabel).join(", ");
  const confirmed = window.confirm(
    `${getString("clean-metadata-confirm-msg", {
      args: { count: items.length },
    })}\n\n${labels}`,
  );
  if (!confirmed) return;

  let success = 0;
  const failures: string[] = [];
  for (const item of items) {
    try {
      clearFieldsOnItem(item, selectedKeys);
      await item.saveTx();
      success++;
    } catch (error) {
      const reason = (error as Error)?.message || String(error);
      failures.push(`${item.getDisplayTitle()}: ${reason}`);
      ztoolkit.log("Metadata clean failed", item.id, error);
    }
  }

  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
    .createLine({
      text: getString("clean-metadata-done", {
        args: { success, failed: failures.length },
      }),
      type: success ? "success" : "default",
    })
    .show();

  if (failures.length) {
    window.alert(
      `${config.addonName} — ${getString("clean-metadata-dialog-title")}\n\n` +
        failures.slice(0, 30).join("\n"),
    );
  }
}
