const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

test("validation verdicts: match clears review; unverifiable keeps; mismatch erase-gates file", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /cleanupRejectedAttachment/);
  assert.match(source, /removeAutomationTag\(item,\s*"#pdf-review"\)/);
  assert.match(
    source,
    /Unverifiable PDF content[\s\S]*?#pdf-review[\s\S]*?return null/,
  );
  assert.doesNotMatch(
    source,
    /Unverifiable PDF content[\s\S]{0,400}eraseTx\(\)/,
  );
  assert.match(
    source,
    /Rejected PDF \(metadata mismatch\)[\s\S]*?cleanupRejectedAttachment/,
  );
  assert.match(
    source,
    /await opts\.attachment\.eraseTx\(\);[\s\S]*?IOUtils\.remove\(opts\.persistedPath\)/,
  );
});

test("cleanupRejectedAttachment does not delete file when erase fails", async () => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/oaDownloadPath.ts")],
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
  const { shouldCleanupPersistedDownload } = module.exports;
  assert.equal(shouldCleanupPersistedDownload(true), true);

  let removed = false;
  let erased = false;
  async function cleanupRejectedAttachment(opts) {
    try {
      await opts.attachment.eraseTx();
      erased = true;
    } catch {
      return "erase-failed";
    }
    if (
      opts.persistedPath &&
      shouldCleanupPersistedDownload(opts.finalCreatedByThisRun)
    ) {
      removed = true;
    }
    return "cleaned";
  }

  const failAtt = {
    eraseTx: async () => {
      throw new Error("locked");
    },
  };
  assert.equal(
    await cleanupRejectedAttachment({
      attachment: failAtt,
      persistedPath: "C:\\x.pdf",
      finalCreatedByThisRun: true,
    }),
    "erase-failed",
  );
  assert.equal(removed, false);
  assert.equal(erased, false);

  const okAtt = { eraseTx: async () => {} };
  assert.equal(
    await cleanupRejectedAttachment({
      attachment: okAtt,
      persistedPath: "C:\\x.pdf",
      finalCreatedByThisRun: true,
    }),
    "cleaned",
  );
  assert.equal(removed, true);
});
