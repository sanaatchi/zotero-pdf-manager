// @ajan: cursor · @etiket: katman-2, format-metadata, b4-lint, test
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadNormalize() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/metadataNormalize.ts")],
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

function loadMetadataCheck() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/metadataCheck.ts")],
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

test("normalizeDOI strips doi.org and DOI: prefixes", () => {
  const { normalizeDOI } = loadNormalize();
  assert.equal(
    normalizeDOI("https://doi.org/10.1000/ABC.12"),
    "10.1000/abc.12",
  );
  assert.equal(normalizeDOI("DOI: 10.1000/ABC.12"), "10.1000/abc.12");
  assert.equal(normalizeDOI("10.1000/ABC.12"), "10.1000/abc.12");
});

test("ISBN-10 and ISBN-13 for the same work are equivalent", () => {
  const { isbnsEquivalent, isbn10To13 } = loadNormalize();
  // Well-known: 0-306-40615-2 ↔ 978-0-306-40615-7
  assert.equal(isbn10To13("0306406152"), "9780306406157");
  assert.equal(isbnsEquivalent("0-306-40615-2", "978-0-306-40615-7"), true);
  assert.equal(isbnsEquivalent("0306406152", "9780306406157"), true);
  assert.equal(isbnsEquivalent("0306406152", "9780306406158"), false);
});

test("invalid ISBN checksums never convert or equate", () => {
  const {
    isbn10To13,
    isbn13To10,
    isbnsEquivalent,
    isValidIsbn10,
    isValidIsbn13,
  } = loadNormalize();
  // Bad check digit (valid would be …2)
  assert.equal(isValidIsbn10("0306406153"), false);
  assert.equal(isbn10To13("0306406153"), "");
  assert.equal(isbnsEquivalent("0306406153", "9780306406157"), false);
  // Bad ISBN-13 check digit
  assert.equal(isValidIsbn13("9780306406158"), false);
  assert.equal(isbn13To10("9780306406158"), "");
  // 979 cannot convert to ISBN-10
  assert.equal(isbn13To10("9791234567896"), "");
});

test("pages connector and title trailing-dot helpers", () => {
  const { normalizePagesConnector, stripTitleTrailingDot } = loadNormalize();
  assert.equal(normalizePagesConnector("12~34+56"), "12-34, 56");
  assert.equal(stripTitleTrailingDot("A Study."), "A Study");
  assert.equal(stripTitleTrailingDot("Dr. Who"), "Dr. Who");
});

test("B4: thesis type, zeros, language, planFieldNormalizations", () => {
  const {
    normalizeThesisType,
    removeLeadingZeros,
    guessLanguageTag,
    planFieldNormalizations,
  } = loadNormalize();
  assert.equal(normalizeThesisType("Ph.D."), "Doctoral dissertation");
  assert.equal(normalizeThesisType("yüksek lisans"), "Yüksek Lisans Tezi");
  assert.equal(removeLeadingZeros("007-012"), "7-12");
  assert.equal(guessLanguageTag("Varlık ve Zaman"), "tr-TR");
  assert.equal(guessLanguageTag("Being and Time"), "en-US");
  const patches = planFieldNormalizations({
    title: "Tez Başlığı.",
    language: "",
    pages: "001~010",
    doi: "DOI: 10.1000/XYZ",
    thesisType: "doktora",
    itemType: "thesis",
  });
  const byField = Object.fromEntries(patches.map((p) => [p.field, p.to]));
  assert.equal(byField.title, "Tez Başlığı");
  assert.equal(byField.language, "tr-TR");
  assert.equal(byField.pages, "1-10");
  assert.equal(byField.DOI, "10.1000/xyz");
  assert.equal(byField.thesisType, "Doktora Tezi");
});

test("B4b: pages-range order, expand helpers, creators-case, extra order", () => {
  const {
    normalizePagesRangeOrder,
    shouldExpandPagesFromPdf,
    generatePagesRange,
    normalizeCreatorCase,
    reorderExtraField,
    planFieldNormalizations,
  } = loadNormalize();
  assert.equal(normalizePagesRangeOrder("34–12"), "12-34");
  assert.equal(normalizePagesRangeOrder("001~010"), "1-10");
  assert.equal(shouldExpandPagesFromPdf("12"), true);
  assert.equal(shouldExpandPagesFromPdf("12-34"), false);
  assert.equal(shouldExpandPagesFromPdf("1234"), false);
  assert.equal(generatePagesRange("12", 5), "12-16");
  const creators = normalizeCreatorCase([
    { fieldMode: 0, firstName: "JOHN", lastName: "DOE" },
    { fieldMode: 0, firstName: "jane", lastName: "smith" },
    { fieldMode: 1, lastName: "UNESCO" },
  ]);
  assert.equal(creators[0].firstName, "John");
  assert.equal(creators[0].lastName, "Doe");
  assert.equal(creators[1].firstName, "Jane");
  assert.equal(creators[1].lastName, "Smith");
  assert.equal(creators[2].lastName, "UNESCO");
  const extra = reorderExtraField(
    "Note: keep\nKutuphane-KP: KP000001\nCitation Key: doe2020\nDOI: 10.1/x",
  );
  assert.ok(extra);
  assert.equal(
    extra.split("\n")[0],
    "Citation Key: doe2020",
  );
  assert.match(extra.split("\n")[1], /^Kutuphane-KP:/);
  const patches = planFieldNormalizations({ pages: "34-12" });
  assert.equal(patches.find((p) => p.field === "pages")?.to, "12-34");
});

test("compareMetadata treats ISBN-10↔13 as a match", () => {
  const { compareMetadata } = loadMetadataCheck();
  const result = compareMetadata(
    {
      title: "Quantum Theory",
      creators: ["Someone"],
      isbn: "0-306-40615-2",
    },
    {
      title: "Quantum Theory",
      creators: ["Someone"],
      isbn: "978-0-306-40615-7",
    },
  );
  assert.equal(result.status, "match");
  assert.ok(result.details.some((d) => d.includes("ISBN eşleşiyor")));
});

test("compareMetadata DOI prefix variants match", () => {
  const { compareMetadata } = loadMetadataCheck();
  const result = compareMetadata(
    { title: "Paper", creators: ["A"], doi: "https://doi.org/10.1000/xyz" },
    { title: "Paper", creators: ["A"], doi: "DOI:10.1000/xyz" },
  );
  assert.equal(result.status, "match");
  assert.ok(result.details.includes("DOI eşleşiyor"));
});

test("pdfSources wires structured identifier compare into validation", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /compareItemAgainstText/);
  assert.match(source, /hasIdentifierConflict/);
  assert.match(source, /normalizeItemIdentifiers/);
  assert.match(source, /normalizeDOI/);
});
