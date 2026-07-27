const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/folderIndex.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

test("watch roots accept semicolon and newline separated paths", () => {
  const { parseWatchRoots } = loadModule();

  assert.deepEqual(
    parseWatchRoots(" D:\\Papers ; E:\\Archive\\\nC:\\Research\r\n"),
    ["D:\\Papers", "E:\\Archive", "C:\\Research"],
  );
});

test("watch roots are de-duplicated case-insensitively", () => {
  const { parseWatchRoots } = loadModule();

  assert.deepEqual(
    parseWatchRoots("D:\\Papers;d:\\papers\\;D:\\Other"),
    ["D:\\Papers", "D:\\Other"],
  );
});

test("filesystem roots retain their required trailing separator", () => {
  const { parseWatchRoots } = loadModule();

  assert.deepEqual(parseWatchRoots("C:\\;/"), ["C:\\", "/"]);
});
