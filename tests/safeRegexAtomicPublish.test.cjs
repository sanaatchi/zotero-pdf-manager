const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadSafeRegex() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/safeRegex.ts")],
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

function loadAtomic() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/utils/atomicJson.ts")],
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

test("safeRegex rejects nested quantifier / oversized patterns", () => {
  const { compileUserRegex, isRiskyUserRegexPattern, safeRegexTest } =
    loadSafeRegex();
  assert.equal(isRiskyUserRegexPattern("(a+)+"), true);
  assert.equal(compileUserRegex("(a+)+"), null);
  assert.equal(compileUserRegex("a".repeat(201)), null);
  assert.equal(isRiskyUserRegexPattern("(a|aa)+$"), true);
  assert.equal(compileUserRegex("(a|aa)+$"), null);
  assert.equal(isRiskyUserRegexPattern("(a|a?)+$"), true);
  assert.equal(compileUserRegex("(a|a?)+$"), null);
  assert.equal(isRiskyUserRegexPattern("(foo)\\1"), true);
  assert.equal(isRiskyUserRegexPattern("(?=a)"), true);
  const ok = compileUserRegex("^draft", "i");
  assert.ok(ok);
  assert.equal(safeRegexTest(ok, "Draft-notes"), true);
});

test("atomic JSON move failure keeps original file; corrupt is quarantined", async () => {
  const { writeUtf8Atomic, readJsonOrQuarantine, __setAtomicJsonIOForTests } =
    loadAtomic();

  const files = new Map([["data.json", '{"ok":true}']]);
  let movedCorrupt = null;

  __setAtomicJsonIOForTests({
    exists: async (p) => files.has(p) || p.startsWith("data.json.corrupt-"),
    readUTF8: async (p) => {
      if (!files.has(p)) throw new Error("missing");
      return files.get(p);
    },
    writeUTF8: async (p, t) => {
      files.set(p, t);
    },
    move: async (from, to) => {
      if (to === "data.json") throw new Error("crash before replace");
      if (to.startsWith("data.json.corrupt-")) {
        movedCorrupt = to;
        files.set(to, files.get(from));
        files.delete(from);
        return;
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
    remove: async (p) => {
      files.delete(p);
    },
  });

  await assert.rejects(() => writeUtf8Atomic("data.json", '{"new":1}'));
  assert.equal(files.get("data.json"), '{"ok":true}');

  files.set("data.json", "{not-json");
  await assert.rejects(() => readJsonOrQuarantine("data.json"));
  assert.ok(movedCorrupt);
  assert.equal(files.has("data.json"), false);
  __setAtomicJsonIOForTests(null);
});

test("publish release notes stay a single argv value (no shell)", async () => {
  const { pathToFileURL } = require("node:url");
  const mod = await import(
    pathToFileURL(path.join(process.cwd(), "scripts/publish.mjs")).href
  );
  const notes = 'title with "quotes" & | % \nbreak';
  const args = mod.buildGhReleaseCreateArgs({
    tag: "v1.0.28",
    xpi: "build/zotero-pdf-manager.xpi",
    updateJson: "update.json",
    repo: "sanaatchi/zotero-pdf-manager-releases",
    title: "v1.0.28",
    releaseNotes: notes,
  });
  assert.equal(args[args.length - 1], notes);
  assert.equal(args[args.length - 2], "--notes");
  assert.ok(!args.some((a) => typeof a === "string" && a.includes(" && ")));
});
