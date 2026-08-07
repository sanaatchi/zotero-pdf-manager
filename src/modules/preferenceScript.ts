// @ajan: cursor · @etiket: katman-2, prefs, watch-root-parent, disk-audit
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { listenShortcut } from "../utils/shortcut";
import { invalidateIndex, normalizeDefaultWatchRoots } from "./folderIndex";
import {
  normalizeAddSettleMs,
  normalizePeriodicMinutes,
} from "./pdfReconciler";
import { clearAuditEvents, openAutomationAuditReport } from "./automationAudit";
import { runDiskAuditWithProgress } from "./diskAudit";

async function runManualReconcileWithProgress() {
  const reconciler = addon.data.pdfReconciler;
  if (!reconciler) return;
  if (reconciler.isBusy()) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 3000 })
      .createLine({
        text: getString("pdf-reconcile-busy"),
        type: "default",
      })
      .show();
    return;
  }
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: false,
    closeTime: -1,
  });
  progress
    .createLine({
      text: getString("pdf-reconcile-running"),
      type: "default",
      progress: 20,
    })
    .show();
  // Second line acts as cancel affordance (click closes + cancels).
  progress.createLine({
    text: getString("pdf-reconcile-cancel-hint"),
    type: "default",
    progress: 0,
  });
  const onClick = () => {
    reconciler.cancel("prefs-progress");
  };
  try {
    (progress as any).window?.addEventListener?.("click", onClick);
  } catch {
    /* ProgressWindow may not expose window in all builds */
  }
  try {
    await reconciler.run("manual");
    progress.changeLine({
      text: getString("pdf-reconcile-done"),
      type: "success",
      progress: 100,
      idx: 0,
    });
  } catch (e) {
    if ((e as Error)?.name === "RunAbortedError") {
      progress.changeLine({
        text: getString("pdf-reconcile-cancelled"),
        type: "default",
        progress: 100,
        idx: 0,
      });
    } else {
      ztoolkit.log("Manual reconcile failed", e);
      progress.changeLine({
        text: getString("pdf-reconcile-failed"),
        type: "fail",
        progress: 100,
        idx: 0,
      });
    }
  } finally {
    try {
      (progress as any).window?.removeEventListener?.("click", onClick);
    } catch {
      /* ignore */
    }
    progress.startCloseTimer(4000);
  }
}
export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    };
  } else {
    addon.data.prefs.window = _window;
  }
  ensureStringPref("filenameSkipRenameRules");
  ensureStringPref("filenameSkipAutoMoveRenameRules");
  ensureBooleanPref("autoRenameOnModifyDebounceEnabled", true);
  ensureNumberPref("autoRenameOnModifyDebounceMs", 1000);
  ensureBooleanPref("autoRenameOnModifyDelayEnabled", false);
  ensureNumberPref("autoRenameOnModifyDelayMs", 0);
  ensureNumberPref("pdf.periodicMinutes", 30);
  ensureNumberPref("pdf.autoAttachThreshold", 0.85);
  ensureNumberPref("pdf.reviewThreshold", 0.6);
  ensureNumberPref("pdf.addSettleMs", 1000);
  ensureBooleanPref("pdf.saveOaToDownloads", true);
  ensureNumberPref("pdf.onlineMaxPerRun", 10);
  ensureNumberPref("pdf.orphanMaxPerRun", 10);
  // Keep user-chosen orphanMode (including opt-in autoCreate). Default in prefs.js is report.
  migratePDFWatchRoots();
  ensureBooleanPref("pdf.useLinkedAttachmentBase", true);
  updatePrefsUI();
  bindPrefEvents(_window);
}

async function updatePrefsUI() {
  const doc = addon.data.prefs!.window.document;
  const destSettingBox = doc.querySelector("#dest-setting") as XUL.GroupBox;
  if (getPref("attachType") == "importing") {
    destSettingBox.style.opacity = ".6";
  } else {
    destSettingBox.style.opacity = "1";
  }
  const autoRenameOnModify = Boolean(getPref("autoRenameOnModify"));
  const autoRenameOptions = doc.querySelector(
    "#auto-rename-on-modify-options",
  ) as HTMLElement | null;
  if (autoRenameOptions) {
    autoRenameOptions.hidden = !autoRenameOnModify;
  }
  const timedSettings = [
    {
      id: "auto-rename-on-modify-debounce",
      enabledKey: "autoRenameOnModifyDebounceEnabled",
      valueKey: "autoRenameOnModifyDebounceMs",
      fallback: 1000,
    },
    {
      id: "auto-rename-on-modify-delay",
      enabledKey: "autoRenameOnModifyDelayEnabled",
      valueKey: "autoRenameOnModifyDelayMs",
      fallback: 0,
    },
  ];
  for (const setting of timedSettings) {
    const checkbox = doc.querySelector(`#${setting.id}`) as XUL.Checkbox;
    const input = doc.querySelector(`#${setting.id}-ms`) as HTMLInputElement;
    if (checkbox) {
      checkbox.checked = Boolean(getPref(setting.enabledKey));
    }
    if (input) {
      input.value = `${getNonNegativeIntegerPref(
        setting.valueKey,
        setting.fallback,
      )}`;
      input.disabled = !checkbox?.checked;
    }
  }
  updateShortcutRows();
}

/**
 * 快捷键勾选框未勾选时，对应输入框置灰禁用
 */
function updateShortcutRows() {
  const doc = addon.data.prefs!.window.document;
  doc
    .querySelectorAll("checkbox.shortcut-enable")
    // @ts-ignore forEach
    .forEach((checkbox: XUL.Checkbox) => {
      const input = checkbox
        .closest("hbox")
        ?.querySelector("input.shortcut") as HTMLInputElement | null;
      if (!input) return;
      const prefName = checkbox.getAttribute("preference") as string;
      const enabled = Zotero.Prefs.get(prefName, true) !== false;
      input.disabled = !enabled;
      input.style.opacity = enabled ? "1" : "0.5";
    });
}

function ensureStringPref(key: string) {
  const value = getPref(key);
  if (typeof value !== "string") {
    setPref(key, "");
  }
}

function migratePDFWatchRoots() {
  let roots = getPref("pdf.watchRoots");
  if (typeof roots !== "string" || !roots.trim()) {
    const legacy = getPref("pdf.localFolder");
    if (typeof legacy === "string" && legacy.trim()) {
      roots = legacy.trim();
    } else {
      roots = "";
    }
  }
  // Parent 1A_E_KAYNAKLARIM covers all buckets/subfolders recursively;
  // drop nested Dışı (or any child) when the parent is listed.
  const next = normalizeDefaultWatchRoots(String(roots || ""));
  setPref("pdf.watchRoots", next);
  if (next !== String(roots || "").trim()) {
    try {
      invalidateIndex();
    } catch {
      /* index rebuild on next search */
    }
  }
}

function ensureBooleanPref(key: string, fallback: boolean) {
  if (typeof getPref(key) !== "boolean") {
    setPref(key, fallback);
  }
}

function normalizeNonNegativeInteger(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(`${value ?? ""}`, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function getNonNegativeIntegerPref(key: string, fallback: number) {
  return normalizeNonNegativeInteger(getPref(key), fallback);
}

function ensureNumberPref(key: string, fallback: number) {
  setPref(key, getNonNegativeIntegerPref(key, fallback));
}

function bindNumberPrefInput(
  selector: string,
  key: string,
  fallback: number,
  doc: Document,
) {
  const inputNode = doc.querySelector(selector) as HTMLInputElement | null;
  inputNode?.addEventListener("change", () => {
    const normalized = normalizeNonNegativeInteger(inputNode.value, fallback);
    inputNode.value = `${normalized}`;
    setPref(key, normalized);
  });
}

function bindPrefEvents(_window: Window) {
  // 选择源目录
  const doc = addon.data.prefs!.window.document;
  doc
    .querySelector("#file-renaming-button")
    ?.addEventListener("command", () => {
      // @ts-ignore Zotero exposes this preferences controller at runtime.
      _window.Zotero_Preferences.General.openFileRenamingDialog();
    });
  doc
    .querySelector("#choose-source-dir")
    ?.addEventListener("command", async () => {
      let oldPath = getPref("sourceDir") as string;
      try {
        PathUtils.normalize(oldPath);
      } catch {
        oldPath = "";
      }

      // @ts-ignore _window
      const fp = new window.FilePicker();
      if (oldPath) {
        fp.displayDirectory = PathUtils.normalize(oldPath);
      }
      fp.init(window, "Select Source Directory", fp.modeGetFolder);
      fp.appendFilters(fp.filterAll);
      if ((await fp.show()) != fp.returnOK) {
        return false;
      }
      const newPath = PathUtils.normalize(fp.file);
      if (newPath) {
        setPref("sourceDir", newPath);
      }
    });
  // 选择目标目录
  doc
    .querySelector("#choose-dest-dir")
    ?.addEventListener("command", async () => {
      let oldPath = getPref("destDir") as string;
      try {
        PathUtils.normalize(oldPath);
      } catch {
        oldPath = "";
      }
      // @ts-ignore _window
      const fp = new window.FilePicker();
      if (oldPath) {
        fp.displayDirectory = PathUtils.normalize(oldPath);
      }
      fp.init(window, "Select Destination Directory", fp.modeGetFolder);
      fp.appendFilters(fp.filterAll);
      if ((await fp.show()) != fp.returnOK) {
        return false;
      }
      const newPath = PathUtils.normalize(fp.file);
      if (newPath) {
        setPref("destDir", newPath);
      }
    });
  doc.querySelector("#attach-type")?.addEventListener("command", async () => {
    await updatePrefsUI();
  });
  const autoRenameOnModifyCheckbox = doc.querySelector(
    "#auto-rename-on-modify",
  ) as XUL.Checkbox | null;
  autoRenameOnModifyCheckbox?.addEventListener("command", async () => {
    setPref("autoRenameOnModify", autoRenameOnModifyCheckbox.checked);
    await updatePrefsUI();
  });
  doc
    .querySelectorAll(
      "#auto-rename-on-modify-debounce, #auto-rename-on-modify-delay",
    )
    // @ts-ignore forEach
    .forEach((checkbox: XUL.Checkbox) => {
      checkbox.addEventListener("command", async () => {
        const enabledKey = checkbox.id.endsWith("-debounce")
          ? "autoRenameOnModifyDebounceEnabled"
          : "autoRenameOnModifyDelayEnabled";
        setPref(enabledKey, checkbox.checked);
        await updatePrefsUI();
      });
    });
  doc
    .querySelector('[preference$=".pdf.watchRoots"]')
    ?.addEventListener("change", invalidateIndex);
  doc
    .querySelector('[preference$=".pdf.useLinkedAttachmentBase"]')
    ?.addEventListener("command", invalidateIndex);
  doc
    .querySelector('[preference$=".pdf.useLinkedAttachmentBase"]')
    ?.addEventListener("change", invalidateIndex);
  bindNumberPrefInput(
    "#auto-rename-on-modify-debounce-ms",
    "autoRenameOnModifyDebounceMs",
    1000,
    doc,
  );
  bindNumberPrefInput(
    '[preference$=".pdf.orphanMaxPerRun"]',
    "pdf.orphanMaxPerRun",
    10,
    doc,
  );
  bindNumberPrefInput(
    "#auto-rename-on-modify-delay-ms",
    "autoRenameOnModifyDelayMs",
    0,
    doc,
  );
  const periodicInput = doc.querySelector(
    '[preference$=".pdf.periodicMinutes"]',
  ) as HTMLInputElement | null;
  periodicInput?.addEventListener("change", () => {
    const normalized = normalizePeriodicMinutes(periodicInput.value);
    periodicInput.value = `${normalized}`;
    setPref("pdf.periodicMinutes", normalized);
    addon.data.pdfReconciler?.start();
  });
  const settleInput = doc.querySelector(
    '[preference$=".pdf.addSettleMs"]',
  ) as HTMLInputElement | null;
  settleInput?.addEventListener("change", () => {
    const normalized = normalizeAddSettleMs(settleInput.value);
    settleInput.value = `${normalized}`;
    setPref("pdf.addSettleMs", normalized);
  });
  bindNumberPrefInput(
    '[preference$=".pdf.onlineMaxPerRun"]',
    "pdf.onlineMaxPerRun",
    10,
    doc,
  );
  doc
    .querySelector('[preference$=".pdf.autoOnStartup"]')
    ?.addEventListener("command", () => addon.data.pdfReconciler?.start());
  doc
    .querySelector('[preference$=".pdf.autoOnAdd"]')
    ?.addEventListener("command", () => addon.data.pdfReconciler?.start());
  doc.querySelector("#pdf-run-reconcile")?.addEventListener("command", () => {
    void runManualReconcileWithProgress();
  });
  doc
    .querySelector("#pdf-cancel-reconcile")
    ?.addEventListener("command", () => {
      addon.data.pdfReconciler?.cancel("prefs-button");
      new ztoolkit.ProgressWindow(config.addonName, { closeTime: 2500 })
        .createLine({
          text: getString("pdf-reconcile-cancel-requested"),
          type: "default",
        })
        .show();
    });
  doc.querySelector("#pdf-open-audit")?.addEventListener("command", () => {
    void openAutomationAuditReport();
  });
  doc.querySelector("#pdf-clear-audit")?.addEventListener("command", () => {
    void (async () => {
      await clearAuditEvents();
      new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
        .createLine({
          text: "Automation audit log cleared",
          type: "success",
        })
        .show();
    })();
  });
  doc.querySelector("#pdf-create-orphans")?.addEventListener("command", () => {
    void addon.data.pdfReconciler?.processOrphansNow();
  });
  doc
    .querySelector("#pdf-disk-audit-orphan")
    ?.addEventListener("command", () => {
      void runDiskAuditWithProgress("orphan");
    });
  doc
    .querySelector("#pdf-disk-audit-name-content")
    ?.addEventListener("command", () => {
      void runDiskAuditWithProgress("nameContent");
    });
  doc.querySelector("#pdf-disk-audit-copy")?.addEventListener("command", () => {
    void runDiskAuditWithProgress("copy");
  });
  doc
    .querySelector('[preference$=".moveWithoutDeleting"]')
    ?.addEventListener("command", () => {
      addon.data.menu?.refreshItemMenu();
    });

  doc
    .querySelectorAll(".shortcut")
    // @ts-ignore forEach
    .forEach((inputNode: HTMLInputElement) => {
      listenShortcut(inputNode, (shortcut: string) => {
        Zotero.Prefs.set(
          inputNode.getAttribute("preference") as string,
          shortcut,
          true,
        );
        // 同步更新右键菜单中的快捷键提示
        addon.data.menu?.refreshItemMenu();
      });
    });

  doc
    .querySelectorAll("checkbox.shortcut-enable")
    // @ts-ignore forEach
    .forEach((checkbox: XUL.Checkbox) => {
      checkbox.addEventListener("command", () => {
        Zotero.Prefs.set(
          checkbox.getAttribute("preference") as string,
          checkbox.checked,
          true,
        );
        updateShortcutRows();
        addon.data.menu?.refreshItemMenu();
      });
    });
}
