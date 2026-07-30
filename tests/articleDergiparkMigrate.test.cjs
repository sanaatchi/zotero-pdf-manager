const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/articleDergiparkMigrate.ts"),
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

test("migrate enables DergiPark and places it after local", () => {
  const { api, store } = loadModule();
  store["pdf.sourceOrder"] = "local,doi,arxiv,pmc,s2,libgen";
  store["pdf.dergiparkEnabled"] = false;

  api.migrateArticleDergiparkPriority();

  assert.equal(store["pdf.dergiparkEnabled"], true);
  assert.match(store["pdf.sourceOrder"], /^local,dergipark,/);
  assert.equal(store["pdf.articleDergiparkMigratedV1"], true);

  store["pdf.dergiparkEnabled"] = false;
  api.migrateArticleDergiparkPriority();
  assert.equal(store["pdf.dergiparkEnabled"], false);
});
