const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/bookSourcesMigrate.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  // Stub Zotero prefs for migrate
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

test("migrate enables LibGen and inserts it into legacy sourceOrder", () => {
  const { api, store } = loadModule();
  store["pdf.sourceOrder"] = "local,doi,arxiv,pmc,s2,dergipark,yoktez";
  store["pdf.libgenEnabled"] = false;

  api.migrateBookPdfSources();

  assert.equal(store["pdf.libgenEnabled"], true);
  assert.match(store["pdf.sourceOrder"], /libgen/);
  assert.equal(store["pdf.bookSourcesMigratedV2"], true);

  // idempotent
  store["pdf.libgenEnabled"] = false;
  api.migrateBookPdfSources();
  assert.equal(store["pdf.libgenEnabled"], false);
});
