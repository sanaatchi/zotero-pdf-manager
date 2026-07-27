import { config } from "../../package.json";
import { getString } from "../utils/locale";

/** Fallback if live ItemFields APIs fail (@see https://api.zotero.org/schema). */
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

function fieldLabel(key: string): string {
  if (key === "creators") return getString("clean-metadata-field-creators");
  if (key === "tags") return getString("clean-metadata-field-tags");
  try {
    const localized = (Zotero as any).ItemFields?.getLocalizedString?.(key);
    if (localized) return String(localized);
  } catch {
    /* ignore */
  }
  return key;
}

function sortKeys(names: Iterable<string>): string[] {
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

/**
 * Fields for the selected items' types (what the item pane shows), plus
 * creators/tags. Falls back to the full schema list if the API yields nothing.
 */
function getCleanableKeysForItems(items: Zotero.Item[]): string[] {
  const names = new Set<string>(["creators", "tags"]);
  try {
    for (const item of items) {
      const fieldIDs =
        (Zotero as any).ItemFields?.getItemTypeFields?.(
          (item as any).itemTypeID,
        ) || [];
      for (const fieldID of fieldIDs) {
        const name = (Zotero as any).ItemFields?.getName?.(fieldID);
        if (name) names.add(name);
      }
    }
  } catch (error) {
    ztoolkit.log("getItemTypeFields failed", error);
  }
  if (names.size <= 2) {
    for (const name of SCHEMA_FIELD_FALLBACK) names.add(name);
  }
  return sortKeys(names);
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
 * Checkbox dialog. Selection is tracked in a Set via change listeners — we do
 * not rely on DialogHelper data-bind or getElementById at confirm time.
 */
async function showCleanFieldsDialog(
  keys: string[],
): Promise<string[] | null> {
  const checked = new Set<string>();
  const dialogData: Record<string, any> = {
    _lastButtonId: "",
  };

  const checkboxCell = (key: string) => ({
    tag: "hbox",
    attributes: { align: "center" },
    styles: { margin: "1px 4px" },
    children: [
      {
        tag: "input",
        namespace: "html" as const,
        id: `clean-field-${key}`,
        attributes: { type: "checkbox" },
        listeners: [
          {
            type: "change",
            listener: (ev: Event) => {
              const el = ev.target as HTMLInputElement | null;
              if (!el) return;
              if (el.checked) checked.add(key);
              else checked.delete(key);
            },
          },
        ],
      },
      {
        tag: "label",
        namespace: "html" as const,
        attributes: { for: `clean-field-${key}` },
        properties: { innerText: fieldLabel(key) },
        styles: { marginLeft: "6px", fontSize: "12px" },
      },
    ],
  });

  // Intro + toolbar + scrollable grid of checkboxes (3 columns).
  const cols = 3;
  const fieldRows = Math.ceil(keys.length / cols);
  // row 0: intro, row 1: select all/none, rows 2..: fields
  const dialog = new ztoolkit.Dialog(fieldRows + 2, cols);

  dialog.addCell(
    0,
    0,
    {
      tag: "p",
      namespace: "html",
      properties: { innerText: getString("clean-metadata-dialog-intro") },
      styles: { margin: "0 0 4px 0", fontSize: "12px", maxWidth: "560px" },
    },
    false,
  );

  const setAll = (value: boolean) => {
    checked.clear();
    if (value) {
      for (const key of keys) checked.add(key);
    }
    const win = dialog.window;
    if (!win) return;
    for (const key of keys) {
      const el = win.document.getElementById(
        `clean-field-${key}`,
      ) as HTMLInputElement | null;
      if (el) el.checked = value;
    }
  };

  dialog.addCell(
    1,
    0,
    {
      tag: "hbox",
      styles: { gap: "8px", marginBottom: "4px" },
      children: [
        {
          tag: "button",
          namespace: "html",
          attributes: { type: "button" },
          properties: { innerText: getString("clean-metadata-select-all") },
          listeners: [
            {
              type: "click",
              listener: (ev: Event) => {
                ev.preventDefault();
                setAll(true);
              },
            },
          ],
        },
        {
          tag: "button",
          namespace: "html",
          attributes: { type: "button" },
          properties: { innerText: getString("clean-metadata-select-none") },
          listeners: [
            {
              type: "click",
              listener: (ev: Event) => {
                ev.preventDefault();
                setAll(false);
              },
            },
          ],
        },
      ],
    },
    false,
  );

  for (let i = 0; i < keys.length; i++) {
    const row = Math.floor(i / cols) + 2;
    const col = i % cols;
    dialog.addCell(row, col, checkboxCell(keys[i]), false);
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
  return keys.filter((key) => checked.has(key));
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
      // false is Zotero's canonical "clear this field" value.
      (item as any).setField(key, false);
      cleared.push(key);
    } catch (error) {
      ztoolkit.log(`Could not clear ${key} on item ${item.id}`, error);
    }
  }
  return cleared;
}

export async function cleanMetadataForSelectedItems() {
  try {
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

    const keys = getCleanableKeysForItems(items);
    const selectedKeys = await showCleanFieldsDialog(keys);
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
        if (typeof (item as any).isEditable === "function" && !item.isEditable()) {
          failures.push(
            `${item.getDisplayTitle()}: ${getString("clean-metadata-not-editable")}`,
          );
          continue;
        }
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
  } catch (error) {
    const reason = (error as Error)?.message || String(error);
    ztoolkit.log("cleanMetadataForSelectedItems crashed", error);
    window.alert(`${config.addonName}\n\n${reason}`);
  }
}
