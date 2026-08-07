// @ajan: cursor · @etiket: katman-2, yoktez, pdfkitap, test
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
    getCreators() {
      return [];
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

test("oa bridge request embeds thesis kind criteria from item", () => {
  const { buildOaSearchRequest } = loadBridge();
  global.Zotero.ItemTypes = { getName: () => "thesis" };
  const item = {
    itemTypeID: 1,
    getField(field) {
      return (
        {
          title: "Soyut resme bakis",
          date: "2015-06-01",
          language: "tr",
          university: "Mimar Sinan",
          thesisType: "Yüksek Lisans",
          DOI: "",
          ISBN: "",
          extra: "",
          url: "",
        }[field] || ""
      );
    },
    getCreators() {
      return [{ firstName: "Ayşe", lastName: "Yılmaz", creatorType: "author" }];
    },
  };
  const req = buildOaSearchRequest("yoktez", item, 3);
  assert.equal(req.kind, "thesis");
  assert.equal(req.year, "2015");
  assert.equal(req.language, "tr");
  assert.equal(req.university, "Mimar Sinan");
  assert.equal(req.thesisType, "Yüksek Lisans");
  assert.match(req.authors, /Yılmaz/);
});

test("filterTrustedHits drops year mismatch when year provided", () => {
  const { filterTrustedHits } = loadBridge();
  const kept = filterTrustedHits(
    [
      {
        source: "doi",
        title: "The mercenaries interview Leon Golub",
        pdfUrl: "https://a/x.pdf",
        year: "2010",
      },
      {
        source: "doi",
        title: "The mercenaries interview Leon Golub",
        pdfUrl: "https://a/y.pdf",
        year: "1990",
      },
    ],
    {
      title: "The mercenaries interview Leon Golub",
      year: "2010",
    },
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].year, "2010");
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
  delete global.Zotero;
});

test("yoktezUnavailableMessage explains NO_PERMIT", () => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pythonPdfSources.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["./pdfSources", "./oaPdfBridge", "../utils/prefs"],
  });
  const module = { exports: {} };
  const stubs = {
    "./oaPdfBridge": {
      buildOaSearchRequest: () => ({}),
      filterTrustedHits: (h) => h,
      fetchOaPdfViaBridge: async () => null,
      hitNeedsBridgeFetch: () => false,
      searchOaPdfBridge: async () => [],
    },
    "./pdfSources": {},
    "../utils/prefs": { getPref: () => false },
  };
  const req = (name) => stubs[name] || require(name);
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
  );
  const msg = module.exports.yoktezUnavailableMessage({
    source: "yoktez",
    title: "Sanatsal yaratıcılıkta soyutlama",
    extra: {
      display_no: 128122,
      asset_status: 3,
      asset_status_name: "NO_PERMIT",
      info_message:
        "Bu tezin, veri tabanı üzerinden yayınlanma izni bulunmamaktadır.",
    },
  });
  assert.match(msg, /128122/);
  assert.match(msg, /izin yok|izni yok/i);
  assert.match(msg, /bulundu/);
  assert.doesNotMatch(msg, /bulunamadı/);
});

test("LibGen supports books and articles (TR articles filtered by priority)", () => {
  global.Zotero = {
    ItemTypes: {
      getName: (id) =>
        ({ 1: "journalArticle", 2: "book", 5: "thesis" })[id] || "book",
    },
  };
  const { ALL_SOURCES } = loadPdfSources();
  assert.equal(ALL_SOURCES.libgen.supportsItem({ itemTypeID: 2 }), true);
  assert.equal(ALL_SOURCES.libgen.supportsItem({ itemTypeID: 1 }), true);
  assert.equal(ALL_SOURCES.libgen.supportsItem({ itemTypeID: 5 }), false);
  delete global.Zotero;
});

test("PDFKitap is registered and supports books and articles", () => {
  global.Zotero = {
    ItemTypes: {
      getName: (id) =>
        ({ 1: "journalArticle", 2: "book", 5: "thesis" })[id] || "book",
    },
  };
  const { ALL_SOURCES } = loadPdfSources();
  assert.ok(ALL_SOURCES.pdfkitap);
  assert.equal(ALL_SOURCES.pdfkitap.id, "pdfkitap");
  assert.equal(ALL_SOURCES.pdfkitap.supportsItem({ itemTypeID: 2 }), true);
  assert.equal(ALL_SOURCES.pdfkitap.supportsItem({ itemTypeID: 1 }), true);
  assert.equal(ALL_SOURCES.pdfkitap.supportsItem({ itemTypeID: 5 }), false);
  delete global.Zotero;
});
