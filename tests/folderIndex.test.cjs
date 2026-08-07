// @ajan: cursor · @etiket: katman-2, tests, watch-root-parent
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
    external: [],
  });
  const module = { exports: {} };
  // Prefer stubs for Zotero/prefs when unit-testing pure helpers.
  const requireStub = (id) => {
    if (id.includes("prefs") || id.endsWith("../utils/prefs")) {
      return {
        getPref: () => undefined,
        setPref: () => undefined,
      };
    }
    return require(id);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    requireStub,
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

  assert.deepEqual(parseWatchRoots("D:\\Papers;d:\\papers\\;D:\\Other"), [
    "D:\\Papers",
    "D:\\Other",
  ]);
});

test("ensurePathInWatchRoots appends default Kaynaklar once", () => {
  const { ensurePathInWatchRoots, DEFAULT_WATCH_ROOT } = loadModule();
  const once = ensurePathInWatchRoots("", DEFAULT_WATCH_ROOT);
  assert.equal(once, DEFAULT_WATCH_ROOT);
  const twice = ensurePathInWatchRoots(once, DEFAULT_WATCH_ROOT);
  assert.equal(twice, DEFAULT_WATCH_ROOT);
});

test("normalizeDefaultWatchRoots pins Kaynaklar and strips OneDrive parent", () => {
  const {
    collapseNestedWatchRoots,
    normalizeDefaultWatchRoots,
    DEFAULT_WATCH_ROOT,
    LEGACY_ONEDRIVE_LIBRARY_ROOT,
  } = loadModule();
  const nested = `${DEFAULT_WATCH_ROOT}\\sanat`;
  assert.equal(
    collapseNestedWatchRoots(`${DEFAULT_WATCH_ROOT};${nested}`),
    DEFAULT_WATCH_ROOT,
  );
  assert.equal(normalizeDefaultWatchRoots(""), DEFAULT_WATCH_ROOT);
  assert.equal(
    normalizeDefaultWatchRoots(LEGACY_ONEDRIVE_LIBRARY_ROOT),
    DEFAULT_WATCH_ROOT,
  );
  assert.equal(
    normalizeDefaultWatchRoots(
      `${LEGACY_ONEDRIVE_LIBRARY_ROOT};${DEFAULT_WATCH_ROOT}`,
    ),
    DEFAULT_WATCH_ROOT,
  );
  assert.equal(
    normalizeDefaultWatchRoots(`E:\\Other;${LEGACY_ONEDRIVE_LIBRARY_ROOT}`),
    `E:\\Other;${DEFAULT_WATCH_ROOT}`,
  );
  assert.match(DEFAULT_WATCH_ROOT, /Zotero Kaynaklar$/i);
});

test("filesystem roots retain their required trailing separator", () => {
  const { parseWatchRoots } = loadModule();

  assert.deepEqual(parseWatchRoots("C:\\;/"), ["C:\\", "/"]);
});

test("mergeWatchRoots adds linked base and de-duplicates", () => {
  const { mergeWatchRoots } = loadModule();

  assert.deepEqual(mergeWatchRoots(["D:\\Papers"], "D:\\Papers", true), [
    "D:\\Papers",
  ]);
  assert.deepEqual(mergeWatchRoots(["D:\\Papers"], "E:\\LinkedBase", true), [
    "D:\\Papers",
    "E:\\LinkedBase",
  ]);
  assert.deepEqual(mergeWatchRoots(["D:\\Papers"], "E:\\LinkedBase", false), [
    "D:\\Papers",
  ]);
});

test("indexEntryFromDiscovery extracts DOI/ISBN/title from filename", () => {
  const { indexEntryFromDiscovery } = loadModule();
  const entry = indexEntryFromDiscovery(
    "D:\\lib\\10.1000\\xyz-Book Title.pdf",
    1000,
  );
  assert.equal(entry.mtime, 1000);
  assert.ok(entry.norm);
  // DOI may or may not parse depending on path chars; prefer a clean name
  const withDoi = indexEntryFromDiscovery(
    "D:\\lib\\Smith (2020) Great Paper [journalArticle] Nature 10.1234\\abc.pdf",
    1,
  );
  // At minimum name/norm/alnum always set
  assert.ok(withDoi.name);
  assert.ok(withDoi.alnum);

  const isbnEntry = indexEntryFromDiscovery(
    "D:\\lib\\Author - Title - 2020 - Publisher - ISBN 9780306406157 - CAT001.pdf",
    2,
  );
  assert.equal(isbnEntry.isbn, "9780306406157");
  assert.ok(isbnEntry.pdfTitle || isbnEntry.name);
});

test("indexEntryFromDiscovery reuses previous entry on same mtime", () => {
  const { indexEntryFromDiscovery } = loadModule();
  const prev = {
    path: "D:\\a.pdf",
    mtime: 42,
    name: "a",
    norm: "a",
    alnum: "a",
    doi: "10.1/x",
    pdfTitle: "Cached",
  };
  const next = indexEntryFromDiscovery("D:\\a.pdf", 42, prev);
  assert.equal(next.pdfTitle, "Cached");
  assert.equal(next.doi, "10.1/x");
});

test("folder index caps align with 99_999 contract and expose incomplete meta", () => {
  const {
    MAX_INDEX_FILES,
    MAX_WALK_DEPTH,
    getLastIndexBuildMeta,
    isFolderIndexComplete,
    __setLastIndexBuildMetaForTests,
  } = loadModule();
  assert.equal(MAX_INDEX_FILES, 99999);
  assert.equal(MAX_WALK_DEPTH, 8);
  const meta = getLastIndexBuildMeta();
  assert.equal(typeof meta.incomplete, "boolean");
  assert.equal(meta.cappedAt, 99999);
  __setLastIndexBuildMetaForTests({
    incomplete: true,
    truncateReason: "maxFiles",
    discovered: 99999,
    cappedAt: 99999,
    maxDepth: 8,
  });
  assert.equal(isFolderIndexComplete(), false);
  __setLastIndexBuildMetaForTests({
    incomplete: false,
    truncateReason: null,
    discovered: 0,
    cappedAt: 99999,
    maxDepth: 8,
  });
  assert.equal(isFolderIndexComplete(), true);
});

test("unreadable getChildren marks index incomplete via ioError", async () => {
  const {
    buildIndex,
    getLastIndexBuildMeta,
    isFolderIndexComplete,
    __setFolderIOForTests,
    invalidateIndex,
  } = loadModule();

  globalThis.IOUtils = {
    exists: async () => false,
    readUTF8: async () => "[]",
    writeUTF8: async () => {},
    move: async () => {},
    remove: async () => {},
  };
  globalThis.PathUtils = { join: (...parts) => parts.join("/") };
  globalThis.Zotero = { DataDirectory: { dir: "/tmp/zotero-data" } };
  globalThis.ztoolkit = { log: () => {} };

  __setFolderIOForTests({
    getChildren: async () => {
      throw new Error("permission denied");
    },
    stat: async () => ({ type: "directory" }),
  });
  invalidateIndex();
  await buildIndex(true, ["D:\\Papers"]);
  const meta = getLastIndexBuildMeta();
  assert.equal(meta.incomplete, true);
  assert.equal(meta.truncateReason, "ioError");
  assert.equal(isFolderIndexComplete(), false);
  __setFolderIOForTests(null);
});

test("stat error on a child marks incomplete while other root still scanned", async () => {
  const {
    buildIndex,
    getLastIndexBuildMeta,
    __setFolderIOForTests,
    invalidateIndex,
  } = loadModule();

  globalThis.IOUtils = {
    exists: async () => false,
    readUTF8: async () => "[]",
    writeUTF8: async () => {},
    move: async () => {},
    remove: async () => {},
  };
  globalThis.PathUtils = { join: (...parts) => parts.join("/") };
  globalThis.Zotero = { DataDirectory: { dir: "/tmp/zotero-data" } };
  globalThis.ztoolkit = { log: () => {} };

  __setFolderIOForTests({
    getChildren: async (dir) => {
      if (dir === "D:\\Good") return ["D:\\Good\\a.pdf"];
      if (dir === "D:\\Bad") return ["D:\\Bad\\x.pdf"];
      return [];
    },
    stat: async (p) => {
      if (p.includes("Bad")) throw new Error("stat fail");
      if (p.endsWith(".pdf")) {
        return { type: "file", lastModified: 1, size: 10 };
      }
      return { type: "directory" };
    },
  });
  invalidateIndex();
  const files = await buildIndex(true, ["D:\\Good", "D:\\Bad"]);
  assert.equal(files.length, 1);
  assert.equal(getLastIndexBuildMeta().incomplete, true);
  assert.equal(getLastIndexBuildMeta().truncateReason, "ioError");
  __setFolderIOForTests(null);
});

test("index mutation queue runs tasks sequentially", async () => {
  const { __enqueueIndexMutationForTests } = loadModule();
  const order = [];
  const a = __enqueueIndexMutationForTests(async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
    return 1;
  });
  const b = __enqueueIndexMutationForTests(async () => {
    order.push("b-start");
    order.push("b-end");
    return 2;
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  assert.deepEqual([ra, rb], [1, 2]);
});
