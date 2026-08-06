// @ajan: cursor · @etiket: katman-2, ztoolkit, console-group-polyfill
import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit, ensureConsoleGroupPolyfill };

/**
 * Zotero 9 toolkit `BasicTool.log` calls `console.group` / `groupCollapsed` /
 * `groupEnd`. Sandbox consoles often expose those names as non-writable
 * undefined (or omit them). Plain assignment then fails under strict mode and
 * was previously swallowed — polyfill looked present in source but never took.
 *
 * Use `typeof !== "function"` + `defineProperty`, patch toolkit ConsoleAPI
 * fallback (`_console`), and wrap `log` so a missed patch cannot throw.
 */
function ensureConsoleGroupPolyfill(consoleLike?: object | null): void {
  const patchOne = (c: object | null | undefined) => {
    if (!c || (typeof c !== "object" && typeof c !== "function")) return;
    const target = c as Console & Record<string, unknown>;
    const logFn = (...args: unknown[]) => {
      try {
        if (typeof target.log === "function") {
          target.log(...args);
        }
      } catch {
        /* ignore */
      }
    };
    const install = (name: "group" | "groupCollapsed" | "groupEnd", fn: (...args: unknown[]) => void) => {
      if (typeof target[name] === "function") return;
      try {
        Object.defineProperty(target, name, {
          value: fn,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch {
        try {
          (target as Console)[name] = fn as Console["group"];
        } catch {
          /* ignore — log wrapper is the backstop */
        }
      }
      // Assignment may silently no-op on some hosts; verify.
      if (typeof target[name] !== "function") {
        try {
          Object.defineProperty(target, name, {
            get: () => fn,
            configurable: true,
            enumerable: false,
          });
        } catch {
          /* ignore */
        }
      }
    };
    install("group", logFn);
    install("groupCollapsed", logFn);
    install("groupEnd", () => {});
  };

  if (consoleLike) {
    patchOne(consoleLike);
    return;
  }
  try {
    if (typeof console !== "undefined") patchOne(console);
  } catch {
    /* ignore */
  }
  try {
    const w = (Zotero as any)?.getMainWindow?.();
    patchOne(w?.console);
  } catch {
    /* ignore */
  }
}

function wrapToolkitLog(toolkit: ZoteroToolkit): void {
  const raw = toolkit.log.bind(toolkit);
  toolkit.log = ((...data: Parameters<ZoteroToolkit["log"]>) => {
    ensureConsoleGroupPolyfill();
    try {
      ensureConsoleGroupPolyfill((toolkit as unknown as { _console?: object })._console);
    } catch {
      /* ignore */
    }
    try {
      return raw(...data);
    } catch (e) {
      try {
        Zotero.debug(`[${config.addonName}] log failed: ${String(e)}`);
      } catch {
        /* ignore */
      }
    }
  }) as ZoteroToolkit["log"];
}

function createZToolkit() {
  // Before toolkit ctor: BasicTool may touch console; field inits (UITool) log.
  ensureConsoleGroupPolyfill();
  const _ztoolkit = new ZoteroToolkit();
  ensureConsoleGroupPolyfill(
    (_ztoolkit as unknown as { _console?: object })._console,
  );
  try {
    ensureConsoleGroupPolyfill(
      (_ztoolkit.UI as unknown as { _console?: object })?._console,
    );
  } catch {
    /* ignore */
  }
  initZToolkit(_ztoolkit);
  wrapToolkitLog(_ztoolkit);
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
