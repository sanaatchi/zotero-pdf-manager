// @ajan: cursor · @etiket: katman-2, tests, pdf-mismatch, tag-guard, user-clear
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadGuard() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/pdfAutomationTagGuard.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["../utils/prefs"],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "ztoolkit", result.outputFiles[0].text)(
    module,
    module.exports,
    (id) => {
      if (id.includes("prefs")) {
        return { getPref: () => "", setPref: () => {} };
      }
      throw new Error(id);
    },
    { log: () => {} },
  );
  return module.exports;
}

function loadReconcilerPure() {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  return source;
}

test("passive mismatch tag suppressed after user clear", () => {
  const {
    _resetPdfAutomationTagGuardForTests,
    _setUserClearTimestampForTests,
    shouldSuppressPassiveMismatchTag,
    recordPdfAutomationTagsUserClear,
  } = loadGuard();
  _resetPdfAutomationTagGuardForTests();
  recordPdfAutomationTagsUserClear(42);
  assert.equal(
    shouldSuppressPassiveMismatchTag(42, "reconcile-periodic"),
    true,
  );
  assert.equal(
    shouldSuppressPassiveMismatchTag(42, "local-finalize-passive"),
    true,
  );
  assert.equal(
    shouldSuppressPassiveMismatchTag(42, "content-audit"),
    false,
  );
  assert.equal(
    shouldSuppressPassiveMismatchTag(99, "reconcile-startup"),
    false,
  );
  _setUserClearTimestampForTests(50, Date.now() - 31 * 24 * 60 * 60 * 1000);
  assert.equal(
    shouldSuppressPassiveMismatchTag(50, "reconcile-periodic"),
    false,
  );
});

test("applyPdfMismatchTags logs suppressed vs applied (source contract)", () => {
  const guard = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfAutomationTags.ts"),
    "utf8",
  );
  const sources = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  const audit = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfContentAudit.ts"),
    "utf8",
  );
  assert.match(guard, /pdf-mismatch-tag-suppressed/);
  assert.match(guard, /pdf-mismatch-tag-applied/);
  assert.match(sources, /applyPdfMismatchTags/);
  assert.match(audit, /recordPdfAutomationTagsUserClear/);
  assert.match(audit, /pdf-automation-tags-user-clear/);
});

test("canReconcileItem skips items after user cleared automation tags", () => {
  const reconciler = loadReconcilerPure();
  assert.match(
    reconciler,
    /wasPdfAutomationTagsUserClearedRecently\(item\.id\)/,
  );
});

test("reconciler attachFile passes reconcile mismatch tag source", () => {
  const reconciler = loadReconcilerPure();
  assert.match(reconciler, /source: `reconcile-\$\{shared\.reason\}`/);
});
