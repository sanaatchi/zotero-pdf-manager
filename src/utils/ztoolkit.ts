// @ajan: cursor · @etiket: katman-2, ztoolkit, console-group-polyfill, console-trace-polyfill
import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit, ensureConsoleGroupPolyfill };

/**
 * Zotero 9 toolkit `BasicTool.log` calls `console.groupCollapsed` (or
 * `console.group` as fallback), then unconditionally `console.trace()`, then
 * `console.groupEnd()`. Sandbox consoles often expose those names as
 * non-writable undefined (or omit them entirely). Plain assignment then
 * fails under strict mode and was previously swallowed — polyfill looked
 * present in source but never took (`group`), and `trace` was missing from
 * the patched set entirely (`_console.trace is not a function`).
 *
 * Rather than whack-a-mole one method at a time as toolkit call sites are
 * found, install a full ConsoleAPI-shaped stub for every standard `console`
 * method that is missing/non-callable: informational methods forward to
 * `log`, structural/timer/no-output methods (`groupEnd`, `time`, …) are
 * no-ops. Use `typeof !== "function"` + `defineProperty`, patch toolkit
 * ConsoleAPI fallback (`_console`), and wrap `log` so a missed patch cannot
 * throw.
 */
function ensureConsoleGroupPolyfill(consoleLike?: object | null): void {
  // Methods that should print via `log` when the host console lacks them.
  const FORWARD_TO_LOG = [
    "group",
    "groupCollapsed",
    "trace",
    "table",
    "dir",
    "dirxml",
    "debug",
    "info",
  ] as const;
  // Methods that are structural/stateful (grouping, timers, counters) and
  // are safe to no-op when missing — the point is "callable", not "faithful".
  const NO_OP = [
    "groupEnd",
    "count",
    "countReset",
    "time",
    "timeEnd",
    "timeLog",
    "timeStamp",
    "clear",
    "profile",
    "profileEnd",
    "assert",
  ] as const;

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
    const install = (name: string, fn: (...args: unknown[]) => void) => {
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
          (target as Record<string, unknown>)[name] = fn;
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
    for (const name of FORWARD_TO_LOG) install(name, logFn);
    for (const name of NO_OP) install(name, () => {});
    // `error`/`warn` themselves: extremely unlikely to be missing, but if a
    // host stub omits them, fall back to `log` (never to each other/`logFn`
    // pointing at a still-missing `log`, to avoid self-recursive stubs).
    for (const name of ["error", "warn"] as const) {
      if (typeof target[name] === "function") continue;
      install(name, logFn);
    }
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
      ensureConsoleGroupPolyfill(
        (toolkit as unknown as { _console?: object })._console,
      );
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
