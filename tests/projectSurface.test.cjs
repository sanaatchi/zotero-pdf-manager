const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = process.cwd();

test("auto-rename preferences have defaults and checkbox controls", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const preferenceScript = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );

  assert.match(prefs, /autoRenameOnModify", false/);
  assert.match(prefs, /autoRenameOnModifyDebounceEnabled", true/);
  assert.match(prefs, /autoRenameOnModifyDebounceMs", 1000/);
  assert.match(prefs, /autoRenameOnModifyDelayEnabled", false/);
  assert.match(prefs, /autoRenameOnModifyDelayMs", 0/);
  assert.match(preferences, /id="auto-rename-on-modify"/);
  assert.match(
    preferences,
    /id="auto-rename-on-modify-options"[\s\S]*?hidden="true"/,
  );
  assert.match(preferences, /id="auto-rename-on-modify-debounce"/);
  assert.match(preferences, /id="auto-rename-on-modify-delay"/);
  assert.match(preferences, /id="auto-rename-on-modify-debounce-ms"/);
  assert.match(preferences, /id="auto-rename-on-modify-delay-ms"/);
  assert.equal(
    preferences.match(/lucide-circle-question-mark-icon/g)?.length,
    3,
  );
  assert.match(preferences, /data-l10n-id="auto-rename-on-modify-help"/);
  assert.match(
    preferences,
    /data-l10n-id="auto-rename-on-modify-debounce-help"/,
  );
  assert.match(preferences, /data-l10n-id="auto-rename-on-modify-delay-help"/);
  assert.match(preferences, /id="auto-rename-on-modify-debounce-ms"/);
  assert.match(preferences, /id="auto-rename-on-modify-delay-ms"/);
  assert.equal(preferences.match(/cursor: pointer/g)?.length, 3);
  assert.doesNotMatch(preferences, /cursor: help/);
  assert.match(preferenceScript, /input\.disabled = !checkbox\?\.checked/);
  assert.match(
    preferenceScript,
    /autoRenameOptions\.hidden = !autoRenameOnModify/,
  );
  assert.match(
    preferenceScript,
    /setPref\("autoRenameOnModify", autoRenameOnModifyCheckbox\.checked\)/,
  );
  assert.doesNotMatch(preferenceScript, /checkbox\.disabled\s*=/);
});

test("new automation locale keys exist in all supported locales", () => {
  const locales = ["de", "en-US", "it-IT"];
  const preferenceKeys = [
    "auto-rename-on-modify",
    "auto-rename-on-modify-debounce",
    "auto-rename-on-modify-delay",
  ];
  const helpKeys = [
    "auto-rename-on-modify-help",
    "auto-rename-on-modify-debounce-help",
    "auto-rename-on-modify-delay-help",
  ];
  const addonKeys = [
    "dir-not-set-destDir",
    "dir-not-set-sourceDir",
    "rename-linked-attachment-error",
  ];

  for (const locale of locales) {
    const preferences = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    const addon = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/addon.ftl`),
      "utf8",
    );
    for (const key of preferenceKeys) {
      assert.match(
        preferences,
        new RegExp(`^${key}\\s*=\\s*\\n\\s+\\.label\\s*=`, "m"),
      );
    }
    for (const key of helpKeys) {
      assert.match(
        preferences,
        new RegExp(
          `^${key}\\s*=\\s*\\n\\s+\\.tooltiptext\\s*=.+\\n\\s+\\.aria-label\\s*=`,
          "m",
        ),
      );
    }
    for (const key of addonKeys) {
      assert.match(addon, new RegExp(`^${key}\\s*=`, "m"));
    }
  }
});

test("multi-root PDF indexing is exposed in preferences", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const preferenceScript = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );

  assert.match(
    prefs,
    /pdf\.watchRoots",\s*"D:\\\\OneDrive\\\\1A_E_KAYNAKLARIM\\\\Kütüphane Dışı Kaynaklar"/,
  );
  assert.match(
    preferenceScript,
    /DEFAULT_DISI_WATCH_ROOT|ensurePathInWatchRoots/,
  );
  assert.match(prefs, /pdf\.useLinkedAttachmentBase", true/);
  assert.match(prefs, /pdf\.localAsLink", true/);
  assert.match(preferences, /preference="[^"]+\.pdf\.watchRoots"/);
  assert.match(preferences, /pdf\.useLinkedAttachmentBase"/);
  assert.match(preferences, /data-l10n-id="pdf-watch-roots-help"/);
  assert.match(preferences, /data-l10n-id="pdf-use-linked-base"/);
  assert.match(preferenceScript, /migratePDFWatchRoots\(\)/);
  assert.match(
    preferenceScript,
    /addEventListener\("change", invalidateIndex\)/,
  );

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-watch-roots\s*=/m);
    assert.match(source, /^pdf-watch-roots-help\s*=/m);
    assert.match(source, /^pdf-use-linked-base\s*=/m);
    assert.match(source, /^pdf-use-linked-base-help\s*=/m);
  }
});

test("startup and periodic PDF reconciliation are wired into lifecycle", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const hooks = fs.readFileSync(path.join(root, "src/hooks.ts"), "utf8");

  assert.match(prefs, /pdf\.autoOnStartup", true/);
  assert.match(prefs, /pdf\.periodicMinutes", 30/);
  assert.match(preferences, /preference="[^"]+\.pdf\.autoOnStartup"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.periodicMinutes"/);
  assert.match(hooks, /new PDFReconciler\(\)/);
  assert.match(hooks, /pdfReconciler\.start\(\)/);
  assert.match(hooks, /pdfReconciler\?\.dispose\(\)/);
  // P1 multi-window: process reconciler must not die on window unload.
  assert.match(hooks, /loadedWindows/);
  assert.match(hooks, /ensureProcessReconciler/);
  const unloadFn =
    hooks.match(
      /async function onMainWindowUnload[\s\S]*?(?=\nfunction onShutdown)/,
    )?.[0] || "";
  assert.ok(unloadFn.includes("onMainWindowUnload"));
  assert.doesNotMatch(unloadFn, /pdfReconciler\?\.dispose/);
  assert.doesNotMatch(unloadFn, /unregisterAll/);
  assert.match(hooks, /function onShutdown[\s\S]*pdfReconciler\?\.dispose/);
  assert.match(hooks, /function onShutdown[\s\S]*unregisterAll/);

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-auto-on-startup\s*=/m);
    assert.match(source, /^pdf-periodic-minutes\s*=/m);
    assert.match(source, /^pdf-periodic-minutes-help\s*=/m);
  }
});

test("new Zotero items enter the debounced automatic reconcile queue", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const reconciler = fs.readFileSync(
    path.join(root, "src/modules/pdfReconciler.ts"),
    "utf8",
  );

  assert.match(prefs, /pdf\.autoOnAdd", true/);
  assert.match(prefs, /pdf\.addSettleMs", 1000/);
  assert.match(prefs, /pdf\.autoAttachThreshold", 0\.85/);
  assert.match(prefs, /pdf\.reviewThreshold", 0\.6/);
  assert.match(preferences, /preference="[^"]+\.pdf\.autoOnAdd"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.autoAttachThreshold"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.reviewThreshold"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.addSettleMs"/);
  assert.match(reconciler, /Zotero\.Notifier\.registerObserver/);
  assert.match(reconciler, /event === "add"/);
  assert.match(reconciler, /event === "trash" \|\| event === "delete"/);
  assert.match(reconciler, /pendingItemIDs = new Set<number>\(\)/);
  assert.match(reconciler, /normalizeAddSettleMs/);
  assert.match(reconciler, /pdf\.addSettleMs/);
  assert.match(reconciler, /expandAddedItemIDs/);
  assert.match(reconciler, /addFlushRunning/);
  assert.match(reconciler, /unregisterNotifier/);
  assert.match(reconciler, /Zotero\.Notifier\.unregisterObserver/);

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-auto-on-add\s*=/m);
    assert.match(source, /^pdf-auto-attach-threshold\s*=/m);
    assert.match(source, /^pdf-review-threshold\s*=/m);
    assert.match(source, /^pdf-add-settle-ms\s*=/m);
  }
});

test("OA downloads folder preference is exposed", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const download = fs.readFileSync(
    path.join(root, "src/modules/pdfDownload.ts"),
    "utf8",
  );
  const sources = fs.readFileSync(
    path.join(root, "src/modules/pdfSources.ts"),
    "utf8",
  );

  assert.match(prefs, /pdf\.saveOaToDownloads", true/);
  assert.match(preferences, /preference="[^"]+\.pdf\.saveOaToDownloads"/);
  assert.match(sources, /relocateImportedPdfToDownloads/);
  assert.match(sources, /registerDownloadedFile/);
  assert.match(sources, /resolveOaDownloadsDir/);
  assert.match(
    download,
    /AUTOMATIC_ONLINE_SOURCE_IDS = \[[\s\S]*?"doi"[\s\S]*?"dergipark"[\s\S]*?"pmc"[\s\S]*\]/,
  );

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-save-oa-to-downloads\s*=/m);
    assert.match(source, /^pdf-save-oa-to-downloads-help\s*=/m);
  }
});

test("automatic online fallback is configurable and bulk-limited", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const reconciler = fs.readFileSync(
    path.join(root, "src/modules/pdfReconciler.ts"),
    "utf8",
  );

  assert.match(prefs, /pdf\.onlineAutoDownload", true/);
  assert.match(prefs, /pdf\.onlineOnReconcile", false/);
  assert.match(prefs, /pdf\.onlineMaxPerRun", 10/);
  assert.match(prefs, /pdf\.libraryBatchSize", 250/);
  assert.match(preferences, /preference="[^"]+\.pdf\.onlineAutoDownload"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.onlineOnReconcile"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.onlineMaxPerRun"/);
  assert.match(reconciler, /tryAutomaticOnlineSources\(item\)/);
  assert.match(reconciler, /isFolderIndexComplete/);
  assert.match(reconciler, /index-incomplete/);
  assert.match(reconciler, /"#auto-oa"/);
  assert.match(reconciler, /iterateLibraryItemBatches/);
  assert.match(reconciler, /AbortController/);
  assert.match(reconciler, /runWithAbortSignal/);

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-online-auto-download\s*=/m);
    assert.match(source, /^pdf-online-on-reconcile\s*=/m);
    assert.match(source, /^pdf-online-max-per-run\s*=/m);
    assert.match(source, /^pdf-online-safety-help\s*=/m);
  }
});

test("orphan PDF item creation respects orphanMode with safe autoCreate opt-in", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const processor = fs.readFileSync(
    path.join(root, "src/modules/orphanProcessor.ts"),
    "utf8",
  );
  const preferenceScript = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );

  assert.match(prefs, /pdf\.orphanMode", "report"/);
  assert.match(prefs, /pdf\.orphanMaxPerRun", 10/);
  assert.match(preferences, /value="autoCreate"/);
  assert.match(preferences, /id="pdf-create-orphans"/);
  assert.match(preferences, /preference="[^"]+\.pdf\.orphanMaxPerRun"/);
  assert.match(processor, /item\.addTag\("#auto-created"\)/);
  assert.match(processor, /item\.addTag\("#pdf-orphan"\)/);
  assert.match(processor, /ZPDF-Source-Path:/);
  assert.match(processor, /linkFromFile/);
  assert.match(processor, /item\.eraseTx\(\)/);
  assert.match(processor, /shouldAutoCreateOrphan/);
  assert.match(processor, /normalizeOrphanMode/);
  assert.doesNotMatch(preferenceScript, /orphanMode"\) === "autoCreate"/);
  const reconciler = fs.readFileSync(
    path.join(root, "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  assert.match(reconciler, /processOrphansNow\(\)/);
  assert.match(
    reconciler,
    /normalizeOrphanMode\(getPref\("pdf\.orphanMode"\)\)/,
  );
  assert.match(reconciler, /"automatic"/);
  assert.match(reconciler, /"manual"/);

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-orphan-mode\s*=/m);
    assert.match(source, /^pdf-orphan-auto-create\s*=/m);
    assert.match(source, /^pdf-orphan-max-per-run\s*=/m);
    assert.match(source, /^pdf-orphan-help\s*=/m);
    assert.match(source, /^pdf-create-orphans\s*=/m);
  }
});

test("PDF filename metadata is available only as a manual context command", () => {
  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  const module = fs.readFileSync(
    path.join(root, "src/modules/filenameMetadata.ts"),
    "utf8",
  );

  assert.match(menu, /pdf-filename-metadata-menu/);
  assert.match(menu, /fillMetadataFromSelectedPDFFilenames\(\)/);
  assert.match(module, /if \(!String\(\(item as any\)\.getField\(field\)/);
  assert.match(module, /parent\.addTag\("#filename-metadata"\)/);

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/addon.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-filename-metadata-menu\s*=/m);
  }
});

test("annotation-safe duplicate PDF merging is exposed in every locale", () => {
  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  const merger = fs.readFileSync(
    path.join(root, "src/modules/duplicateAttachmentMerger.ts"),
    "utf8",
  );

  assert.match(menu, /pdf-merge-duplicates-menu/);
  assert.match(menu, /mergeDuplicatePDFAttachments/);
  assert.match(merger, /attachmentHash/);
  assert.match(merger, /candidateContainsAnnotations/);
  assert.match(merger, /Zotero\.Items\.trashTx/);
  for (const locale of ["en-US", "de", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, "addon/locale", locale, "addon.ftl"),
      "utf8",
    );
    assert.match(source, /^pdf-merge-duplicates-menu\s*=/m);
  }
});

test("PDF-content metadata research is manual, identifier-first and confirmable", () => {
  const menu = fs.readFileSync(path.join(root, "src/modules/menu.ts"), "utf8");
  const module = fs.readFileSync(
    path.join(root, "src/modules/pdfContentMetadata.ts"),
    "utf8",
  );

  assert.match(menu, /pdf-content-metadata-menu/);
  assert.match(menu, /researchMetadataForSelectedPDFs/);
  assert.match(menu, /pdf-content-audit-menu/);
  assert.match(menu, /auditSelectedPdfContent/);
  assert.match(menu, /pdf-federated-menu/);
  assert.match(menu, /searchAllPdfSourcesForSelection/);
  assert.match(module, /extractDocumentIdentifiers/);
  assert.match(module, /crossrefByDOI/);
  assert.match(module, /openLibraryByISBN/);
  assert.match(module, /repairTurkishPDFText/);
  assert.match(module, /candidateFromPDFText/);
  assert.match(module, /window\.confirm/);
  assert.match(module, /attachment\.parentItemID = target\.id/);
  for (const locale of ["en-US", "de", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, "addon/locale", locale, "addon.ftl"),
      "utf8",
    );
    assert.match(source, /^pdf-content-metadata-menu\s*=/m);
    assert.match(source, /^pdf-content-audit-menu\s*=/m);
    assert.match(source, /^pdf-federated-menu\s*=/m);
  }
});

test("dry-run and persistent automation audit are exposed to the user", () => {
  const prefs = fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8");
  const preferences = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  const reconciler = fs.readFileSync(
    path.join(root, "src/modules/pdfReconciler.ts"),
    "utf8",
  );
  const audit = fs.readFileSync(
    path.join(root, "src/modules/automationAudit.ts"),
    "utf8",
  );

  assert.match(prefs, /pdf\.dryRun", false/);
  assert.match(preferences, /preference="[^"]+\.pdf\.dryRun"/);
  assert.match(preferences, /id="pdf-run-reconcile"/);
  assert.match(preferences, /id="pdf-cancel-reconcile"/);
  assert.match(preferences, /id="pdf-open-audit"/);
  assert.match(preferences, /id="pdf-clear-audit"/);
  assert.match(preferences, /data-l10n-id="pdf-audit-tags-help"/);
  assert.match(reconciler, /getPref\("pdf\.dryRun"\) === true/);
  assert.match(reconciler, /openAutomationAuditReport/);
  assert.match(reconciler, /Dry-run: linked attachment was not created/);
  assert.match(reconciler, /Dry-run: OA sources were not contacted/);
  assert.match(audit, /MAX_EVENTS = 2000/);
  assert.match(audit, /zpdfmanager-automation-audit\.json/);
  assert.match(audit, /openAutomationAuditReport/);
  assert.match(audit, /summarizeAuditEvents/);
  assert.match(audit, /REVERSIBLE_AUTOMATION_TAGS/);
  assert.match(audit, /clearAuditEvents/);

  for (const locale of ["de", "en-US", "it-IT"]) {
    const source = fs.readFileSync(
      path.join(root, `addon/locale/${locale}/preferences.ftl`),
      "utf8",
    );
    assert.match(source, /^pdf-dry-run\s*=/m);
    assert.match(source, /^pdf-run-reconcile\s*=/m);
    assert.match(source, /^pdf-cancel-reconcile\s*=/m);
    assert.match(source, /^pdf-open-audit\s*=/m);
    assert.match(source, /^pdf-clear-audit\s*=/m);
    assert.match(source, /^pdf-audit-tags-help\s*=/m);
  }
});

test("root README identifies Zotero PDF Manager and Katman 2 release channel", () => {
  const source = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(source, /Zotero PDF Manager/);
  assert.match(source, /zotero-pdf-manager@ibrahimyildiz\.art/);
  assert.match(source, /sanaatchi\/zotero-pdf-manager-releases/);
  assert.match(source, /Katman 2/);
  assert.doesNotMatch(source, /MuiseDestiny\/zotero-attanger/);
  assert.doesNotMatch(source, /^# Zotero Attanger/m);
});

test("legacy README translations still cross-link language switchers", () => {
  const docs = ["doc/README-zhCN.md", "doc/README-de.md", "doc/README-itIT.md"];

  for (const relativeFile of docs) {
    const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
    assert.match(source, /English/);
    assert.match(source, /简体中文/);
    assert.match(source, /Deutsch/);
    assert.match(source, /Italiano/);
  }
});
