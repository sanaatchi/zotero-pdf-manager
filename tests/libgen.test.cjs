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

test("LibGen bridge request prioritizes DOI ISBN and title", () => {
  const { buildOaSearchRequest } = loadBridge();
  const item = {
    getField(field) {
      return (
        {
          DOI: "10.1000/test",
          ISBN: "978-975-7496-18-2",
          title: "Van Gogh: Toplumun İntihar Ettirdiği",
          extra: "",
          url: "",
        }[field] || ""
      );
    },
  };
  const req = buildOaSearchRequest("libgen", item);
  assert.equal(req.doi, "10.1000/test");
  assert.equal(req.isbn, "9789757496182");
  assert.match(req.text, /Van Gogh/);
});
