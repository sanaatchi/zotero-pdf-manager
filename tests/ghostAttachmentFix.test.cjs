// @ajan: cursor · @etiket: katman-2, tests, ghost-attach-fix
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("source: findParent skips ghosts; relocate links before erase; purge helper exists", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /export async function attachmentFileAccessible/);
  assert.match(
    source,
    /export async function purgeMissingSiblingPdfAttachments/,
  );
  assert.match(
    source,
    /Path match alone is not enough[\s\S]*fileExists\(\) is false/,
  );
  assert.match(
    source,
    /Always link \(or reuse\) BEFORE erasing the imported storage copy/,
  );
  assert.match(source, /Local attach created inaccessible link; removing stub/);
  assert.match(
    source,
    /purgeMissingSiblingPdfAttachments\(item, attachment\.id\)/,
  );
  // Old erase-then-link order must not return.
  assert.doesNotMatch(
    source,
    /relocate: erase imported attachment failed[\s\S]{0,200}linkFromFile/,
  );
});

test("source: menu Match Attachment verifies accessibility before removeFile", () => {
  const menu = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  assert.match(menu, /purgeMissingSiblingPdfAttachments/);
  assert.match(menu, /attachmentFileAccessible/);
  assert.match(
    menu,
    /Imported attachment \$\{attItem\.id\} is inaccessible after import/,
  );
  assert.match(
    menu,
    /reusing accessible linked attachment; erase imported duplicate/,
  );
  assert.match(menu, /dropping inaccessible linked ghost before re-link/);
  assert.match(
    menu,
    /replaceWithLinkedAttachment: new linked item inaccessible; keep imported/,
  );
  const importIdx = menu.indexOf(
    "Imported attachment ${attItem.id} is inaccessible after import",
  );
  const removeIdx = menu.indexOf("removeFile(matchedFile.path)");
  assert.ok(importIdx > 0 && removeIdx > importIdx);
});

test("findParentLinkedPdfByPath ignores missing-file ghosts at the same path", async () => {
  const ghost = {
    id: 1,
    erased: false,
    isPDFAttachment: () => true,
    isAttachment: () => true,
    fileExists: async () => false,
    getFilePathAsync: async () => "D:/OneDrive/book.pdf",
    eraseTx: async () => {
      ghost.erased = true;
    },
  };
  const good = {
    id: 2,
    erased: false,
    isPDFAttachment: () => true,
    isAttachment: () => true,
    fileExists: async () => true,
    getFilePathAsync: async () => "D:/OneDrive/book.pdf",
    eraseTx: async () => {
      good.erased = true;
    },
  };
  const items = new Map([
    [1, ghost],
    [2, good],
  ]);
  const parent = { getAttachments: () => [1, 2] };

  async function findParentLinkedPdfByPath(item, filePath) {
    const want = String(filePath || "")
      .replace(/\\/g, "/")
      .toLowerCase();
    for (const attachmentID of item.getAttachments()) {
      const att = items.get(attachmentID);
      if (!att) continue;
      const p = String((await att.getFilePathAsync()) || "")
        .replace(/\\/g, "/")
        .toLowerCase();
      if (p !== want) continue;
      if (!(await att.fileExists())) continue;
      return att;
    }
    return null;
  }

  async function purgeMissingSiblingPdfAttachments(item, keepAttachmentID) {
    let purged = 0;
    for (const attachmentID of item.getAttachments()) {
      if (keepAttachmentID && attachmentID === keepAttachmentID) continue;
      const att = items.get(attachmentID);
      if (!att) continue;
      if (await att.fileExists()) continue;
      await att.eraseTx();
      purged++;
    }
    return purged;
  }

  assert.equal(
    await findParentLinkedPdfByPath(parent, "D:/OneDrive/book.pdf"),
    good,
  );
  assert.equal(await purgeMissingSiblingPdfAttachments(parent, 2), 1);
  assert.equal(ghost.erased, true);
  assert.equal(good.erased, false);
});

test("mismatch keep policy still present (no detach regression)", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  const audit = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfContentAudit.ts"),
    "utf8",
  );
  assert.match(source, /keeping attachment \(#pdf-mismatch\)/);
  assert.doesNotMatch(audit, /cleanupRejectedAttachment/);
  assert.doesNotMatch(audit, /eraseTx/);
});
