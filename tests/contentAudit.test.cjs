// @ajan: cursor · @etiket: katman-2, tests, content-audit
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadAuditPure() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), "src/modules/pdfContentAudit.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: [
      "../utils/locale",
      "../utils/prefs",
      "./automationAudit",
      "./pdfSources",
      "../../package.json",
    ],
  });
  const module = { exports: {} };
  const req = (id) => {
    if (id.endsWith("package.json")) {
      return { config: { addonName: "test", addonRef: "zpdfmanager" } };
    }
    if (id.includes("locale")) return { getString: (k) => k };
    if (id.includes("prefs")) return { getPref: () => true };
    if (id.includes("automationAudit")) return { appendAuditEvent: () => {} };
    if (id.includes("pdfSources")) {
      return {
        cleanupRejectedAttachment: async () => "cleaned",
        validateAttachmentContentDetailed: async () => ({
          verdict: "match",
          pdfText: "",
        }),
      };
    }
    return require(id);
  };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    req,
  );
  return module.exports;
}

test("decideContentAuditAction: match ok; mismatch tags or detaches; unverifiable review", () => {
  const { decideContentAuditAction } = loadAuditPure();
  assert.equal(
    decideContentAuditAction({ verdict: "match", detachMismatch: false }),
    "ok",
  );
  assert.equal(
    decideContentAuditAction({ verdict: "mismatch", detachMismatch: false }),
    "tag-mismatch",
  );
  assert.equal(
    decideContentAuditAction({ verdict: "mismatch", detachMismatch: true }),
    "detach",
  );
  assert.equal(
    decideContentAuditAction({
      verdict: "unverifiable",
      detachMismatch: true,
    }),
    "tag-review",
  );
  assert.equal(
    decideContentAuditAction({ verdict: "skipped", detachMismatch: false }),
    "skip",
  );
});

test("summarizeContentAudit counts verdicts and detached", () => {
  const { summarizeContentAudit } = loadAuditPure();
  const sum = summarizeContentAudit([
    { verdict: "match", action: "ok" },
    { verdict: "mismatch", action: "tagged" },
    { verdict: "mismatch", action: "detached" },
    { verdict: "unverifiable", action: "tagged" },
    { verdict: "no-pdf", action: "skipped" },
  ]);
  assert.equal(sum.match, 1);
  assert.equal(sum.mismatch, 2);
  assert.equal(sum.unverifiable, 1);
  assert.equal(sum.noPdf, 1);
  assert.equal(sum.detached, 1);
});

test("content audit module + menu + locales wired", () => {
  const root = process.cwd();
  const audit = fs.readFileSync(
    path.join(root, "src/modules/pdfContentAudit.ts"),
    "utf8",
  );
  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  const sources = fs.readFileSync(
    path.join(root, "src/modules/pdfSources.ts"),
    "utf8",
  );
  const tags = fs.readFileSync(
    path.join(root, "src/modules/automationAudit.ts"),
    "utf8",
  );

  assert.match(audit, /PDF_MISMATCH_TAG = "#pdf-mismatch"/);
  assert.match(audit, /validateAttachmentContentDetailed/);
  assert.match(audit, /force:\s*true/);
  assert.match(audit, /auditSelectedPdfContent/);
  assert.match(audit, /cleanupRejectedAttachment/);
  assert.match(menu, /pdf-content-audit-menu/);
  assert.match(menu, /auditSelectedPdfContent/);
  assert.match(sources, /opts\.force/);
  assert.match(tags, /"#pdf-mismatch"/);

  for (const locale of ["en-US", "de", "it-IT"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", locale, "addon.ftl"),
      "utf8",
    );
    assert.match(ftl, /^pdf-content-audit-menu\s*=/m);
    assert.match(ftl, /^pdf-content-audit-detach-confirm\s*=/m);
  }
});
