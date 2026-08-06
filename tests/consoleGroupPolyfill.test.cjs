// @ajan: cursor · @etiket: katman-2, tests, console-group-polyfill, console-trace-polyfill
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = process.cwd();

test("console.group polyfill uses defineProperty + typeof function check (Zotero 9)", () => {
  const ztoolkit = fs.readFileSync(
    path.join(root, "src/utils/ztoolkit.ts"),
    "utf8",
  );
  const index = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");

  assert.match(ztoolkit, /ensureConsoleGroupPolyfill/);
  assert.match(ztoolkit, /Object\.defineProperty/);
  assert.match(ztoolkit, /typeof target\[name\] === "function"/);
  assert.match(ztoolkit, /wrapToolkitLog/);
  // Must run before new ZoteroToolkit()
  assert.match(
    ztoolkit,
    /ensureConsoleGroupPolyfill\(\);\s*const _ztoolkit = new ZoteroToolkit\(\)/s,
  );
  // Earliest bootstrap in index.ts
  assert.match(index, /ensureConsoleGroupPolyfill\(\);/);
  assert.match(
    index,
    /ensureConsoleGroupPolyfill\(\);\s*\n\s*const basicTool = new BasicTool\(\)/s,
  );
});

test("console.group polyfill source patches trace (and other ConsoleAPI methods), not just group family", () => {
  const ztoolkit = fs.readFileSync(
    path.join(root, "src/utils/ztoolkit.ts"),
    "utf8",
  );
  // Toolkit's BasicTool.log calls groupCollapsed/group, then unconditionally
  // console.trace(), then groupEnd() — `trace` was missing from the original
  // one-method-at-a-time polyfill (`_console.trace is not a function`).
  assert.match(ztoolkit, /["']trace["']/);
  // Full ConsoleAPI stub, not whack-a-mole: at least a handful of other
  // standard console methods are covered too.
  assert.match(ztoolkit, /["']table["']/);
  assert.match(ztoolkit, /["']dir["']/);
  assert.match(ztoolkit, /["']groupEnd["']/);
  assert.match(ztoolkit, /["']assert["']/);
});

// Mirror the install strategy from ztoolkit.ts without importing TS.
const FORWARD_TO_LOG = [
  "group",
  "groupCollapsed",
  "trace",
  "table",
  "dir",
  "dirxml",
  "debug",
  "info",
];
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
];

function patchOne(c) {
  if (!c || (typeof c !== "object" && typeof c !== "function")) return;
  const target = c;
  const logFn = (...args) => {
    if (typeof target.log === "function") target.log(...args);
  };
  const install = (name, fn) => {
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
        target[name] = fn;
      } catch {
        /* ignore */
      }
    }
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
  for (const name of ["error", "warn"]) {
    if (typeof target[name] === "function") continue;
    install(name, logFn);
  }
}

test("console.group polyfill installs functions on non-writable stub console (group family)", () => {
  // Simulate Zotero sandbox: own props exist but are not functions / not writable.
  const stub = { log: () => {} };
  Object.defineProperty(stub, "group", {
    value: undefined,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(stub, "groupCollapsed", {
    value: undefined,
    writable: false,
    configurable: true,
    enumerable: false,
  });

  // Plain assignment (old polyfill) would fail / no-op under strict-ish hosts.
  assert.equal(typeof stub.group, "undefined");

  patchOne(stub);
  assert.equal(typeof stub.group, "function");
  assert.equal(typeof stub.groupCollapsed, "function");
  assert.equal(typeof stub.groupEnd, "function");
  stub.group("x");
  stub.groupCollapsed("y");
  stub.groupEnd();
});

test("console.group polyfill installs console.trace (toolkit's BasicTool.log calls it unconditionally)", () => {
  // Stub reproducing the exact reported crash: `console.trace is not a
  // function`. Toolkit calls `_console.groupCollapsed(...)`, then
  // `_console.trace()`, then `_console.groupEnd()` on every `ztoolkit.log()`.
  const calls = [];
  const stub = {
    log: (...args) => calls.push(["log", args]),
  };

  assert.equal(typeof stub.trace, "undefined");

  patchOne(stub);

  assert.equal(typeof stub.trace, "function");
  // Must not throw — this is what crashed before the fix.
  assert.doesNotThrow(() => {
    stub.groupCollapsed("[Zotero PDF Manager]");
    stub.trace();
    stub.groupEnd();
  });
});
