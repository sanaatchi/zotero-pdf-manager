// @ajan: cursor · @etiket: katman-2, tests, content-validate, tr-i-fold, sentence-tr-override, no-validate-subtitle-enrich, title-length-aware
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("TR İ fold: İşlenen ≡ işlenen (item 726 false #pdf-mismatch)", () => {
  const {
    normalizeSearchText,
    distinctiveTitleCoverage,
    distinctiveTitleCoverageDetail,
    titleSentenceSimilarity,
    missingDistinctiveAreTurkishIVariants,
    decideContentValidation,
    formatContentValidationReason,
  } = loadModule();
  // PDF extract often has title-case İ; künye has lowercase i + ş.
  assert.equal(normalizeSearchText("İşlenen"), normalizeSearchText("işlenen"));
  assert.equal(normalizeSearchText("İşlenen").trim(), "islenen");
  assert.equal(normalizeSearchText("ISLENEN").trim(), "islenen");

  const itemTitle =
    "Çok alanlı sanat eğitimi yönteminin öğrencilerin işlenen derslere " +
    "yönelik bilgilerini uygulamaya geçirmelerine katkısı";
  // Extract uses title-case «İşlenen» — previously folded to ıslenen and
  // missed the künye token islenen → coverage 0.90 → false mismatch.
  const pdfText =
    "Çok alanlı sanat eğitimi yönteminin öğrencilerin İşlenen derslere " +
    "yönelik bilgilerini uygulamaya geçirmelerine katkısı. " +
    "Alakuş Şahin ".repeat(20);
  const coverage = distinctiveTitleCoverage(itemTitle, pdfText);
  assert.equal(
    coverage,
    1,
    `expected full distinctive coverage, got ${coverage}`,
  );
  assert.ok(
    titleSentenceSimilarity(itemTitle, pdfText) >= 0.9,
    "sentence-level TR fold overlap should be high",
  );
  assert.equal(
    missingDistinctiveAreTurkishIVariants(itemTitle, pdfText),
    true,
    "old locale fold must still expose the İ→ı vs i miss pattern",
  );
  const detail = distinctiveTitleCoverageDetail(itemTitle, pdfText);
  assert.equal(detail.coverage, 1);
  assert.equal(detail.turkishCharNormalization, true);
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 800,
      titleHit: 0.92,
      score: 1.4,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: coverage,
    }),
    "match",
  );
  const reason = formatContentValidationReason({
    verdict: "match",
    kind: "other",
    textChars: 800,
    titleHit: 0.92,
    score: 1.4,
    hasIdConflict: false,
    hasIdMatch: false,
    authorExpected: true,
    authorFound: true,
    distinctiveCoverage: 1,
    turkishCharNormalization: true,
  });
  assert.match(reason, /Türkçe karakter \/ İ-ı normalizasyon farkı/);
});

test("sentence-level TR override: do not #pdf-mismatch on İ-ı-only miss", () => {
  const {
    titleSentenceSimilarity,
    missingDistinctiveAreTurkishIVariants,
    distinctiveTitleCoverageDetail,
    decideContentValidation,
  } = loadModule();
  const itemTitle =
    "Öğrencilerin işlenen derslere yönelik bilgilerini uygulamaya geçirmeleri";
  // PDF title-cases İ; same sentence otherwise.
  const pdfHaystack =
    "Öğrencilerin İşlenen derslere yönelik bilgilerini uygulamaya geçirmeleri. " +
    "Makale gövdesi ".repeat(30);
  assert.ok(titleSentenceSimilarity(itemTitle, pdfHaystack) >= 0.9);
  assert.equal(
    missingDistinctiveAreTurkishIVariants(itemTitle, pdfHaystack),
    true,
  );
  const detail = distinctiveTitleCoverageDetail(itemTitle, pdfHaystack);
  assert.equal(detail.coverage, 1);
  assert.equal(detail.turkishCharNormalization, true);
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 600,
      titleHit: 0.91,
      score: 1.3,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: detail.coverage,
    }),
    "match",
  );
});

test("sentence-level TR override: real missing distinctive token still mismatches", () => {
  const {
    distinctiveTitleCoverageDetail,
    missingDistinctiveAreTurkishIVariants,
    decideContentValidation,
  } = loadModule();
  const itemTitle =
    "Çok alanlı sanat eğitimi yönteminin öğrencilerin işlenen derslere " +
    "yönelik bilgilerini uygulamaya geçirmelerine katkısı";
  // Drop a real distinctive stem («yönteminin») — not an İ-ı-only issue.
  const pdfText =
    "Çok alanlı sanat eğitimi öğrencilerin İşlenen derslere " +
    "yönelik bilgilerini uygulamaya geçirmelerine katkısı. WrongPaper ".repeat(
      10,
    );
  assert.equal(
    missingDistinctiveAreTurkishIVariants(itemTitle, pdfText),
    false,
  );
  const detail = distinctiveTitleCoverageDetail(itemTitle, pdfText);
  assert.ok(detail.coverage < 1);
  assert.equal(detail.turkishCharNormalization, undefined);
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 800,
      titleHit: 0.85,
      score: 1.0,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: detail.coverage,
    }),
    "mismatch",
  );
});

test("validateAttachmentContentDetailed: no subtitle enrich / title write", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  const start = source.indexOf(
    "export async function validateAttachmentContentDetailed(",
  );
  assert.ok(start >= 0, "validateAttachmentContentDetailed missing");
  const nextExport = source.indexOf("\nexport ", start + 10);
  const body = source.slice(start, nextExport > start ? nextExport : undefined);
  assert.doesNotMatch(body, /resolveSubtitleEnrichment/);
  assert.doesNotMatch(body, /proposeSubtitleEnrichment/);
  assert.doesNotMatch(body, /setField\(\s*["']title["']/);
  assert.doesNotMatch(body, /enrichedTitle\s*:/);
  assert.match(body, /never mutate/);
  assert.match(body, /Ignore enriched_title from bridge/);
});

test("title length bands: 1-word short, 21-word long, medium between", () => {
  const { titleWordCount, classifyTitleLength, TITLE_LENGTH } = loadModule();
  assert.equal(TITLE_LENGTH.SHORT_MAX_WORDS, 3);
  assert.equal(TITLE_LENGTH.LONG_MIN_WORDS, 21);
  assert.equal(titleWordCount("Gece"), 1);
  assert.equal(titleWordCount("Renk"), 1);
  assert.equal(classifyTitleLength("Gece"), "short");
  assert.equal(classifyTitleLength("Bir dünya sözcüklerden"), "short");
  assert.equal(
    classifyTitleLength("The art of political storytelling"),
    "medium",
  );
  const twentyOne =
    "One two three four five six seven eight nine ten " +
    "eleven twelve thirteen fourteen fifteen sixteen " +
    "seventeen eighteen nineteen twenty twentyone";
  assert.equal(titleWordCount(twentyOne), 21);
  assert.equal(classifyTitleLength(twentyOne), "long");
  const twenty =
    "One two three four five six seven eight nine ten " +
    "eleven twelve thirteen fourteen fifteen sixteen " +
    "seventeen eighteen nineteen twenty";
  assert.equal(titleWordCount(twenty), 20);
  assert.equal(classifyTitleLength(twenty), "medium");
});

test("1-word short title needs author/year/id corroboration", () => {
  const { decideContentValidation, classifyTitleLength } = loadModule();
  assert.equal(classifyTitleLength("Gece"), "short");
  // Title-alone high score → mismatch (common false friend).
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 400,
      titleHit: 1,
      score: 0.9,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: false,
      titleLengthBand: "short",
      yearFound: false,
    }),
    "mismatch",
  );
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 400,
      titleHit: 1,
      score: 0.9,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: false,
      distinctiveCoverage: 1,
      titleLengthBand: "short",
      yearFound: false,
    }),
    "mismatch",
  );
  // Author found → match.
  assert.equal(
    decideContentValidation({
      kind: "book",
      textChars: 400,
      titleHit: 1,
      score: 0.9,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      titleLengthBand: "short",
      yearFound: false,
    }),
    "match",
  );
  // Year found without author → match.
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 400,
      titleHit: 1,
      score: 0.9,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: false,
      authorFound: false,
      distinctiveCoverage: 1,
      titleLengthBand: "short",
      yearFound: true,
    }),
    "match",
  );
});

test("21-word long title softens distinctiveCoverage < 1", () => {
  const {
    decideContentValidation,
    classifyTitleLength,
    articleDistinctiveCoverageOk,
    TITLE_LENGTH,
  } = loadModule();
  const twentyOne =
    "One two three four five six seven eight nine ten " +
    "eleven twelve thirteen fourteen fifteen sixteen " +
    "seventeen eighteen nineteen twenty twentyone";
  assert.equal(classifyTitleLength(twentyOne), "long");
  assert.equal(
    articleDistinctiveCoverageOk({
      titleLengthBand: "long",
      distinctiveCoverage: 0.88,
      authorFound: true,
      titleHit: 0.7,
    }),
    true,
  );
  assert.equal(
    articleDistinctiveCoverageOk({
      titleLengthBand: "long",
      distinctiveCoverage: 0.7,
      authorFound: true,
      titleHit: 0.9,
    }),
    false,
  );
  // Soft match: coverage 0.88 + author (would have been mismatch at ==1).
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 800,
      titleHit: 0.7,
      score: 0.8,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: 0.88,
      titleLengthBand: "long",
    }),
    "match",
  );
  // Soft match via high titleHit without author.
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 800,
      titleHit: TITLE_LENGTH.LONG_TITLE_HIT_SOFT,
      score: 0.8,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: false,
      authorFound: false,
      distinctiveCoverage: 0.88,
      titleLengthBand: "long",
    }),
    "match",
  );
  // Medium band still demands coverage === 1.
  assert.equal(
    decideContentValidation({
      kind: "other",
      textChars: 800,
      titleHit: 0.9,
      score: 0.8,
      hasIdConflict: false,
      hasIdMatch: false,
      authorExpected: true,
      authorFound: true,
      distinctiveCoverage: 0.88,
      titleLengthBand: "medium",
    }),
    "mismatch",
  );
});
