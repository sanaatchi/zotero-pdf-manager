const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/oaDownloadPath.ts")],
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

test("OA downloads dir is first watch root + downloads", () => {
  const { resolveOaDownloadsDir } = loadModule();
  assert.equal(
    resolveOaDownloadsDir(["D:\\Papers", "E:\\Other"]),
    "D:\\Papers\\downloads",
  );
  assert.equal(resolveOaDownloadsDir(["/home/lib/"]), "/home/lib/downloads");
  assert.equal(resolveOaDownloadsDir([]), null);
});

test("OA download basename prefers DOI and sanitizes", () => {
  const {
    buildOaDownloadBasename,
    sanitizeDownloadBasename,
    uniqueDownloadPath,
  } = loadModule();
  assert.equal(
    buildOaDownloadBasename(
      { doi: "10.1000/ABC/12", title: "Ignore" },
      "arxiv",
    ),
    "10.1000_ABC_12",
  );
  assert.equal(
    buildOaDownloadBasename({ title: "Hello: World?", itemID: 7 }, "pmc"),
    "Hello_ World_-pmc",
  );
  assert.equal(sanitizeDownloadBasename('a<>b:"c'), "a__b__c");
  assert.equal(
    uniqueDownloadPath("D:\\Papers\\downloads", "file", () => false),
    "D:\\Papers\\downloads\\file.pdf",
  );
  assert.equal(
    uniqueDownloadPath("D:\\Papers\\downloads", "file", () => true, 99),
    "D:\\Papers\\downloads\\file-99.pdf",
  );
});

test("parallel reserveUniqueDownloadPath never returns the same path", async () => {
  const { reserveUniqueDownloadPath, releaseDownloadPathReservation } =
    loadModule();
  const existing = new Set();
  const existsAsync = async (p) => existing.has(p);
  const [a, b, c] = await Promise.all([
    reserveUniqueDownloadPath("D:\\d", "same", existsAsync, 1000),
    reserveUniqueDownloadPath("D:\\d", "same", existsAsync, 1000),
    reserveUniqueDownloadPath("D:\\d", "same", existsAsync, 1000),
  ]);
  assert.equal(new Set([a, b, c]).size, 3);
  for (const p of [a, b, c]) releaseDownloadPathReservation(p);
});

test("exists probe failure is fail-closed (path not reserved as free)", async () => {
  const { reserveUniqueDownloadPath, releaseDownloadPathReservation } =
    loadModule();
  const path = await reserveUniqueDownloadPath(
    "D:\\d",
    "probe",
    async (p) => {
      if (p.endsWith("probe.pdf")) throw new Error("exists broken");
      return false;
    },
    1,
  );
  assert.notEqual(path, "D:\\d\\probe.pdf");
  assert.match(path, /probe-1\.pdf$/);
  releaseDownloadPathReservation(path);
});

test("shouldCleanupPersistedDownload only when this run created the final file", () => {
  const { shouldCleanupPersistedDownload } = loadModule();
  assert.equal(shouldCleanupPersistedDownload(false), false);
  assert.equal(shouldCleanupPersistedDownload(true), true);
});

test("automatic OA source list still excludes Sci-Hub and LibGen", () => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfDownload.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["../../package.json"],
  });
  // Prefer loading only the const via oa helpers + reconciler test already covers list.
  // Soft-check source file surface instead when bundle pulls Zotero-heavy deps.
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pdfDownload.ts"),
    "utf8",
  );
  assert.match(src, /AUTOMATIC_ONLINE_SOURCE_IDS/);
  assert.match(src, /\["dergipark", "pmc"\]/);
  assert.doesNotMatch(src, /doi.*arxiv.*pmc.*s2/);
  const autoBlock =
    src.match(/export const AUTOMATIC_ONLINE_SOURCE_IDS = \[[\s\S]*?\]/)?.[0] ||
    "";
  assert.doesNotMatch(autoBlock, /scihub/);
  assert.doesNotMatch(autoBlock, /libgen/);
  assert.doesNotMatch(autoBlock, /doi/);
  assert.doesNotMatch(autoBlock, /arxiv/);
  assert.doesNotMatch(autoBlock, /s2/);
  void result;
});
