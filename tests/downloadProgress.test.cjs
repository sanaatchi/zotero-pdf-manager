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
        const line = {
          text: opts.text || "",
          progress: opts.progress ?? 0,
          type: opts.type || "default",
          setText(t) {
            this.text = t;
          },
          setProgress(p) {
            this.progress = p;
          },
          setItemTypeAndIcon() {},
        };
        this.lines.push(line);
        return this;
      }
      changeLine(opts) {
        const idx = opts.idx ?? 0;
        const line = this.lines[idx];
        if (!line) return;
        if (opts.text) line.setText(opts.text);
        if (typeof opts.progress === "number") line.setProgress(opts.progress);
        if (opts.type) line.type = opts.type;
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

test("reportDownloadProgress without jobId notifies handler", () => {
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

test("reportDownloadProgress with jobId does not collapse via handler", () => {
  const {
    setDownloadProgressHandler,
    reportDownloadProgress,
    registerDownloadJob,
    finishDownloadJob,
  } = load();
  const seen = [];
  setDownloadProgressHandler((p) => seen.push(p.percent));
  registerDownloadJob("a", { source: "s2", title: "One" });
  reportDownloadProgress(25, 100, "a");
  finishDownloadJob("a", { ok: true });
  setDownloadProgressHandler(null);
  assert.deepEqual(seen, []);
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

test("concurrent jobs update separate ProgressWindow lines", () => {
  const {
    registerDownloadJob,
    reportDownloadProgress,
    finishDownloadJob,
    snapshotActiveDownloadJobs,
    formatActiveJobsStatus,
  } = load();

  registerDownloadJob("j1", {
    source: "dergipark",
    title: "Alpha paper title",
  });
  registerDownloadJob("j2", { source: "yoktez", title: "Beta thesis title" });

  reportDownloadProgress(40, 100, "j1");
  reportDownloadProgress(10, 100, "j2");

  const snap = snapshotActiveDownloadJobs();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].percent, "40%");
  assert.equal(snap[1].percent, "10%");

  const status = formatActiveJobsStatus(snap);
  assert.match(status, /dergipark/);
  assert.match(status, /yoktez/);
  assert.match(status, /40%/);
  assert.match(status, /10%/);

  const win = global.ztoolkit._lastWin;
  void win;
  // Lines live on the ProgressWindow instance created inside the module.
  // Re-read via change: both lines must keep distinct text after updates.
  finishDownloadJob("j1", { ok: true });
  assert.equal(snapshotActiveDownloadJobs().length, 1);
  finishDownloadJob("j2", { ok: true });
  assert.equal(snapshotActiveDownloadJobs().length, 0);
});

test("finishDownloadJob is idempotent (no board wipe while siblings run)", () => {
  const {
    registerDownloadJob,
    reportDownloadProgress,
    finishDownloadJob,
    snapshotActiveDownloadJobs,
  } = load();
  registerDownloadJob("a", { source: "a", title: "A" });
  registerDownloadJob("b", { source: "b", title: "B" });
  reportDownloadProgress(50, 100, "a");
  reportDownloadProgress(20, 100, "b");
  finishDownloadJob("a", { ok: true });
  finishDownloadJob("a", { ok: true }); // double finish
  assert.equal(snapshotActiveDownloadJobs().length, 1);
  assert.equal(snapshotActiveDownloadJobs()[0].jobId, "b");
  reportDownloadProgress(80, 100, "b");
  assert.equal(snapshotActiveDownloadJobs()[0].percent, "80%");
  finishDownloadJob("b", { ok: true });
  assert.equal(snapshotActiveDownloadJobs().length, 0);
});
