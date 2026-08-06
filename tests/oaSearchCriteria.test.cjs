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
  const { KIND_FIELDS, OA_SEARCH_KINDS } = loadCriteria();
  assert.deepEqual(OA_SEARCH_KINDS, [
    "book",
    "journalArticle",
    "periodical",
    "bookSection",
    "thesis",
    "document",
    "magazineArticle",
    "report",
    "newspaperArticle",
  ]);
  // No volume/issue/numPages/pages/place — APIs cannot filter on them.
  for (const kind of OA_SEARCH_KINDS) {
    for (const id of KIND_FIELDS[kind]) {
      assert.ok(
        !["volume", "issue", "numPages", "pages", "place"].includes(id),
        `${kind} must not expose non-filterable field ${id}`,
      );
    }
  }
  assert.deepEqual(KIND_FIELDS.book, [
    "title",
    "authors",
    "year",
    "isbn",
    "publisher",
    "editors",
    "translator",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.journalArticle, [
    "title",
    "authors",
    "year",
    "doi",
    "publication",
    "editors",
    "translator",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.periodical, [
    "title",
    "year",
    "publisher",
    "publication",
    "editors",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.bookSection, [
    "title",
    "authors",
    "year",
    "isbn",
    "bookTitle",
    "publisher",
    "editors",
    "translator",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.thesis, [
    "title",
    "authors",
    "year",
    "university",
    "thesisType",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.document, [
    "title",
    "authors",
    "year",
    "publisher",
    "translator",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.magazineArticle, [
    "title",
    "authors",
    "year",
    "doi",
    "publisher",
    "publication",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.report, [
    "title",
    "authors",
    "year",
    "publisher",
    "translator",
    "language",
  ]);
  assert.deepEqual(KIND_FIELDS.newspaperArticle, [
    "title",
    "authors",
    "year",
    "publication",
    "language",
  ]);
});

test("periodical maps to Zotero book + Extra type", () => {
  const {
    zoteroItemTypeFromOaKind,
    kindFromZoteroItemType,
  } = loadCriteria();
  assert.equal(zoteroItemTypeFromOaKind("periodical"), "book");
  assert.equal(zoteroItemTypeFromOaKind("journalArticle"), "journalArticle");
  assert.equal(
    kindFromZoteroItemType("book", "type: periodical\nKP: 1"),
    "periodical",
  );
  assert.equal(kindFromZoteroItemType("book", ""), "book");
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
  // Non-title primaries must not bleed into text (fake-title regression).
  assert.ok(
    parts.filter((p) => p.authors || p.publication).every((p) => !p.text),
  );
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
  assert.match(xhtml, /value="document"/);
  assert.match(xhtml, /value="periodical"/);
  assert.match(xhtml, /value="magazineArticle"/);
  assert.match(xhtml, /value="report"/);
  assert.match(xhtml, /value="newspaperArticle"/);
  // Non-filterable fields must not appear as inputs.
  assert.doesNotMatch(xhtml, /data-field="volume"/);
  assert.doesNotMatch(xhtml, /data-field="issue"/);
  assert.doesNotMatch(xhtml, /data-field="numPages"/);
  assert.doesNotMatch(xhtml, /data-field="pages"/);
  assert.doesNotMatch(xhtml, /data-field="place"/);
});
