// @ajan: cursor · @etiket: katman-2, tests, match-rename-move
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");
const {
  createAttachment,
  createHarness,
  createRegularItem,
} = require("./helpers/menuHarness.cjs");

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

test("finalizeLocalAttachment relocates only after shouldClearMatchTags", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(
    source,
    /if \(shouldClearMatchTags\(detailed\.verdict,\s*via\)\) \{[\s\S]*?return relocateAfterSuccessfulMatch\(attachment\)/,
  );
  assert.match(source, /registerMatchedAttachmentRelocate/);
  // Mismatch / unverifiable must not call relocate.
  const mismatchBlock = source.slice(
    source.indexOf("Local PDF mismatch"),
    source.indexOf("matchItem(item"),
  );
  assert.doesNotMatch(mismatchBlock, /relocateAfterSuccessfulMatch/);
  const unverifiableBlock = source.slice(
    source.indexOf("Local PDF unverifiable"),
    source.indexOf("Local PDF mismatch"),
  );
  assert.doesNotMatch(unverifiableBlock, /relocateAfterSuccessfulMatch/);
});

test("Menu registers relocate handler and Match Attachment calls it", () => {
  const menu = fs.readFileSync(
    path.join(process.cwd(), "src/modules/menu.ts"),
    "utf8",
  );
  assert.match(
    menu,
    /registerMatchedAttachmentRelocate\(maybeRenameAndMoveMatchedAttachment\)/,
  );
  assert.match(
    menu,
    /export async function maybeRenameAndMoveMatchedAttachment/,
  );
  assert.match(
    menu,
    /await maybeRenameAndMoveMatchedAttachment\(\s*existingAttachment/,
  );
  assert.match(menu, /await maybeRenameAndMoveMatchedAttachment\(attItem\)/);
  // Move gated on autoMove + destDir; rename always attempted after.
  assert.match(menu, /getPref\("autoMove"\)/);
  assert.match(menu, /destDir unset/);
  assert.match(menu, /await renameFile\(current\)/);
});

test("registerMatchedAttachmentRelocate wires and clears", async () => {
  const {
    registerMatchedAttachmentRelocate,
    __getMatchedAttachmentRelocateForTests,
  } = loadPdfSources();

  assert.equal(__getMatchedAttachmentRelocateForTests(), null);
  const stub = async (att) => att;
  registerMatchedAttachmentRelocate(stub);
  assert.equal(__getMatchedAttachmentRelocateForTests(), stub);
  registerMatchedAttachmentRelocate(null);
  assert.equal(__getMatchedAttachmentRelocateForTests(), null);
});

test("maybeRenameAndMoveMatchedAttachment moves linked file then renames", async () => {
  const harness = createHarness({
    directories: ["/inbox", "/dest"],
    files: ["/inbox/raw-title.pdf"],
    prefs: {
      autoMove: true,
      destDir: "/dest",
      subfolderFormat: "",
      attachType: "linking",
    },
    baseName: "Author - Title",
  });
  try {
    const parent = createRegularItem(harness, {
      id: 201,
      title: "Title",
      fileBaseName: "Author - Title",
    });
    const attachment = createAttachment(harness, {
      id: 202,
      mode: "linked",
      parent,
      path: "/inbox/raw-title.pdf",
    });
    // Ensure Menu constructor registration does not steal focus — call export.
    const relocate = harness.module.maybeRenameAndMoveMatchedAttachment;
    assert.equal(typeof relocate, "function");

    const result = await relocate(attachment);

    assert.ok(result, "relocate should return an attachment");
    assert.ok(
      harness.calls.copy.some(
        ([src, dest]) =>
          src === "/inbox/raw-title.pdf" && dest === "/dest/raw-title.pdf",
      ),
      "expected copy toward destDir",
    );
    const renamedOnResult =
      result.calls?.rename?.some((name) => /Author - Title\.pdf/i.test(name)) ||
      false;
    const pathAfter = await result.getFilePathAsync();
    assert.ok(
      renamedOnResult || /Author - Title\.pdf$/i.test(pathAfter || ""),
      `expected künye rename, path=${pathAfter} rename=${JSON.stringify(result.calls?.rename)}`,
    );
    assert.match(pathAfter || "", /^\/dest\//);
  } finally {
    harness.cleanup();
  }
});

test("maybeRenameAndMoveMatchedAttachment renames in place when destDir unset", async () => {
  const harness = createHarness({
    directories: ["/inbox"],
    files: ["/inbox/messy.pdf"],
    prefs: {
      autoMove: true,
      destDir: "",
      subfolderFormat: "",
      attachType: "linking",
    },
    baseName: "Author - Title",
  });
  try {
    const parent = createRegularItem(harness, {
      id: 301,
      title: "Title",
      fileBaseName: "Author - Title",
    });
    const attachment = createAttachment(harness, {
      id: 302,
      mode: "linked",
      parent,
      path: "/inbox/messy.pdf",
    });

    await harness.module.maybeRenameAndMoveMatchedAttachment(attachment);

    assert.equal(harness.calls.copy.length, 0, "no move without destDir");
    assert.deepEqual(attachment.calls.rename, ["Author - Title.pdf"]);
    assert.equal(
      await attachment.getFilePathAsync(),
      "/inbox/Author - Title.pdf",
    );
  } finally {
    harness.cleanup();
  }
});

test("maybeRenameAndMoveMatchedAttachment skips move when autoMove false", async () => {
  const harness = createHarness({
    directories: ["/inbox", "/dest"],
    files: ["/inbox/messy.pdf"],
    prefs: {
      autoMove: false,
      destDir: "/dest",
      subfolderFormat: "",
      attachType: "linking",
    },
    baseName: "Author - Title",
  });
  try {
    const parent = createRegularItem(harness, { id: 401, title: "Title" });
    const attachment = createAttachment(harness, {
      id: 402,
      mode: "linked",
      parent,
      path: "/inbox/messy.pdf",
    });

    await harness.module.maybeRenameAndMoveMatchedAttachment(attachment);

    assert.equal(harness.calls.copy.length, 0);
    assert.deepEqual(attachment.calls.rename, ["Author - Title.pdf"]);
  } finally {
    harness.cleanup();
  }
});
