// @ajan: claude · @etiket: katman-2, tests, pdf-mismatch, tag-guard, user-clear, explicit-session-scope-fix
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
  new Function(
    "module",
    "exports",
    "require",
    "ztoolkit",
    result.outputFiles[0].text,
  )(
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
  assert.equal(shouldSuppressPassiveMismatchTag(42, "content-audit"), false);
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

test("explicit session for one item does not leak into a concurrent item's passive suppression", async () => {
  const {
    _resetPdfAutomationTagGuardForTests,
    recordPdfAutomationTagsUserClear,
    shouldSuppressPassiveMismatchTag,
    runInExplicitMismatchTagSessionAsync,
  } = loadGuard();
  _resetPdfAutomationTagGuardForTests();
  // Both items were cleared by the user recently.
  recordPdfAutomationTagsUserClear(1);
  recordPdfAutomationTagsUserClear(2);

  let sawBSuppressedWhileAExplicit = false;
  await Promise.all([
    // Item 1: explicit download session (e.g. user-triggered "Download & attach").
    runInExplicitMismatchTagSessionAsync(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Explicit session covers only item 1 — it may re-tag.
      assert.equal(shouldSuppressPassiveMismatchTag(1, "download-doi"), false);
    }),
    // Item 2: unrelated passive re-tag (e.g. reconciler add-flush) firing
    // concurrently. It must stay suppressed — item 1's explicit session must
    // not leak into item 2 via a shared global flag.
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sawBSuppressedWhileAExplicit = shouldSuppressPassiveMismatchTag(
        2,
        "reconcile-add",
      );
    })(),
  ]);
  assert.equal(sawBSuppressedWhileAExplicit, true);
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

test("reconciler's passive #pdf-candidate add path is routed through the same user-clear guard as #pdf-mismatch", () => {
  // Regression: addAutomationTag(item, "#pdf-review") for ambiguous/collided
  // local matches (processItemBatch) used to call a raw, unguarded helper
  // directly — bypassing shouldSuppressPassiveMismatchTag entirely and
  // relying only on canReconcileItem's coarser whole-item pre-filter. Also
  // split from #pdf-review into its own tag (#pdf-candidate): these two
  // branches fire for a candidate file that was NOT confidently attached —
  // a different situation from #pdf-mismatch/#pdf-review, which both mean
  // an attachment exists and its content is wrong/unclear. Both add sites
  // must go through addReconcileCandidateTag, which checks the guard the
  // same way #pdf-mismatch does.
  const reconciler = loadReconcilerPure();
  assert.match(
    reconciler,
    /async function addReconcileCandidateTag\([^)]*\)\s*\{\s*if \(shouldSuppressPassiveMismatchTag\(item\.id, `reconcile-\$\{reason\}`\)\) return;/,
  );
  const candidateCallSites = reconciler.match(
    /await addReconcileCandidateTag\(item, reason\);/g,
  );
  assert.equal(
    candidateCallSites?.length,
    2,
    "expected both the ambiguous-match and file-collision branches to use the guarded helper",
  );
  // The raw primitive call to add "#pdf-candidate" must appear exactly once
  // in the whole file — inside addReconcileCandidateTag itself (asserted
  // above). If it appears anywhere else, some call site is bypassing the
  // guard. And #pdf-review (the old, now-ambiguous tag) must not be added
  // by the reconciler's local-match branches at all anymore.
  const rawCandidateCalls = reconciler.match(
    /await addAutomationTag\(item, "#pdf-candidate"\)/g,
  );
  assert.equal(rawCandidateCalls?.length, 1);
  assert.doesNotMatch(reconciler, /addAutomationTag\(item, "#pdf-review"\)/);
});

test("reconciler's addAutomationTag dedups tags with '#'-prefix awareness, not an exact string match", () => {
  // Regression: the old implementation compared `entry.tag === tag`
  // (exact string only). If Zotero ever returns/stores a tag without the
  // leading "#", this silently missed the existing tag and added a second,
  // differently-spelled one for the same status.
  const reconciler = loadReconcilerPure();
  assert.match(
    reconciler,
    /if \(resolveAutomationTagOnItem\(item, tag\)\) return;/,
  );
  assert.doesNotMatch(
    reconciler,
    /tags\.some\(\(entry\) => entry\.tag === tag\)/,
  );
});
