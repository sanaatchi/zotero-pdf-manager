const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const esbuild = require("esbuild");

function loadModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/automationAudit.ts")],
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

test("automation audit HTML escapes user-controlled metadata", () => {
  const { auditEventsToHTML } = loadModule();
  const html = auditEventsToHTML([
    {
      timestamp: "2026-07-26T12:00:00.000Z",
      run: "test",
      action: "local-attach",
      outcome: "planned",
      title: '<script>alert("x")</script>',
      detail: "dry-run",
    },
  ]);

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /planned/);
});

test("empty automation audit renders a useful state", () => {
  const { auditEventsToHTML } = loadModule();

  assert.match(auditEventsToHTML([]), /No automation events yet/);
});
