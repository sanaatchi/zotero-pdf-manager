// @ajan: cursor · @etiket: katman-2, ztoolkit, console-group-polyfill
import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

/** Zotero 9 toolkit log uses console.group — polyfill when missing. */
function ensureConsoleGroupPolyfill(): void {
  const patch = (c: Console | undefined) => {
    if (!c || typeof c !== "object") return;
    const target = c as Console & {
      group?: (...args: unknown[]) => void;
      groupCollapsed?: (...args: unknown[]) => void;
      groupEnd?: () => void;
    };
    if (!target.group) {
      target.group = (...args: unknown[]) => {
        try {
          target.log?.(...args);
        } catch {
          /* ignore */
        }
      };
    }
    if (!target.groupCollapsed) {
      target.groupCollapsed = target.group;
    }
    if (!target.groupEnd) {
      target.groupEnd = () => {};
    }
  };
  try {
    if (typeof console !== "undefined") patch(console);
  } catch {
    /* ignore */
  }
  try {
    const w = (Zotero as any)?.getMainWindow?.();
    patch(w?.console);
  } catch {
    /* ignore */
  }
}

function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  /**
   * Alternatively, import toolkit modules you use to minify the plugin size.
   * You can add the modules under the `MyToolkit` class below and uncomment the following line.
   */
  // const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  ensureConsoleGroupPolyfill();
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  _ztoolkit.basicOptions.debug.disableDebugBridgePassword =
    __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  _ztoolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/favicon.png`,
  );
  _ztoolkit.ProgressWindow.setIconURI(
    "success",
    `chrome://zotero/skin/tick@2x.png`,
  );
  _ztoolkit.ProgressWindow.setIconURI("fail", `chrome://zotero/skin/cross.png`);
}
