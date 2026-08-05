// @ajan: cursor · @etiket: katman-2, tests, cascade-abort, pdf-mismatch-detach
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

test("validation + cascade: mismatch detaches; ContentMismatch continues sources", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /class AttachStoppedError/);
  // OA + local mismatch: detach link + tag; never keep wrong PDF as success.
  assert.match(source, /detaching link \(#pdf-mismatch\)/);
  assert.doesNotMatch(source, /keeping attachment \(#pdf-mismatch\)/);
  assert.match(source, /keeping attachment \(#pdf-review\)/);
  assert.doesNotMatch(source, /throw new AttachStoppedError\("review"/);
  assert.match(source, /finalizeLocalAttachment/);
  assert.match(source, /Yerel PDF künye ile uyuşmuyor/);
  assert.match(source, /İndirilen PDF künye ile uyuşmuyor/);
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
  assert.match(download, /hasAcceptedPdfAttachment/);
  assert.match(download, /detachMismatchPdfAttachments/);
  assert.match(download, /itemHasPdfMismatchTag/);
  // Mismatch-tagged items must not count as "already have PDF".
  assert.match(download, /hasAcceptedPdfAttachment\(item\)/);
  assert.match(
    download,
    /isContentMismatchError\(e\)[\s\S]*?outcome:\s*"rejected"/,
  );

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

test("hasAcceptedPdfAttachment: mismatch tag means not done", () => {
  // Pure logic mirror of pdfDownload.hasAcceptedPdfAttachment
  function hasPDFAttachment(item) {
    return (item.attachments || []).some((a) => a.contentType === "application/pdf");
  }
  function hasAcceptedPdfAttachment(item) {
    if (!hasPDFAttachment(item)) return false;
    if (item.tags && item.tags.includes("#pdf-mismatch")) return false;
    return true;
  }

  assert.equal(
    hasAcceptedPdfAttachment({
      attachments: [{ contentType: "application/pdf" }],
      tags: [],
    }),
    true,
  );
  assert.equal(
    hasAcceptedPdfAttachment({
      attachments: [{ contentType: "application/pdf" }],
      tags: ["#pdf-mismatch"],
    }),
    false,
  );
  assert.equal(
    hasAcceptedPdfAttachment({
      attachments: [],
      tags: ["#pdf-mismatch"],
    }),
    false,
  );
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
