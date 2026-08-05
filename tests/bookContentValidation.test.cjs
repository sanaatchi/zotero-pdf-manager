const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
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

test("book validation: ISBN match keeps; ISBN conflict is mismatch", () => {
  const { decideContentValidation } = loadModule();
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.1,
      score: 0.1,
      hasIdConflict: false,
      hasIdMatch: true,
      authorExpected: true,
      authorFound: false,
    }),
    "match",
  );
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.8,
      score: 0.9,
      hasIdConflict: true,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
    }),
    "mismatch",
  );
});

test("book validation: weak/wrong evidence is mismatch (tag, not erase)", () => {
  const { decideContentValidation } = loadModule();
  // Middling title — previously "unverifiable"/kept; now erase.
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.35,
      score: 0.4,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
    }),
    "mismatch",
  );
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.05,
      score: 0.1,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: false,
    }),
    "mismatch",
  );
  // Solid title+score without ISBN still keeps when author is in the PDF.
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.6,
      score: 0.5,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
    }),
    "match",
  );
  // Middling title without author surname → still mismatch (Devlet/Farabi).
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.6,
      score: 0.5,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: false,
    }),
    "mismatch",
  );
  // Strong title evidence without author → keep (OCR miss / translator-first).
  // Previously this erased correct PDFs → delete → re-download loop.
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 200,
      titleHit: 0.8,
      score: 0.9,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: false,
    }),
    "match",
  );
});

test("article validation stays stricter than books", () => {
  const { decideContentValidation } = loadModule();
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 200,
      titleHit: 0.35,
      score: 0.4,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
    }),
    "mismatch",
  );
});

test("article validation rejects Golub name-only PDF without mercenaries", () => {
  const { decideContentValidation, distinctiveTitleCoverage } = loadModule();
  const itemTitle = "The mercenaries: an interview with Leon Golub";
  const turkishEssay =
    "Leon Golub resimlerinde bellek olarak fotograf kullanimi interview leon golub";
  const coverage = distinctiveTitleCoverage(itemTitle, turkishEssay);
  assert.ok(coverage < 1, "mercenaries missing → coverage < 1");
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 500,
      titleHit: 0.8,
      score: 1.2,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: coverage,
    }),
    "mismatch",
  );
});
