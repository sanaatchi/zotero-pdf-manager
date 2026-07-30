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

test("Turkish thesis text normalization preserves meaningful letters", () => {
  const { normalizeSearchText } = loadModule();

  assert.equal(
    normalizeSearchText("Çağdaş sanat, müziksel imge ve özgünlük"),
    "cagdas sanat  muziksel imge ve ozgunluk",
  );
});

test("YÖK thesis PDF links are extracted from current and legacy markup", () => {
  const { extractYokPdfURL } = loadModule();
  const base = "https://tez.yok.gov.tr/UlusalTezMerkezi/tezDetay.jsp?id=1";

  assert.equal(
    extractYokPdfURL("<a href='TezGoster?key=abc&amp;no=123'>PDF</a>", base),
    "https://tez.yok.gov.tr/UlusalTezMerkezi/TezGoster?key=abc&no=123",
  );
  assert.equal(
    extractYokPdfURL(
      '<script>window.location="TezGoster?key=xyz"</script>',
      base,
    ),
    "https://tez.yok.gov.tr/UlusalTezMerkezi/TezGoster?key=xyz",
  );
});

test("YÖK URL can be recovered from Zotero Extra when URL is empty", () => {
  const { getYokRecordURL } = loadModule();
  const item = {
    getField(field) {
      return field === "extra"
        ? "Tez URL: https://tez.yok.gov.tr/UlusalTezMerkezi/TezGoster?key=abc"
        : "";
    },
  };

  assert.equal(
    getYokRecordURL(item),
    "https://tez.yok.gov.tr/UlusalTezMerkezi/TezGoster?key=abc",
  );
});

test("DergiPark source supports only journal articles", () => {
  global.Zotero = {
    ItemTypes: {
      getName: (id) =>
        ({
          1: "journalArticle",
          2: "conferencePaper",
          3: "preprint",
          4: "report",
          5: "thesis",
        })[id],
    },
  };
  const { DergiParkSource } = loadModule();
  const source = new DergiParkSource();

  assert.equal(source.supportsItem({ itemTypeID: 1 }), true);
  assert.equal(source.supportsItem({ itemTypeID: 2 }), false);
  assert.equal(source.supportsItem({ itemTypeID: 3 }), false);
  assert.equal(source.supportsItem({ itemTypeID: 4 }), false);
  assert.equal(source.supportsItem({ itemTypeID: 5 }), false);
  delete global.Zotero;
});

test("DergiPark extraction ignores article PDFs cited in references", () => {
  const { extractDergiParkPdfURL } = loadModule();
  const base = "https://dergipark.org.tr/tr/pub/example/article/123";
  const html = `
    <div class="references">
      <a href="/tr/download/article-file/999">Cited article</a>
    </div>
    <meta name="citation_pdf_url"
      content="https://dergipark.org.tr/tr/download/article-file/123">
    <a href="/tr/download/article-file/123">Tam Metin</a>
  `;

  assert.equal(
    extractDergiParkPdfURL(html, base),
    "https://dergipark.org.tr/tr/download/article-file/123",
  );
});

test("YÖK getTezPdf.jsp assets HTML yields TezGoster PDF URL", () => {
  const { parseYokTezAssets, buildYokAssetsURL } = loadModule();

  assert.equal(
    buildYokAssetsURL("reg1", "tez2"),
    "https://tez.yok.gov.tr/UlusalTezMerkezi/getTezPdf.jsp?kayitNo=reg1&tezNo=tez2",
  );

  const available = parseYokTezAssets(
    '<a href="TezGoster?key=abcKEY&amp;x=1">PDF</a>',
  );
  assert.equal(available.status, "AVAILABLE");
  assert.equal(available.pdfKey, "abcKEY&x=1");
  assert.equal(
    available.pdfURL,
    "https://tez.yok.gov.tr/UlusalTezMerkezi/TezGoster?key=abcKEY&x=1",
  );

  const embargo = parseYokTezAssets(
    '<span class="pdf-info-msg">Embargo 15.03.2028</span>',
  );
  assert.equal(embargo.status, "UNDER_EMBARGO");
  assert.equal(embargo.pdfURL, "");
});

test("YÖK opaque keys and display tez no are read from Extra", () => {
  const {
    extractYokAssetKeys,
    extractYokDisplayTezNo,
    extractYokCardsFromSearchHtml,
  } = loadModule();

  const keyed = {
    getField(field) {
      return field === "extra"
        ? "kayitNo=AAA111\ntezNo=BBB222\nYÖK Tez No: 695080"
        : "";
    },
  };
  assert.deepEqual(extractYokAssetKeys(keyed), {
    kayitNo: "AAA111",
    tezNo: "BBB222",
  });
  assert.equal(extractYokDisplayTezNo(keyed), "695080");

  const cards = extractYokCardsFromSearchHtml(
    '<div data-kayitno="k1" data-tezno="t1"></div>' +
      '<div data-tezno="t2" data-kayitno="k2"></div>',
  );
  assert.deepEqual(cards, [
    { kayitNo: "k1", tezNo: "t1" },
    { kayitNo: "k2", tezNo: "t2" },
  ]);
});

test("DergiPark OpenAlex picker keeps only dergipark.org.tr PDF URLs", () => {
  const { pickDergiParkOpenAlexPdfUrls } = loadModule();
  const urls = pickDergiParkOpenAlexPdfUrls([
    {
      primary_location: {
        landing_page_url: "https://dergipark.org.tr/tr/pub/x",
        pdf_url: "https://dergipark.org.tr/tr/download/article-file/1",
      },
    },
    {
      locations: [
        {
          landing_page_url: "https://example.com/a",
          pdf_url: "https://example.com/a.pdf",
        },
      ],
    },
  ]);
  assert.deepEqual(urls, [
    "https://dergipark.org.tr/tr/download/article-file/1",
  ]);
});
