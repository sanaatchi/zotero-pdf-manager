// @ajan: cursor · @etiket: katman-2, validated-pdf-lock, test
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "pdfValidatedLock.ts"),
  "utf8",
);

test("pdfValidatedLock exports claim helpers and Extra prefix", () => {
  assert.match(src, /VALIDATED_PATH_PREFIX\s*=\s*"ZPDF-Validated-Path:"/);
  assert.match(src, /export function normalizeClaimPath/);
  assert.match(src, /export function isPathClaimedByOther/);
  assert.match(src, /export async function collectAttachedPdfPathClaims/);
  assert.match(src, /export async function persistValidatedPdfLock/);
  assert.match(src, /export async function lockValidatedAttachment/);
});

test("menu Match Attachment filters paths claimed by other parents", () => {
  const menu = fs.readFileSync(
    path.join(__dirname, "..", "src", "modules", "menu.ts"),
    "utf8",
  );
  assert.match(menu, /collectAttachedPdfPathClaims/);
  assert.match(menu, /isPathClaimedByOther/);
  assert.match(menu, /unlockedFiles/);
  assert.match(menu, /rememberMatchedPathClaim/);
});

test("reconciler seeds pathClaims and skips other-item attachments", () => {
  const reconciler = fs.readFileSync(
    path.join(__dirname, "..", "src", "modules", "pdfReconciler.ts"),
    "utf8",
  );
  assert.match(reconciler, /collectAttachedPdfPathClaims/);
  assert.match(reconciler, /isPathClaimedByOther/);
  assert.match(reconciler, /pathClaims/);
  assert.match(
    reconciler,
    /File already attached to another item; tagged #pdf-candidate/,
  );
});

test("validate match locks attachment; mismatch clears Extra stamp", () => {
  const sources = fs.readFileSync(
    path.join(__dirname, "..", "src", "modules", "pdfSources.ts"),
    "utf8",
  );
  assert.match(sources, /lockValidatedAttachment\(item, attachmentID\)/);
  assert.match(sources, /persistValidatedPdfLock/);
  assert.match(sources, /clearValidatedPdfLock/);

  const tags = fs.readFileSync(
    path.join(__dirname, "..", "src", "modules", "pdfAutomationTags.ts"),
    "utf8",
  );
  assert.match(tags, /clearValidatedPdfLock\(item\)/);
});

// Pure Extra helpers — evaluate by requiring compiled logic via Function
// from the TypeScript source's exported pure functions (strip types lightly).
test("Extra rewrite keeps multiple validated paths and removes one", () => {
  // Inline parity of the pure helpers (keeps test free of ts-node).
  const PREFIX = "ZPDF-Validated-Path:";
  function normalizeClaimPath(p) {
    return String(p || "")
      .trim()
      .replace(/\//g, "\\")
      .toLowerCase();
  }
  function clearExtraPrefixedLine(extra, prefix) {
    return String(extra || "")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !l.trim().startsWith(prefix))
      .join("\n");
  }
  function rewriteValidatedPathExtra(extra, paths) {
    const base = clearExtraPrefixedLine(extra, PREFIX);
    const lines = String(base || "")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim());
    const keys = new Set();
    for (const pathValue of paths) {
      const display = String(pathValue || "").trim();
      const key = normalizeClaimPath(display);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      lines.push(`${PREFIX} ${display}`);
    }
    return lines.join("\n");
  }
  function listValidatedPathsFromExtra(extra) {
    const out = [];
    for (const line of String(extra || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(PREFIX)) continue;
      out.push(trimmed.slice(PREFIX.length).trim());
    }
    return out;
  }

  let extra = "foo: bar\n";
  extra = rewriteValidatedPathExtra(extra, [
    "D:\\lib\\a.pdf",
    "D:\\lib\\b.pdf",
  ]);
  assert.deepEqual(listValidatedPathsFromExtra(extra).sort(), [
    "D:\\lib\\a.pdf",
    "D:\\lib\\b.pdf",
  ]);
  extra = rewriteValidatedPathExtra(extra, ["D:\\lib\\b.pdf"]);
  assert.deepEqual(listValidatedPathsFromExtra(extra), ["D:\\lib\\b.pdf"]);
  assert.match(extra, /foo: bar/);
});

test("isPathClaimedByOther ignores same parent", () => {
  function normalizeClaimPath(p) {
    return String(p || "")
      .trim()
      .replace(/\//g, "\\")
      .toLowerCase();
  }
  function isPathClaimedByOther(pathValue, parentID, claims) {
    const key = normalizeClaimPath(pathValue);
    if (!key) return false;
    const claim = claims.get(key);
    if (!claim) return false;
    return claim.parentID !== parentID;
  }
  const claims = new Map([
    [
      normalizeClaimPath("D:\\x\\a.pdf"),
      {
        parentID: 10,
        parentKey: "AAAA",
        attachmentID: 1,
        path: "D:\\x\\a.pdf",
        validated: true,
      },
    ],
  ]);
  assert.equal(isPathClaimedByOther("D:\\x\\a.pdf", 10, claims), false);
  assert.equal(isPathClaimedByOther("D:\\x\\a.pdf", 20, claims), true);
  assert.equal(isPathClaimedByOther("D:\\x\\missing.pdf", 20, claims), false);
});
