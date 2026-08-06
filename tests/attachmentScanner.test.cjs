// @ajan: claude · @etiket: katman-2, tests, attachmentScanner, stale-mismatch-tag-fix
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
    statType: async (p) =>
      Object.prototype.hasOwnProperty.call(tree, p) ? "directory" : "file",
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

test("scanAttachmentState clears stale #pdf-mismatch/#pdf-review when the item has no file attachment left", async () => {
  global.Zotero = {
    Prefs: { get: () => undefined, set: () => {} },
    ItemTypes: { getID: () => 1 },
  };
  try {
    const { scanAttachmentState } = loadModule();
    const tags = new Set(["pdf-mismatch", "pdf-review"]);
    let saveCount = 0;
    const item = {
      isRegularItem: () => true,
      loadAllData: async () => {},
      getAttachments: () => [],
      getTags: () => [...tags].map((tag) => ({ tag })),
      hasTag: (t) => tags.has(String(t).replace(/^#/, "")),
      addTag: (t) => {
        tags.add(String(t).replace(/^#/, ""));
      },
      removeTag: (t) => {
        tags.delete(String(t).replace(/^#/, ""));
      },
      saveTx: async () => {
        saveCount++;
      },
    };

    const state = await scanAttachmentState(item, false);

    assert.equal(state.noSource, true);
    // #nosource added (scanner's own tag) + #pdf-mismatch/#pdf-review cleared
    // (stale — no attachment left for a "mismatch" to point at).
    assert.equal(tags.has("nosource"), true);
    assert.equal(tags.has("pdf-mismatch"), false);
    assert.equal(tags.has("pdf-review"), false);
    assert.ok(saveCount >= 1);
  } finally {
    delete global.Zotero;
  }
});

test("scanAttachmentState leaves #pdf-mismatch alone when the item still has a file attachment", async () => {
  global.Zotero = {
    Prefs: { get: () => undefined, set: () => {} },
    ItemTypes: { getID: () => 1 },
  };
  try {
    const { scanAttachmentState } = loadModule();
    const tags = new Set(["pdf-mismatch", "pdf-review"]);
    const attachment = {
      isEmbeddedImageAttachment: () => false,
      isSnapshotAttachment: () => false,
      isFileAttachment: () => true,
      fileExists: async () => true,
      isPDFAttachment: () => true,
      attachmentContentType: "application/pdf",
      attachmentFilename: "kept.pdf",
    };
    const item = {
      isRegularItem: () => true,
      loadAllData: async () => {},
      getAttachments: () => [1],
      getTags: () => [...tags].map((tag) => ({ tag })),
      hasTag: (t) => tags.has(String(t).replace(/^#/, "")),
      addTag: (t) => {
        tags.add(String(t).replace(/^#/, ""));
      },
      removeTag: (t) => {
        tags.delete(String(t).replace(/^#/, ""));
      },
      saveTx: async () => {},
    };
    global.Zotero.Items = { getAsync: async () => attachment };

    const state = await scanAttachmentState(item, false);

    assert.equal(state.noSource, false);
    assert.equal(tags.has("pdf-mismatch"), true);
    assert.equal(tags.has("pdf-review"), true);
  } finally {
    delete global.Zotero;
  }
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
