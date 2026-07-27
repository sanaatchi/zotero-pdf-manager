const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfSources.ts")],
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

test("ISBN validation checks the checksum, not only the length", () => {
  const { isValidISBN } = loadModule();

  assert.equal(isValidISBN("978-975-7496-18-2"), true);
  assert.equal(isValidISBN("978-975-7496-18-3"), false);
  assert.equal(isValidISBN("0-306-40615-2"), true);
});

test("LibGen book queries prioritize DOI and valid ISBN before title", () => {
  global.Zotero = {
    ItemTypes: { getName: () => "book" },
  };
  const { buildLibGenQueries } = loadModule();
  const fields = {
    DOI: "10.1000/test",
    ISBN: "978-975-7496-18-2",
    title: "Van Gogh: Toplumun İntihar Ettirdiği",
  };
  const item = {
    itemTypeID: 1,
    getField: (field) => fields[field] || "",
  };

  assert.deepEqual(buildLibGenQueries(item), [
    "10.1000/test",
    "9789757496182",
    "Van Gogh: Toplumun İntihar Ettirdiği",
  ]);
});

test("LibGen omits an invalid ISBN but still searches by title", () => {
  global.Zotero = {
    ItemTypes: { getName: () => "book" },
  };
  const { buildLibGenQueries } = loadModule();
  const fields = {
    ISBN: "978-975-7496-18-3",
    title: "Van Gogh",
  };
  const item = {
    itemTypeID: 1,
    getField: (field) => fields[field] || "",
  };

  assert.deepEqual(buildLibGenQueries(item), ["Van Gogh"]);
});
