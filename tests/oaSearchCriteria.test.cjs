// @ajan: cursor · @etiket: katman-2, oa-search, search-kind, test
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

function loadCriteria() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/oaSearchCriteria.ts")],
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

test("kind fields match product criteria matrix", () => {
  const { KIND_FIELDS } = loadCriteria();
  assert.deepEqual(KIND_FIELDS.book, [
    "title",
    "authors",
    "isbn",
    "year",
    "language",
    "translator",
  ]);
  assert.deepEqual(KIND_FIELDS.journalArticle, [
    "title",
    "authors",
    "publication",
    "year",
    "doi",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.bookSection, [
    "title",
    "authors",
    "editors",
    "bookTitle",
    "year",
    "publisher",
    "isbn",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.thesis, [
    "title",
    "authors",
    "thesisType",
    "university",
    "year",
    "language",
  ]);
});

test("criteriaHasQuery respects visible kind fields", () => {
  const { criteriaHasQuery, emptyCriteria } = loadCriteria();
  const book = emptyCriteria("book");
  assert.equal(criteriaHasQuery(book), false);
  book.isbn = "9781234567890";
  assert.equal(criteriaHasQuery(book), true);
  const article = emptyCriteria("journalArticle");
  article.doi = "10.1/x";
  assert.equal(criteriaHasQuery(article), true);
});

test("applyActiveFields clears inactive metadata", () => {
  const { applyActiveFields, emptyCriteria } = loadCriteria();
  const c = emptyCriteria("journalArticle");
  c.text = "Estetik";
  c.authors = "Yılmaz";
  c.year = "2012";
  c.doi = "10.1/x";
  const active = new Set(["title", "year"]);
  const out = applyActiveFields(c, active);
  assert.equal(out.text, "Estetik");
  assert.equal(out.year, "2012");
  assert.equal(out.authors, "");
  assert.equal(out.doi, "");
});

test("buildFieldByFieldQueries fans out primary fields", () => {
  const { buildFieldByFieldQueries, emptyCriteria } = loadCriteria();
  const c = emptyCriteria("journalArticle");
  c.text = "Estetik";
  c.authors = "Yılmaz";
  c.year = "2012";
  c.publication = "Örnek Dergi";
  const active = new Set(["title", "authors", "year", "publication"]);
  const parts = buildFieldByFieldQueries(c, active);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.year === "2012"));
  assert.ok(parts.some((p) => p.text === "Estetik" && !p.authors));
  assert.ok(parts.some((p) => p.authors === "Yılmaz"));
  assert.ok(parts.some((p) => p.publication === "Örnek Dergi"));
});

test("criteriaHasQuery honors active set", () => {
  const { criteriaHasQuery, emptyCriteria } = loadCriteria();
  const c = emptyCriteria("journalArticle");
  c.authors = "Yılmaz";
  assert.equal(criteriaHasQuery(c, new Set(["title"])), false);
  assert.equal(criteriaHasQuery(c, new Set(["authors"])), true);
});

test("xhtml has kind selector and structured fields", () => {
  const xhtml = fs.readFileSync(
    path.join(process.cwd(), "addon/chrome/content/oa-search.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /zpdfmanager-oa-kind/);
  assert.match(xhtml, /oa-field-active/);
  assert.match(xhtml, /zpdfmanager-oa-field-by-field/);
  assert.match(xhtml, /data-field="bookTitle"/);
  assert.match(xhtml, /data-field="thesisType"/);
  assert.match(xhtml, /data-field="university"/);
  assert.match(xhtml, /data-field="translator"/);
  assert.match(xhtml, /data-field="publication"/);
});
