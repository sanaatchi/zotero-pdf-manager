// @ajan: cursor · @etiket: katman-2, tests, hit-trust, subtitle-enrich, address-gate
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

test("filterTrustedHits drops post-truth era Arendt article", () => {
  const { filterTrustedHits } = loadBridge();
  const trusted = filterTrustedHits(
    [
      {
        source: "doi",
        title: "Hannah Arendt's Truth and Politics in the Post-Truth Era",
        pdfUrl: "https://ssrn.com/abstract=3209057.pdf",
        authors: "Marcelo F. Ponce",
        year: "2018",
        extra: { crossref_type: "journal-article" },
      },
      {
        source: "libgen",
        title: "Hannah Arendt's Truth and Politics in the Post-Truth Era",
        pdfUrl: "https://example.com/ponce-libgen.pdf",
        authors: "Marcelo F. Ponce",
        year: "2018",
      },
      {
        source: "libgen",
        title:
          "The Post-Truth Era: Dishonesty and Deception in Contemporary Life",
        pdfUrl: "https://example.com/keyes-book.pdf",
        authors: "Ralph Keyes",
        year: "2013",
        extra: { title_overlap: 1.0 },
      },
    ],
    {
      title: "The post-truth era",
      kind: "book",
      authors: "Ralph Keyes",
      year: "2013",
    },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/keyes-book.pdf");
});

test("filterTrustedHits keeps ALL-CAPS Turkish DergiPark titles (TR I fold)", () => {
  const { filterTrustedHits } = loadBridge();
  const itemTitle =
    "Yüksek öğretim kurumlarındaki çağdaş sanat eğitimi müfredatının yeni medya sanatını kapsayıcılığı";
  const trusted = filterTrustedHits(
    [
      {
        source: "dergipark",
        title:
          "YÜKSEK ÖĞRETİM KURUMLARINDAKİ ÇAĞDAŞ SANAT EĞİTİMİ MÜFREDATININ YENİ MEDYA SANATINI KAPSAYICILIĞI",
        pdfUrl: "https://example.com/yuksek.pdf",
        doi: "10.22252/ijca.1091443",
      },
    ],
    {
      title: itemTitle,
      doi: "10.22252/ijca.1091443",
      sourceId: "dergipark",
    },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/yuksek.pdf");
});

test("filterTrustedHits keeps DergiPark glued-space titles", () => {
  const { filterTrustedHits } = loadBridge();
  const cases = [
    [
      "Görsel okuryazarlık ve eleştirel pedagoji: sanatın toplumsal ve pedagojik temellerine gelecekçi bir bakış",
      "Görselokuryazarlık ve eleştirel pedagoji: Sanatın toplumsal ve pedagojik temellerine gelecekçi bir bakış",
    ],
    [
      "Müzik eğitiminin 3-6 yaş çocuğunun gelişiminde özerk olma sürecindeki işlevi",
      "Müzikeğitiminin 3-6 yaş çocuğunun gelişiminde özerk olma sürecindeki işlevi",
    ],
    [
      "Sanat eğitimi alan ve almayan ergenlerin öz-yeterliklerinin incelenmesi",
      "SANATEĞİTİMİ ALAN VE ALMAYAN ERGENLERİN ÖZ-YETERLİKLERİNİN İNCELENMESİ",
    ],
    ["Sanata karşi başkaldiri: avangard", "SANATAKARŞI BAŞKALDIRI: AVANGARD"],
  ];
  for (const [q, h] of cases) {
    const trusted = filterTrustedHits(
      [{ source: "dergipark", title: h, pdfUrl: "https://example.com/ok.pdf" }],
      { title: q, sourceId: "dergipark" },
    );
    assert.equal(
      trusted.length,
      1,
      `expected keep for glued/ALLCAPS: ${q.slice(0, 40)}`,
    );
  }
});

test("filterTrustedHits drops LibGen hits with low title_overlap extra", () => {
  const { filterTrustedHits } = loadBridge();
  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: "The Post-Truth Era",
        pdfUrl: "https://example.com/wrong.pdf",
        extra: { title_overlap: 0.2, query: "9780312306229" },
      },
      {
        source: "libgen",
        title: "The Post-Truth Era",
        pdfUrl: "https://example.com/right.pdf",
        authors: "Ralph Keyes",
        extra: { title_overlap: 0.92 },
      },
    ],
    {
      title: "The Post-Truth Era",
      authors: "Ralph Keyes",
      sourceId: "libgen",
      kind: "book",
    },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/right.pdf");
});

test("filterTrustedHits drops fabricated LibGen title_overlap 1.0 (Chinese ISBN set)", () => {
  const { filterTrustedHits } = loadBridge();
  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: "人大社新闻传播学文库精选第一辑（套装共11册）",
        pdfUrl: "https://example.com/cn-set.pdf",
        extra: { title_overlap: 1.0, via: "json.php" },
      },
      {
        source: "libgen",
        title: "The Post-Truth Era",
        pdfUrl: "https://example.com/keyes.pdf",
        authors: "Ralph Keyes",
        extra: { title_overlap: 1.0 },
      },
    ],
    {
      title: "The post-truth era",
      authors: "Ralph Keyes",
      isbn: "9781429976220",
      sourceId: "libgen",
      kind: "book",
    },
  );
  assert.equal(trusted.length, 1);
  assert.match(trusted[0].title, /Post-Truth/i);
});

test("filterTrustedHits drops Dünya tarihi wrong chronicle LibGen hit", () => {
  const { filterTrustedHits } = loadBridge();
  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: "Dünya Tarihi: Kronolojik Zaman Çizelgeli",
        pdfUrl: "https://example.com/wrong-chronicle.pdf",
        authors: "Kolektif",
        extra: { title_overlap: 1.2 },
      },
    ],
    {
      title: "Dünya tarihi",
      authors: "William H. McNeill; Alaeddin Şenel",
      sourceId: "libgen",
      kind: "book",
    },
  );
  assert.equal(trusted.length, 0);
});

test("filterTrustedHits keeps Şarkiyatçılık LibGen paren subtitle + ISBN", () => {
  const { filterTrustedHits, sameWorkTitle } = loadBridge();
  assert.equal(
    sameWorkTitle("Şarkiyatçılık", "Şarkiyatçılık (Batı'nın Şark Anlayışları)"),
    true,
  );
  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: "Şarkiyatçılık (Batı'nın Şark Anlayışları)",
        pdfUrl: "https://example.com/said.pdf",
        authors: "Edward Said",
        year: "2013",
        extra: { title_overlap: 0.5, isbn: "9789753422369" },
      },
    ],
    {
      title: "Şarkiyatçılık",
      authors: "Edward W. Said; Berna Ülner",
      isbn: "9789753422369",
      year: "2013",
      sourceId: "libgen",
      kind: "book",
    },
  );
  assert.equal(trusted.length, 1);
});

test("filterTrustedHits drops short Devlet with wrong author (thrash gate)", () => {
  const { filterTrustedHits } = loadBridge();
  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: "Devlet",
        pdfUrl: "https://example.com/farabi.pdf",
        authors: "Farabi",
        extra: { title_overlap: 1.0 },
      },
      {
        source: "libgen",
        title: "Devlet",
        pdfUrl: "https://example.com/platon.pdf",
        authors: "Platon",
        extra: { title_overlap: 1.0 },
      },
      {
        source: "libgen",
        title: "Devlet",
        pdfUrl: "https://example.com/anon.pdf",
        extra: { title_overlap: 1.0 },
      },
    ],
    {
      title: "Devlet",
      authors: "Platon; Sabahattin Eyüboğlu",
      isbn: "9789754587173",
      sourceId: "libgen",
      kind: "book",
      year: "2010",
    },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/platon.pdf");
});

test("filterTrustedHits keeps Adorno LibGen title with ISBN/edition chrome", () => {
  const { filterTrustedHits, cleanLibgenTitle, sameWorkTitle } = loadBridge();
  const polluted =
    "Kültür Endüstrisi Kültür Yönetimi 6th Edition 9789750505256; 9750505255 b l 2977293";
  const cleaned = cleanLibgenTitle(polluted);
  assert.equal(cleaned, "Kültür Endüstrisi Kültür Yönetimi");
  assert.equal(
    sameWorkTitle("Kültür endüstrisi kültür yönetimi", cleaned),
    true,
  );
  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: polluted,
        authors: "",
        year: "2007",
        pdfUrl: "https://example.com/adorno.pdf",
        extra: { title_overlap: 1.0 },
      },
    ],
    {
      title: "Kültür endüstrisi kültür yönetimi",
      authors: "Adorno Theodor",
      year: "2007",
      kind: "book",
      sourceId: "libgen",
      isbn: "9789750505256",
    },
  );
  assert.equal(trusted.length, 1);

  // No ISBN on item: cleaned same-work title alone is enough (long title).
  const trustedNoIsbn = filterTrustedHits(
    [
      {
        source: "libgen",
        title: polluted,
        authors: "",
        year: "2007",
        pdfUrl: "https://example.com/adorno.pdf",
        extra: { title_overlap: 1.0 },
      },
    ],
    {
      title: "Kültür endüstrisi kültür yönetimi",
      authors: "Adorno Theodor",
      year: "2007",
      kind: "book",
      sourceId: "libgen",
    },
  );
  assert.equal(trustedNoIsbn.length, 1);

  const wrong = filterTrustedHits(
    [
      {
        source: "libgen",
        title:
          "Tamamen Farklı Kitap 6th Edition 9789750505256; 9750505255 b l 2977293",
        authors: "",
        year: "2007",
        pdfUrl: "https://example.com/wrong.pdf",
        extra: { title_overlap: 0.3 },
      },
    ],
    {
      title: "Kültür endüstrisi kültür yönetimi",
      authors: "Adorno Theodor",
      year: "2007",
      kind: "book",
      sourceId: "libgen",
      isbn: "9789750505256",
    },
  );
  assert.equal(wrong.length, 0);
});

test("filterTrustedHits keeps Seargeant LibGen short core with blank authors", () => {
  const { filterTrustedHits, sameWorkTitle } = loadBridge();
  const itemTitle =
    "The art of political storytelling: why stories win votes in post-truth politics";
  const hitTitle = "The Art of Political Storytelling";
  assert.equal(sameWorkTitle(itemTitle, hitTitle), true);

  const trusted = filterTrustedHits(
    [
      {
        source: "libgen",
        title: hitTitle,
        authors: "",
        year: "",
        pdfUrl: "https://example.com/seargeant.pdf",
        extra: { title_overlap: 0.33 },
      },
    ],
    {
      title: itemTitle,
      authors: "Philip Seargeant",
      year: "2020",
      kind: "book",
      sourceId: "libgen",
      isbn: "9781350107410",
    },
  );
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].pdfUrl, "https://example.com/seargeant.pdf");

  // Distinctive same-work core alone (no item ISBN) still attaches.
  const trustedNoIsbn = filterTrustedHits(
    [
      {
        source: "libgen",
        title: hitTitle,
        authors: "",
        year: "",
        pdfUrl: "https://example.com/seargeant.pdf",
        extra: { title_overlap: 0.33 },
      },
    ],
    {
      title: itemTitle,
      authors: "Philip Seargeant",
      year: "2020",
      kind: "book",
      sourceId: "libgen",
    },
  );
  assert.equal(trustedNoIsbn.length, 1);

  // ISBN + wrong core must still reject.
  const wrong = filterTrustedHits(
    [
      {
        source: "libgen",
        title: "Completely Different Political Book 9781350107410",
        authors: "",
        year: "2020",
        pdfUrl: "https://example.com/wrong.pdf",
        extra: { title_overlap: 0.2 },
      },
    ],
    {
      title: itemTitle,
      authors: "Philip Seargeant",
      year: "2020",
      kind: "book",
      sourceId: "libgen",
      isbn: "9781350107410",
    },
  );
  assert.equal(wrong.length, 0);
});

test("subtitle enrichment: missing subtitle → enrich; wrong core → null; already-full → null", () => {
  const { proposeSubtitleEnrichment, resolveSubtitleEnrichment } = loadBridge();

  const item = "The Art of Political Storytelling";
  const evidence =
    "The Art of Political Storytelling: why stories win votes in post-truth politics";
  assert.equal(proposeSubtitleEnrichment(item, evidence), evidence);

  assert.equal(
    proposeSubtitleEnrichment(
      "Rengin etkileşimi",
      "İlkel topluluktan uygar topluma: Toplumun evrimi",
    ),
    null,
  );

  assert.equal(proposeSubtitleEnrichment(evidence, evidence), null);
  assert.equal(
    proposeSubtitleEnrichment(
      "The Art of Political Storytelling: why stories win",
      evidence,
    ),
    null,
  );

  const pdf = `${evidence}\nPhilip Seargeant\n${"Narrative politics. ".repeat(20)}`;
  const resolved = resolveSubtitleEnrichment(item, {
    pdfText: pdf,
    authorOk: true,
  });
  assert.equal(resolved, evidence);
});

test("subtitle enrichment: reject TÜBA publisher street/postal address", () => {
  const {
    proposeSubtitleEnrichment,
    resolveSubtitleEnrichment,
    looksLikeAddressOrPublisherHq,
  } = loadBridge();

  const item = "Tarihi ve Etimolojik Türkiye Türkçesi Lügatı";
  const addr = "Türkiye Bilimler Akademisi Piyade Sokak No 27, 06690";
  assert.equal(looksLikeAddressOrPublisherHq(addr), true);
  assert.equal(proposeSubtitleEnrichment(item, `${item}: ${addr}`), null);

  const pdf = `${item}\n${addr}\n${"Bu lügat Türkçenin etimolojik sözlüğüdür. ".repeat(12)}`;
  assert.equal(
    resolveSubtitleEnrichment(item, { pdfText: pdf, authorOk: true }),
    null,
  );

  // Seargeant topical subtitle still enriches (parity with Python).
  const seargeant =
    "The Art of Political Storytelling: why stories win votes in post-truth politics";
  assert.equal(
    proposeSubtitleEnrichment("The Art of Political Storytelling", seargeant),
    seargeant,
  );
});
