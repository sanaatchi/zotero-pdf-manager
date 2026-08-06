// @ajan: cursor · @etiket: katman-2, tests, match-tag-clear, match-rename-move, tag-hash-normalize
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadPdfSources() {
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

test("shouldClearMatchTags: match always; skipped only DOI/ISBN", () => {
  const { shouldClearMatchTags } = loadPdfSources();

  assert.equal(shouldClearMatchTags("match", "title"), true);
  assert.equal(shouldClearMatchTags("match", "doi"), true);
  assert.equal(shouldClearMatchTags("match", "isbn"), true);

  assert.equal(shouldClearMatchTags("skipped", "doi"), true);
  assert.equal(shouldClearMatchTags("skipped", "isbn"), true);
  assert.equal(shouldClearMatchTags("skipped", "title"), false);

  assert.equal(shouldClearMatchTags("mismatch", "doi"), false);
  assert.equal(shouldClearMatchTags("unverifiable", "isbn"), false);
});

test("clearSuccessfulMatchTags: single saveTx removes all automation tags", async () => {
  const { clearSuccessfulMatchTags } = loadPdfSources();
  const tags = new Set([
    "pdf-mismatch",
    "pdf-review",
    "pdf-quarantine",
    "#keep-me",
  ]);
  let saveCount = 0;
  const item = {
    loadAllData: async () => {},
    getTags: () => [...tags].map((tag) => ({ tag })),
    hasTag: (t) => tags.has(String(t).replace(/^#/, "")),
    removeTag: (tag) => {
      tags.delete(String(tag).replace(/^#/, ""));
    },
    saveTx: async () => {
      saveCount++;
    },
  };

  await clearSuccessfulMatchTags(item);

  assert.equal(saveCount, 1);
  assert.equal(tags.has("pdf-mismatch"), false);
  assert.equal(tags.has("pdf-review"), false);
  assert.equal(tags.has("pdf-quarantine"), false);
  assert.equal(tags.has("#keep-me"), true);
});

test("resolveAutomationTagOnItem: hash and no-hash storage", () => {
  const { resolveAutomationTagOnItem } = loadPdfSources();
  const item = {
    hasTag: (t) => t === "pdf-mismatch" || t === "#pdf-review",
    getTags: () => [{ tag: "pdf-mismatch" }, { tag: "pdf-review" }],
  };
  assert.equal(
    resolveAutomationTagOnItem(item, "#pdf-mismatch"),
    "pdf-mismatch",
  );
  assert.equal(resolveAutomationTagOnItem(item, "#pdf-quarantine"), null);
});

test("clearSuccessfulMatchTags removes mismatch + review on parent", async () => {
  const { clearSuccessfulMatchTags } = loadPdfSources();
  const tags = new Set(["#pdf-mismatch", "#pdf-review", "#keep-me"]);
  const item = {
    getTags: () => [...tags].map((tag) => ({ tag })),
    hasTag: (t) => tags.has(t),
    removeTag: (tag) => {
      tags.delete(tag);
    },
    saveTx: async () => {},
  };

  await clearSuccessfulMatchTags(item);

  assert.equal(tags.has("#pdf-mismatch"), false);
  assert.equal(tags.has("#pdf-review"), false);
  assert.equal(tags.has("#keep-me"), true);
});

test("clearSuccessfulMatchTags: getTags without # but hasTag with #", async () => {
  const { clearSuccessfulMatchTags } = loadPdfSources();
  const tags = new Set(["pdf-mismatch", "pdf-review"]);
  const item = {
    getTags: () => [...tags].map((tag) => ({ tag })),
    hasTag: (t) => tags.has(String(t).replace(/^#/, "")),
    removeTag: (tag) => {
      tags.delete(String(tag).replace(/^#/, ""));
    },
    saveTx: async () => {},
  };

  await clearSuccessfulMatchTags(item);

  assert.equal(tags.has("pdf-mismatch"), false);
  assert.equal(tags.has("pdf-review"), false);
});

test("finalizeLocalAttachment wires shouldClearMatchTags + clearSuccessfulMatchTags", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /shouldClearMatchTags\(detailed\.verdict,\s*via\)/);
  assert.match(
    source,
    /if \(shouldClearMatchTags\(detailed\.verdict,\s*via\)\) \{[\s\S]*?await clearSuccessfulMatchTags\(item\)/,
  );
  assert.match(source, /return relocateAfterSuccessfulMatch\(attachment\)/);
  // No early return that skips tag clear when validate pref is off.
  assert.doesNotMatch(
    source,
    /if \(getPref\("pdf\.validateContent"\) === false\) return attachment;/,
  );
  // Mismatch path still tags (does not clear).
  assert.match(source, /keeping attachment \(#pdf-mismatch\)/);
  assert.match(source, /await tagItem\(item, "#pdf-mismatch"\)/);
});

test("Match Attachment menu clears tags after successful attach", () => {
  const menu = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  assert.match(menu, /clearSuccessfulMatchTags/);
  assert.match(
    menu,
    /if \(existingAttachment\) \{[\s\S]*?await clearSuccessfulMatchTags\(item\)/,
  );
  assert.match(
    menu,
    /await clearSuccessfulMatchTags\(item\);[\s\S]*?await maybeEmbedMetadata\(item,\s*shown\)/,
  );
  assert.match(menu, /maybeRenameAndMoveMatchedAttachment/);
});

test("reconciler passes match.via into attachFile", () => {
  const reconciler = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  assert.match(
    reconciler,
    /source\.attachFile\(\s*item,\s*match\.file,\s*match\.via\s*\|\|\s*"title"/,
  );
});
