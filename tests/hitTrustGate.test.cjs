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
    external: ["../utils/prefs", "../utils/metadataNormalize"],
  });
  const module = { exports: {} };
  const stubs = {
    "../utils/prefs": { getPref: () => "" },
    "../utils/metadataNormalize": {
      normalizeDOI: (v) =>
        String(v || "")
          .replace(/^https?:\/\/doi\.org\//i, "")
          .replace(/^doi:\s*/i, "")
          .trim()
          .toLowerCase(),
    },
  };
  const req = (name) => stubs[name] || require(name);
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
  );
  return module.exports;
}

test("filterTrustedHits keeps DOI match and drops weak titles", () => {
  const { filterTrustedHits, trustedPdfUrlsFromHits } = loadBridge();
  const hits = [
    {
      source: "dergipark",
      title: "Completely Unrelated Cooking Guide",
      pdfUrl: "https://example.com/wrong.pdf",
    },
    {
      source: "dergipark",
      title: "Otto Dix ve Der Krieg Gravur Serisi",
      pdfUrl: "https://example.com/right.pdf",
      doi: "10.1000/dix",
    },
  ];
  const trusted = filterTrustedHits(hits, {
    title: "Otto Dix ve Der Krieg Gravür Serisi Üzerine",
    doi: "10.1000/dix",
  });
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/right.pdf");
  assert.deepEqual(
    trustedPdfUrlsFromHits(hits, {
      title: "Otto Dix ve Der Krieg Gravür Serisi Üzerine",
      doi: "",
    }),
    ["https://example.com/right.pdf"],
  );
});

test("filterTrustedHits allows scihub when item has DOI", () => {
  const { filterTrustedHits } = loadBridge();
  // Empty hit title → DOI-keyed Sci-Hub still trusted (title gate N/A).
  const trusted = filterTrustedHits(
    [{ source: "scihub", title: "", pdfUrl: "https://sci-hub.se/p.pdf" }],
    { title: "Anything", doi: "10.1000/x", sourceId: "scihub" },
  );
  assert.equal(trusted.length, 1);
});

test("filterTrustedHits drops short name-only titles (Golub reverse containment)", () => {
  const { filterTrustedHits } = loadBridge();
  const itemTitle = "The mercenaries: an interview with Leon Golub";
  const trusted = filterTrustedHits(
    [
      {
        source: "doi",
        title: "Golub, Leon",
        pdfUrl: "https://example.com/encyclopedia.pdf",
        doi: "10.1093/gao/9781884446054.article.t033121",
      },
      {
        source: "doi",
        title: "Leon Golub",
        pdfUrl: "https://example.com/chapter.pdf",
      },
      {
        source: "doi",
        title: "Interview with Dr. Todd Golub, M.D.",
        pdfUrl: "https://example.com/todd.pdf",
      },
      {
        source: "doi",
        title: "Interview: Leon Golub Talks with Irving Sandler",
        pdfUrl: "https://example.com/sandler.pdf",
      },
      {
        source: "doi",
        title: "The Mercenaries: An Interview with Leon Golub",
        pdfUrl: "https://example.com/right.pdf",
      },
    ],
    { title: itemTitle, doi: "" },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/right.pdf");
});

test("filterTrustedHits drops Turkish Golub essay even with matching wrong DOI", () => {
  const { filterTrustedHits } = loadBridge();
  const itemTitle = "The mercenaries: an interview with Leon Golub";
  const trusted = filterTrustedHits(
    [
      {
        source: "doi",
        title:
          "LEON GOLUB RESIMLERINDE BIR TUR BELLEK OLARAK FOTOGRAFIN KULLANIMI",
        pdfUrl: "https://www.idildergisi.com/makale/pdf/1457710450.pdf",
        doi: "10.7816/idil-05-21-04",
      },
    ],
    { title: itemTitle, doi: "10.7816/idil-05-21-04" },
  );
  assert.equal(trusted.length, 0);
});

test("filterTrustedHits drops Eğitim Örgütlerinde Makyavelist/Çevik false friends", () => {
  const { filterTrustedHits } = loadBridge();
  const itemTitle = "Eğitim örgütlerinde kültürel liderlik ve meslek ahlakı";
  const trusted = filterTrustedHits(
    [
      {
        source: "doi",
        title:
          "Eğitim Örgütlerinde Makyavelist Liderlik: Değerlendirme ve İncelenmesi",
        pdfUrl: "https://example.com/makyavelist.pdf",
        doi: "10.51460/baebd.1595660",
      },
      {
        source: "doi",
        title:
          "Eğitim Örgütlerinde Çevik Liderlik: Bir Ölçek Geliştirme Çalışması",
        pdfUrl: "https://example.com/cevik.pdf",
        doi: "10.51460/baebd.1503632",
      },
      {
        source: "doi",
        title: "Eğitim örgütlerinde kültürel liderlik ve meslek ahlakı",
        pdfUrl: "https://example.com/right.pdf",
        doi: "10.14527/3954",
      },
    ],
    { title: itemTitle, doi: "" },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/right.pdf");
});

test("filterTrustedHits drops Rengin vs İlkel and Sinema containment", () => {
  const { filterTrustedHits } = loadBridge();
  assert.equal(
    filterTrustedHits(
      [
        {
          source: "libgen",
          title: "İlkel topluluktan uygar topluma",
          pdfUrl: "https://example.com/ilkel.pdf",
        },
      ],
      { title: "Rengin etkileşimi", kind: "book", authors: "Josef Albers" },
    ).length,
    0,
  );
  assert.equal(
    filterTrustedHits(
      [
        {
          source: "yoktez",
          title: "Gilles Deleuze'de imge hareketi olarak sinemanın felsefesi",
          pdfUrl: "https://example.com/deleuze.pdf",
        },
      ],
      { title: "Sinemanın felsefesi", kind: "book" },
    ).length,
    0,
  );
  assert.equal(
    filterTrustedHits(
      [
        {
          source: "libgen",
          title: "Sinemanın felsefesi: bir giriş",
          pdfUrl: "https://example.com/ok.pdf",
        },
      ],
      { title: "Sinemanın felsefesi", kind: "book" },
    ).length,
    1,
  );
});

test("filterTrustedHits drops mystic-way book reviews", () => {
  const { filterTrustedHits, isBookReviewHit } = loadBridge();
  const mystic =
    "The mystic way in postmodernity: transcending theological boundaries in the writings of iris murdoch, denise levertov and annie dillard";
  assert.equal(isBookReviewHit(`Book Review: ${mystic}`), true);
  assert.equal(isBookReviewHit(mystic, { crossref_type: "book-review" }), true);
  const trusted = filterTrustedHits(
    [
      {
        source: "doi",
        title: `Book Review: ${mystic}`,
        pdfUrl: "https://example.com/review.pdf",
        extra: { crossref_type: "book-review" },
      },
      {
        source: "doi",
        title: mystic,
        pdfUrl: "https://example.com/typed-review.pdf",
        extra: { crossref_type: "book-review" },
      },
      {
        source: "libgen",
        title: mystic,
        pdfUrl: "https://example.com/book.pdf",
        extra: { title_overlap: 1.0 },
      },
    ],
    { title: mystic, kind: "book" },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/book.pdf");
});

test("filterTrustedHits drops Avangard kuramı journal article", () => {
  const { filterTrustedHits, isJournalArticleHit } = loadBridge();
  assert.equal(
    isJournalArticleHit({ crossref_type: "journal-article" }, "doi"),
    true,
  );
  const trusted = filterTrustedHits(
    [
      {
        source: "dergipark",
        title: "Sanata karşı başkaldırı: avangard",
        pdfUrl: "https://example.com/article.pdf",
        extra: { crossref_type: "journal-article" },
      },
      {
        source: "libgen",
        title: "Avangard kuramı",
        pdfUrl: "https://example.com/book.pdf",
        authors: "Peter Bürger",
        extra: { title_overlap: 1.0 },
      },
    ],
    {
      title: "Avangard kuramı",
      kind: "book",
      authors: "Peter Bürger",
    },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/book.pdf");
});
