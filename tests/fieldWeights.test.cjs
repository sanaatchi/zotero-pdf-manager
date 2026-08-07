// @ajan: cursor · @etiket: katman-2, field-weights, test
/**
 * fieldWeights — 100-point table parity for content-validate scores.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

function loadFieldWeights() {
  const srcPath = path.join(
    __dirname,
    "..",
    "src",
    "modules",
    "fieldWeights.ts",
  );
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: srcPath,
  });
  const module = { exports: {} };
  const fn = new Function(
    "exports",
    "require",
    "module",
    "__dirname",
    outputText,
  );
  fn(module.exports, require, module, path.dirname(srcPath));
  return module.exports;
}

test("kind weights sum to ~1.0 (content-relevant tables)", () => {
  const { KIND_FIELD_WEIGHT } = loadFieldWeights();
  for (const [kind, fields] of Object.entries(KIND_FIELD_WEIGHT)) {
    const sum = Object.values(fields).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.02, `${kind} sum=${sum}`);
  }
});

test("weightedKindScore matches 100-point journalArticle table", () => {
  const { weightedKindScore, CONTENT_SCORE } = loadFieldWeights();
  // Perfect title+author+year = 30+25+15 = 70 → 0.70
  assert.ok(
    Math.abs(
      weightedKindScore("journalArticle", {
        title: 1,
        authors: 1,
        year: 1,
      }) - 0.7,
    ) < 1e-9,
  );
  // Demir-like: titleHit 0.57 + author → 0.171+0.25 = 0.421
  const demir = weightedKindScore("journalArticle", {
    title: 0.57,
    authors: 1,
  });
  assert.ok(Math.abs(demir - 0.421) < 1e-9);
  assert.ok(demir >= CONTENT_SCORE.SOFT);
  assert.ok(demir < CONTENT_SCORE.HIGH);
});

test("contentScoreKind maps bookLike / itemType", () => {
  const { contentScoreKind } = loadFieldWeights();
  assert.equal(contentScoreKind({ itemType: "thesis" }), "thesis");
  assert.equal(contentScoreKind({ bookLike: true }), "book");
  assert.equal(contentScoreKind({}), "journalArticle");
});
