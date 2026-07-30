const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfMetadata.ts")],
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

test("escapeXml escapes all five XML-significant characters", () => {
  const { escapeXml } = loadModule();
  assert.equal(
    escapeXml(`<tag> & 'quote' "double"`),
    "&lt;tag&gt; &amp; &apos;quote&apos; &quot;double&quot;",
  );
});

test("escapeXml preserves Turkish characters untouched", () => {
  const { escapeXml } = loadModule();
  assert.equal(escapeXml("Doğa bilimleri ışığında"), "Doğa bilimleri ışığında");
});

test("xmpAlt omits the element entirely for an empty value", () => {
  const { xmpAlt } = loadModule();
  assert.equal(xmpAlt("dc:title", ""), "");
});

test("xmpAlt wraps a value in rdf:Alt/rdf:li with escaping", () => {
  const { xmpAlt } = loadModule();
  const xml = xmpAlt("dc:title", "A & B");
  assert.match(
    xml,
    /<dc:title><rdf:Alt><rdf:li xml:lang="x-default">A &amp; B<\/rdf:li><\/rdf:Alt><\/dc:title>/,
  );
});

test("xmpBag omits the element for an empty array", () => {
  const { xmpBag } = loadModule();
  assert.equal(xmpBag("dc:subject", []), "");
});

test("xmpBag renders every item as an escaped rdf:li inside rdf:Bag", () => {
  const { xmpBag } = loadModule();
  const xml = xmpBag("dc:subject", ["bilim", "AT&T"]);
  assert.match(
    xml,
    /<dc:subject><rdf:Bag><rdf:li>bilim<\/rdf:li><rdf:li>AT&amp;T<\/rdf:li><\/rdf:Bag><\/dc:subject>/,
  );
});

test("xmpSeq omits the element for an empty array", () => {
  const { xmpSeq } = loadModule();
  assert.equal(xmpSeq("dc:creator", []), "");
});

test("xmpSeq renders items in order inside rdf:Seq", () => {
  const { xmpSeq } = loadModule();
  const xml = xmpSeq("dc:creator", ["Yazar Bir", "Yazar İki"]);
  assert.match(
    xml,
    /<dc:creator><rdf:Seq><rdf:li>Yazar Bir<\/rdf:li><rdf:li>Yazar İki<\/rdf:li><\/rdf:Seq><\/dc:creator>/,
  );
});

test("xmpSimple omits the element for an empty value", () => {
  const { xmpSimple } = loadModule();
  assert.equal(xmpSimple("pdf:Producer", ""), "");
});

test("xmpSimple renders a single escaped value", () => {
  const { xmpSimple } = loadModule();
  assert.match(
    xmpSimple("pdf:Producer", "Alan & Co"),
    /<pdf:Producer>Alan &amp; Co<\/pdf:Producer>/,
  );
});

test("isSystemTag rejects hash-prefixed automation tags", () => {
  const { isSystemTag } = loadModule();
  assert.equal(isSystemTag("#nosource"), true);
  assert.equal(isSystemTag("#pdf-review"), true);
  assert.equal(isSystemTag("#metadata-embedded"), true);
});

test("isSystemTag rejects known internal namespaces", () => {
  const { isSystemTag } = loadModule();
  assert.equal(isSystemTag("MetadataHunter: No DOI"), true);
  assert.equal(isSystemTag("ZPDF-Source-Path: x"), true);
  assert.equal(isSystemTag("YÖK Tez No: 123456"), true);
});

test("isSystemTag accepts ordinary subject-keyword tags", () => {
  const { isSystemTag } = loadModule();
  assert.equal(isSystemTag("bilim"), false);
  assert.equal(isSystemTag("doğa tarihi"), false);
});

test("parseYear extracts a 4-digit year from various date formats", () => {
  const { parseYear } = loadModule();
  assert.equal(parseYear("1997"), 1997);
  assert.equal(parseYear("2020-03"), 2020);
  assert.equal(parseYear("March 5, 2016"), 2016);
});

test("parseYear returns null when no year is present", () => {
  const { parseYear } = loadModule();
  assert.equal(parseYear(""), null);
  assert.equal(parseYear("n.d."), null);
});

test("aggregateItemOutcomes: a single successful attachment marks the item succeeded", () => {
  const { aggregateItemOutcomes } = loadModule();
  const item = { id: 1 };
  const outcomes = aggregateItemOutcomes([{ item, succeeded: true }]);
  assert.equal(outcomes.get(1).allSucceeded, true);
});

test("aggregateItemOutcomes: one failing attachment marks the whole item failed, even if another attachment for it succeeded", () => {
  const { aggregateItemOutcomes } = loadModule();
  const item = { id: 1 };
  const outcomesSuccessThenFail = aggregateItemOutcomes([
    { item, succeeded: true },
    { item, succeeded: false },
  ]);
  assert.equal(outcomesSuccessThenFail.get(1).allSucceeded, false);

  const outcomesFailThenSuccess = aggregateItemOutcomes([
    { item, succeeded: false },
    { item, succeeded: true },
  ]);
  assert.equal(outcomesFailThenSuccess.get(1).allSucceeded, false);
});

test("aggregateItemOutcomes: different items are tracked independently", () => {
  const { aggregateItemOutcomes } = loadModule();
  const itemA = { id: 1 };
  const itemB = { id: 2 };
  const outcomes = aggregateItemOutcomes([
    { item: itemA, succeeded: true },
    { item: itemB, succeeded: false },
  ]);
  assert.equal(outcomes.get(1).allSucceeded, true);
  assert.equal(outcomes.get(2).allSucceeded, false);
  assert.equal(outcomes.size, 2);
});

test("metadataEmbedTmpPath uses a short sibling name (Windows MAX_PATH safe)", () => {
  const { metadataEmbedTmpPath } = loadModule();
  const dir =
    "D:\\OneDrive\\1A_E_KAYNAKLARIM\\Zotero Kaynaklar\\iletişim\\özcan abi kaynaklar\\";
  const name =
    "Yörük Karakılıç ve Madikova Özer (2023) An assessment of the effect of generation Y and Z executives' perceptions of religion on narcissisti [journalArticle] Hitit Theology Jou.pdf";
  const pdf = dir + name;
  const tmp = metadataEmbedTmpPath(pdf, "ABCD1234");
  assert.equal(tmp, `${dir}.zpm-ABCD1234.tmp`);
  assert.ok(tmp.length < 260, `short tmp should be under 260, got ${tmp.length}`);
  assert.ok(
    `${pdf}.zpdfmanager.tmp`.length > 260,
    `legacy tmp must exceed 260, got ${`${pdf}.zpdfmanager.tmp`.length}`,
  );
});

test("metadataEmbedTmpPath preserves POSIX separators and sanitizes key", () => {
  const { metadataEmbedTmpPath } = loadModule();
  assert.equal(
    metadataEmbedTmpPath("/data/books/long-name.pdf", "ab/cd!ef"),
    "/data/books/.zpm-abcdef.tmp",
  );
  assert.equal(metadataEmbedTmpPath("orphan.pdf", ""), ".zpm-tmp.tmp");
});
