const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule(entry) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), entry)],
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

test("cancelToken abortable rejects when signal aborts", async () => {
  const {
    abortable,
    runWithAbortSignal,
    throwIfRunAborted,
    isRunAborted,
    RunAbortedError,
  } = loadModule("src/utils/cancelToken.ts");

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => abortable(Promise.resolve(1), ac.signal),
    (err) => err instanceof RunAbortedError || err?.name === "RunAbortedError",
  );

  const live = new AbortController();
  const p = abortable(
    new Promise((resolve) => setTimeout(() => resolve(42), 50)),
    live.signal,
  );
  live.abort();
  await assert.rejects(
    () => p,
    (err) => err?.name === "RunAbortedError",
  );

  const scoped = new AbortController();
  await assert.rejects(
    () =>
      runWithAbortSignal(scoped.signal, async () => {
        scoped.abort();
        throwIfRunAborted();
      }),
    (err) => err?.name === "RunAbortedError",
  );
  assert.equal(isRunAborted(scoped.signal), true);
});

test("chunkIds pages a 99999-id library into bounded batches", () => {
  const {
    chunkIds,
    normalizeLibraryBatchSize,
    DEFAULT_LIBRARY_BATCH_SIZE,
    MAX_LIBRARY_BATCH_SIZE,
  } = loadModule("src/utils/libraryIterate.ts");

  assert.equal(normalizeLibraryBatchSize(0), DEFAULT_LIBRARY_BATCH_SIZE);
  assert.equal(normalizeLibraryBatchSize(9999), MAX_LIBRARY_BATCH_SIZE);
  assert.equal(normalizeLibraryBatchSize(250), 250);

  const CAP = 99999;
  const ids = Array.from({ length: CAP }, (_, i) => i + 1);
  const batches = chunkIds(ids, 250);
  assert.equal(batches.length, Math.ceil(CAP / 250));
  assert.equal(batches[0].length, 250);
  assert.equal(batches[batches.length - 1].length, CAP % 250);
  assert.equal(
    batches.reduce((n, b) => n + b.length, 0),
    CAP,
  );
  assert.equal(batches[0][0], 1);
  assert.equal(batches[batches.length - 1].at(-1), CAP);
});

test("iterateLibraryItemBatches yields via getAllIDs+getAsync and respects abort", async () => {
  const { iterateLibraryItemBatches } = loadModule(
    "src/utils/libraryIterate.ts",
  );

  const ids = [1, 2, 3, 4, 5];
  const loaded = [];
  const batches = [];
  for await (const batch of iterateLibraryItemBatches(1, {
    batchSize: 2,
    yieldEventLoop: async () => {},
    loader: {
      getAllIDs: async () => ids,
      getAsync: async (chunk) => {
        loaded.push([...chunk]);
        return chunk.map((id) => ({
          id,
          isRegularItem: () => true,
          isTopLevelItem: () => true,
        }));
      },
    },
  })) {
    batches.push(batch.map((item) => item.id));
  }
  assert.deepEqual(loaded, [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);

  const ac = new AbortController();
  let yielded = 0;
  for await (const _batch of iterateLibraryItemBatches(1, {
    batchSize: 2,
    signal: ac.signal,
    yieldEventLoop: async () => {
      ac.abort();
    },
    loader: {
      getAllIDs: async () => [10, 11, 12, 13],
      getAsync: async (chunk) =>
        chunk.map((id) => ({
          id,
          isRegularItem: () => true,
          isTopLevelItem: () => true,
        })),
    },
  })) {
    yielded++;
  }
  assert.equal(yielded, 1);
});

test("cancelToken abortable invokes onAbort canceller", async () => {
  const { abortable, RunAbortedError } = loadModule("src/utils/cancelToken.ts");
  const ac = new AbortController();
  let cancelled = 0;
  const p = abortable(new Promise(() => {}), ac.signal, () => {
    cancelled++;
  });
  ac.abort();
  await assert.rejects(
    () => p,
    (err) => err?.name === "RunAbortedError" || err instanceof RunAbortedError,
  );
  assert.equal(cancelled, 1);
});

test("iterateLibraryItemBatches fail-closes without getAllIDs by default", async () => {
  const { iterateLibraryItemBatches } = loadModule(
    "src/utils/libraryIterate.ts",
  );
  const batches = [];
  for await (const batch of iterateLibraryItemBatches(1, {
    batchSize: 2,
    yieldEventLoop: async () => {},
    loader: {
      getAll: async () => [
        { id: 1, isRegularItem: () => true, isTopLevelItem: () => true },
        { id: 2, isRegularItem: () => true, isTopLevelItem: () => true },
      ],
    },
  })) {
    batches.push(batch);
  }
  assert.equal(batches.length, 0);
});

test("httpGet wires cancellerReceiver for real HTTP abort", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfSources.ts"),
    "utf8",
  );
  assert.match(source, /cancellerReceiver/);
  assert.match(source, /cancelRef/);
  const index = fs.readFileSync(
    path.join(process.cwd(), "src/modules/folderIndex.ts"),
    "utf8",
  );
  assert.match(index, /signal\?\.aborted/);
  assert.match(index, /RunAbortedError/);
  const reconciler = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  assert.match(reconciler, /mergeKnownSourcePaths/);
  assert.doesNotMatch(reconciler, /orphanItems\.push/);
});
