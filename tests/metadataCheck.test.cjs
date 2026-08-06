const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/metadataCheck.ts")],
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

test("metadata check accepts normalized matching fields", () => {
  const { compareMetadata } = loadModule();
  const result = compareMetadata(
    {
      title: "Yedinci Adam: Avrupa'daki Göçmen İşçiler",
      creators: ["John Berger"],
      year: "2011",
      doi: "https://doi.org/10.1000/ABC.12",
      isbn: "978-975-00-0000-3",
    },
    {
      title: "Yedinci Adam Avrupa’daki Göçmen İşçiler",
      creators: ["Berger, John"],
      year: "2011",
      doi: "DOI: 10.1000/abc.12",
      isbn: "ISBN 9789750000003",
    },
  );

  assert.equal(result.status, "match");
  assert.equal(result.score, 100);
});

test("DOI or ISBN conflicts are critical metadata mismatches", () => {
  const { compareMetadata } = loadModule();
  const result = compareMetadata(
    {
      title: "Same title",
      creators: ["Author Name"],
      doi: "10.1000/right",
    },
    {
      title: "Same title",
      creators: ["Author Name"],
      doi: "10.1000/wrong",
    },
  );

  assert.equal(result.status, "mismatch");
  assert.equal(
    result.details.some((detail) => detail.includes("DOI uyuşmuyor")),
    true,
  );
});

test("missing embedded PDF fields produce a warning, not a false match", () => {
  const { compareMetadata } = loadModule();
  const result = compareMetadata(
    { title: "A Book", creators: ["Ada Author"], year: "2020" },
    {},
  );

  assert.equal(result.status, "warning");
  assert.equal(result.score, 0);
});

test("PDF page text can verify metadata when embedded fields are empty", () => {
  const { compareMetadata } = loadModule();
  const result = compareMetadata(
    {
      title: "Ailenin Özel Mülkiyetin ve Devletin Kökeni",
      creators: ["Friedrich Engels"],
      year: "1884",
      isbn: "9789757399148",
    },
    {
      evidence:
        "FRIEDRICH ENGELS\nAilenin, Özel Mülkiyetin ve Devletin Kökeni\n" +
        "İlk basım 1884\nISBN 978-975-7399-14-8",
    },
  );

  assert.equal(result.status, "match");
  assert.equal(result.score, 100);
  assert.equal(
    result.details.includes("Başlık PDF içeriğinde eşleşiyor"),
    true,
  );
});

test("a Zotero ISBN that fails its own check digit is not treated as a real conflict (OCR 0/8/3 digit confusion)", () => {
  const { compareMetadata, hasIdentifierConflict } = loadModule();
  // Real case: stored "970-625-6774-03-4" (check digit fails; also not a
  // real 978/979 prefix) vs the PDF's actual, checksum-valid ISBN.
  const result = compareMetadata(
    {
      title: "Dakikalar içinde Selçuklular",
      creators: ["Cihan Piyadeoğlu"],
      isbn: "970-625-6774-03-4",
    },
    {
      evidence:
        "Dakikalar İçinde Selçuklular\nCihan Piyadeoğlu\nISBN 978-625-6774-83-4",
    },
  );
  assert.notEqual(result.status, "mismatch");
  assert.equal(hasIdentifierConflict(result), false);
  assert.equal(
    result.details.some((d) => d.includes("kontrol basamağı geçersiz")),
    true,
  );
});

test("two genuinely different, checksum-valid ISBNs still hard-fail as a conflict", () => {
  const { compareMetadata, hasIdentifierConflict } = loadModule();
  const result = compareMetadata(
    {
      title: "Same title",
      creators: ["Author Name"],
      isbn: "978-0-13-468599-1",
    },
    {
      evidence: "Same title\nAuthor Name\nISBN 978-0-596-52068-7",
    },
  );
  // Title+author soft path: when title/author also match, conflict is
  // downgraded (set-ISBN / imprint noise). Use a weak title so the ISBN
  // conflict remains hard.
  const hard = compareMetadata(
    {
      title: "Completely Different Book Title About Widgets",
      creators: ["Author Name"],
      isbn: "978-0-13-468599-1",
    },
    {
      evidence: "Unrelated Pamphlet\nISBN 978-0-596-52068-7",
    },
  );
  assert.equal(hard.status, "mismatch");
  assert.equal(hasIdentifierConflict(hard), true);
  // Soft path: strong title+author + different PDF ISBN → not forced mismatch
  assert.notEqual(result.status, "mismatch");
  assert.equal(hasIdentifierConflict(result), false);
});

test("Tietze multi-volume: set ISBN listed before volume ISBN still matches künye", () => {
  const { compareMetadata, hasIdentifierConflict, hasIdentifierMatch } =
    loadModule();
  // Real case: tk. (set) 978-9944-252-78-2 appears before 2. cilt volume ISBN.
  const result = compareMetadata(
    {
      title: "Tarihi ve Etimolojik Türkiye Türkçesi Lügatı- II",
      creators: ["Andreas Tietze"],
      year: "2016",
      isbn: "978-9944-252-80-5",
    },
    {
      evidence:
        "Tarihi ve Etimolojik Türkiye Türkçesi Lugati\nANDREAS TIETZE\n" +
        "ISBN: 978-9944-252-78-2 (tk.)\n" +
        "ISBN: 978-9944-252-80-5 (2. cilt)\n",
    },
  );
  assert.notEqual(result.status, "mismatch");
  assert.equal(hasIdentifierConflict(result), false);
  assert.equal(hasIdentifierMatch(result), true);
  assert.equal(
    result.details.some((d) => d.startsWith("ISBN eşleşiyor")),
    true,
  );
});

test("Berger Metis: phone/fax digit runs are not ISBN conflicts when künye ISBN is in PDF", () => {
  const {
    compareMetadata,
    hasIdentifierConflict,
    hasIdentifierMatch,
    looksLikePhoneNotIsbn,
    extractIsbnCandidates,
  } = loadModule();
  assert.equal(looksLikePhoneNotIsbn("2122454696"), true);
  assert.equal(looksLikePhoneNotIsbn("2125678003"), true);
  assert.equal(looksLikePhoneNotIsbn("9789753426909"), false);

  const evidence =
    "John Berger\nA'DAN X'E\n" +
    "John Berger Tarafından Kurtarılmış Mektuplar\n" +
    "Metis Yayınlan\n" +
    "Tel: 212 2454696 Fak s: 212 2454519\n" +
    "Topkapı, İstanbul Tel: 212 5678003\n" +
    "ISBN-13: 978-975-342-690-9\n";
  const cands = extractIsbnCandidates(evidence);
  assert.equal(cands.includes("9789753426909"), true);
  assert.equal(
    cands.some((c) => c.startsWith("212")),
    false,
  );

  const result = compareMetadata(
    {
      title: "A'dan X'e: john berger tarafından kurtarılmış mektuplar",
      creators: ["John Berger", "Aslı Biçen"],
      year: "2009",
      isbn: "978-975-342-690-9",
    },
    { evidence },
  );
  assert.notEqual(result.status, "mismatch");
  assert.equal(hasIdentifierConflict(result), false);
  assert.equal(hasIdentifierMatch(result), true);
});

test("pickPdfIsbn prefers matching künye over first candidate", () => {
  const { pickPdfIsbn } = loadModule();
  const picked = pickPdfIsbn(
    "ISBN: 978-9944-252-78-2 (tk.)\nISBN: 978-9944-252-80-5 (2. cilt)",
    "9789944252805",
  );
  assert.equal(picked.matched, true);
  assert.equal(picked.isbn, "9789944252805");
});

test("isEncryptedPdfError recognizes pdf-lib's encrypted-document message", () => {
  const { isEncryptedPdfError } = loadModule();
  const pdfLibError = new Error(
    "Input document to `PDFDocument.load` is encrypted. You can use " +
      "`PDFDocument.load(..., { ignoreEncryption: true })` if you wish to load the document anyways.",
  );
  assert.equal(isEncryptedPdfError(pdfLibError), true);
});

test("isEncryptedPdfError does not misfire on unrelated errors", () => {
  const { isEncryptedPdfError } = loadModule();
  assert.equal(
    isEncryptedPdfError(new Error("Unexpected token in PDF stream")),
    false,
  );
  assert.equal(isEncryptedPdfError(new Error("File not found")), false);
});
