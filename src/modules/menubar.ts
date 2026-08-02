// @ajan: cursor · @etiket: katman-2, oa-search, menubar
/**
 * Top-level "PDF Manager" menubar entry → OA Search popup.
 * Toolkit has no menuBar selector; insert under #main-menubar.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { openOaSearchWindow } from "./oaSearchWindow";

const MENUBAR_MENU_ID = `${config.addonRef}-menubar-root`;
const MENUBAR_POPUP_ID = `${config.addonRef}-menubar-popup`;
const OA_MENUITEM_ID = `${config.addonRef}-oa-search-menuitem`;

function createXul(doc: Document, tag: string): XUL.Element {
  const create = (doc as any).createXULElement?.bind(doc);
  if (create) return create(tag);
  return doc.createElementNS(
    "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
    tag,
  ) as unknown as XUL.Element;
}

/** Ensure PDF Manager menubar exists on one main window. */
export function ensurePdfManagerMenubar(win: Window): void {
  const doc = win.document;
  if (!doc) return;
  const menubar = doc.getElementById("main-menubar");
  if (!menubar) return;

  let menu = doc.getElementById(MENUBAR_MENU_ID) as XUL.Menu | null;
  if (!menu) {
    menu = createXul(doc, "menu") as unknown as XUL.Menu;
    menu.id = MENUBAR_MENU_ID;
    menu.setAttribute("label", getString("pdf-manager-menu"));
    const popup = createXul(doc, "menupopup");
    popup.id = MENUBAR_POPUP_ID;
    menu.appendChild(popup as any);
    const help = doc.getElementById("helpMenu");
    if (help?.parentNode === menubar) {
      menubar.insertBefore(menu as any, help);
    } else {
      menubar.appendChild(menu as any);
    }
  } else {
    menu.setAttribute("label", getString("pdf-manager-menu"));
  }

  const popup = doc.getElementById(MENUBAR_POPUP_ID) as XUL.MenuPopup | null;
  if (!popup) return;

  if (!doc.getElementById(OA_MENUITEM_ID)) {
    ztoolkit.Menu.register(popup, {
      tag: "menuitem",
      id: OA_MENUITEM_ID,
      label: getString("oa-search-open"),
      icon: addon.data.icons.downloadPdf,
      commandListener: () => {
        void openOaSearchWindow();
      },
    });
  } else {
    doc
      .getElementById(OA_MENUITEM_ID)
      ?.setAttribute("label", getString("oa-search-open"));
  }
}

/** Register / refresh on all open main windows. */
export function registerPdfManagerMenubar(): void {
  for (const win of Zotero.getMainWindows()) {
    try {
      ensurePdfManagerMenubar(win);
    } catch (e) {
      ztoolkit.log("PDF Manager menubar register failed", e);
    }
  }
}

/** Remove menubar nodes (shutdown / last window). */
export function unregisterPdfManagerMenubar(): void {
  for (const win of Zotero.getMainWindows()) {
    try {
      win.document.getElementById(OA_MENUITEM_ID)?.remove();
      win.document.getElementById(MENUBAR_MENU_ID)?.remove();
    } catch {
      /* ignore */
    }
  }
  try {
    ztoolkit.Menu.unregister(OA_MENUITEM_ID);
  } catch {
    /* ignore */
  }
}
