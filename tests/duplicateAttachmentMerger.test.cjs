const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/duplicateAttachmentMerger.ts"),
    ],
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

function harness({ hashes, annotations = [], exists = [] }) {
  const trashed = [];
  const children = annotations.map((text, index) => ({
    id: 100 + index,
    annotationText: text,
    parentItemID: 1,
    saveTx: async function () {},
  }));
  const attachments = hashes.map((hash, index) => ({
    id: index + 1,
    dateAdded: `202${index + 4}-01-01`,
    attachmentContentType: "application/pdf",
    attachmentHash: Promise.resolve(hash),
    attachmentText: Promise.resolve(annotations.join(" ")),
    attachmentPath: `/pdf/${index + 1}.pdf`,
    isPDFAttachment: () => true,
    isLinkedFileAttachment: () => true,
    fileExists: async () => exists[index] !== false,
    getFilePathAsync: async () => `/pdf/${index + 1}.pdf`,
    getAnnotations: () => (index === 0 ? children : []),
    getNotes: () => [],
    saveTx: async () => {},
  }));
  const parent = {
    id: 50,
    isRegularItem: () => true,
    isAttachment: () => false,
    getAttachments: () => attachments.map((item) => item.id),
  };
  global.ZoteroPane = { getSelectedItems: () => [parent] };
  global.Zotero = {
    Items: {
      get: (id) => attachments.find((item) => item.id === id),
      trashTx: async (id) => trashed.push(id),
    },
  };
  global.ztoolkit = {
    log: () => {},
    ProgressWindow: class {
      createLine() {
        return this;
      }
      show() {}
    },
  };
  return { attachments, children, trashed };
}

test("byte-identical PDFs merge while preserving annotation children", async () => {
  const state = harness({
    hashes: ["same", "same"],
    annotations: ["A sufficiently long highlighted passage for validation"],
  });
  const { mergeDuplicatePDFAttachments } = loadModule();

  const result = await mergeDuplicatePDFAttachments();

  assert.equal(result.merged, 1);
  assert.deepEqual(state.trashed, [2]);
  assert.equal(state.children[0].parentItemID, 1);
});

test("different PDF hashes are treated as ambiguous and retained", async () => {
  const state = harness({ hashes: ["edition-a", "edition-b"] });
  const { mergeDuplicatePDFAttachments } = loadModule();

  const result = await mergeDuplicatePDFAttachments();

  assert.equal(result.merged, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(state.trashed, []);
});

test("an empty broken PDF link is trashed when a working PDF exists", async () => {
  const state = harness({
    hashes: ["working", ""],
    exists: [true, false],
  });
  const { mergeDuplicatePDFAttachments } = loadModule();

  const result = await mergeDuplicatePDFAttachments();

  assert.equal(result.merged, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(state.trashed, [2]);
});
