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

test("book validation: ISBN match keeps; ISBN conflict erases", () => {
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

test("book validation: weak OCR keeps for review; wrong title+author erases", () => {
  const { decideContentValidation } = loadModule();
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
    "unverifiable",
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
