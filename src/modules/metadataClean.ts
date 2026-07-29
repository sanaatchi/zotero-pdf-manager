import { config, version } from "../../package.json";
import { getString } from "../utils/locale";

/** @see https://api.zotero.org/schema */
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
 * Native DOM modal on the main Zotero window — no DialogHelper.
 * Checkbox state is tracked in a Set via change/click listeners.
 */
function showCleanFieldsDialog(keys: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const mainWin = Zotero.getMainWindow();
    if (!mainWin?.document?.documentElement) {
      resolve(null);
      return;
    }
    const doc = mainWin.document;
    const checked = new Set<string>();

    const overlay = doc.createElement("div");
    overlay.id = "zpdfmanager-clean-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "99999",
      background: "rgba(0,0,0,0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });

    const panel = doc.createElement("div");
    Object.assign(panel.style, {
      background: "var(--material-background, #2a2a2e)",
      color: "var(--fill-primary, #f0f0f0)",
      borderRadius: "8px",
      padding: "16px",
      width: "min(720px, 92vw)",
      maxHeight: "85vh",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
    });

    const title = doc.createElement("div");
    title.textContent = `${getString("clean-metadata-dialog-title")} (v${version})`;
    Object.assign(title.style, { fontWeight: "600", fontSize: "15px" });

    const intro = doc.createElement("div");
    intro.textContent = getString("clean-metadata-dialog-intro");
    Object.assign(intro.style, { fontSize: "12px", opacity: "0.9" });

    const toolbar = doc.createElement("div");
    Object.assign(toolbar.style, { display: "flex", gap: "8px" });

    const mkBtn = (label: string, primary = false) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      Object.assign(btn.style, {
        padding: "6px 12px",
        cursor: "pointer",
        borderRadius: "4px",
        border: primary ? "none" : "1px solid rgba(127,127,127,0.5)",
        background: primary ? "var(--accent-color, #0a84ff)" : "transparent",
        color: primary ? "#fff" : "inherit",
      });
      return btn;
    };

    const selectAllBtn = mkBtn(getString("clean-metadata-select-all"));
    const selectNoneBtn = mkBtn(getString("clean-metadata-select-none"));
    toolbar.append(selectAllBtn, selectNoneBtn);

    const list = doc.createElement("div");
    Object.assign(list.style, {
      overflowY: "auto",
      flex: "1",
      minHeight: "200px",
      maxHeight: "55vh",
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "4px 12px",
      padding: "8px",
      border: "1px solid rgba(127,127,127,0.35)",
      borderRadius: "4px",
    });

    const inputs: HTMLInputElement[] = [];
    for (const key of keys) {
      const row = doc.createElement("label");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        cursor: "pointer",
        userSelect: "none",
      });
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.dataset.field = key;
      const sync = () => {
        if (input.checked) checked.add(key);
        else checked.delete(key);
      };
      input.addEventListener("change", sync);
      input.addEventListener("click", sync);
      inputs.push(input);
      const span = doc.createElement("span");
      span.textContent = fieldLabel(key);
      row.append(input, span);
      list.append(row);
    }

    selectAllBtn.addEventListener("click", () => {
      checked.clear();
      for (const key of keys) checked.add(key);
      for (const input of inputs) input.checked = true;
    });
    selectNoneBtn.addEventListener("click", () => {
      checked.clear();
      for (const input of inputs) input.checked = false;
    });

    const actions = doc.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "4px",
    });
    const cancelBtn = mkBtn(getString("clean-metadata-cancel"));
    const okBtn = mkBtn(getString("clean-metadata-confirm"), true);

    const close = (result: string[] | null) => {
      overlay.remove();
      mainWin.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(null);
      }
    };
    mainWin.addEventListener("keydown", onKey, true);

    cancelBtn.addEventListener("click", () => close(null));
    okBtn.addEventListener("click", () => {
      // Re-read from DOM as a second source of truth.
      const fromDom = inputs
        .filter((el) => el.checked)
        .map((el) => el.dataset.field!)
        .filter(Boolean);
      const merged = new Set([...checked, ...fromDom]);
      close(keys.filter((k) => merged.has(k)));
    });
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(null);
    });

    actions.append(cancelBtn, okBtn);
    panel.append(title, intro, toolbar, list, actions);
    overlay.append(panel);

    // Remove any leftover overlay from a previous run.
    doc.getElementById("zpdfmanager-clean-overlay")?.remove();
    doc.documentElement.appendChild(overlay);
  });
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
      // Zotero treats false / "" / null as "clear field".
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
    const clearedSummary: string[] = [];

    await Zotero.DB.executeTransaction(async () => {
      for (const item of items) {
        try {
          if (
            typeof (item as any).isEditable === "function" &&
            !item.isEditable()
          ) {
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
          await item.save();
          success++;
          clearedSummary.push(
            `${item.getDisplayTitle()}: ${cleared.map(fieldLabel).join(", ")}`,
          );
        } catch (error) {
          const reason = (error as Error)?.message || String(error);
          failures.push(`${item.getDisplayTitle()}: ${reason}`);
          ztoolkit.log("Metadata clean failed", item.id, error);
        }
      }
    });

    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
      .createLine({
        text: getString("clean-metadata-done", {
          args: { success, failed: failures.length },
        }),
        type: success ? "success" : "default",
      })
      .show();

    // Explicit feedback so a silent no-op is impossible to miss.
    window.alert(
      `${config.addonName} v${version}\n\n` +
        (clearedSummary.length
          ? clearedSummary.slice(0, 20).join("\n")
          : getString("clean-metadata-nothing-cleared")) +
        (failures.length ? `\n\n—\n${failures.slice(0, 10).join("\n")}` : ""),
    );
  } catch (error) {
    const reason = (error as Error)?.message || String(error);
    ztoolkit.log("cleanMetadataForSelectedItems crashed", error);
    window.alert(`${config.addonName} v${version}\n\n${reason}`);
  }
}
