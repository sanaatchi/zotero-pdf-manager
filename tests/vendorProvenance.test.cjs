const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = process.cwd();

const PINNED = [
  {
    name: "attachment-scanner",
    sha: "bd64d535edb265a336bbdeb661fd4cd896aacf22",
    spdx: "MIT",
  },
  {
    name: "zotmoov",
    sha: "8fb20ab8baebe6976b2a281b40bc48910bc3ca62",
    spdx: "GPL-3.0",
  },
  {
    name: "watch-folder",
    sha: "07068206dce23a4ad261c208734d318078108425",
    spdx: "GPL-3.0",
  },
  {
    name: "attanger",
    sha: "a1f98bfab1dc487ee84fdd9d2533d20596d4aea1",
    spdx: "AGPL-3.0",
  },
  {
    name: "zotadata",
    sha: "ad1a8143ae48ea2750fa5bd647921c529a4b17a7",
    spdx: "AGPL",
  },
  {
    name: "format-metadata",
    sha: "39db0a31f5848329d2c34ffe3470bbcabb3ffc34",
    spdx: "AGPL",
  },
  {
    name: "delitemwithatt",
    sha: "d2eaeedb40619f4d2fbe0b7b615016c01e85bdbd",
    spdx: "GPL-3.0",
  },
];

test("vendor table pins full SHAs and notices echo them", () => {
  const vendor = fs.readFileSync(
    path.join(root, "PDFMANAGER-VENDOR.md"),
    "utf8",
  );
  const notices = fs.readFileSync(
    path.join(root, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );

  assert.match(vendor, /Pinned SHA/);
  assert.match(vendor, /MAX_INDEX_FILES = 99999/);
  assert.match(notices, /PDFMANAGER-VENDOR\.md/);

  for (const entry of PINNED) {
    assert.match(
      vendor,
      new RegExp(entry.sha),
      `vendor missing SHA for ${entry.name}`,
    );
    assert.match(
      notices,
      new RegExp(entry.sha),
      `notices missing SHA for ${entry.name}`,
    );
  }

  assert.match(vendor, /SPDX/);
  assert.match(vendor, /attachmentScanner\.ts/);
  assert.match(vendor, /folderIndex\.ts/);
  assert.match(vendor, /pdfReconciler\.ts/);
  assert.match(vendor, /oaDownloadPath\.ts/);
  assert.match(vendor, /metadataNormalize\.ts/);
  assert.match(vendor, /attachmentDelete\.ts/);
});

test("prefs expose libraryBatchSize for scale scans", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  assert.match(prefs, /pdf\.libraryBatchSize", 250/);
});
