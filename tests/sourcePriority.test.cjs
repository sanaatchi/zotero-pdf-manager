const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadPriority() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/sourcePriority.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["./pdfSources"],
  });
  const module = { exports: {} };
  const stubs = {
    "./pdfSources": {
      getDOI: (item) => String(item._doi || ""),
      isArticle: (item) =>
        ["journalArticle", "conferencePaper", "preprint"].includes(
          item._type || "",
        ),
      isBook: (item) => item._type === "book" || item._type === "bookSection",
      isThesis: (item) => item._type === "thesis",
    },
  };
  global.Zotero = {
    ItemTypes: {
      getName: (id) =>
        ({ 1: "journalArticle", 2: "book", 3: "thesis", 4: "conferencePaper" })[
          id
        ] || "",
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
  return module.exports;
}

function item(opts) {
  return {
    itemTypeID: opts.typeId ?? 1,
    _type: opts.type || "journalArticle",
    _doi: opts.doi || "",
    getField(name) {
      if (name === "title") return opts.title || "";
      if (name === "language") return opts.language || "";
      return "";
    },
  };
}

test("Turkish journal article → dergipark only", () => {
  const { prioritizeSourcesForItem, looksTurkish } = loadPriority();
  const it = item({
    title: 'Otto Dix ve "Der Krieg" Gravür Serisi',
    type: "journalArticle",
    typeId: 1,
  });
  assert.equal(looksTurkish(it), true);
  assert.deepEqual(
    prioritizeSourcesForItem(
      ["local", "dergipark", "doi", "libgen", "scihub", "s2"],
      it,
    ),
    ["dergipark"],
  );
});

test("English article with DOI → scihub early; libgen late allowed", () => {
  const { prioritizeSourcesForItem } = loadPriority();
  const it = item({
    title: "Quantum entanglement in cavity QED",
    language: "en",
    doi: "10.1234/x",
    type: "journalArticle",
    typeId: 1,
  });
  const order = prioritizeSourcesForItem(
    ["local", "dergipark", "doi", "arxiv", "pmc", "s2", "scihub", "libgen"],
    it,
  );
  assert.equal(order[0], "local");
  assert.equal(order[1], "scihub");
  assert.ok(order.includes("libgen"));
  assert.ok(order.indexOf("libgen") > order.indexOf("doi"));
});

test("Non-Turkish book → libgen after local", () => {
  const { prioritizeSourcesForItem } = loadPriority();
  const it = item({
    title: "Being and Time",
    language: "en",
    type: "book",
    typeId: 2,
  });
  const order = prioritizeSourcesForItem(
    ["local", "doi", "libgen", "scihub"],
    it,
  );
  assert.deepEqual(order.slice(0, 2), ["local", "libgen"]);
});
