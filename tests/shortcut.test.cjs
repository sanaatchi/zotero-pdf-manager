const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadShortcutModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/shortcut.ts")],
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

function keyEvent(overrides = {}) {
  return {
    key: "m",
    code: "KeyM",
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test("matches editable shortcut text against keydown events", () => {
  const { shortcutMatchesEvent } = loadShortcutModule();

  assert.equal(
    shortcutMatchesEvent("Ctrl + M", keyEvent()),
    true,
  );
  assert.equal(
    shortcutMatchesEvent(
      "Ctrl+Shift+M",
      keyEvent({ shiftKey: true }),
    ),
    true,
  );
  assert.equal(
    shortcutMatchesEvent("Ctrl + M", keyEvent({ altKey: true })),
    false,
  );
});

test("matches Turkish dotted and dotless I keyboard events", () => {
  const { shortcutMatchesEvent } = loadShortcutModule();

  assert.equal(
    shortcutMatchesEvent(
      "Ctrl + I",
      keyEvent({ key: "ı", code: "KeyI" }),
    ),
    true,
  );
  assert.equal(
    shortcutMatchesEvent(
      "Ctrl + İ",
      keyEvent({ key: "i", code: "KeyI" }),
    ),
    true,
  );
});
