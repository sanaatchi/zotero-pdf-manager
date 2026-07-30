// @ajan: cursor · @etiket: katman-2, tests, reject-keep-disk
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("validation verdicts: match clears review; mismatch/unverifiable detach link keep disk", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /cleanupRejectedAttachment/);
  assert.match(source, /removeAutomationTag\(item,\s*"#pdf-review"\)/);
  assert.match(source, /AttachStoppedError\("erase-failed"/);
  assert.match(source, /ContentMismatchError/);
  assert.match(source, /decideContentValidation/);
  assert.match(source, /Rejected PDF \(\$\{verdict\}\)/);
  assert.match(source, /renameRejectedPdfOnDisk/);
  assert.match(source, /Never IOUtils\.remove the PDF/);
  assert.doesNotMatch(source, /AttachStoppedError\("review"/);
  // Detach Zotero link only — do not delete the persisted download.
  assert.match(source, /await opts\.attachment\.eraseTx\(\)/);
  assert.doesNotMatch(
    source,
    /await opts\.attachment\.eraseTx\(\);[\s\S]*?IOUtils\.remove\(opts\.persistedPath\)/,
  );
});

test("cleanupRejectedAttachment does not delete file when erase fails", async () => {
  let removed = false;
  let erased = false;
  async function cleanupRejectedAttachment(opts) {
    try {
      await opts.attachment.eraseTx();
      erased = true;
    } catch {
      return "erase-failed";
    }
    // Disk PDF is kept (rename happens before erase in production).
    void opts.persistedPath;
    void removed;
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
  assert.equal(removed, false);
  assert.equal(erased, true);
});
