const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/attachmentScanner.ts")],
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

// A tiny in-memory filesystem: keys are directory paths, values are arrays of
// child paths (files or subdirectories). Directories not present as a key are
// treated as files.
function makeLister(tree) {
  return {
    getChildren: async (dir) => tree[dir] || [],
    statType: async (p) => (Object.prototype.hasOwnProperty.call(tree, p) ? "directory" : "file"),
  };
}

const normalizeKey = (p) => p.toLowerCase();
const filename = (p) => p.split("/").pop();

test("a directory containing only an orphan file is NOT reported as empty", async () => {
  const { classifyOrphanTree } = loadModule();
  const tree = {
    "/root": ["/root/sub"],
    "/root/sub": ["/root/sub/orphan.pdf"],
  };
  const { orphanFiles, emptyDirs } = await classifyOrphanTree(
    ["/root"],
    new Set(),
    makeLister(tree),
    normalizeKey,
    filename,
  );
  assert.deepEqual(orphanFiles, ["/root/sub/orphan.pdf"]);
  assert.equal(emptyDirs.includes("/root/sub"), false);
});

test("a directory containing only a referenced file is NOT reported as empty or orphan", async () => {
  const { classifyOrphanTree } = loadModule();
  const tree = {
    "/root": ["/root/sub"],
    "/root/sub": ["/root/sub/known.pdf"],
  };
  const { orphanFiles, emptyDirs } = await classifyOrphanTree(
    ["/root"],
    new Set(["/root/sub/known.pdf"]),
    makeLister(tree),
    normalizeKey,
    filename,
  );
  assert.deepEqual(orphanFiles, []);
  assert.equal(emptyDirs.includes("/root/sub"), false);
});

test("a directory with zero children IS reported as empty", async () => {
  const { classifyOrphanTree } = loadModule();
  const tree = {
    "/root": ["/root/sub"],
    "/root/sub": [],
  };
  const { emptyDirs } = await classifyOrphanTree(
    ["/root"],
    new Set(),
    makeLister(tree),
    normalizeKey,
    filename,
  );
  assert.deepEqual(emptyDirs, ["/root/sub"]);
});

test("a directory containing only ignorable system files IS reported as empty", async () => {
  const { classifyOrphanTree } = loadModule();
  const tree = {
    "/root": ["/root/sub"],
    "/root/sub": ["/root/sub/desktop.ini", "/root/sub/Thumbs.db"],
  };
  const { orphanFiles, emptyDirs } = await classifyOrphanTree(
    ["/root"],
    new Set(),
    makeLister(tree),
    normalizeKey,
    filename,
  );
  assert.deepEqual(orphanFiles, []);
  assert.deepEqual(emptyDirs, ["/root/sub"]);
});

test("nested empty directories are all reported, siblings with content are not", async () => {
  const { classifyOrphanTree } = loadModule();
  const tree = {
    "/root": ["/root/empty", "/root/hasOrphan"],
    "/root/empty": [],
    "/root/hasOrphan": ["/root/hasOrphan/file.pdf"],
  };
  const { orphanFiles, emptyDirs } = await classifyOrphanTree(
    ["/root"],
    new Set(),
    makeLister(tree),
    normalizeKey,
    filename,
  );
  assert.deepEqual(emptyDirs, ["/root/empty"]);
  assert.deepEqual(orphanFiles, ["/root/hasOrphan/file.pdf"]);
});
