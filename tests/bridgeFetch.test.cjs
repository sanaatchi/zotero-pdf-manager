// @ajan: cursor · @etiket: katman-2, oa-bridge, loopback, test
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

test("oaBridgeUrl rejects non-loopback (SSRF gate, K1/K3 parity)", () => {
  const {
    isAllowedOaBridgeUrl,
    normalizeOaBridgeUrl,
    DEFAULT_OA_BRIDGE_URL,
  } = loadBridge();
  assert.equal(isAllowedOaBridgeUrl("http://127.0.0.1:8756"), true);
  assert.equal(isAllowedOaBridgeUrl("http://localhost:8756/"), true);
  assert.equal(isAllowedOaBridgeUrl("https://evil.example/pdf"), false);
  assert.equal(isAllowedOaBridgeUrl("http://192.168.1.1:8756"), false);
  assert.equal(isAllowedOaBridgeUrl("file:///etc/passwd"), false);
  assert.equal(
    normalizeOaBridgeUrl("https://evil.example"),
    DEFAULT_OA_BRIDGE_URL,
  );
  assert.equal(
    normalizeOaBridgeUrl("http://127.0.0.1:8756/"),
    "http://127.0.0.1:8756",
  );
});
