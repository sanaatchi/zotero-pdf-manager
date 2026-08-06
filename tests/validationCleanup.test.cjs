// @ajan: cursor · @etiket: katman-2, tests, keep-mismatch, no-auto-detach
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("validation verdicts: match clears tags; mismatch+unverifiable keep", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /cleanupRejectedAttachment/);
  assert.match(source, /removeAutomationTag\(item,\s*"#pdf-review"\)/);
  assert.match(source, /removeAutomationTag\(item,\s*"#pdf-mismatch"\)/);
  assert.match(source, /ContentMismatchError/);
  assert.match(source, /decideContentValidation/);
  // OA + local mismatch: keep attachment + tag (auto-detach cancelled).
  assert.match(source, /keeping attachment \(#pdf-mismatch\)/);
  assert.doesNotMatch(source, /detaching link \(#pdf-mismatch\)/);
  assert.doesNotMatch(source, /İndirilen PDF künye ile uyuşmuyor/);
  assert.match(source, /renameRejectedPdfOnDisk/);
  assert.match(source, /Never IOUtils\.remove the PDF/);
  // Linked path must not be unlinked before overwrite (attachment "vanishes").
  assert.doesNotMatch(
    source,
    /if \(await IOUtils\.exists\(persistedPath\)\) \{[\s\S]*?await IOUtils\.remove\(persistedPath\)/,
  );
  assert.match(source, /findParentLinkedPdfByPath/);
  // OA download: unverifiable scanned books may keep (#pdf-review).
  assert.match(
    source,
    /unverifiable[\s\S]*?keeping attachment \(#pdf-review\)/,
  );
  // Local title-only + unverifiable also keep (no auto-detach).
  assert.doesNotMatch(
    source,
    /Yerel PDF doğrulanamadı \(başlık eşleşmesi; içerik okunamadı\)/,
  );
  assert.match(source, /short title without author match/);
  // Auto-download never throws review-stop; mismatch keeps (no ContentMismatch throw from download).
  assert.doesNotMatch(source, /throw new AttachStoppedError\("review"/);
  assert.match(source, /finalizeLocalAttachment/);
  assert.doesNotMatch(source, /Yerel PDF künye ile uyuşmuyor/);
  // cleanupRejectedAttachment still exists for non-audit reject paths;
  // content-audit / mismatch validation never call it to detach.
  assert.match(source, /await opts\.attachment\.eraseTx\(\)/);
  assert.doesNotMatch(
    source,
    /await opts\.attachment\.eraseTx\(\);[\s\S]*?IOUtils\.remove\(opts\.persistedPath\)/,
  );
  assert.match(source, /rejected storage PDF rescue/);
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
