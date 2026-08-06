// @ajan: claude · @etiket: katman-2, tests, tag-logic-audit, nosource-sync, notifier
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const {
  createAttachment,
  createHarness,
  createRegularItem,
} = require("./helpers/menuHarness.cjs");

let harness;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

test("trashing a PDF attachment immediately syncs #nosource and clears stale #pdf-mismatch/#pdf-review on the parent — no manual scan needed", async () => {
  // Regression: #nosource and the mismatch/review claims used to only be
  // reconciled by a user-triggered "Scan library" run, so an item could sit
  // with both a stale "PDF didn't match" claim AND "no PDF at all" for as
  // long as the user went without running that menu command. This is the
  // event-driven half of the fix — reacting to Zotero's own trash/delete
  // notification instead of waiting for a scan.
  harness = createHarness();
  const parent = createRegularItem(harness, {
    id: 1,
    tags: ["#pdf-mismatch", "#pdf-review", "#auto-attached"],
  });
  const attachment = createAttachment(harness, {
    id: 2,
    parent,
    path: "/source/old.pdf",
  });
  const menu = new harness.module.default();

  // By the time Zotero actually fires "trash", the DB (and therefore
  // getAttachments()) no longer lists the trashed child — simulate that.
  parent.attachmentIDs = parent.attachmentIDs.filter(
    (id) => id !== attachment.id,
  );

  await harness.notify("trash", [attachment.id]);
  await harness.clock.settle();

  assert.equal(parent.hasTag("#nosource"), true);
  assert.equal(parent.hasTag("#pdf-mismatch"), false);
  assert.equal(parent.hasTag("#pdf-review"), false);
  // #auto-attached is untouched by this sync — a different concern.
  assert.equal(parent.hasTag("#auto-attached"), true);
  menu.dispose();
});

test("trashing a non-attachment item does not touch any parent's tags", async () => {
  // Guard against over-firing: the sync must resolve a real attachment with
  // a real regular-item parent before touching anything.
  harness = createHarness();
  const parent = createRegularItem(harness, {
    id: 1,
    tags: ["#pdf-mismatch"],
  });
  const unrelated = createRegularItem(harness, { id: 99, tags: [] });
  const menu = new harness.module.default();

  await harness.notify("trash", [unrelated.id]);
  await harness.clock.settle();

  assert.equal(parent.hasTag("#pdf-mismatch"), true);
  menu.dispose();
});

test("deleting a whole item (parent + its own attachment together) does not write tags to the doomed parent", async () => {
  // Regression: a batch delete of a regular item fires trash/delete for the
  // parent AND its attachment IDs together. Resolving the attachment's
  // parentItemID still finds the (also being-deleted) parent — writing
  // #nosource to an item that's itself mid-deletion is pointless. The
  // parent's own `deleted` flag must gate this, same spirit as
  // cancelAutomaticProcessing's existing isTopLevelItem/isRegularItem checks.
  harness = createHarness();
  const parent = createRegularItem(harness, {
    id: 1,
    tags: ["#pdf-mismatch"],
  });
  const attachment = createAttachment(harness, {
    id: 2,
    parent,
    path: "/source/old.pdf",
  });
  const menu = new harness.module.default();

  parent.deleted = true;
  parent.attachmentIDs = parent.attachmentIDs.filter(
    (id) => id !== attachment.id,
  );

  await harness.notify("trash", [parent.id, attachment.id]);
  await harness.clock.settle();

  // Untouched — no #nosource added, no pre-existing tag removed either.
  assert.equal(parent.hasTag("#nosource"), false);
  assert.equal(parent.hasTag("#pdf-mismatch"), true);
  menu.dispose();
});

test("a throw in the pre-existing cancelAutomaticProcessing does not prevent the #nosource sync from running", async () => {
  // Regression/hardening: cancelAutomaticProcessing (pre-existing code, not
  // touched by this fix) has no try/catch of its own around
  // item?.isTopLevelItem()/isRegularItem(). If it throws for some ID in the
  // batch, that must not stop syncSourceStatusOnRemoval — the two calls in
  // the notifier callback are now independently wrapped.
  harness = createHarness();
  const parent = createRegularItem(harness, {
    id: 1,
    tags: ["#pdf-mismatch"],
  });
  const attachment = createAttachment(harness, {
    id: 2,
    parent,
    path: "/source/old.pdf",
  });
  parent.attachmentIDs = [];

  // Poisoned for cancelAutomaticProcessing specifically: isTopLevelItem
  // throws, so `item?.isTopLevelItem() && ...` blows up before it ever
  // reaches isRegularItem/getAttachments.
  const poisoned = {
    id: 3,
    isTopLevelItem: () => {
      throw new Error("boom in cancelAutomaticProcessing");
    },
  };
  harness.items.set(poisoned.id, poisoned);

  const menu = new harness.module.default();

  await harness.notify("trash", [poisoned.id, attachment.id]);
  await harness.clock.settle();

  assert.equal(parent.hasTag("#nosource"), true);
  assert.equal(parent.hasTag("#pdf-mismatch"), false);
  menu.dispose();
});

test("pdf.nosourceSyncOnRemoval=false disables the sync as a kill switch, without touching cancelAutomaticProcessing", async () => {
  harness = createHarness({
    prefs: { "pdf.nosourceSyncOnRemoval": false },
  });
  const parent = createRegularItem(harness, {
    id: 1,
    tags: ["#pdf-mismatch"],
  });
  const attachment = createAttachment(harness, {
    id: 2,
    parent,
    path: "/source/old.pdf",
  });
  parent.attachmentIDs = [];
  const menu = new harness.module.default();

  await harness.notify("trash", [attachment.id]);
  await harness.clock.settle();

  // Sync is off — neither #nosource nor the mismatch clear happens.
  assert.equal(parent.hasTag("#nosource"), false);
  assert.equal(parent.hasTag("#pdf-mismatch"), true);
  menu.dispose();
});

test("one malformed/throwing ID in a batch does not block syncing the rest of the batch", async () => {
  // Regression: the per-ID resolution loop originally had no try/catch —
  // a single item whose isAttachment()/isRegularItem() throws (malformed
  // state, or any Zotero-side surprise) would abort the whole method,
  // silently skipping every OTHER id in the same batch delete.
  harness = createHarness();
  const goodParent = createRegularItem(harness, {
    id: 1,
    tags: ["#pdf-mismatch"],
  });
  const goodAttachment = createAttachment(harness, {
    id: 2,
    parent: goodParent,
    path: "/source/old.pdf",
  });
  goodParent.attachmentIDs = [];

  // A poisoned entry: resolves to an object whose isAttachment() throws.
  // isTopLevelItem() must also exist (returning false) so the PRE-EXISTING
  // cancelAutomaticProcessing — which runs before this method and has no
  // equivalent try/catch of its own — doesn't itself throw first and mask
  // what this test is actually checking.
  const poisoned = {
    id: 3,
    isTopLevelItem: () => false,
    isAttachment: () => {
      throw new Error("boom");
    },
  };
  harness.items.set(poisoned.id, poisoned);

  const menu = new harness.module.default();

  // Poisoned ID comes FIRST in the batch — if the loop weren't isolated per
  // iteration, this would prevent id 2 (the real, valid case) from ever
  // being reached.
  await harness.notify("trash", [poisoned.id, goodAttachment.id]);
  await harness.clock.settle();

  assert.equal(goodParent.hasTag("#nosource"), true);
  assert.equal(goodParent.hasTag("#pdf-mismatch"), false);
  menu.dispose();
});

test("a still-attached PDF surviving the batch is not falsely marked #nosource", async () => {
  // Two attachments on one item; only one is trashed. The parent still has
  // a real file attachment, so #nosource must NOT be set.
  harness = createHarness();
  const parent = createRegularItem(harness, { id: 1, tags: [] });
  const keep = createAttachment(harness, {
    id: 2,
    parent,
    path: "/source/keep.pdf",
  });
  const gone = createAttachment(harness, {
    id: 3,
    parent,
    path: "/source/gone.pdf",
  });
  void keep;
  const menu = new harness.module.default();

  parent.attachmentIDs = parent.attachmentIDs.filter((id) => id !== gone.id);

  await harness.notify("trash", [gone.id]);
  await harness.clock.settle();

  assert.equal(parent.hasTag("#nosource"), false);
  menu.dispose();
});

test("menu.ts skips syncing tags for any ID flagged in attachmentMutationInFlight (source-level guard)", () => {
  // Behavioral coverage above only exercises the common path. The in-flight
  // guard exists specifically to protect the plugin's own relocate/replace
  // cycle (delete old attachment ID, create a new one) from reading as a
  // real removal — assert the guard is actually wired into the new method,
  // matching the codebase's established pattern (see
  // mismatchRetagGuard.test.cjs for the equivalent reconciler-side checks).
  const menuSrc = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  const start = menuSrc.indexOf("private syncSourceStatusOnRemoval");
  assert.ok(start >= 0, "syncSourceStatusOnRemoval not found");
  const end = menuSrc.indexOf("\n  }\n", start);
  const body = menuSrc.slice(start, end);
  assert.match(body, /attachmentMutationInFlight\.has\(attachmentID\)/);
  assert.match(body, /attachmentMutationInFlight\.has\(parentID\)/);
});

test("matchAttachment's two success paths sync source status through the non-throwing wrapper", () => {
  // safeSyncSourceStatus swallows errors — a tag-bookkeeping failure must
  // never abort the real attach/rename/move flow it runs alongside.
  const menuSrc = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  const callSites = menuSrc.match(/await safeSyncSourceStatus\(item\);/g);
  assert.equal(callSites?.length, 2);
  const wrapperStart = menuSrc.indexOf(
    "async function safeSyncSourceStatus",
  );
  assert.ok(wrapperStart >= 0);
  const wrapperEnd = menuSrc.indexOf("\n}\n", wrapperStart);
  const wrapperBody = menuSrc.slice(wrapperStart, wrapperEnd);
  assert.match(wrapperBody, /try\s*\{/);
  assert.match(wrapperBody, /catch/);
});
