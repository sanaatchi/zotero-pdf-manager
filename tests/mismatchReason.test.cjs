// @ajan: cursor · @etiket: katman-2, tests, pdf-mismatch, mismatch-reason
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
    entryPoints: [
      path.join(process.cwd(), "src/modules/pdfAutomationTags.ts"),
    ],
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
