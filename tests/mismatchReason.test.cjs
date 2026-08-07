// @ajan: cursor · @etiket: katman-2, tests, pdf-mismatch, mismatch-reason, mismatch-note-clear
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadSources() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfSources.ts")],
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

function loadTags() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfAutomationTags.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["./automationAudit", "./pdfAutomationTagGuard"],
  });
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    "require",
    "ztoolkit",
    result.outputFiles[0].text,
  )(
    module,
    module.exports,
    (id) => {
      if (id.includes("automationAudit")) {
        return { appendAuditEvent: () => Promise.resolve() };
      }
      if (id.includes("pdfAutomationTagGuard")) {
        return { shouldSuppressPassiveMismatchTag: () => false };
      }
      throw new Error(id);
    },
    { log: () => {} },
  );
  return module.exports;
}

test("formatContentValidationReason: weak book title explains mismatch", () => {
  const { formatContentValidationReason } = loadSources();
  const reason = formatContentValidationReason({
    verdict: "mismatch",
    kind: "book",
    textChars: 2000,
    titleHit: 0.2,
    score: 0.2,
    hasIdConflict: false,
    hasIdMatch: false,
    authorExpected: true,
    authorFound: true,
  });
  assert.match(reason, /book: title\/score below match threshold/);
  assert.match(reason, /titleHit=0\.20/);
  assert.match(reason, /score=0\.20/);
});

test("formatContentValidationReason: bridge reason preferred when forced", () => {
  const { formatContentValidationReason } = loadSources();
  const reason = formatContentValidationReason({
    verdict: "mismatch",
    kind: "book",
    textChars: 2000,
    titleHit: 0.4,
    score: 0.4,
    hasIdConflict: false,
    hasIdMatch: false,
    authorExpected: true,
    authorFound: false,
    bridgeForcedMismatch: true,
    bridgeVia: "heuristic-book-article",
    bridgeReason: "PDF makale/başka eser — kitap künyesiyle uyuşmuyor",
  });
  assert.match(reason, /bridge\(heuristic-book-article\)/);
  assert.match(reason, /PDF makale/);
});

test("formatContentValidationReason: unverifiable surfaces OCR-fallback bridge reason", () => {
  const { formatContentValidationReason } = loadSources();
  const reason = formatContentValidationReason({
    verdict: "unverifiable",
    kind: "book",
    textChars: 2000,
    titleHit: 0,
    score: 0,
    hasIdConflict: false,
    hasIdMatch: false,
    authorExpected: true,
    authorFound: false,
    bridgeVia: "encoding-gate-no-ocr",
    bridgeReason: "encoding-garbled; OCR unavailable (tesseract/pymupdf yok)",
    encodingUnreliable: true,
  });
  assert.match(reason, /bridge\(encoding-gate-no-ocr\)/);
  assert.match(reason, /OCR unavailable/);
});

test("formatContentValidationReason: unverifiable without bridge reason keeps generic text", () => {
  const { formatContentValidationReason } = loadSources();
  const reason = formatContentValidationReason({
    verdict: "unverifiable",
    kind: "book",
    textChars: 2000,
    titleHit: 0.2,
    score: 0.2,
    hasIdConflict: false,
    hasIdMatch: false,
    authorExpected: true,
    authorFound: false,
  });
  assert.match(reason, /^unverifiable: titleHit=0\.20/);
});

test("Extra mismatch reason upsert/clear round-trip", () => {
  const {
    MISMATCH_REASON_PREFIX,
    upsertExtraPrefixedLine,
    clearExtraPrefixedLine,
  } = loadTags();
  const base = "DOI: 10.1/x\nZPDF-Source-Path: D:\\a.pdf";
  const withReason = upsertExtraPrefixedLine(
    base,
    MISMATCH_REASON_PREFIX,
    "book: title/score below match threshold | titleHit=0.20 score=0.20 author=yes",
  );
  assert.match(withReason, /ZPDF-Mismatch-Reason:/);
  assert.match(withReason, /ZPDF-Source-Path:/);
  const cleared = clearExtraPrefixedLine(withReason, MISMATCH_REASON_PREFIX);
  assert.equal(cleared.includes("ZPDF-Mismatch-Reason:"), false);
  assert.match(cleared, /ZPDF-Source-Path:/);
});

test("clearMismatchExtraLines drops Reason and Note, keeps other Extra", () => {
  const {
    MISMATCH_REASON_PREFIX,
    MISMATCH_NOTE_PREFIX,
    clearMismatchExtraLines,
    upsertExtraPrefixedLine,
  } = loadTags();
  let extra = "DOI: 10.1/x\nZPDF-Source-Path: D:\\a.pdf";
  extra = upsertExtraPrefixedLine(
    extra,
    MISMATCH_REASON_PREFIX,
    "article: incomplete distinctive title tokens (0.40)",
  );
  extra = upsertExtraPrefixedLine(
    extra,
    MISMATCH_NOTE_PREFIX,
    "Cleared false #pdf-mismatch (batch3). FP: stale tag",
  );
  assert.match(extra, /ZPDF-Mismatch-Reason:/);
  assert.match(extra, /ZPDF-Mismatch-Note:/);
  const cleared = clearMismatchExtraLines(extra);
  assert.equal(cleared.includes("ZPDF-Mismatch-Reason:"), false);
  assert.equal(cleared.includes("ZPDF-Mismatch-Note:"), false);
  assert.match(cleared, /DOI: 10\.1\/x/);
  assert.match(cleared, /ZPDF-Source-Path:/);
});

test("clearMismatchReasonExtra clears Note as well as Reason", async () => {
  const { clearMismatchReasonExtra } = loadTags();
  let saved = "";
  const item = {
    getField(name) {
      if (name === "extra") {
        return (
          "ZPDF-Mismatch-Note: Cleared false #pdf-mismatch (batch3)\n" +
          "ZPDF-Mismatch-Reason: article: incomplete | titleHit=0.57\n" +
          "DOI: 10.1/x"
        );
      }
      return "";
    },
    setField(name, value) {
      if (name === "extra") saved = value;
    },
    async saveTx() {},
  };
  await clearMismatchReasonExtra(item);
  assert.equal(saved.includes("ZPDF-Mismatch-Reason:"), false);
  assert.equal(saved.includes("ZPDF-Mismatch-Note:"), false);
  assert.match(saved, /DOI: 10\.1\/x/);
});
