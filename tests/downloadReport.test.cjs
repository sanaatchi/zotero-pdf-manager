const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/downloadReport.ts")],
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

const sampleReports = [
  {
    itemID: 1,
    title: "Added Item",
    result: "added",
    attachedSource: "doi",
    attempts: [{ source: "doi", outcome: "attached" }],
  },
  {
    itemID: 2,
    title: "Failed Item <script>",
    result: "failed",
    attempts: [
      { source: "scihub", outcome: "rejected", reason: "yazar uyuşmuyor" },
    ],
  },
  {
    itemID: 3,
    title: "Skipped Item",
    result: "skipped",
    note: "Zaten PDF eki var",
    attempts: [],
  },
];

test("reportToText renders one block per item with title and outcome", () => {
  const { reportToText } = loadModule();
  const text = reportToText(sampleReports);
  assert.match(text, /\[Eklendi\] Added Item/);
  assert.match(text, /doi: eklendi/);
  assert.match(text, /\[Başarısız\] Failed Item <script>/);
  assert.match(text, /scihub: reddedildi \(içerik uyuşmadı\) \(yazar uyuşmuyor\)/);
  assert.match(text, /\[Atlandı\] Skipped Item/);
  assert.match(text, /Zaten PDF eki var/);
});

test("reportToText shows an em-dash when an item has no attempts and no note", () => {
  const { reportToText } = loadModule();
  const text = reportToText([
    { itemID: 4, title: "No attempts", result: "skipped", attempts: [] },
  ]);
  assert.match(text, /No attempts\n {2}—/);
});

test("generateHtml escapes item titles to prevent HTML injection", () => {
  const { generateHtml } = loadModule();
  const html = generateHtml(sampleReports);
  assert.equal(html.includes("Failed Item <script>"), false);
  assert.match(html, /Failed Item &lt;script&gt;/);
});

test("generateHtml computes correct added/failed/skipped counts", () => {
  const { generateHtml } = loadModule();
  const html = generateHtml(sampleReports);
  assert.match(html, /Toplam 3 öğe/);
  assert.match(html, /<b class="ok">1 eklendi<\/b>/);
  assert.match(html, /<b class="muted">1 atlandı<\/b>/);
  assert.match(html, /<b class="bad">1 başarısız<\/b>/);
});

test("generateHtml is valid enough to contain one <tr> per item", () => {
  const { generateHtml } = loadModule();
  const html = generateHtml(sampleReports);
  const rowCount = (html.match(/<tr data-status=/g) || []).length;
  assert.equal(rowCount, sampleReports.length);
});
