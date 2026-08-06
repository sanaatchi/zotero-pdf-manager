// @ajan: cursor · @etiket: katman-2, cascade, test, cascade-log, downloads-probe
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadCascade() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/oaCascade.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

test("cascadeAutomaticSources stops on AttachStoppedError and skips DOI", async () => {
  const { cascadeAutomaticSources } = loadCascade();
  const calls = [];
  class AttachStoppedError extends Error {
    constructor(reason, attachment) {
      super(reason);
      this.name = "AttachStoppedError";
      this.reason = reason;
      this.attachment = attachment;
    }
  }
  const result = await cascadeAutomaticSources(
    { id: 1 },
    [
      {
        id: "unpaywall",
        isEnabled: () => true,
        supportsItem: () => true,
        tryAttach: async () => {
          calls.push("unpaywall");
          throw new AttachStoppedError("review", { id: 9 });
        },
      },
      {
        id: "doi",
        isEnabled: () => true,
        supportsItem: () => true,
        tryAttach: async () => {
          calls.push("doi");
          return { id: 2 };
        },
      },
    ],
    { hasPDF: () => false },
  );
  assert.deepEqual(calls, ["unpaywall"]);
  assert.equal(result.stopped, "review");
  assert.equal(result.attachment.id, 9);
});

test("cascadeAutomaticSources continues after null attach; skips when hasPDF", async () => {
  const { cascadeAutomaticSources } = loadCascade();
  const calls = [];
  const ok = await cascadeAutomaticSources(
    { id: 1 },
    [
      {
        id: "arxiv",
        isEnabled: () => true,
        supportsItem: () => true,
        tryAttach: async () => {
          calls.push("arxiv");
          return null;
        },
      },
      {
        id: "doi",
        isEnabled: () => true,
        supportsItem: () => true,
        tryAttach: async () => {
          calls.push("doi");
          return { id: 3 };
        },
      },
    ],
    { hasPDF: () => false },
  );
  assert.deepEqual(calls, ["arxiv", "doi"]);
  assert.equal(ok.source, "doi");

  calls.length = 0;
  const skipped = await cascadeAutomaticSources(
    { id: 1 },
    [
      {
        id: "doi",
        isEnabled: () => true,
        supportsItem: () => true,
        tryAttach: async () => {
          calls.push("doi");
          return { id: 4 };
        },
      },
    ],
    { hasPDF: () => true },
  );
  assert.equal(skipped, null);
  assert.deepEqual(calls, []);
});

test("pdfDownload wires cascadeAutomaticSources; prefs expose cancel UI", () => {
  const download = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfDownload.ts"),
    "utf8",
  );
  assert.match(download, /from "\.\.\/utils\/oaCascade"/);
  assert.match(download, /cascadeAutomaticSources\(/);
  assert.match(download, /queueCascadeMissLog/);

  const prefs = fs.readFileSync(
    path.join(process.cwd(), "src/modules/preferenceScript.ts"),
    "utf8",
  );
  assert.match(prefs, /runManualReconcileWithProgress/);
  assert.match(prefs, /pdf-cancel-reconcile/);
  assert.match(prefs, /reconciler\.cancel\(/);
  assert.match(prefs, /isBusy\(\)/);

  const reconciler = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  assert.match(reconciler, /cancel\(reason/);
  assert.match(reconciler, /isBusy\(\)/);

  const xhtml = fs.readFileSync(
    path.join(process.cwd(), "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /id="pdf-cancel-reconcile"/);

  const sources = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(sources, /#pdf-quarantine/);

  const audit = fs.readFileSync(
    path.join(process.cwd(), "src/modules/automationAudit.ts"),
    "utf8",
  );
  assert.match(audit, /"#pdf-quarantine"/);
});

test("downloadPdfForSelectedItems probes downloads folder before source cascade", () => {
  const download = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfDownload.ts"),
    "utf8",
  );
  assert.match(download, /export async function tryAttachFromDownloadsFolder/);
  assert.match(
    download,
    /buildIndex\(true, \[downloadsDir\].*ephemeral:\s*true/s,
  );
  assert.match(download, /LocalFolderSource/);
  assert.match(download, /matchItem\(item, index\)/);
  assert.match(download, /attachFile\(item, match\.file/);
  const probeIdx = download.indexOf("tryAttachFromDownloadsFolder(item)");
  const cascadeIdx = download.indexOf("orderedSourcesForItem(item)");
  assert.ok(probeIdx >= 0 && cascadeIdx >= 0);
  assert.ok(
    probeIdx < cascadeIdx,
    "downloads probe must run before orderedSourcesForItem cascade",
  );
  assert.match(download, /DOWNLOADS_PROBE_SOURCE_ID/);

  const folderIndex = fs.readFileSync(
    path.join(process.cwd(), "src/modules/folderIndex.ts"),
    "utf8",
  );
  assert.match(folderIndex, /ephemeral\?: boolean/);
});
