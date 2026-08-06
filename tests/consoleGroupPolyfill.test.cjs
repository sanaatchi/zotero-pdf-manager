// @ajan: cursor · @etiket: katman-2, tests, console-group-polyfill
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

test("console.group polyfill installs functions on non-writable stub console", () => {
  // Mirror the install strategy from ztoolkit.ts without importing TS.
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
    install("group", logFn);
    install("groupCollapsed", logFn);
    install("groupEnd", () => {});
  }

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
