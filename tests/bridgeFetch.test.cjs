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

test("hitNeedsBridgeFetch true for dergipark and yoktez pdf hits", () => {
  const { hitNeedsBridgeFetch } = loadBridge();
  assert.equal(
    hitNeedsBridgeFetch({
      source: "dergipark",
      title: "x",
      pdfUrl: "https://dergipark.org.tr/tr/download/article-file/1",
    }),
    true,
  );
  assert.equal(
    hitNeedsBridgeFetch({
      source: "yoktez",
      title: "x",
      pdfUrl: "https://tez.yok.gov.tr/x",
    }),
    true,
  );
  assert.equal(
    hitNeedsBridgeFetch({ source: "pmc", title: "x", pdfUrl: "" }),
    false,
  );
});
