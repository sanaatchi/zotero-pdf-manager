// @ajan: cursor · @etiket: katman-2, tests, mismatch-rematch
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("Match Attachment / reconciler / skip gates allow #pdf-mismatch rematch", () => {
  const menu = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  const download = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfDownload.ts"),
    "utf8",
  );
  const reconciler = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfReconciler.ts"),
    "utf8",
  );

  assert.match(menu, /itemHasPdfMismatchTag\(item\)/);
  assert.match(menu, /resolveMatchAttachmentSearchRoots/);
  assert.match(menu, /isPathUnderRoot\(matchedFile\.path, inboxRoot\)/);
  assert.match(menu, /resolveOaDownloadsDir\(getWatchRoots\(\)\)/);

  assert.match(download, /if \(itemHasPdfMismatchTag\(item\)\) return false/);

  assert.match(reconciler, /hasTag\?\.\("#pdf-mismatch"\)/);
});
