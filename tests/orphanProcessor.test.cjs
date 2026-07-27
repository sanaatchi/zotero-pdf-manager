const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/orphanProcessor.ts")],
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

test("orphan filenames become readable fallback titles", () => {
  const { normalizeOrphanTitle } = loadModule();

  assert.equal(
    normalizeOrphanTitle("Walter_Benjamin_-_Pasajlar"),
    "Walter Benjamin — Pasajlar",
  );
});

test("DOI and ISBN identifiers are extracted from PDF-like text", () => {
  const { extractDocumentIdentifiers } = loadModule();
  const ids = extractDocumentIdentifiers(
    "doi: 10.1000/xyz-123. ISBN 978-3-16-148410-0",
  );

  assert.equal(ids.doi, "10.1000/xyz-123");
  assert.equal(ids.isbn, "9783161484100");
});

test("invalid ISBN-like digit sequences are rejected", () => {
  const { extractDocumentIdentifiers } = loadModule();

  assert.equal(extractDocumentIdentifiers("number 12345").isbn, "");
  assert.equal(extractDocumentIdentifiers("number 5032501240750").isbn, "");
});

test("a numeric-only PDF filename is recognized as a YÖK thesis number", () => {
  const { yokThesisNumber } = loadModule();

  assert.equal(yokThesisNumber("736678.pdf"), "736678");
  assert.equal(yokThesisNumber("736678"), "736678");
  assert.equal(yokThesisNumber("tez-736678.pdf"), "");
  assert.equal(yokThesisNumber("1234.pdf"), "");
});

test("thesis cover metadata is extracted conservatively", () => {
  const { parseThesisCoverText } = loadModule();
  const parsed = parseThesisCoverText(`
T.C.
GAZİANTEP ÜNİVERSİTESİ
SOSYAL BİLİMLER ENSTİTÜSÜ
SANAT VE TASARIM ANASANAT DALI
1980 SONRASI TÜRK RESİM SANATINDA KADIN
SANATÇILARIN YAPITLARI VE ÖZNELLİK
YÜKSEK LİSANS TEZİ
ÖZDEN YILDIZ
Tez Danışmanı: Prof. Dr. Mustafa Cevat ATALAY
GAZİANTEP
HAZİRAN 2022
`);

  assert.deepEqual(parsed, {
    itemType: "thesis",
    university: "GAZİANTEP ÜNİVERSİTESİ",
    thesisType: "Yüksek Lisans Tezi",
    authors: ["ÖZDEN YILDIZ"],
    title:
      "1980 SONRASI TÜRK RESİM SANATINDA KADIN SANATÇILARIN YAPITLARI VE ÖZNELLİK",
    year: "2022",
  });
});

test("fine arts thesis cover supports eser metni and a student number", () => {
  const { parseThesisCoverText } = loadModule();
  const parsed = parseThesisCoverText(`
T.C.
MİMAR SİNAN GÜZEL SANATLAR ÜNİVERSİTESİ
SOSYAL BİLİMLER ENSTİTÜSÜ
RESİM ANA SANAT DALI
RESİM PROGRAMI
RESİM-MÜZİK İLİŞKİSİ BAĞLAMINDA
SOYUT RESME BAKIŞ
Yüksek Lisans Eser Metni
Hazırlayan:
20076090 Şela KASPİ
Danışman:
Yrd.Doç.Sedat BALKIR
İSTANBUL-2010
`);

  assert.deepEqual(parsed, {
    itemType: "thesis",
    university: "MİMAR SİNAN GÜZEL SANATLAR ÜNİVERSİTESİ",
    thesisType: "Yüksek Lisans Eser Metni",
    authors: ["Şela KASPİ"],
    title: "RESİM-MÜZİK İLİŞKİSİ BAĞLAMINDA SOYUT RESME BAKIŞ",
    year: "2010",
  });
});
