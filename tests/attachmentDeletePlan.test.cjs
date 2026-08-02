// @ajan: cursor · @etiket: katman-2, b1-delete-att, test
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/utils/attachmentDeletePlan.ts"),
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

test("plans trash without unlinking when deleteLinkedFiles=false", () => {
  const {
    LINK_MODE_LINKED_FILE,
    planAttachmentDeletion,
    formatDeleteConfirmLines,
  } = loadModule();
  const plan = planAttachmentDeletion(
    [
      {
        attachmentId: 1,
        parentItemId: 10,
        linkMode: LINK_MODE_LINKED_FILE,
        path: "D:/lib/a.pdf",
        contentType: "application/pdf",
      },
      {
        attachmentId: 2,
        parentItemId: 10,
        linkMode: 1,
        path: "storage/b.pdf",
        contentType: "application/pdf",
      },
    ],
    { deleteLinkedFiles: false },
  );
  assert.deepEqual(plan.trashAttachmentIds, [1, 2]);
  assert.equal(plan.unlinkPaths.length, 0);
  assert.equal(plan.linkedFileCount, 1);
  const lines = formatDeleteConfirmLines(plan, { deleteLinkedFiles: false });
  assert.ok(lines.some((l) => l.includes("kept")));
});

test("plans disk unlink for linked files only", () => {
  const { LINK_MODE_LINKED_FILE, planAttachmentDeletion } = loadModule();
  const plan = planAttachmentDeletion(
    [
      {
        attachmentId: 1,
        parentItemId: 10,
        linkMode: LINK_MODE_LINKED_FILE,
        path: "D:/lib/a.pdf",
        contentType: "application/pdf",
      },
      {
        attachmentId: 1,
        parentItemId: 10,
        linkMode: LINK_MODE_LINKED_FILE,
        path: "D:/lib/a.pdf",
        contentType: "application/pdf",
      },
      {
        attachmentId: 3,
        parentItemId: 11,
        linkMode: 1,
        path: "storage/c.pdf",
        contentType: "application/pdf",
      },
    ],
    { deleteLinkedFiles: true },
  );
  assert.deepEqual(plan.trashAttachmentIds, [1, 3]);
  assert.deepEqual(plan.unlinkPaths, ["D:/lib/a.pdf"]);
  assert.equal(plan.linkedFileCount, 2);
  assert.equal(plan.otherAttachmentCount, 1);
});
