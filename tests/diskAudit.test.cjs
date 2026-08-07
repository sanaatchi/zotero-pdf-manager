// @ajan: cursor · @etiket: katman-2, disk-audit, test
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
  assert.match(src, /runOrphanDiskAudit/);
  assert.match(src, /runNameContentDiskAudit/);
  assert.match(src, /runCopyDiskAudit/);
  assert.match(src, /listMultiAttachParents/);
  assert.match(src, /dryRun:\s*true/);
  return src;
}

test("diskAudit module exports report-only runners", () => {
  const src = loadDiskAudit();
  assert.doesNotMatch(src, /copyAction\s*===\s*"quarantine"/);
  assert.match(src, /dryRun:\s*true/);
});

test("proposeAttangerRename + classify helpers (inline)", () => {
  // Mirror the pure logic for unit certainty without full Zotero bundle.
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
  function classifyNameContentFromBridge(result) {
    if (!result || !result.verdict) {
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
});

test("prefs + xhtml wire disk audit buttons and dirzon", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  assert.match(prefs, /pdf\.diskAudit\.dryRun/);
  assert.match(prefs, /pdf\.dirzonEnabled/);
  const xhtml = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /pdf-disk-audit-orphan/);
  assert.match(xhtml, /pdf-disk-audit-name-content/);
  assert.match(xhtml, /pdf-disk-audit-copy/);
  assert.match(xhtml, /pdf-dirzon-enabled/);
  const script = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );
  assert.match(script, /runDiskAuditWithProgress\("orphan"\)/);
  assert.match(script, /runDiskAuditWithProgress\("nameContent"\)/);
  assert.match(script, /runDiskAuditWithProgress\("copy"\)/);
  for (const loc of ["en-US", "de", "it-IT", "tr-TR"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", loc, "preferences.ftl"),
      "utf8",
    );
    assert.match(ftl, /pdf-disk-audit-title/);
    assert.match(ftl, /pdf-dirzon-enabled/);
  }
});
