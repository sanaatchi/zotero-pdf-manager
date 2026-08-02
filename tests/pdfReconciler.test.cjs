const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule(entry) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), entry)],
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

test("expandAddedItemIDs maps attachments to parents and skips deleted", () => {
  const { expandAddedItemIDs } = loadModule("src/modules/pdfReconciler.ts");
  const parent = {
    id: 10,
    deleted: false,
    isRegularItem: () => true,
    isTopLevelItem: () => true,
    isAttachment: () => false,
  };
  const attachment = {
    id: 11,
    deleted: false,
    parentItemID: 10,
    isRegularItem: () => false,
    isTopLevelItem: () => false,
    isAttachment: () => true,
  };
  const deleted = {
    id: 12,
    deleted: true,
    isRegularItem: () => true,
    isTopLevelItem: () => true,
    isAttachment: () => false,
  };
  const byId = new Map([
    [10, parent],
    [11, attachment],
    [12, deleted],
  ]);
  const getItem = (id) => byId.get(id);

  assert.deepEqual(expandAddedItemIDs([10, 11, 12, 11], getItem), [10]);
  assert.deepEqual(expandAddedItemIDs([11], getItem), [10]);
  assert.deepEqual(expandAddedItemIDs([12], getItem), []);
});

test("periodic reconcile minutes are normalized and bounded", () => {
  const { normalizePeriodicMinutes, normalizeAddSettleMs } = loadModule(
    "src/modules/pdfReconciler.ts",
  );

  assert.equal(normalizePeriodicMinutes("0"), 0);
  assert.equal(normalizePeriodicMinutes("45"), 45);
  assert.equal(normalizePeriodicMinutes("-1"), 30);
  assert.equal(normalizePeriodicMinutes("not-a-number"), 30);
  assert.equal(normalizePeriodicMinutes(99999), 10080);

  assert.equal(normalizeAddSettleMs("0"), 0);
  assert.equal(normalizeAddSettleMs("1500"), 1500);
  assert.equal(normalizeAddSettleMs("-5"), 1000);
  assert.equal(normalizeAddSettleMs("bad"), 1000);
  assert.equal(normalizeAddSettleMs(999999), 60000);
});

test("match confidence thresholds classify attach / review / skip", () => {
  const { classifyMatchConfidence, normalizeMatchThresholds } = loadModule(
    "src/modules/pdfSources.ts",
  );

  assert.deepEqual(normalizeMatchThresholds(0.85, 0.6), {
    autoAttach: 0.85,
    review: 0.6,
  });
  assert.deepEqual(normalizeMatchThresholds(0.5, 0.9), {
    autoAttach: 0.9,
    review: 0.5,
  });
  assert.equal(classifyMatchConfidence(0.9, 0.85, 0.6), "attach");
  assert.equal(classifyMatchConfidence(0.7, 0.85, 0.6), "review");
  assert.equal(classifyMatchConfidence(0.5, 0.85, 0.6), "skip");
  assert.equal(classifyMatchConfidence(1, 0.85, 0.6), "attach");
});

test("reconcile considers only regular items without a PDF", () => {
  global.Zotero = {
    Items: {
      get: (id) =>
        id === 1
          ? { attachmentContentType: "application/pdf" }
          : { attachmentContentType: "text/html" },
    },
  };
  const { canReconcileItem } = loadModule("src/modules/pdfReconciler.ts");
  const item = (attachments, overrides = {}) => ({
    isRegularItem: () => true,
    isFeedItem: false,
    deleted: false,
    getAttachments: () => attachments,
    ...overrides,
  });

  assert.equal(canReconcileItem(item([])), true);
  assert.equal(canReconcileItem(item([2])), true);
  assert.equal(canReconcileItem(item([1])), false);
  assert.equal(canReconcileItem(item([], { deleted: true })), false);
  assert.equal(
    canReconcileItem(item([], { isRegularItem: () => false })),
    false,
  );
  delete global.Zotero;
});

test("title match below auto-attach lands in review; high score attaches", () => {
  global.Zotero = {
    Prefs: {
      get: () => undefined,
    },
  };
  const { LocalFolderSource } = loadModule("src/modules/pdfSources.ts");
  const source = new LocalFolderSource();
  // 6 significant tokens (>3 chars); 4/6 ≈ 0.67 → review under defaults 0.85/0.60
  const item = {
    getField: (field) => {
      if (field === "title") {
        return "Complete Guide Ancient Philosophy Modern Thought";
      }
      if (field === "DOI" || field === "ISBN" || field === "date") return "";
      return "";
    },
    getCreators: () => [],
  };
  const files = [
    {
      path: "D:\\partial.pdf",
      mtime: 1,
      name: "complete guide ancient philosophy",
      norm: "complete guide ancient philosophy",
      alnum: "completeguideancientphilosophy",
    },
  ];
  assert.equal(source.matchItem(item, files).status, "review");

  const strong = [
    {
      path: "D:\\full.pdf",
      mtime: 1,
      name: "complete guide ancient philosophy modern thought smith 2020",
      norm: "complete guide ancient philosophy modern thought smith 2020",
      alnum: "completeguideancientphilosophymodernthoughtsmith2020",
    },
  ];
  const itemWithAuthor = {
    ...item,
    getField: (field) => {
      if (field === "title") {
        return "Complete Guide Ancient Philosophy Modern Thought";
      }
      if (field === "date") return "2020";
      return "";
    },
    getCreators: () => [{ lastName: "Smith" }],
  };
  const attached = source.matchItem(itemWithAuthor, strong);
  assert.equal(attached.status, "matched");
  assert.ok(attached.score >= 0.85);
  delete global.Zotero;
});

test("duplicate DOI filename matches are treated as ambiguous", () => {
  global.Zotero = { Prefs: { get: () => undefined } };
  const { LocalFolderSource } = loadModule("src/modules/pdfSources.ts");
  const source = new LocalFolderSource();
  const item = {
    getField: (field) => (field === "DOI" ? "10.1000/example" : ""),
  };
  const files = ["D:\\one.pdf", "E:\\two.pdf"].map((file) => ({
    path: file,
    mtime: 1,
    name: file,
    norm: file.toLowerCase(),
    alnum: "101000example",
  }));

  assert.deepEqual(source.matchItem(item, files), {
    status: "ambiguous",
    score: 1,
  });
  delete global.Zotero;
});

test("automatic online fallback contains only approved OA sources", () => {
  const { AUTOMATIC_ONLINE_SOURCE_IDS } = loadModule(
    "src/modules/pdfDownload.ts",
  );

  assert.deepEqual(
    [...AUTOMATIC_ONLINE_SOURCE_IDS],
    ["doi", "dergipark", "pmc"],
  );
  for (const unsafe of [
    "scihub",
    "libgen",
    "proxy",
    "proquest",
    "arxiv",
    "s2",
  ]) {
    assert.equal(AUTOMATIC_ONLINE_SOURCE_IDS.includes(unsafe), false);
  }
});

test("enabled LibGen runs even when omitted from legacy sourceOrder", () => {
  const { mergeEnabledSourceOrder } = loadModule("src/modules/pdfDownload.ts");
  const available = {
    local: { isEnabled: () => true },
    dergipark: { isEnabled: () => true },
    pmc: { isEnabled: () => true },
    libgen: { isEnabled: () => true },
    scihub: { isEnabled: () => false },
  };
  assert.deepEqual(mergeEnabledSourceOrder("local,dergipark,pmc", available), [
    "local",
    "dergipark",
    "pmc",
    "libgen",
  ]);
});
