const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadBridge() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/oaPdfBridge.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  global.Zotero = { Prefs: { get: () => undefined, set: () => {} } };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

function loadPdfSources() {
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
  const { normalizeSearchText } = loadPdfSources();
  assert.equal(
    normalizeSearchText("Çağdaş sanat, müziksel imge ve özgünlük"),
    "cagdas sanat  muziksel imge ve ozgunluk",
  );
});

test("oa bridge request carries title DOI and YÖK tez no", () => {
  const { buildOaSearchRequest, pdfUrlsFromHits } = loadBridge();
  const item = {
    getField(field) {
      if (field === "title") return "Melih Cevdet Anday şiirinde zaman";
      if (field === "DOI") return "10.1000/example";
      if (field === "extra") return "YÖK Tez No: 123456";
      if (field === "ISBN") return "";
      if (field === "url") return "";
      return "";
    },
  };
  const req = buildOaSearchRequest("yoktez", item, 3);
  assert.equal(req.source, "yoktez");
  assert.match(req.text, /Anday/);
  assert.match(req.text, /123456/);
  assert.equal(req.doi, "10.1000/example");
  assert.equal(req.limit, 3);
  assert.deepEqual(
    pdfUrlsFromHits([
      { source: "yoktez", title: "x", pdfUrl: "https://a/pdf" },
      { source: "yoktez", title: "y", pdfUrl: "" },
      { source: "yoktez", title: "z", pdfUrl: "https://a/pdf" },
    ]),
    ["https://a/pdf"],
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
  const { ALL_SOURCES } = loadPdfSources();
  assert.equal(ALL_SOURCES.dergipark.supportsItem({ itemTypeID: 1 }), true);
  assert.equal(ALL_SOURCES.dergipark.supportsItem({ itemTypeID: 2 }), false);
  assert.equal(ALL_SOURCES.dergipark.supportsItem({ itemTypeID: 5 }), false);
  delete global.Zotero;
});

test("YokTez source supports only theses", () => {
  global.Zotero = {
    ItemTypes: {
      getName: (id) => (id === 5 ? "thesis" : "book"),
    },
  };
  const { ALL_SOURCES } = loadPdfSources();
  assert.equal(ALL_SOURCES.yoktez.supportsItem({ itemTypeID: 5 }), true);
  assert.equal(ALL_SOURCES.yoktez.supportsItem({ itemTypeID: 1 }), false);
  assert.equal(ALL_SOURCES.libgen.supportsItem({ itemTypeID: 1 }), true);
  delete global.Zotero;
});
