// @ajan: cursor · @etiket: katman-2, tests, content-audit, match-tag-clear
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadAuditPure(opts = {}) {
  const verdict = opts.verdict || "match";
  const clearCalls = opts.clearCalls || [];
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
        cleanupRejectedAttachment: async () => {
          throw new Error(
            "content-audit must not call cleanupRejectedAttachment",
          );
        },
        clearSuccessfulMatchTags: async (item) => {
          clearCalls.push(item);
          for (const tag of [
            "#pdf-review",
            "#pdf-quarantine",
            "#pdf-mismatch",
          ]) {
            if (item.hasTag?.(tag)) item.removeTag(tag);
          }
        },
        validateAttachmentContentDetailed: async () => ({
          verdict,
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

test("decideContentAuditAction: match ok; mismatch always tags; never detach", () => {
  const { decideContentAuditAction } = loadAuditPure();
  assert.equal(decideContentAuditAction({ verdict: "match" }), "ok");
  assert.equal(
    decideContentAuditAction({ verdict: "mismatch" }),
    "tag-mismatch",
  );
  assert.equal(
    decideContentAuditAction({ verdict: "unverifiable" }),
    "tag-review",
  );
  assert.equal(decideContentAuditAction({ verdict: "skipped" }), "skip");
  assert.equal(decideContentAuditAction({ verdict: "error" }), "error");
  assert.doesNotMatch(
    String(decideContentAuditAction({ verdict: "mismatch" })),
    /detach/,
  );
});

test("summarizeContentAudit counts verdicts (no detached field)", () => {
  const { summarizeContentAudit } = loadAuditPure();
  const sum = summarizeContentAudit([
    { verdict: "match", action: "ok" },
    { verdict: "mismatch", action: "tagged" },
    { verdict: "mismatch", action: "tagged" },
    { verdict: "unverifiable", action: "tagged" },
    { verdict: "no-pdf", action: "skipped" },
  ]);
  assert.equal(sum.match, 1);
  assert.equal(sum.mismatch, 2);
  assert.equal(sum.unverifiable, 1);
  assert.equal(sum.noPdf, 1);
  assert.equal(sum.detached, undefined);
});

test("auditItemPdfContent match clears mismatch/review/quarantine tags", async () => {
  const clearCalls = [];
  const { auditItemPdfContent } = loadAuditPure({
    verdict: "match",
    clearCalls,
  });
  const tags = new Set(["#pdf-mismatch", "#pdf-review", "#pdf-quarantine"]);
  const att = {
    id: 22,
    isFileAttachment: () => true,
    isPDFAttachment: () => true,
    attachmentContentType: "application/pdf",
    fileExists: async () => true,
  };
  const item = {
    id: 11,
    getField: () => "Okunan Kitap",
    getAttachments: () => [22],
    hasTag: (t) => tags.has(t),
    addTag: (t) => tags.add(t),
    removeTag: (t) => tags.delete(t),
    saveTx: async () => {},
  };
  globalThis.Zotero = {
    Items: {
      getAsync: async (id) => (id === 22 ? att : item),
    },
  };

  const rows = await auditItemPdfContent(item);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "match");
  assert.equal(rows[0].action, "ok");
  assert.equal(clearCalls.length, 1);
  assert.equal(tags.has("#pdf-mismatch"), false);
  assert.equal(tags.has("#pdf-review"), false);
  assert.equal(tags.has("#pdf-quarantine"), false);
  assert.match(rows[0].note || "", /cleared mismatch tags/);
});

test("auditItemPdfContent mismatch keeps tags (no clearSuccessfulMatchTags)", async () => {
  const clearCalls = [];
  const { auditItemPdfContent } = loadAuditPure({
    verdict: "mismatch",
    clearCalls,
  });
  const tags = new Set();
  const att = {
    id: 22,
    isFileAttachment: () => true,
    isPDFAttachment: () => true,
    attachmentContentType: "application/pdf",
    fileExists: async () => true,
  };
  const item = {
    id: 11,
    getField: () => "Yanlis Kitap",
    getAttachments: () => [22],
    hasTag: (t) => tags.has(t),
    addTag: (t) => tags.add(t),
    removeTag: (t) => tags.delete(t),
    saveTx: async () => {},
  };
  globalThis.Zotero = {
    Items: {
      getAsync: async (id) => (id === 22 ? att : item),
    },
  };

  const rows = await auditItemPdfContent(item);
  assert.equal(rows[0].verdict, "mismatch");
  assert.equal(rows[0].action, "tagged");
  assert.equal(clearCalls.length, 0);
  assert.equal(tags.has("#pdf-mismatch"), true);
  assert.equal(tags.has("#pdf-review"), true);
});

test("content audit module + menu + locales: tag-only, no detach", () => {
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
  assert.match(audit, /clearSuccessfulMatchTags/);
  assert.match(
    audit,
    /plan === "ok"[\s\S]*?await clearSuccessfulMatchTags\(item\)/,
  );
  assert.doesNotMatch(audit, /cleanupRejectedAttachment/);
  assert.doesNotMatch(audit, /detachMismatch/);
  assert.doesNotMatch(audit, /eraseTx/);
  assert.doesNotMatch(audit, /confirmDialog/);
  assert.doesNotMatch(audit, /pdf-content-audit-detach/);
  assert.match(menu, /pdf-content-audit-menu/);
  assert.match(menu, /auditSelectedPdfContent/);
  assert.match(sources, /opts\.force/);
  assert.match(sources, /export async function clearSuccessfulMatchTags/);
  assert.match(tags, /"#pdf-mismatch"/);

  for (const locale of ["en-US", "de", "it-IT"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", locale, "addon.ftl"),
      "utf8",
    );
    assert.match(ftl, /^pdf-content-audit-menu\s*=/m);
    assert.match(ftl, /^pdf-content-audit-done\s*=/m);
    assert.match(ftl, /#pdf-mismatch/);
    assert.doesNotMatch(ftl, /pdf-content-audit-detach-confirm/);
    assert.doesNotMatch(ftl, /pdf-content-audit-detached/);
  }
});
