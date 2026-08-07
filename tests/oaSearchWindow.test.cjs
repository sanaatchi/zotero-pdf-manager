// @ajan: cursor · @etiket: katman-2, tests, oa-search, multi-source, pdfkitap
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadActions() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/oaSearchActions.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["./oaPdfBridge", "./pdfSources"],
  });
  const module = { exports: {} };
  const req = (id) => {
    if (id.includes("oaPdfBridge")) {
      return {
        fetchOaPdfViaBridge: async () => null,
        filterTrustedHits: (hits) => hits,
      };
    }
    if (id.includes("pdfSources")) {
      return {
        downloadAndAttach: async () => null,
        rethrowAttachControlFlow: () => {},
      };
    }
    return require(id);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
  );
  return module.exports;
}

test("createItemFieldsFromHit maps DOI article and ISBN book", () => {
  const {
    createItemFieldsFromHit,
    guessItemTypeFromHit,
    parseAuthorsField,
    relatedPairIds,
    isRetryableOaFetchError,
    fallbackHitsForAttach,
    humanizeOaFetchError,
    DOI_PAYWALL_HINT,
  } = loadActions();

  assert.equal(isRetryableOaFetchError("oa_pdf fetch doi: HTTP 502"), true);
  assert.equal(
    humanizeOaFetchError(
      "oa_pdf fetch doi: köprü PDF indirme başarısız (HTTP 500)",
    ),
    DOI_PAYWALL_HINT,
  );
  assert.equal(
    humanizeOaFetchError(
      "oa_pdf fetch doi: Açık PDF yok (ücretli/paywall) — Unpaywall’da tam metin yok.",
    ),
    DOI_PAYWALL_HINT,
  );
  assert.equal(
    isRetryableOaFetchError("downloadAndAttach returned null (disk/link)"),
    false,
  );
  const fallbacks = fallbackHitsForAttach(
    { source: "doi", pdfUrl: "https://a.example/a.pdf", title: "A" },
    [
      { source: "doi", pdfUrl: "https://a.example/a.pdf", title: "A" },
      { source: "scihub", pdfUrl: "https://s.example/s.pdf", title: "S" },
      { source: "dergipark", pdfUrl: "https://d.example/d.pdf", title: "D" },
    ],
  );
  assert.equal(fallbacks[0].source, "dergipark");

  const article = createItemFieldsFromHit({
    source: "doi",
    title: "Sample Paper",
    doi: "10.1000/xyz",
    year: "2020",
    authors: "Doe, Jane; Smith, John",
    landingUrl: "https://example.org/a",
  });
  assert.equal(article.itemType, "journalArticle");
  assert.equal(article.DOI, "10.1000/xyz");
  assert.equal(article.creators.length, 2);
  assert.equal(article.creators[0].lastName, "Doe");
  assert.equal(article.creators[0].firstName, "Jane");

  assert.equal(
    guessItemTypeFromHit({
      source: "libgen",
      title: "Book",
      extra: { isbn: "978-0-00-000000-0" },
    }),
    "book",
  );
  assert.equal(
    guessItemTypeFromHit({ source: "yoktez", title: "Tez" }),
    "thesis",
  );

  const fullJournal = createItemFieldsFromHit(
    {
      source: "libgen",
      title: "Toplum ve Bilim",
      year: "1995",
    },
    { preferredItemType: "periodical" },
  );
  assert.equal(fullJournal.itemType, "book");

  assert.deepEqual(parseAuthorsField("Ada Lovelace"), [
    { firstName: "Ada", lastName: "Lovelace", creatorType: "author" },
  ]);
  assert.deepEqual(relatedPairIds(9, 3), [3, 9]);
  assert.deepEqual(relatedPairIds(2, 2), [2, 2]);
});

test("attachHitToItem source skips content validation for user picks", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/modules/oaSearchActions.ts"),
    "utf8",
  );
  assert.match(src, /validate:\s*false/);
  assert.match(src, /attachPdfFromUrl|trust|user-picked|Explicit OA Search/i);
});

test("rankOaHits prefers PDF rows; filterOaHits drops landing-only", () => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/oaSearchWindow.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: [
      "../utils/locale",
      "./oaPdfBridge",
      "./oaSearchActions",
      "../../package.json",
    ],
  });
  const module = { exports: {} };
  const req = (id) => {
    if (id.endsWith("package.json")) {
      return { config: { addonName: "t", addonRef: "zpdfmanager" } };
    }
    if (id.includes("locale")) return { getString: (k) => k };
    if (id.includes("oaPdfBridge")) {
      return {
        allFederatedSourceIds: () => ["doi", "pmc"],
        FEDERATED_SOURCE_LABEL: { doi: "DOI", pmc: "PMC" },
        loadOaSearchSourceSelection: () => ["doi"],
        saveOaSearchSourceSelection: () => {},
        enabledFederatedSourceIds: () => ["doi"],
        searchAllOaSourcesByQuery: async () => ({ hits: [] }),
      };
    }
    if (id.includes("oaSearchActions")) {
      return {
        attachHitToItem: async () => false,
        attachToSelectedWithRelated: async () => ({
          attachmentOk: false,
          relatedItem: null,
        }),
        createItemFromHit: async () => ({}),
      };
    }
    return require(id);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
  );
  const { rankOaHits, filterOaHits } = module.exports;
  const ranked = rankOaHits([
    { source: "a", title: "no", score: 0.99 },
    { source: "b", title: "yes", pdfUrl: "https://x/a.pdf", score: 0.5 },
  ]);
  assert.equal(ranked[0].source, "b");
  assert.equal(
    filterOaHits(
      [
        { source: "a", title: "no" },
        { source: "b", title: "yes", pdfUrl: "https://x/a.pdf" },
      ],
      true,
    ).length,
    1,
  );
});

test("OA search surface: xhtml + menubar + locales + menu wiring", () => {
  const root = process.cwd();
  const xhtml = fs.readFileSync(
    path.join(root, "addon/chrome/content/oa-search.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /zpdfmanager-oa-shell/);
  assert.match(xhtml, /zpdfmanager-oa-tbody/);
  assert.match(xhtml, /data-label="Seçiliye ekle"/);
  assert.match(xhtml, /zpdfmanager-oa-pdf-only/);
  assert.match(xhtml, /zpdfmanager-oa-sources/);
  assert.match(xhtml, /zpdfmanager-oa-sources-all/);
  assert.match(xhtml, /zpdfmanager-oa-kind/);
  assert.match(xhtml, /data-field="university"/);

  const win = fs.readFileSync(
    path.join(root, "src/modules/oaSearchWindow.ts"),
    "utf8",
  );
  assert.match(win, /openOaSearchWindow/);
  assert.match(win, /initOaSearchWindow/);
  assert.match(win, /oa-search\.xhtml/);
  assert.match(win, /uiString/);
  assert.match(win, /syncTargetFromPane/);
  assert.match(win, /LABEL_FALLBACK/);
  assert.match(win, /waitForOaDom/);
  assert.match(win, /bindSearchTrigger/);
  assert.match(win, /filterOaHits/);
  assert.match(win, /rankOaHits/);
  assert.match(win, /applyPrimaryAction/);
  assert.match(win, /renderSourcePicker/);
  assert.match(win, /persistSelectedSources/);
  assert.match(win, /oa-search-need-sources/);
  assert.match(win, /sources,\s*\n\s*\}/);
  assert.match(win, /profile:\s*"full"/);
  assert.match(
    win,
    /arama için gerekmez|selection is optional|Zotero selection is optional|gerekmez/,
  );

  const menubar = fs.readFileSync(
    path.join(root, "src/modules/menubar.ts"),
    "utf8",
  );
  assert.match(menubar, /pdf-manager-menu/);
  assert.match(menubar, /main-menubar/);
  assert.match(menubar, /openOaSearchWindow/);

  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  assert.match(menu, /registerPdfManagerMenubar/);
  assert.match(menu, /openOaSearchWindow/);
  assert.match(menu, /pdf-federated-menu/);

  const bridge = fs.readFileSync(
    path.join(root, "src/modules/oaPdfBridge.ts"),
    "utf8",
  );
  assert.match(bridge, /searchAllOaSourcesByQuery/);
  assert.match(bridge, /loadOaSearchSourceSelection/);
  assert.match(bridge, /saveOaSearchSourceSelection/);
  assert.match(bridge, /allFederatedSourceIds/);
  assert.match(bridge, /pdfkitap:\s*"pdf\.pdfkitapEnabled"/);
  assert.match(bridge, /pdfkitap:\s*"PDFKitap"/);
  assert.doesNotMatch(bridge, /arxiv:\s*"pdf\.arxivEnabled"/);
  assert.doesNotMatch(bridge, /arxiv:\s*"arXiv"/);

  const keys = [
    "pdf-manager-menu",
    "oa-search-open",
    "oa-search-title",
    "oa-search-attach",
    "oa-search-create",
    "oa-search-related",
    "oa-search-pdf-only",
    "oa-search-dblclick-hint",
    "oa-search-sources",
    "oa-search-need-sources",
  ];
  for (const locale of ["en-US", "de", "it-IT"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", locale, "addon.ftl"),
      "utf8",
    );
    for (const key of keys) {
      assert.match(ftl, new RegExp(`^${key}\\s*=`, "m"));
    }
  }
});
