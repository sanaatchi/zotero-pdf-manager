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
  const { isAllowedOaBridgeUrl, normalizeOaBridgeUrl, DEFAULT_OA_BRIDGE_URL } =
    loadBridge();
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

test("fanOutOaSourcesByQuery ranks by extra.rank (single-source hits carry no top-level score)", async () => {
  const responses = {
    doi: {
      ok: true,
      source: "doi",
      hits: [
        {
          source: "doi",
          title: "Weak match",
          pdfUrl: "https://x/weak.pdf",
          extra: { rank: 0.5 },
        },
      ],
    },
    pmc: {
      ok: true,
      source: "pmc",
      hits: [
        {
          source: "pmc",
          title: "Strong match",
          pdfUrl: "https://x/strong.pdf",
          extra: { rank: 0.95 },
        },
      ],
    },
  };
  // loadBridge() resets global.Zotero to a bare {Prefs} stub as a module
  // -load side effect — the HTTP mock must be installed *after* loading,
  // not before, or it gets clobbered.
  const { fanOutOaSourcesByQuery } = loadBridge();
  global.Zotero.HTTP = {
    // Regression guard: the final sort used to compare a nonexistent
    // top-level `score` (always 0 - 0), so results stayed in network
    // -completion order instead of relevance order. `pmc` is made to
    // resolve *after* `doi` here so a completion-order bug would put
    // the weak "doi" hit first.
    request: async (_method, _endpoint, opts) => {
      const body = JSON.parse(opts.body);
      if (body.source === "pmc") {
        await new Promise((r) => setTimeout(r, 10));
      }
      return {
        status: 200,
        responseText: JSON.stringify(
          responses[body.source] || { ok: true, hits: [] },
        ),
      };
    },
  };
  const result = await fanOutOaSourcesByQuery(
    { text: "x" },
    { sources: ["doi", "pmc"] },
  );
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].title, "Strong match");
  assert.equal(result.hits[1].title, "Weak match");
});
