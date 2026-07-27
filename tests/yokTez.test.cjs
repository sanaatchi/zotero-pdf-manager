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
    extractYokPdfURL(
      "<a href='TezGoster?key=abc&amp;no=123'>PDF</a>",
      base,
    ),
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

test("DergiPark extraction refuses an unlabelled reference-only PDF", () => {
  const { extractDergiParkPdfURL } = loadModule();
  const html =
    '<div class="references"><a href="/tr/download/article-file/999">' +
    "Kaynakça makalesi</a></div>";

  assert.equal(
    extractDergiParkPdfURL(
      html,
      "https://dergipark.org.tr/tr/pub/example/article/123",
    ),
    "",
  );
});
