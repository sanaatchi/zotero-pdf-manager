// @ajan: cursor · @etiket: katman-2, tests, mir-az, prefs-migrate
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/mirAzSourcesMigrate.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  const store = {};
  global.Zotero = {
    Prefs: {
      get(key) {
        const short = key.replace(/^extensions\.zotero\.zpdfmanager\./, "");
        return store[short];
      },
      set(key, value) {
        const short = key.replace(/^extensions\.zotero\.zpdfmanager\./, "");
        store[short] = value;
      },
    },
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return { api: module.exports, store };
}

test("migrate inserts mir_az after dirzon in legacy sourceOrder", () => {
  const { api, store } = loadModule();
  store["pdf.sourceOrder"] = "local,doi,libgen,pdfkitap,dirzon,zenodo";

  api.migrateMirAzPdfSource();

  assert.match(store["pdf.sourceOrder"], /dirzon,mir_az/);
  assert.equal(store["pdf.mirAzSourcesMigratedV1"], true);

  store["pdf.sourceOrder"] = "local,doi";
  api.migrateMirAzPdfSource();
  assert.equal(store["pdf.sourceOrder"], "local,doi");
});
