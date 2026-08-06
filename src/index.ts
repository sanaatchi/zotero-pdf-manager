// @ajan: cursor · @etiket: katman-2, bootstrap, console-group-polyfill
import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";
import { ensureConsoleGroupPolyfill } from "./utils/ztoolkit";

// Earliest possible: before BasicTool / Addon touch toolkit logging.
ensureConsoleGroupPolyfill();

const basicTool = new BasicTool();
ensureConsoleGroupPolyfill(
  (basicTool as unknown as { _console?: object })._console,
);

if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  defineGlobal("window");
  defineGlobal("document");
  defineGlobal("ZoteroPane");
  defineGlobal("Zotero_Tabs");
  // @ts-ignore Zotero的window
  _globalThis.OS = window.OS;
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
