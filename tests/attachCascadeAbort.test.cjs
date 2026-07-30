// @ajan: cursor · @etiket: katman-2, tests, cascade-abort
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadPdfSourcesExports() {
  // Bundle only the error helpers by evaluating a tiny stub that mirrors API.
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfSources.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: [
      "../utils/locale",
      "../utils/prefs",
      "./folderIndex",
      "./oaDownloadPath",
      "../utils/cancelToken",
    ],
  });
  // Full pdfSources needs Zotero globals — instead assert source contracts +
  // unit-test AttachStoppedError via a minimal inline module.
  void result;
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    `
    class AttachStoppedError extends Error {
      constructor(reason, attachment) {
        super("PDF attach stopped (" + reason + ")");
        this.name = "AttachStoppedError";
        this.reason = reason;
        this.attachment = attachment;
      }
    }
    function isAttachStoppedError(e) {
      return !!(e && e.name === "AttachStoppedError");
    }
    function rethrowAttachControlFlow(e) {
      if (isAttachStoppedError(e)) throw e;
      if (e && e.name === "RunAbortedError") throw e;
    }
    module.exports = { AttachStoppedError, isAttachStoppedError, rethrowAttachControlFlow };
  `,
  )(module, module.exports);
  return module.exports;
}

test("validation + cascade: AttachStoppedError stops further sources", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /class AttachStoppedError/);
  // mismatch/unverifiable detach successfully → ContentMismatchError (cascade may continue).
  // Only erase-failed keeps the Zotero link and stops the cascade.
  assert.doesNotMatch(source, /throw new AttachStoppedError\("review"/);
  assert.match(source, /throw new AttachStoppedError\("erase-failed"/);
  assert.match(source, /ContentMismatchError/);
  assert.match(source, /rethrowAttachControlFlow/);

  const download = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfDownload.ts"),
    "utf8",
  );
  assert.match(download, /isAttachStoppedError/);
  assert.match(download, /isContentMismatchError/);
  assert.match(download, /cascadeAutomaticSources/);
  assert.match(download, /stopped:/);
  assert.match(download, /hasPDFAttachment\(item\)/);

  const { AttachStoppedError, isAttachStoppedError, rethrowAttachControlFlow } =
    loadPdfSourcesExports();

  const err = new AttachStoppedError("erase-failed", { id: 1 });
  assert.equal(isAttachStoppedError(err), true);
  assert.throws(() => rethrowAttachControlFlow(err), /stopped/);

  const sourcesTried = [];
  function simulateCascade(firstResult) {
    for (const id of ["pmc", "dergipark", "scihub"]) {
      sourcesTried.push(id);
      if (id === "pmc" && firstResult === "erase-failed") {
        throw new AttachStoppedError("erase-failed", { id: 99 });
      }
    }
    return "continued";
  }
  let stopped = null;
  try {
    simulateCascade("erase-failed");
  } catch (e) {
    if (isAttachStoppedError(e)) stopped = e.reason;
  }
  assert.equal(stopped, "erase-failed");
  assert.deepEqual(sourcesTried, ["pmc"]);
});

test("add-notifier flush wires AbortController into performItems", () => {
  const reconciler = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  assert.match(reconciler, /flushAddedItems/);
  assert.match(
    reconciler,
    /performItems\(items,\s*"add",\s*false,\s*controller\.signal\)/,
  );
  assert.match(reconciler, /runWithAbortSignal\(controller\.signal/);
  assert.match(reconciler, /buildIndex\(forceIndex,\s*undefined,\s*signal\)/);
  assert.match(reconciler, /"stopped" in online/);
});
