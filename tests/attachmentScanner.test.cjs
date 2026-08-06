// @ajan: claude · @etiket: katman-2, tests, attachmentScanner, stale-mismatch-tag-fix, library-scope-fix
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

test("scanAllAttachments scopes its library-wide SQL query to the personal library, not every connected library", async () => {
  // Regression: the raw SQL query had no libraryID filter at all — running
  // "Scan entire library" would also tag items in any connected group
  // library, unlike pdfReconciler.ts's own passes which are deliberately
  // scoped to Zotero.Libraries.userLibraryID everywhere. Same bug class as
  // the cross-library markdb staleness fixed once already in LibRart (K3),
  // now proven against real Zotero: item.js's items table has a NOT NULL
  // libraryID column, and Zotero.DB.queryAsync(sql, [param]) is the real
  // `?`-placeholder binding form (verified against zotero/zotero source).
  const capturedQueries = [];
  global.Zotero = {
    Prefs: { get: () => undefined, set: () => {} },
    ItemTypes: { getID: () => 1 },
    Libraries: { userLibraryID: 42 },
    DB: {
      queryAsync: async (sql, params) => {
        capturedQueries.push({ sql, params });
        return [];
      },
    },
  };
  global.ztoolkit = {
    ProgressWindow: class {
      createLine() {
        return this;
      }
      show() {
        return this;
      }
    },
  };
  try {
    const { scanAllAttachments } = loadModule();
    await scanAllAttachments();

    assert.equal(capturedQueries.length, 1);
    assert.match(capturedQueries[0].sql, /AND libraryID = \?/);
    assert.deepEqual(capturedQueries[0].params, [42]);
  } finally {
    delete global.Zotero;
    delete global.ztoolkit;
  }
});

test("scanOrphanFiles' 'referenced' query is deliberately NOT library-scoped", () => {
  // Opposite of the fix above, on purpose: this set means "some Zotero item
  // already claims this file," and must hold across every library sharing
  // the watch roots, or a group-library attachment's file would be
  // misclassified as an orphan.
  const source = require("node:fs").readFileSync(
    require("node:path").join(
      process.cwd(),
      "src/modules/attachmentScanner.ts",
    ),
    "utf8",
  );
  const anchor = source.indexOf("const referenced = new Set<string>();");
  assert.ok(anchor >= 0);
  const nextQuery = source.indexOf("Zotero.DB.queryAsync(", anchor);
  const queryEnd = source.indexOf(")) || [];", nextQuery);
  const querySlice = source.slice(nextQuery, queryEnd);
  assert.doesNotMatch(querySlice, /libraryID/);
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

test("setTag does not add a duplicate '#broken' when the item already stores it without the '#' prefix", async () => {
  // Regression: `scannerPref("tagBroken", "#broken")` reads the tag string
  // from a user-editable pref with no validation that it starts with "#".
  // The old setTag() did a raw item.hasTag(tag) — if the pref value and the
  // item's stored tag disagreed on the leading "#", it would silently add a
  // second, differently-spelled tag for the same status. This mock's hasTag
  // is intentionally STRICT (exact string only, no normalization) so the
  // test actually exercises resolveAutomationTagOnItem's `#`-aware lookup
  // instead of masking the bug the way the lenient mocks above do.
  global.Zotero = {
    Prefs: {
      get: (key) => (key.endsWith("tagBroken") ? "broken" : undefined),
      set: () => {},
    },
    ItemTypes: { getID: () => 1 },
  };
  try {
    const { scanAttachmentState } = loadModule();
    const tags = new Set(["#broken"]);
    const attachment = {
      isEmbeddedImageAttachment: () => false,
      isSnapshotAttachment: () => false,
      isFileAttachment: () => true,
      fileExists: async () => false, // still broken
      attachmentContentType: "application/pdf",
      attachmentFilename: "broken.pdf",
    };
    global.Zotero.Items = { getAsync: async () => attachment };
    const item = {
      isRegularItem: () => true,
      loadAllData: async () => {},
      getAttachments: () => [1],
      getTags: () => [...tags].map((tag) => ({ tag })),
      hasTag: (t) => tags.has(t), // strict — no '#' normalization
      addTag: (t) => tags.add(t),
      removeTag: (t) => tags.delete(t),
      saveTx: async () => {},
    };

    await scanAttachmentState(item, false);

    assert.deepEqual([...tags], ["#broken"]);
  } finally {
    delete global.Zotero;
  }
});

test("setTag removes the item's actual stored tag variant, not just the pref's spelling", async () => {
  // Same scenario in reverse: item stores the un-prefixed "broken" (from an
  // older scan run under a different pref value); the file now exists again,
  // so the tag must clear. removeTag must target the stored "broken", not a
  // "#broken" the item never had.
  global.Zotero = {
    Prefs: { get: () => undefined, set: () => {} }, // defaults: tagBroken="#broken"
    ItemTypes: { getID: () => 1 },
  };
  try {
    const { scanAttachmentState } = loadModule();
    const tags = new Set(["broken"]);
    const attachment = {
      isEmbeddedImageAttachment: () => false,
      isSnapshotAttachment: () => false,
      isFileAttachment: () => true,
      fileExists: async () => true, // fixed — no longer broken
      isPDFAttachment: () => true,
      attachmentContentType: "application/pdf",
      attachmentFilename: "fixed.pdf",
    };
    global.Zotero.Items = { getAsync: async () => attachment };
    const item = {
      isRegularItem: () => true,
      loadAllData: async () => {},
      getAttachments: () => [1],
      getTags: () => [...tags].map((tag) => ({ tag })),
      hasTag: (t) => tags.has(t), // strict — no '#' normalization
      addTag: (t) => tags.add(t),
      removeTag: (t) => tags.delete(t),
      saveTx: async () => {},
    };

    await scanAttachmentState(item, false);

    assert.deepEqual([...tags], []);
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
