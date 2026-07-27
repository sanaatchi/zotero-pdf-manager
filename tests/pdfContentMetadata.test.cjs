const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/pdfContentMetadata.ts"),
    ],
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

test("broken Turkish PDF glyphs are repaired", () => {
  const { repairTurkishPDFText } = loadModule();

  assert.equal(
    repairTurkishPDFText("KLASĠK BĠRDĠġLĠ ĢÖZÜM"),
    "KLASİK BİRDİŞLİ ŞÖZÜM",
  );
});

test("article metadata is recovered from a Turkish abstract cover", () => {
  const { candidateFromPDFText } = loadModule();
  const candidate = candidateFromPDFText(`
KLASĠK DÖNEM OSMANLI KAYNAKLARINDA DEVLET SORUNLARI VE
ÇÖZÜM YOLLARI. DEFTERDAR SARI MEHMET PAġA’NIN
“NESAYĠH’ÜL VÜZERA VE’L-ÜMERA / DEVLET ADAMINA ÖĞÜTLER”
KĠTABININ ĠÇERĠK ÇÖZÜMLEMESĠ
THE SOLUTION OF THE STATE PROBLEMS IN THE CLASICAL OTTOMAN LITERATURE
Fikret BĠRDĠġLĠi
Özet
Bu makalede Osmanlı siyasetnameleri incelenmektedir.
Akademik Yaklaşımlar Dergisi Cilt 1 Sayı 1 2010
`);

  assert.equal(candidate.itemType, "journalArticle");
  assert.equal(candidate.authors[0].firstName, "Fikret");
  assert.equal(candidate.authors[0].lastName, "Birdişli");
  assert.equal(candidate.year, "2010");
  assert.match(candidate.title, /^Klasik Dönem Osmanlı Kaynaklarında/);
  assert.doesNotMatch(candidate.title, /^Platon/u);
});
