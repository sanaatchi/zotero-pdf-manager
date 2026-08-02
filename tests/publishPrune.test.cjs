// @ajan: cursor · @etiket: katman-2, tests, publish-prune
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

test("selectReleasesToPrune keeps newest 5 versioned; ignores update", async () => {
  const mod = await import(
    pathToFileURL(path.join(process.cwd(), "scripts/publish.mjs")).href
  );
  const tags = [
    "v1.0.56",
    "v1.0.55",
    "v1.0.54",
    "v1.0.53",
    "v1.0.52",
    "v1.0.51",
    "update",
    "v1.0.44",
  ];
  assert.deepEqual(mod.selectReleasesToPrune(tags, 5), [
    "v1.0.51",
    "v1.0.44",
  ]);
  assert.deepEqual(mod.selectReleasesToPrune(["update", "v1"], 5), []);
  assert.deepEqual(mod.selectReleasesToPrune(["v3", "v2", "v1"], 2), ["v1"]);
});
