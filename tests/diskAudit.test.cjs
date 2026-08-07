// @ajan: cursor · @etiket: katman-2, disk-audit, test, apply, cross-folder-dupe, bridge-unavailable, dry-run-ux
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const root = process.cwd();

function loadDiskAudit() {
  const entry = path.join(root, "src/modules/diskAudit.ts");
  const src = fs.readFileSync(entry, "utf8");
  assert.match(src, /proposeAttangerRename/);
  assert.match(src, /classifyNameContentFromBridge/);
  assert.match(src, /groupCrossFolderDuplicates/);
  assert.match(src, /crossFolderUnlinkedLosers/);
  assert.match(src, /extractFilenameItemTypeTag/);
  assert.match(src, /filenameItemTypeMismatch/);
  assert.match(src, /bridge_unavailable/);
  assert.match(src, /runOrphanDiskAudit/);
  assert.match(src, /runNameContentDiskAudit/);
  assert.match(src, /runCopyDiskAudit/);
  assert.match(src, /listMultiAttachParents/);
  assert.match(src, /applyOrphanRemediation/);
  assert.match(src, /applyNameContentRenames/);
  assert.match(src, /applyCopyQuarantine/);
  assert.match(src, /fileContentFingerprint/);
  assert.match(src, /safeFilename/);
  assert.match(src, /safePathKey/);
  assert.match(src, /safeParent/);
  assert.match(src, /filesAreIdenticalCopies/);
  assert.match(src, /filterHashVerifiedLosers/);
  assert.match(src, /hashVerify/);
  assert.match(src, /openLastDiskAuditReport/);
  assert.match(src, /formatDiskAuditMarkdown/);
  assert.match(src, /last-\$\{kind\}\.md|last-\$\{fileKind\}\.md/);
  assert.match(src, /movePathToQuarantine/);
  assert.match(src, /isDiskAuditDryRun/);
  assert.match(src, /renameAttachmentFileSafe/);
  assert.match(src, /findAttachmentByAbsolutePath/);
  assert.match(src, /applyTargets/);
  assert.match(src, /crossFolder/);
  return src;
}

test("diskAudit module exports scan + apply surface", () => {
  const src = loadDiskAudit();
  assert.match(src, /applyOrphanRemediation/);
  assert.match(src, /_pdf_quarantine/);
  assert.match(src, /runDiskAuditApplyWithProgress/);
  assert.match(src, /## Ne yapmalı/);
  assert.match(src, /Kayıtsız PDF denetimi/);
});

test("proposeAttangerRename + classify helpers (inline)", () => {
  function proposeAttangerRename(
    currentName,
    contentTitle,
    contentAuthor,
    contentYear,
  ) {
    const title = String(contentTitle || "")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 4) return null;
    const author = (contentAuthor || "").split(/[;,]/)[0].trim() || "Unknown";
    const year = String(contentYear || "")
      .replace(/\D/g, "")
      .slice(0, 4);
    const yearPart = year.length === 4 ? ` (${year})` : "";
    let stem = `${author}${yearPart} ${title}`.replace(/\s+/g, " ").trim();
    stem = stem
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const proposed = `${stem}.pdf`;
    if (proposed.toLowerCase() === currentName.toLowerCase()) return null;
    return proposed;
  }
  function classifyNameContentFromBridge(result, opts) {
    if (!result) {
      if (opts && opts.bridgeAttempted === false) {
        return { class: "unverifiable", clearMismatch: false };
      }
      return { class: "bridge_unavailable", clearMismatch: false };
    }
    if (!result.verdict) {
      return { class: "unverifiable", clearMismatch: false };
    }
    const v = String(result.verdict).toLowerCase();
    if (v === "match" || v === "ok")
      return { class: "ok", clearMismatch: false };
    if (v === "weak" || v === "review")
      return { class: "weak", clearMismatch: false };
    if (v === "mismatch") {
      return {
        class: "mismatch",
        clearMismatch: Number(result.confidence || 0) >= 0.75,
      };
    }
    return { class: "unverifiable", clearMismatch: false };
  }

  assert.equal(
    proposeAttangerRename("bad.pdf", "Küçük prens", "Saint Exupéry", "2016"),
    "Saint Exupéry (2016) Küçük prens.pdf",
  );
  assert.equal(
    classifyNameContentFromBridge({ verdict: "mismatch", confidence: 0.9 })
      .clearMismatch,
    true,
  );
  assert.equal(
    classifyNameContentFromBridge({ verdict: "mismatch", confidence: 0.2 })
      .clearMismatch,
    false,
  );
  assert.equal(classifyNameContentFromBridge({ verdict: "match" }).class, "ok");
  assert.equal(classifyNameContentFromBridge(null).class, "bridge_unavailable");
  assert.equal(
    classifyNameContentFromBridge(null, { bridgeAttempted: false }).class,
    "unverifiable",
  );
});

test("groupCrossFolderDuplicates + losers + filename itemType tag", () => {
  function groupCrossFolderDuplicates(files) {
    const map = new Map();
    for (const f of files) {
      if (!f?.path || !f.basename || !(f.size > 0)) continue;
      const key = `${String(f.basename).toLowerCase()}|${f.size}`;
      const list = map.get(key) || [];
      list.push(f);
      map.set(key, list);
    }
    const out = [];
    for (const list of map.values()) {
      if (list.length < 2) continue;
      const dirs = Array.from(new Set(list.map((x) => x.dir)));
      if (dirs.length < 2) continue;
      out.push({
        basename: list[0].basename,
        size: list[0].size,
        paths: list.map((x) => x.path),
        dirs,
      });
    }
    return out;
  }
  function crossFolderUnlinkedLosers(groups, referenced, normalizePath) {
    const losers = [];
    for (const g of groups) {
      const linked = [];
      const unlinked = [];
      for (const p of g.paths) {
        if (referenced.has(normalizePath(p))) linked.push(p);
        else unlinked.push(p);
      }
      if (linked.length >= 1 && unlinked.length >= 1) {
        for (const p of unlinked) losers.push(p);
      }
    }
    return losers;
  }
  function extractFilenameItemTypeTag(filename) {
    const m = String(filename || "").match(
      /\[(book|journalArticle|thesis|bookSection|conferencePaper|report|document|webpage|newspaperArticle|magazineArticle|preprint|manuscript)\]/i,
    );
    return m ? m[1] : null;
  }
  function filenameItemTypeMismatch(zoteroItemType, filename) {
    const tag = extractFilenameItemTypeTag(filename);
    if (!tag || !zoteroItemType) return { mismatch: false, filenameType: tag };
    return {
      mismatch: tag.toLowerCase() !== String(zoteroItemType).toLowerCase(),
      filenameType: tag,
    };
  }

  const files = [
    {
      path: "D:/a/Book.pdf",
      basename: "Book.pdf",
      size: 100,
      dir: "D:/a",
    },
    {
      path: "D:/b/Book.pdf",
      basename: "Book.pdf",
      size: 100,
      dir: "D:/b",
    },
    {
      path: "D:/a/Other.pdf",
      basename: "Other.pdf",
      size: 50,
      dir: "D:/a",
    },
    {
      path: "D:/a/Book.pdf",
      basename: "Book.pdf",
      size: 999,
      dir: "D:/a",
    },
  ];
  const groups = groupCrossFolderDuplicates(files);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].paths.length, 2);
  const norm = (p) => p.toLowerCase();
  const referenced = new Set(["d:/a/book.pdf"]);
  const losers = crossFolderUnlinkedLosers(groups, referenced, norm);
  assert.deepEqual(losers, ["D:/b/Book.pdf"]);

  assert.equal(
    extractFilenameItemTypeTag("X (2020) Title [book] Pub.pdf"),
    "book",
  );
  assert.equal(
    filenameItemTypeMismatch("book", "X (2020) Title [journalArticle] Pub.pdf")
      .mismatch,
    true,
  );
  assert.equal(
    filenameItemTypeMismatch("book", "X (2020) Title [book] Pub.pdf").mismatch,
    false,
  );
});

test("clear_mismatch rename filter keeps only proposed rows", () => {
  const rows = [
    { path: "a.pdf", proposed_rename: "A.pdf", clear_mismatch: true },
    { path: "b.pdf", proposed_rename: null, clear_mismatch: true },
    { path: "c.pdf", proposed_rename: "C.pdf", clear_mismatch: false },
  ].filter((r) => r?.path && r?.proposed_rename && r.clear_mismatch !== false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "a.pdf");
});

test("prefs + xhtml wire disk audit scan/open/apply + automation split", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  assert.match(prefs, /pdf\.diskAudit\.dryRun/);
  assert.match(prefs, /pdf\.diskAudit\.copyAction", "quarantine"/);
  assert.match(prefs, /pdf\.dirzonEnabled/);
  const xhtml = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /pdf-disk-audit-orphan/);
  assert.match(xhtml, /pdf-disk-audit-orphan-apply/);
  assert.match(xhtml, /pdf-disk-audit-name-apply/);
  assert.match(xhtml, /pdf-disk-audit-copy-apply/);
  assert.match(xhtml, /pdf-disk-audit-orphan-open/);
  assert.match(xhtml, /pdf-automation-title/);
  assert.doesNotMatch(xhtml, /pdf-disk-audit-apply-disabled/);
  assert.doesNotMatch(
    xhtml,
    /id="pdf-disk-audit-dry-run"[\s\S]*?disabled="true"/,
  );
  const script = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );
  assert.match(script, /runDiskAuditWithProgress\("orphan"\)/);
  assert.match(script, /runDiskAuditApplyWithProgress\("orphan"\)/);
  assert.match(script, /openLastDiskAuditReport\("nameContent"\)/);
  assert.match(script, /syncDiskAuditApplyButtonLabels/);
  for (const loc of ["en-US", "de", "it-IT", "tr-TR"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", loc, "preferences.ftl"),
      "utf8",
    );
    assert.match(ftl, /pdf-disk-audit-title/);
    assert.match(ftl, /pdf-disk-audit-orphan-apply/);
    assert.match(ftl, /pdf-disk-audit-name-apply/);
    assert.match(ftl, /pdf-disk-audit-copy-apply/);
    assert.match(ftl, /pdf-disk-audit-plan-write/);
    assert.match(ftl, /pdf-automation-title/);
    assert.match(ftl, /pdf-disk-audit-flow-help/);
    assert.doesNotMatch(ftl, /pdf-disk-audit-apply-disabled/);
  }
});
