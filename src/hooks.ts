// @ajan: cursor · @etiket: katman-2, p1, multi-window, lifecycle, startup-threshold-repair, mir-az
import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefsScripts,
  repairMatchThresholdPrefs,
} from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import Menu from "./modules/menu";
import { PDFReconciler } from "./modules/pdfReconciler";
import { migrateBookPdfSources } from "./modules/bookSourcesMigrate";
import { migrateArticleDergiparkPriority } from "./modules/articleDergiparkMigrate";
import {
  migrateDoiUnpaywallIntoAutoCascade,
  migrateMetadataOnlyOutOfDownload,
} from "./modules/metadataSourcesMigrate";
import { migrateMirAzPdfSource } from "./modules/mirAzSourcesMigrate";

/** Open Zotero main windows that have UI loaded for this add-on. */
const loadedWindows = new Set<Window>();

function ensureProcessToolkit(): void {
  if (!addon.data.ztoolkit) {
    addon.data.ztoolkit = createZToolkit();
  }
}

function ensureProcessReconciler(): void {
  if (!addon.data.pdfReconciler) {
    addon.data.pdfReconciler = new PDFReconciler();
    addon.data.pdfReconciler.start();
  }
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();
  ensureProcessToolkit();
  // Repair floor-corrupted 0.85/0.6→0 before reconciler can mass-attach (B2).
  try {
    repairMatchThresholdPrefs();
  } catch (e) {
    ztoolkit.log("repairMatchThresholdPrefs failed", e);
  }
  try {
    migrateBookPdfSources();
  } catch (e) {
    ztoolkit.log("migrateBookPdfSources failed", e);
  }
  try {
    migrateArticleDergiparkPriority();
  } catch (e) {
    ztoolkit.log("migrateArticleDergiparkPriority failed", e);
  }
  try {
    migrateMetadataOnlyOutOfDownload();
  } catch (e) {
    ztoolkit.log("migrateMetadataOnlyOutOfDownload failed", e);
  }
  try {
    migrateDoiUnpaywallIntoAutoCascade();
  } catch (e) {
    ztoolkit.log("migrateDoiUnpaywallIntoAutoCascade failed", e);
  }
  try {
    migrateMirAzPdfSource();
  } catch (e) {
    ztoolkit.log("migrateMirAzPdfSource failed", e);
  }
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
  // Process-wide reconciler once — not tied to any single window.
  ensureProcessReconciler();
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(win: Window): Promise<void> {
  if (loadedWindows.has(win)) return;
  loadedWindows.add(win);
  ensureProcessToolkit();
  ensureProcessReconciler();

  // Menu registers toolkit items once and refreshItemMenu updates all windows.
  // Do not dispose/recreate on every window — that killed the previous window's UI.
  if (!addon.data.menu) {
    addon.data.menu = new Menu();
  } else {
    try {
      addon.data.menu.refreshItemMenu();
    } catch (e) {
      ztoolkit.log("refreshItemMenu after window load failed", e);
    }
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  loadedWindows.delete(win);
  // Keep reconciler + toolkit alive while other windows (or process) remain.
  // Only tear down window-local dialog; process services end in onShutdown.
  if (addon.data.dialog?.window === win) {
    try {
      addon.data.dialog.window.close();
    } catch {
      /* ignore */
    }
  }
  if (loadedWindows.size === 0 && addon.data.menu) {
    // No main window left — release menu notifier/timers, keep reconciler.
    try {
      addon.data.menu.dispose();
    } catch (e) {
      ztoolkit.log("menu dispose on last window unload failed", e);
    }
    addon.data.menu = undefined;
  }
}

function onShutdown(): void {
  loadedWindows.clear();
  try {
    addon.data.pdfReconciler?.dispose();
  } catch (e) {
    ztoolkit.log("reconciler dispose on shutdown failed", e);
  }
  addon.data.pdfReconciler = undefined;
  try {
    addon.data.menu?.dispose();
  } catch (e) {
    ztoolkit.log("menu dispose on shutdown failed", e);
  }
  addon.data.menu = undefined;
  try {
    ztoolkit.unregisterAll();
  } catch {
    /* ignore */
  }
  try {
    addon.data.dialog?.window?.close();
  } catch {
    /* ignore */
  }
  addon.data.alive = false;
  delete (Zotero as any)[config.addonInstance];
}

/**
 * Preference UI dispatcher — keep thin; logic lives in preferenceScript.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

/** Test/surface helpers — not part of Zotero bootstrap contract. */
export function __testLoadedWindowCount(): number {
  return loadedWindows.size;
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
