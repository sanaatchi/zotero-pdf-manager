import { config } from "../../package.json";
import { getString } from "../utils/locale";

/** Fallback if the live Zotero schema APIs are unavailable (schema v42). */
const SCHEMA_FIELD_FALLBACK = [
  "DOI",
  "ISBN",
  "ISSN",
  "PMCID",
  "PMID",
  "abstractNote",
  "accessDate",
  "applicationNumber",
  "archive",
  "archiveID",
  "archiveLocation",
  "artworkMedium",
  "artworkSize",
  "assignee",
  "audioFileType",
  "audioRecordingFormat",
  "billNumber",
  "blogTitle",
  "bookTitle",
  "callNumber",
  "caseName",
  "citationKey",
  "code",
  "codeNumber",
  "codePages",
  "codeVolume",
  "committee",
  "company",
  "conferenceName",
  "country",
  "court",
  "date",
  "dateDecided",
  "dateEnacted",
  "dictionaryTitle",
  "distributor",
  "docketNumber",
  "documentNumber",
  "edition",
  "encyclopediaTitle",
  "episodeNumber",
  "eventPlace",
  "extra",
  "filingDate",
  "firstPage",
  "format",
  "forumTitle",
  "genre",
  "history",
  "identifier",
  "institution",
  "interviewMedium",
  "issue",
  "issueDate",
  "issuingAuthority",
  "journalAbbreviation",
  "label",
  "language",
  "legalStatus",
  "legislativeBody",
  "letterType",
  "libraryCatalog",
  "manuscriptType",
  "mapType",
  "meetingName",
  "nameOfAct",
  "network",
  "numPages",
  "number",
  "numberOfVolumes",
  "organization",
  "originalDate",
  "originalPlace",
  "originalPublisher",
  "pages",
  "partNumber",
  "partTitle",
  "patentNumber",
  "place",
  "postType",
  "presentationType",
  "priorityDate",
  "priorityNumbers",
  "proceedingsTitle",
  "programTitle",
  "programmingLanguage",
  "publicLawNumber",
  "publicationTitle",
  "publisher",
  "references",
  "reportNumber",
  "reportType",
  "reporter",
  "reporterVolume",
  "repository",
  "repositoryLocation",
  "rights",
  "runningTime",
  "scale",
  "section",
  "series",
  "seriesNumber",
  "seriesText",
  "seriesTitle",
  "session",
  "sessionTitle",
  "shortTitle",
  "status",
  "studio",
  "subject",
  "system",
  "thesisType",
  "title",
  "type",
  "university",
  "url",
  "versionNumber",
  "videoRecordingFormat",
  "volume",
  "websiteTitle",
  "websiteType",
];

const SKIP_ITEM_TYPES = new Set(["attachment", "note", "annotation"]);

/**
 * Every field name from the installed Zotero schema, plus creators/tags.
 * @see https://api.zotero.org/schema
 */
function getAllCleanableKeys(): string[] {
  const names = new Set<string>(["creators", "tags"]);
  try {
    const types = (Zotero as any).ItemTypes?.getTypes?.() || [];
    for (const t of types) {
      const typeID = t.id ?? (Zotero as any).ItemTypes.getID(t.name);
      const typeName =
        t.name || (Zotero as any).ItemTypes.getName?.(typeID) || "";
      if (!typeID || SKIP_ITEM_TYPES.has(typeName)) continue;
      const fieldIDs =
        (Zotero as any).ItemFields?.getItemTypeFields?.(typeID) || [];
      for (const fieldID of fieldIDs) {
        const name = (Zotero as any).ItemFields?.getName?.(fieldID);
        if (name) names.add(name);
      }
    }
  } catch (error) {
    ztoolkit.log("Failed to read live ItemFields; using schema fallback", error);
  }
  if (names.size <= 2) {
    for (const name of SCHEMA_FIELD_FALLBACK) names.add(name);
  }
  return [...names].sort((a, b) => {
    const rank = (k: string) =>
      k === "creators" ? 0 : k === "tags" ? 1 : k === "title" ? 2 : 10;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return fieldLabel(a).localeCompare(fieldLabel(b), undefined, {
      sensitivity: "base",
    });
  });
}

function fieldLabel(key: string): string {
  if (key === "creators") return getString("clean-metadata-field-creators");
  if (key === "tags") return getString("clean-metadata-field-tags");
  try {
    const localized = (Zotero as any).ItemFields?.getLocalizedString?.(key);
    if (localized) return String(localized);
  } catch {
    // Fall through.
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

function readCheckedKeys(dialogWin: Window, keys: string[]): string[] {
  const doc = dialogWin.document;
  return keys.filter((key) => {
    const el = doc.getElementById(`clean-field-${key}`) as
      | HTMLInputElement
      | null;
    return Boolean(el?.checked);
  });
}

/**
 * Checkbox dialog listing every schema field. Returns ticked keys, or null
 * if cancelled. Checkbox state is read from the DOM on Confirm — DialogHelper
 * data-bind is unreliable for unchecked→checked HTML checkboxes on unload.
 */
async function showCleanFieldsDialog(): Promise<string[] | null> {
  const keys = getAllCleanableKeys();
  const dialogData: Record<string, any> = {
    _lastButtonId: "",
    selectedKeys: [] as string[],
  };

  const fieldChildren = keys.map((key) => ({
    tag: "label",
    namespace: "html" as const,
    styles: {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      margin: "2px 0",
      fontSize: "12px",
      cursor: "pointer",
    },
    children: [
      {
        tag: "input",
        namespace: "html" as const,
        id: `clean-field-${key}`,
        attributes: { type: "checkbox" },
      },
      {
        tag: "span",
        namespace: "html" as const,
        properties: { innerText: fieldLabel(key) },
      },
    ],
  }));

  const dialog = new ztoolkit.Dialog(1, 1);
  dialog.addCell(
    0,
    0,
    {
      tag: "div",
      namespace: "html",
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "4px",
        width: "640px",
        maxWidth: "90vw",
      },
      children: [
        {
          tag: "p",
          namespace: "html",
          properties: { innerText: getString("clean-metadata-dialog-intro") },
          styles: { margin: "0", fontSize: "12px" },
        },
        {
          tag: "div",
          namespace: "html",
          styles: { display: "flex", gap: "8px" },
          children: [
            {
              tag: "button",
              namespace: "html",
              id: "clean-select-all",
              attributes: { type: "button" },
              properties: {
                innerText: getString("clean-metadata-select-all"),
              },
              listeners: [
                {
                  type: "click",
                  listener: (ev: Event) => {
                    ev.preventDefault();
                    const win = dialog.window;
                    if (!win) return;
                    for (const key of keys) {
                      const el = win.document.getElementById(
                        `clean-field-${key}`,
                      ) as HTMLInputElement | null;
                      if (el) el.checked = true;
                    }
                  },
                },
              ],
            },
            {
              tag: "button",
              namespace: "html",
              id: "clean-select-none",
              attributes: { type: "button" },
              properties: {
                innerText: getString("clean-metadata-select-none"),
              },
              listeners: [
                {
                  type: "click",
                  listener: (ev: Event) => {
                    ev.preventDefault();
                    const win = dialog.window;
                    if (!win) return;
                    for (const key of keys) {
                      const el = win.document.getElementById(
                        `clean-field-${key}`,
                      ) as HTMLInputElement | null;
                      if (el) el.checked = false;
                    }
                  },
                },
              ],
            },
          ],
        },
        {
          tag: "div",
          namespace: "html",
          styles: {
            maxHeight: "420px",
            overflowY: "auto",
            border: "1px solid rgba(127,127,127,0.35)",
            borderRadius: "4px",
            padding: "8px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            columnGap: "12px",
            rowGap: "2px",
          },
          children: fieldChildren,
        },
      ],
    },
    false,
  );

  dialog
    .addButton(getString("clean-metadata-confirm"), "confirm", {
      callback: () => {
        // Read DOM before the window tears down — more reliable than data-bind.
        if (dialog.window) {
          dialogData.selectedKeys = readCheckedKeys(dialog.window, keys);
        }
      },
    })
    .addButton(getString("clean-metadata-cancel"), "cancel")
    .setDialogData(dialogData)
    .open(getString("clean-metadata-dialog-title"), {
      centerscreen: true,
      resizable: true,
      fitContent: false,
      width: 680,
      height: 560,
    });

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "confirm") return null;
  return (dialogData.selectedKeys as string[]) || [];
}

function clearFieldsOnItem(item: Zotero.Item, keys: string[]): string[] {
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
      // Exact type-specific names and base names (publicationTitle→bookTitle,
      // publisher→university, …) are both accepted by setField.
      (item as any).setField(key, "");
      cleared.push(key);
    } catch (error) {
      // Field not valid for this item type — skip quietly.
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
      const cleared = clearFieldsOnItem(item, selectedKeys);
      if (!cleared.length) {
        failures.push(
          `${item.getDisplayTitle()}: ${getString("clean-metadata-nothing-cleared")}`,
        );
        continue;
      }
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
