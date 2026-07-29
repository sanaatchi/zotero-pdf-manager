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
  assert.match(html, /data-f="planned"/);
  assert.match(html, /Reversible tags/);
});

test("empty automation audit renders a useful state", () => {
  const { auditEventsToHTML } = loadModule();

  assert.match(auditEventsToHTML([]), /No automation events yet/);
});

test("summarizeAuditEvents counts outcomes and dry-run banner works", () => {
  const {
    summarizeAuditEvents,
    auditEventsToHTML,
    auditEventsToText,
    REVERSIBLE_AUTOMATION_TAGS,
  } = loadModule();
  const events = [
    {
      timestamp: "2026-07-26T12:00:00.000Z",
      run: "a",
      action: "local-attach",
      outcome: "success",
    },
    {
      timestamp: "2026-07-26T12:01:00.000Z",
      run: "a",
      action: "local-attach",
      outcome: "planned",
    },
    {
      timestamp: "2026-07-26T12:02:00.000Z",
      run: "a",
      action: "local-match",
      outcome: "review",
    },
    {
      timestamp: "2026-07-26T12:03:00.000Z",
      run: "a",
      action: "item-reconcile",
      outcome: "failed",
    },
  ];
  assert.deepEqual(summarizeAuditEvents(events), {
    total: 4,
    success: 1,
    planned: 1,
    review: 1,
    failed: 1,
    info: 0,
    dryRunHints: 1,
  });
  const html = auditEventsToHTML(events, { dryRunActive: true });
  assert.match(html, /Dry-run is ON/);
  assert.match(auditEventsToText(events), /\[planned\]/);
  assert.ok(REVERSIBLE_AUTOMATION_TAGS.includes("#pdf-review"));
});
