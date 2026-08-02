// @ajan: cursor · @etiket: katman-2, tests, federated-search
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

function loadApply() {
  const result = esbuild.buildSync({
    entryPoints: [
      path.join(process.cwd(), "src/modules/federatedSearchApply.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: [
      "../utils/locale",
      "./oaPdfBridge",
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
    if (id.includes("oaPdfBridge")) {
      return {
        enabledFederatedSourceIds: () => ["doi"],
        fetchOaPdfViaBridge: async () => null,
        searchAllOaSources: async () => ({ hits: [] }),
      };
    }
    if (id.includes("pdfSources")) {
      return {
        downloadAndAttach: async () => null,
        rethrowAttachControlFlow: () => {},
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

test("pickTopDownloadableHit skips landing-only rows", () => {
  const { pickTopDownloadableHit } = loadApply();
  assert.equal(
    pickTopDownloadableHit([
      { source: "yoktez", title: "A", pdfUrl: "" },
      { source: "doi", title: "B", pdfUrl: "https://x/a.pdf", score: 0.9 },
    ])?.source,
    "doi",
  );
  assert.equal(pickTopDownloadableHit([{ title: "x" }]), null);
});

test("federated search wired in menu + locales + bridge", () => {
  const root = process.cwd();
  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  const bridge = fs.readFileSync(
    path.join(root, "src/modules/oaPdfBridge.ts"),
    "utf8",
  );
  assert.match(menu, /pdf-federated-menu/);
  assert.match(menu, /searchAllPdfSourcesForSelection/);
  assert.match(bridge, /searchAllOaSources/);
  assert.match(bridge, /enabledFederatedSourceIds/);
  assert.match(bridge, /source:\s*"all"/);
  for (const locale of ["en-US", "de", "it-IT"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", locale, "addon.ftl"),
      "utf8",
    );
    assert.match(ftl, /^pdf-federated-menu\s*=/m);
  }
});
