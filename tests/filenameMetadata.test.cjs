const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/filenameMetadata.ts")],
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

test("author-year-title filenames are parsed conservatively", () => {
  const { parseFilenameMetadata } = loadModule();

  assert.deepEqual(
    parseFilenameMetadata("Yılmaz, Ahmet - 2021 - Kitap Adı.pdf"),
    {
      itemType: "document",
      authors: ["Yılmaz, Ahmet"],
      year: "2021",
      title: "Kitap Adı",
    },
  );
});

test("parenthesized year filenames are parsed", () => {
  const { parseFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    "Doe, John (2019) A Reliable Paper Title.pdf",
  );

  assert.equal(parsed.year, "2019");
  assert.equal(parsed.title, "A Reliable Paper Title");
  assert.deepEqual(parsed.authors, ["Doe, John"]);
});

test("explicit Turkish labels provide publisher and multiple authors", () => {
  const { parseFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    "Yazar: Ak, Ali; Demir, Ece__Başlık: Örnek Kitap__Yıl: 2020__Yayınevi: Bilgi.pdf",
  );

  assert.equal(parsed.title, "Örnek Kitap");
  assert.equal(parsed.year, "2020");
  assert.equal(parsed.publisher, "Bilgi");
  assert.deepEqual(parsed.authors, ["Ak, Ali", "Demir, Ece"]);
});

test("metadata application fills blanks without overwriting existing fields", () => {
  const { applyFilenameMetadata } = loadModule();
  const fields = { title: "Existing title", date: "", publisher: "" };
  let creators = [];
  const item = {
    getField: (field) => fields[field] || "",
    setField: (field, value) => {
      fields[field] = value;
    },
    getCreators: () => creators,
    setCreators: (value) => {
      creators = value;
    },
  };

  const changed = applyFilenameMetadata(item, {
    title: "Replacement",
    year: "2022",
    publisher: "Press",
    authors: ["Doe, Jane"],
  });

  assert.equal(fields.title, "Existing title");
  assert.equal(fields.date, "2022");
  assert.equal(fields.publisher, "Press");
  assert.deepEqual(changed, ["date", "publisher", "creators"]);
  assert.equal(creators[0].lastName, "Doe");
  assert.equal(creators[0].firstName, "Jane");
});

test("author-title-volume year-publisher filenames ignore source suffixes", () => {
  const { parseFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    "Andreas Tietze — Tarihi ve Etimolojik Türkiye Türkçesi Lugati III 3 (2016, TÜBA Yayınları) — libgen.li.pdf",
  );

  assert.deepEqual(parsed, {
    itemType: "book",
    authors: ["Andreas Tietze"],
    title: "Tarihi ve Etimolojik Türkiye Türkçesi Lugati III",
    volume: "3",
    year: "2016",
    publisher: "TÜBA Yayınları",
  });
  assert.doesNotMatch(JSON.stringify(parsed), /libgen/i);
});

test("LibGen spaced DOI and ISBN bracket is normalized safely", () => {
  const { parseFilenameMetadata } = loadModule();

  assert.deepEqual(
    parseFilenameMetadata(
      "Tim Ingold — The Life of Lines (2015, Routledge) [10.4324 9781315727240] — libgen.li.pdf",
    ),
    {
      itemType: "book",
      authors: ["Tim Ingold"],
      title: "The Life of Lines",
      year: "2015",
      publisher: "Routledge",
      doi: "10.4324/9781315727240",
      isbn: "9781315727240",
    },
  );
});

test("LibGen domain suffix is not mistaken for the attachment extension", () => {
  const { isRawFilenameTitle } = loadModule();
  assert.equal(
    isRawFilenameTitle(
      "Andreas Tietze — Eser 2 (2018, Yayınevi) — libgen.li",
      "Andreas Tietze - Eser 2 (2018, Yayınevi) - libgen.li.pdf",
    ),
    true,
  );
});

test("stray closing parenthesis is removed and uncommaed author is split", () => {
  const { parseFilenameMetadata, applyFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    ") Andreas Tietze — Tarihi ve Etimolojik Türkiye Türkçesi Lugati III 3 (2016, TÜBA Yayınları) — libgen.li.pdf",
  );
  let creators = [];
  const item = {
    getField: () => "",
    setField: () => {},
    getCreators: () => [],
    setCreators: (value) => {
      creators = value;
    },
  };
  applyFilenameMetadata(item, parsed);

  assert.deepEqual(parsed.authors, ["Andreas Tietze"]);
  assert.deepEqual(creators, [
    {
      firstName: "Andreas",
      lastName: "Tietze",
      creatorType: "author",
    },
  ]);
});

test("surname-initial year title type publisher filenames are parsed", () => {
  const { parseFilenameMetadata, applyFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    "Foucault M. (0206) Kliniğin doğuşu. [book] Epos Yayınları.pdf",
  );
  let creators = [];
  const item = {
    getField: () => "",
    setField: () => {},
    getCreators: () => [],
    setCreators: (value) => {
      creators = value;
    },
  };
  applyFilenameMetadata(item, parsed);

  assert.deepEqual(parsed, {
    authors: ["Foucault M."],
    year: "2006",
    title: "Kliniğin doğuşu",
    itemType: "book",
    publisher: "Epos Yayınları",
  });
  assert.deepEqual(creators, [
    {
      firstName: "M.",
      lastName: "Foucault",
      creatorType: "author",
    },
  ]);
});

test("APA book filenames are parsed without positional guessing", () => {
  const { parseFilenameMetadata } = loadModule();

  assert.deepEqual(
    parseFilenameMetadata(
      "Foucault, Michel. (2006). Kliniğin doğuşu. Epos Yayınları.pdf",
    ),
    {
      itemType: "document",
      authors: ["Foucault, Michel"],
      year: "2006",
      title: "Kliniğin doğuşu",
      publisher: "Epos Yayınları",
    },
  );
});

test("four-part author title publisher year filenames are parsed", () => {
  const { parseFilenameMetadata } = loadModule();

  assert.deepEqual(
    parseFilenameMetadata(
      "Michel Foucault — Kliniğin Doğuşu — Epos Yayınları — 2006.pdf",
    ),
    {
      itemType: "document",
      authors: ["Michel Foucault"],
      title: "Kliniğin Doğuşu",
      publisher: "Epos Yayınları",
      year: "2006",
    },
  );
});

test("four-part author year title publisher filenames are parsed", () => {
  const { parseFilenameMetadata } = loadModule();

  assert.deepEqual(
    parseFilenameMetadata(
      "Michel Foucault — 2006 — Kliniğin Doğuşu — Epos Yayınları.pdf",
    ),
    {
      itemType: "document",
      authors: ["Michel Foucault"],
      year: "2006",
      title: "Kliniğin Doğuşu",
      publisher: "Epos Yayınları",
    },
  );
});

test("four-part bracketed year filenames are parsed", () => {
  const { parseFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    "Walter Benjamin — Pasajlar — [1993] — Yapı Kredi Yayınları.pdf",
  );

  assert.deepEqual(parsed, {
    itemType: "document",
    authors: ["Walter Benjamin"],
    title: "Pasajlar",
    year: "1993",
    publisher: "Yapı Kredi Yayınları",
  });
});

test("explicit bibliographic labels fill extended safe fields", () => {
  const { parseFilenameMetadata } = loadModule();
  const parsed = parseFilenameMetadata(
    "Yazar: Ada Lovelace__Başlık: Notes__Yıl: 1843__Dergi: Scientific Memoirs__Cilt: 3__Sayı: 4__Sayfa: 666-731__Yer: London.pdf",
  );

  assert.deepEqual(parsed, {
    itemType: "document",
    authors: ["Ada Lovelace"],
    title: "Notes III",
    year: "1843",
    volume: "3",
    issue: "4",
    pages: "666-731",
    place: "London",
    publicationTitle: "Scientific Memoirs",
  });
});

test("typed journal filenames map the trailing journal title safely", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Göktepe (2020) Romantizm sanat akımı üzerine bir değerlendirme [journalArticle] Journal of Arts.pdf",
    ),
    {
      authors: ["Göktepe"],
      year: "2020",
      title: "Romantizm sanat akımı üzerine bir değerlendirme",
      itemType: "journalArticle",
      publicationTitle: "Journal of Arts",
    },
  );
});

test("typed filenames split only explicitly separated multiple authors", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Altıok M., Akatlı Z. (2013) Metin Altıok'tan Zeynep'e mektuplar [book] Kırmızı Kedi Yayınevi.pdf",
    ).authors,
    ["Altıok M.", "Akatlı Z."],
  );
  assert.deepEqual(
    parseFilenameMetadata(
      "Breinholt ve Jaeger (2020) Cultural capital [journalArticle] Sociology.pdf",
    ).authors,
    ["Breinholt", "Jaeger"],
  );
});

test("explicit Turkish thesis and report types are recognized", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Ahmet Yılmaz (2022) Sanat eğitimi üzerine [yüksek lisans tezi] Ankara Üniversitesi.pdf",
    ),
    {
      authors: ["Ahmet Yılmaz"],
      year: "2022",
      title: "Sanat eğitimi üzerine",
      itemType: "thesis",
      thesisType: "Yüksek Lisans Tezi",
      publisher: "Ankara Üniversitesi",
    },
  );
  assert.equal(
    parseFilenameMetadata("Ayşe Kaya (2021) Kültür politikaları [rapor].pdf")
      .itemType,
    "report",
  );
});

test("English and Turkish publication markers use the same Zotero types", () => {
  const { parseFilenameMetadata } = loadModule();
  const pairs = [
    ["book", "kitap", "book"],
    ["journalArticle", "makale", "journalArticle"],
    ["doctoral thesis", "doktora tezi", "thesis"],
    ["report", "rapor", "report"],
    ["conference paper", "bildiri", "conferencePaper"],
    ["presentation", "sunum", "presentation"],
    ["manuscript", "el yazması", "manuscript"],
  ];
  for (const [english, turkish, expected] of pairs) {
    assert.equal(
      parseFilenameMetadata(`Doe (2020) Sample [${english}].pdf`).itemType,
      expected,
    );
    assert.equal(
      parseFilenameMetadata(`Yılmaz (2020) Örnek [${turkish}].pdf`).itemType,
      expected,
    );
  }
});

test("curated archive filenames provide book metadata and ISBN", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Stephen Hawking - Zamanın Kısa Tarihi - 2013 - Alfa Yayınları - ISBN 9786051067582 - KP000048.pdf",
    ),
    {
      authors: ["Stephen Hawking"],
      title: "Zamanın Kısa Tarihi",
      year: "2013",
      publisher: "Alfa Yayınları",
      isbn: "9786051067582",
      itemType: "book",
    },
  );
});

test("LibGen brace filenames provide initial book metadata", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Dakikalar İçinde Felsefe — Anında Açıklanan 200 Temel Kavram{Marcus Weeks}(2023, Kronik Kitap){115422695} libgen.li.pdf",
    ),
    {
      itemType: "book",
      title: "Dakikalar İçinde Felsefe — Anında Açıklanan 200 Temel Kavram",
      shortTitle: "Dakikalar İçinde Felsefe",
      authors: ["Marcus Weeks"],
      year: "2023",
      publisher: "Kronik Kitap",
    },
  );
});

test("LibGen brace title and subtitle stay in the full Zotero title", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Dakikalar İçinde Genetik — Anında Açıklanan 200 Temel Kavram{Tom Jackson}(2022, Kronik Kitap){114110655} libgen.li.pdf",
    ),
    {
      itemType: "book",
      title: "Dakikalar İçinde Genetik — Anında Açıklanan 200 Temel Kavram",
      shortTitle: "Dakikalar İçinde Genetik",
      authors: ["Tom Jackson"],
      year: "2022",
      publisher: "Kronik Kitap",
    },
  );
});

test("LibGen author-title filenames without a year retain safe fields", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Thomas Kuhn — Kopernik Devrimi (İmge) — libgen.li.pdf",
    ),
    {
      itemType: "book",
      authors: ["Thomas Kuhn"],
      title: "Kopernik Devrimi",
      publisher: "İmge",
    },
  );
});

test("KorPiracy brace filenames without a year discard source noise", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "[KorPiracy — KorPiracy] Şiir Atlası 2{Cevat Çapan}(Kavram Yayınları){112193818} libgen.li.pdf",
    ),
    {
      itemType: "book",
      title: "Şiir Atlası II",
      volume: "2",
      authors: ["Cevat Çapan"],
      publisher: "Kavram Yayınları",
    },
  );
});

test("numeric volumes are appended to titles as uppercase Roman numerals", () => {
  const { volumeAsRoman, parseFilenameMetadata } = loadModule();
  assert.equal(volumeAsRoman("1"), "I");
  assert.equal(volumeAsRoman("4"), "IV");
  assert.equal(volumeAsRoman("10"), "X");
  assert.equal(
    parseFilenameMetadata(
      "Andreas Tietze — Lugat III 3 (2016, TÜBA) — libgen.li.pdf",
    ).title,
    "Lugat III",
  );
});

test("KorPiracy Dakikalar İçinde Sanat filename is parsed exactly", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "[KorPiracy — KorPiracy] Dakikalar İçinde Sanat{Susie Hodge}(Kronik Yayınları){111926442} libgen.li.pdf",
    ),
    {
      itemType: "book",
      title: "Dakikalar İçinde Sanat",
      authors: ["Susie Hodge"],
      publisher: "Kronik Yayınları",
    },
  );
});

test("renamed attachment wrappers do not hide a KorPiracy filename", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "() [KorPiracy — KorPiracy] Dakikalar İçinde Sanat{Susie Hodge}(Kronik Yayınları){111926442} libgen.li [document].pdf",
    ),
    {
      itemType: "book",
      title: "Dakikalar İçinde Sanat",
      authors: ["Susie Hodge"],
      publisher: "Kronik Yayınları",
    },
  );
});

test("stored orphan source path wins over a renamed attachment filename", () => {
  const { sourceFilenameForMetadata } = loadModule();
  assert.equal(
    sourceFilenameForMetadata(
      "Citation Key: example\nZPDF-Source-Path: D:\\Books\\[KorPiracy — KorPiracy] Dakikalar İçinde Sanat{Susie Hodge}(Kronik Yayınları){111926442} libgen.li.pdf",
      "D:\\Books\\() Dakikalar İçinde Sanat. [book].pdf",
    ),
    "[KorPiracy — KorPiracy] Dakikalar İçinde Sanat{Susie Hodge}(Kronik Yayınları){111926442} libgen.li.pdf",
  );
});

test("explicit filename type can repair a wrong auto-created item type", () => {
  const { applyFilenameMetadata } = loadModule();
  const previousZotero = global.Zotero;
  global.Zotero = {
    ItemTypes: {
      getName: (id) => (id === 1 ? "book" : "journalArticle"),
      getID: (name) => (name === "journalArticle" ? 2 : 1),
    },
  };
  let itemTypeID = 1;
  const item = {
    get itemTypeID() {
      return itemTypeID;
    },
    setType: (id) => {
      itemTypeID = id;
    },
    getField: () => "existing",
    getCreators: () => [{}],
  };
  try {
    const changed = applyFilenameMetadata(
      item,
      { itemType: "journalArticle" },
      true,
    );
    assert.equal(itemTypeID, 2);
    assert.deepEqual(changed, ["itemType"]);
  } finally {
    global.Zotero = previousZotero;
  }
});

test("original auto-created title and filename are preserved in Extra once", () => {
  const { preserveOriginalMetadataInExtra } = loadModule();
  const first = preserveOriginalMetadataInExtra(
    "ZPDF-Source-Path: D:\\Books\\source.pdf",
    "Raw filename title",
    "source.pdf",
  );
  const second = preserveOriginalMetadataInExtra(
    first,
    "A later title",
    "renamed.pdf",
  );
  assert.match(first, /ZPDF-Original-Title: Raw filename title/);
  assert.match(first, /ZPDF-Original-Filename: source\.pdf/);
  assert.equal(second, first);
});

test("explicit Turkish academic thesis filenames are parsed", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Kılınç Gökcen Meryem. Sanat, iktidar, beden. Anadolu Üniversitesi, [Sanatta yeterlik tezi], 2016.pdf",
    ),
    {
      itemType: "thesis",
      authors: ["Kılınç Gökcen Meryem"],
      title: "Sanat, iktidar, beden",
      university: "Anadolu Üniversitesi",
      thesisType: "Sanatta Yeterlik Tezi",
      year: "2016",
    },
  );
});

test("archive year 0000 is treated as missing rather than a date", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Ansiklopedisi - Türk Aile Ansiklopedisi 3 - 0000 - Unknown - ISBN NA - KP003266.pdf",
    ),
    {
      itemType: "book",
      authors: ["Ansiklopedisi"],
      title: "Türk Aile Ansiklopedisi 3",
    },
  );
});

test("APA archive filenames with ISBN and catalogue code are parsed", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata(
      "Balanuye, Çetin (2017). Spinoza'nın sevinci nereden geliyor. Ayrıntı Yayınları - ISBN 9786053141525 - KP001352.pdf",
    ),
    {
      itemType: "book",
      authors: ["Balanuye, Çetin"],
      title: "Spinoza'nın sevinci nereden geliyor",
      year: "2017",
      publisher: "Ayrıntı Yayınları",
      isbn: "9786053141525",
    },
  );
});

test("title-author-place-year archive form requires a known place", () => {
  const { parseFilenameMetadata } = loadModule();
  assert.deepEqual(
    parseFilenameMetadata("101 Kelam - Ramiz Abdullayev - Bakü - 2010.pdf"),
    {
      itemType: "book",
      title: "101 Kelam",
      authors: ["Ramiz Abdullayev"],
      place: "Bakü",
      year: "2010",
    },
  );
});
