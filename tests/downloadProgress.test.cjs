// @ajan: cursor · @etiket: katman-2, download-progress, multi-job, test
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
    external: ["../../package.json"],
  });
  const module = { exports: {} };
  // Stub ztoolkit ProgressWindow for board helpers.
  global.ztoolkit = {
    ProgressWindow: class {
      constructor() {
        this.lines = [];
      }
      createLine(opts) {
        this.lines.push({ ...opts });
        return this;
      }
      changeLine(opts) {
        const idx = opts.idx ?? 0;
        this.lines[idx] = { ...(this.lines[idx] || {}), ...opts };
      }
      show() {
        return this;
      }
      startCloseTimer() {}
    },
  };
  const pkg = { config: { addonName: "Test PDF Manager" } };
  const req = (name) => {
    if (name.endsWith("package.json") || name === "../../package.json")
      return pkg;
    return require(name);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
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

test("mapPool runs with bounded concurrency", async () => {
  const { mapPool } = load();
  let running = 0;
  let maxRunning = 0;
  const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(maxRunning <= 2);
});

test("job listener receives jobId", () => {
  const { addJobProgressListener, reportDownloadProgress } = load();
  const seen = [];
  const off = addJobProgressListener((id, p) => seen.push([id, p.percent]));
  reportDownloadProgress(10, 100, "job-a");
  off();
  assert.deepEqual(seen, [["job-a", 10]]);
});
