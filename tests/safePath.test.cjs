// @ajan: cursor · @etiket: katman-2, pathutils-safe, test
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

/**
 * Mirror of src/utils/safePath.ts (JS) with a PathUtils stub that throws
 * NS_ERROR_FILE_UNRECOGNIZED_PATH on attachments:/empty/relative — same class
 * as the bidir crash. Keep in lockstep with the TS helpers.
 */
function makeSafePathHelpers() {
  const PathUtils = {
    filename(p) {
      const s = String(p || "");
      if (
        !s ||
        s.startsWith("attachments:") ||
        (!/^[a-zA-Z]:[\\/]/.test(s) && !s.startsWith("\\\\"))
      ) {
        throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
      }
      const parts = s.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1] || "";
    },
    normalize(p) {
      const s = String(p || "");
      if (
        !s ||
        s.startsWith("attachments:") ||
        (!/^[a-zA-Z]:[\\/]/.test(s) && !s.startsWith("\\\\"))
      ) {
        throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
      }
      return s.replace(/\//g, "\\");
    },
    parent(p) {
      const s = String(p || "");
      if (
        !s ||
        s.startsWith("attachments:") ||
        (!/^[a-zA-Z]:[\\/]/.test(s) && !s.startsWith("\\\\"))
      ) {
        throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
      }
      const norm = s.replace(/\\/g, "/");
      const i = norm.lastIndexOf("/");
      return i > 0 ? norm.slice(0, i).replace(/\//g, "\\") : null;
    },
  };

  function safeFilename(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    const stripped = raw.replace(/^attachments:/i, "");
    try {
      if (/^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith("\\\\")) {
        return String(PathUtils.filename(stripped) || "");
      }
    } catch {
      /* fall through */
    }
    const parts = stripped.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || stripped || raw;
  }

  function safePathKey(p) {
    const raw = String(p || "").trim();
    if (!raw) return "";
    try {
      if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
        return PathUtils.normalize(raw).normalize("NFC").toLowerCase();
      }
    } catch {
      /* fall through */
    }
    return raw.normalize("NFC").toLowerCase().replace(/\\/g, "/");
  }

  function safeNormalize(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    try {
      if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
        return String(PathUtils.normalize(raw) || raw);
      }
    } catch {
      /* fall through */
    }
    return raw.replace(/\\/g, "/");
  }

  function safeParent(path) {
    const raw = String(path || "").trim();
    if (!raw) return null;
    try {
      if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
        return PathUtils.parent?.(raw) || null;
      }
    } catch {
      /* fall through */
    }
    const norm = raw.replace(/\\/g, "/");
    const i = norm.lastIndexOf("/");
    return i > 0 ? norm.slice(0, i) : null;
  }

  return { safeFilename, safePathKey, safeNormalize, safeParent };
}

test("safePath.ts exports safeFilename/safePathKey/safeParent/safeNormalize", () => {
  const src = fs.readFileSync(path.join(root, "src/utils/safePath.ts"), "utf8");
  assert.match(src, /export function safeFilename/);
  assert.match(src, /export function safePathKey/);
  assert.match(src, /export function safeParent/);
  assert.match(src, /export function safeNormalize/);
  assert.match(src, /NS_ERROR_FILE_UNRECOGNIZED_PATH|attachments:/);
});

test("diskAudit and bidirectionalAudit re-export from safePath", () => {
  const disk = fs.readFileSync(
    path.join(root, "src/modules/diskAudit.ts"),
    "utf8",
  );
  const bidir = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  assert.match(disk, /from ["']\.\.\/utils\/safePath["']/);
  assert.match(bidir, /from ["']\.\.\/utils\/safePath["']/);
  assert.match(disk, /export \{[^}]*safeFilename/);
  assert.match(bidir, /export \{[^}]*safeFilename/);
});

test("menu.ts uses safe helpers on match/rename attachment paths", () => {
  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  assert.match(menu, /from ["']\.\.\/utils\/safePath["']/);
  assert.match(menu, /safeFilename/);
  assert.match(menu, /safePathKey/);
  assert.match(menu, /safeParent/);
  const live = menu
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join("\n");
  assert.doesNotMatch(live, /PathUtils\.filename\s*\(/);
  assert.doesNotMatch(live, /PathUtils\.normalize\s*\(/);
  assert.doesNotMatch(live, /PathUtils\.parent\s*\(/);
  // B8 residual: getAttachmentFilenameNoExt / renameFileInternal must not
  // use raw PathUtils.split(...).pop() — prefer safeFilename.
  assert.doesNotMatch(live, /PathUtils\.split\s*\(/);
  assert.match(
    menu,
    /async function getAttachmentFilenameNoExt[\s\S]*?safeFilename\s*\(/,
  );
  assert.match(
    menu,
    /async function renameFileInternal[\s\S]*?safeFilename\s*\(/,
  );
});

test("safeFilename never throws on attachments:/empty/relative", () => {
  const { safeFilename } = makeSafePathHelpers();
  assert.equal(safeFilename(""), "");
  assert.equal(safeFilename("attachments:foo/bar.pdf"), "bar.pdf");
  assert.equal(safeFilename("relative/path.pdf"), "path.pdf");
  assert.equal(safeFilename("D:/a/b.pdf"), "b.pdf");
  assert.equal(
    safeFilename("attachments:Emrali (2010) x.pdf"),
    "Emrali (2010) x.pdf",
  );
});

test("safePathKey never throws on attachments:/empty/relative", () => {
  const { safePathKey } = makeSafePathHelpers();
  assert.equal(safePathKey(""), "");
  assert.equal(safePathKey("attachments:foo"), "attachments:foo");
  assert.equal(safePathKey("relative/path.pdf"), "relative/path.pdf");
  assert.ok(safePathKey("D:/A/B.PDF").endsWith("b.pdf"));
  assert.equal(safePathKey("D:/A/B.PDF"), safePathKey("D:\\A\\B.PDF"));
});

test("safeParent never throws on attachments:/empty/relative", () => {
  const { safeParent } = makeSafePathHelpers();
  assert.equal(safeParent(""), null);
  assert.equal(safeParent("attachments:foo/bar.pdf"), "attachments:foo");
  assert.equal(safeParent("relative/path.pdf"), "relative");
  assert.ok(safeParent("D:/a/b.pdf"));
});

test("safeNormalize never throws on attachments:/empty/relative", () => {
  const { safeNormalize } = makeSafePathHelpers();
  assert.equal(safeNormalize(""), "");
  assert.equal(safeNormalize("attachments:foo"), "attachments:foo");
  assert.equal(safeNormalize("relative/path.pdf"), "relative/path.pdf");
  assert.ok(safeNormalize("D:/a/b.pdf"));
});
