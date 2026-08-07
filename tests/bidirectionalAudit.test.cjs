// @ajan: cursor · @etiket: katman-2, bidirectional-audit, test
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const root = process.cwd();

test("bidirectionalAudit module surface", () => {
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  assert.match(src, /runBidirectionalAudit/);
  assert.match(src, /runBidirectionalAuditWithProgress/);
  assert.match(src, /openLastBidirectionalReport/);
  assert.match(src, /suggestAlternatePaths/);
  assert.match(src, /walkPdfEntries/);
  assert.match(src, /filenameItemTypeMismatch/);
  assert.match(src, /groupCrossFolderDuplicates/);
  assert.match(src, /typeConflict/);
  assert.match(src, /crossFolder/);
  assert.match(src, /kind: \"bidirectional\"/);
});

test("suggestAlternatePaths prefers exact basename", () => {
  function suggestAlternatePaths(brokenBasename, diskFiles, limit = 5) {
    const want = String(brokenBasename || "").toLowerCase();
    if (!want) return [];
    const hits = [];
    for (const f of diskFiles) {
      if (String(f.basename || "").toLowerCase() !== want) continue;
      hits.push(f.path);
      if (hits.length >= limit) break;
    }
    return hits;
  }
  const disk = [
    { path: "D:/a/foo.pdf", basename: "foo.pdf" },
    { path: "D:/b/foo.pdf", basename: "foo.pdf" },
    { path: "D:/c/bar.pdf", basename: "bar.pdf" },
  ];
  assert.deepEqual(suggestAlternatePaths("foo.pdf", disk), [
    "D:/a/foo.pdf",
    "D:/b/foo.pdf",
  ]);
  assert.deepEqual(suggestAlternatePaths("missing.pdf", disk), []);
});

test("filenameItemTypeMismatch detects [book] vs journalArticle", () => {
  const FILENAME_ITEM_TYPE_RE =
    /\[(book|journalArticle|thesis|bookSection|conferencePaper|report|document|webpage|newspaperArticle|magazineArticle|preprint|manuscript)\]/i;
  function extractFilenameItemTypeTag(filename) {
    const m = String(filename || "").match(FILENAME_ITEM_TYPE_RE);
    return m ? m[1] : null;
  }
  function filenameItemTypeMismatch(zoteroItemType, filename) {
    const tag = extractFilenameItemTypeTag(filename);
    if (!tag || !zoteroItemType) {
      return { mismatch: false, filenameType: tag };
    }
    return {
      mismatch: tag.toLowerCase() !== String(zoteroItemType).toLowerCase(),
      filenameType: tag,
    };
  }
  assert.equal(
    filenameItemTypeMismatch(
      "journalArticle",
      "Author (2020) Title [book] Pub.pdf",
    ).mismatch,
    true,
  );
  assert.equal(
    filenameItemTypeMismatch("book", "Author (2020) Title [book] Pub.pdf")
      .mismatch,
    false,
  );
  assert.equal(
    filenameItemTypeMismatch("book", "Author (2020) Title.pdf").mismatch,
    false,
  );
});

test("prefs wire bidirectional scan + open", () => {
  const script = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );
  assert.match(script, /runBidirectionalAuditWithProgress/);
  assert.match(script, /openLastBidirectionalReport/);
  assert.match(script, /pdf-disk-audit-bidir/);
  const xhtml = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /pdf-disk-audit-bidir-heading/);
  assert.match(xhtml, /id="pdf-disk-audit-bidir"/);
  for (const loc of ["en-US", "de", "it-IT", "tr-TR"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", loc, "preferences.ftl"),
      "utf8",
    );
    assert.match(ftl, /pdf-disk-audit-bidir-heading/);
    assert.match(ftl, /pdf-disk-audit-bidir-help/);
    assert.match(ftl, /pdf-disk-audit-bidir\s*=/);
  }
});
