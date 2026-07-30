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
  const trusted = filterTrustedHits(
    [{ source: "scihub", title: "x", pdfUrl: "https://sci-hub.se/p.pdf" }],
    { title: "Anything", doi: "10.1000/x", sourceId: "scihub" },
  );
  assert.equal(trusted.length, 1);
});
