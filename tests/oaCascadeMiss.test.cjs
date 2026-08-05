// @ajan: cursor · @etiket: katman-2, oa-cascade-miss, search-log, test
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadMiss() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/oaCascadeMiss.ts")],
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

test("TR article + dergipark+doi miss matches download-report copy", () => {
  const { cascadeMissMessage, cascadeMissKind, buildOaCascadeLogBody } =
    loadMiss();
  const hints = {
    isTurkishJournal: true,
    isBook: false,
    isThesis: false,
  };
  const attempts = [
    { source: "dergipark", outcome: "no-match" },
    { source: "doi", outcome: "no-match" },
  ];
  const msg = cascadeMissMessage(hints, attempts);
  assert.equal(
    msg,
    "Türkçe makale: DergiPark ve Unpaywall’da bulunamadı (başka kaynak aranmaz).",
  );
  assert.equal(cascadeMissKind(hints, attempts), "tr-article-miss");
  const body = buildOaCascadeLogBody({
    kind: "tr-article-miss",
    message: msg,
    origin: "download-report",
    title:
      "Cumhuriyet devri ortaöğretimindeki sanat tarihi müfredatının değerlendirilmesi",
    doi: "10.17719/jisr.20164216196",
    itemType: "journalArticle",
    attempts,
  });
  assert.equal(body.kind, "tr-article-miss");
  assert.deepEqual(body.sourcesTried, ["dergipark", "doi"]);
  assert.equal(body.origin, "download-report");
});

test("TR article without dergipark attempt asks to enable pref", () => {
  const { cascadeMissMessage, cascadeMissKind } = loadMiss();
  const msg = cascadeMissMessage(
    { isTurkishJournal: true, isBook: false, isThesis: false },
    [],
  );
  assert.match(msg, /DergiPark’ı açın/);
  assert.equal(
    cascadeMissKind(
      { isTurkishJournal: true, isBook: false, isThesis: false },
      [],
    ),
    "tr-article-disabled",
  );
});

test("thesis miss and yoktez reason pass through", () => {
  const { cascadeMissMessage, cascadeMissKind } = loadMiss();
  assert.equal(
    cascadeMissMessage(
      { isTurkishJournal: false, isBook: false, isThesis: true },
      [{ source: "yoktez", outcome: "no-match" }],
    ),
    "Tez: YÖKTez’te bulunamadı (başka kaynak aranmaz).",
  );
  assert.equal(
    cascadeMissKind(
      { isTurkishJournal: false, isBook: false, isThesis: true },
      [{ source: "yoktez", outcome: "error", reason: "embargo" }],
    ),
    "thesis-miss",
  );
  assert.match(
    cascadeMissMessage(
      { isTurkishJournal: false, isBook: false, isThesis: true },
      [{ source: "yoktez", outcome: "error", reason: "embargo" }],
    ),
    /embargo/,
  );
});

test("pdfDownload + oaPdfBridge wire cascade miss to /pdf-search-log", () => {
  const download = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfDownload.ts"),
    "utf8",
  );
  assert.match(download, /queueCascadeMissLog/);
  assert.match(download, /logOaCascadeMiss/);
  assert.match(download, /"download-report"/);
  assert.match(download, /"auto-cascade"/);
  const bridge = fs.readFileSync(
    path.join(process.cwd(), "src/modules/oaPdfBridge.ts"),
    "utf8",
  );
  assert.match(bridge, /\/pdf-search-log/);
  assert.match(bridge, /export async function logOaCascadeMiss/);
});
