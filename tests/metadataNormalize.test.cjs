// @ajan: cursor · @etiket: katman-2, format-metadata, test
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

test("pages connector and title trailing-dot helpers", () => {
  const { normalizePagesConnector, stripTitleTrailingDot } = loadNormalize();
  assert.equal(normalizePagesConnector("12~34+56"), "12-34, 56");
  assert.equal(stripTitleTrailingDot("A Study."), "A Study");
  assert.equal(stripTitleTrailingDot("Dr. Who"), "Dr. Who");
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
