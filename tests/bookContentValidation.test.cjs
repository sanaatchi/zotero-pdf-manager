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

test("thesis colon subtitle: core in PDF body matches (1980 Sanat: Dönüşümler)", () => {
  const { decideContentValidation, distinctiveTitleCoverage } = loadModule();
  const itemTitle = "1980 Sonrası Türkiye'de Sanat: Dönüşümler";
  const pdfText =
    "1980 sonrasi turkiye de sanat\nYuksek Lisans Tezi\n" +
    "Bu calisma 1980 sonrasi turkiye de sanat alaninda incelenmektedir. ".repeat(
      12,
    );
  const coverage = distinctiveTitleCoverage(itemTitle, pdfText);
  assert.ok(
    coverage >= 1,
    "core distinctive tokens in body should satisfy coverage",
  );
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 500,
      titleHit: 0.75,
      score: 1.0,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: coverage,
    }),
    "match",
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

test("bridge guard: Frege-style titleHit 0.5 + author keeps match vs bridge mismatch", () => {
  const { isStrongHeuristicContentMatch, shouldSkipBridgeContentValidation } =
    loadModule();
  const base = {
    titleHit: 0.5,
    score: 1.0,
    authorFound: true,
    hasIdMatch: false,
  };
  assert.equal(isStrongHeuristicContentMatch(base), true);
  assert.equal(
    shouldSkipBridgeContentValidation({ heuristic: "match", ...base }),
    true,
  );
});

test("bridge guard: Bourdieu-style high titleHit keeps match vs bridge mismatch", () => {
  const { isStrongHeuristicContentMatch } = loadModule();
  assert.equal(
    isStrongHeuristicContentMatch({
      titleHit: 1,
      score: 1.5,
      authorFound: true,
      hasIdMatch: false,
    }),
    true,
  );
});

test("OCR haystack: doubled dots still yield title token hit", () => {
  const { normalizeOcrHaystack, titleTokenHit } = loadModule();
  const hay = normalizeOcrHaystack(
    "Gottlob Frege\nkavram..yaztst\nKavram Yazisi uzerine calisma " +
      "x".repeat(80),
  );
  assert.ok(hay.includes("kavram yaztst"));
  const item = {
    getField: () => "Kavram Yazısı",
  };
  const hit = titleTokenHit(item, hay);
  assert.ok(hit >= 0.5, `expected titleHit>=0.5 got ${hit}`);
});

test("garbled encoding extract is detected; clean Turkish text is not", () => {
  const { looksLikeGarbledPdfText } = loadModule();
  const garbled =
    "Hakemli Makale.\n6$1$7\x13(GITIM\x13" +
    "$\x13".repeat(40) +
    "\n,QWHUGLVFLSOLQDU\\ $SSURDFK\n" +
    "\x01\x02\x03abc ".repeat(80);
  assert.equal(looksLikeGarbledPdfText(garbled), true);
  const clean =
    "Sanat egitiminde disiplinlerarasi yaklasim ve muzeler. Aydin Afacan. ".repeat(
      10,
    );
  assert.equal(looksLikeGarbledPdfText(clean), false);
});

test("formatContentValidationReason notes encodingUnreliable unverifiable", () => {
  const { formatContentValidationReason } = loadModule();
  const reason = formatContentValidationReason({
    verdict: "unverifiable",
    kind: "other",
    textChars: 5000,
    titleHit: 0,
    score: 0,
    hasIdConflict: false,
    hasIdMatch: false,
    authorExpected: true,
    authorFound: false,
    encodingUnreliable: true,
  });
  assert.match(reason, /encoding unreliable/);
});

test("shouldAllowValidateOcr: force/allowOcr only (passive false)", () => {
  const { shouldAllowValidateOcr } = loadModule();
  assert.equal(shouldAllowValidateOcr({}), false);
  assert.equal(shouldAllowValidateOcr({ force: true }), true);
  assert.equal(shouldAllowValidateOcr({ allowOcr: true }), true);
  assert.equal(
    shouldAllowValidateOcr({ force: false, allowOcr: false }),
    false,
  );
});
