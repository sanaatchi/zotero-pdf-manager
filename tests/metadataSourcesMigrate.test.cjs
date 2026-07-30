const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadMigrate() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/metadataSourcesMigrate.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["../utils/prefs"],
  });
  const store = {};
  const module = { exports: {} };
  const stubs = {
    "../utils/prefs": {
      getPref: (k) => store[k],
      setPref: (k, v) => {
        store[k] = v;
      },
    },
  };
  const req = (name) => {
    if (stubs[name]) return stubs[name];
    return require(name);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
  );
  return { api: module.exports, store };
}

test("migrate strips doi/arxiv/s2/proquest from sourceOrder", () => {
  const { api, store } = loadMigrate();
  store["pdf.sourceOrder"] =
    "local,dergipark,doi,arxiv,pmc,s2,libgen,scihub,yoktez,proquest,proxy";
  store["pdf.doiEnabled"] = true;
  store["pdf.arxivEnabled"] = true;
  store["pdf.s2Enabled"] = true;
  store["pdf.proquestEnabled"] = true;

  api.migrateMetadataOnlyOutOfDownload();

  assert.equal(store["pdf.doiEnabled"], false);
  assert.equal(store["pdf.arxivEnabled"], false);
  assert.equal(store["pdf.s2Enabled"], false);
  assert.equal(store["pdf.proquestEnabled"], false);
  assert.equal(
    store["pdf.sourceOrder"],
    "local,dergipark,pmc,libgen,scihub,yoktez,proxy",
  );
  assert.equal(store["pdf.metadataOnlySourcesMigratedV1"], true);

  // Idempotent
  store["pdf.sourceOrder"] = "local,doi,pmc";
  api.migrateMetadataOnlyOutOfDownload();
  assert.equal(store["pdf.sourceOrder"], "local,doi,pmc");
});
