// @ajan: cursor · @etiket: katman-2, download-progress, test
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function load() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/downloadProgress.ts")],
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

test("formatDownloadPercent prefers percent when total known", () => {
  const { formatDownloadPercent } = load();
  assert.equal(
    formatDownloadPercent({ loaded: 50, total: 100, percent: 50 }),
    "50%",
  );
  assert.equal(
    formatDownloadPercent({ loaded: 2048, total: 0, percent: null }),
    "2 KB",
  );
});

test("reportDownloadProgress notifies handler", () => {
  const {
    setDownloadProgressHandler,
    reportDownloadProgress,
    formatDownloadPercent,
  } = load();
  const seen = [];
  setDownloadProgressHandler((p) => seen.push(formatDownloadPercent(p)));
  reportDownloadProgress(25, 100);
  setDownloadProgressHandler(null);
  assert.deepEqual(seen, ["25%"]);
});
