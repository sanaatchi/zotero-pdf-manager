// @ajan: cursor · @etiket: katman-2, b5-dup-report, test
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadDup() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/duplicateItemReport.ts")],
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

test("extractKpToken normalizes KP padding", () => {
  const { extractKpToken } = loadDup();
  assert.equal(extractKpToken("Kutuphane-KP: KP42"), "KP000042");
  assert.equal(extractKpToken("no key"), null);
  assert.equal(extractKpToken("KP1234567"), null);
});

test("findDuplicateGroups clusters DOI / ISBN10↔13 / KP", () => {
  const { findDuplicateGroups, formatDuplicateReportLines } = loadDup();
  const groups = findDuplicateGroups([
    {
      itemId: 1,
      title: "A",
      doi: "https://doi.org/10.1000/xyz",
      isbn: "0-306-40615-2",
      kp: "KP000001",
    },
    {
      itemId: 2,
      title: "B",
      doi: "DOI:10.1000/xyz",
      isbn: "978-0-306-40615-7",
      kp: "KP000002",
    },
    { itemId: 3, title: "C", kp: "KP000001" },
    { itemId: 4, title: "D unique" },
  ]);
  const byKind = Object.fromEntries(groups.map((g) => [g.kind, g]));
  assert.equal(byKind.doi.itemIds.length, 2);
  assert.equal(byKind.isbn.itemIds.length, 2);
  assert.equal(byKind.kp.itemIds.length, 2);
  const lines = formatDuplicateReportLines(groups);
  assert.match(lines[0], /Zoplicate/);
  assert.ok(lines.length > 1);
});

test("menu wires duplicate report entry", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  assert.match(source, /reportDuplicateItemsForSelection/);
  assert.match(source, /pdf-dup-report-menu/);
});
