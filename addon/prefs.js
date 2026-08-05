// @ajan: cursor · @etiket: katman-2, prefs, arxiv-hidden
/* eslint-disable no-undef */
pref("extensions.zotero.__addonRef__.enable", true);
pref("extensions.zotero.__addonRef__.attachType", "linking");
pref("extensions.zotero.__addonRef__.subfolderFormat", "{{collection}}");
pref("extensions.zotero.__addonRef__.slashAsSubfolderDelimiter", true);
pref("extensions.zotero.__addonRef__.sourceDir", "");
pref("extensions.zotero.__addonRef__.readPDFtitle", "nonCJK");
pref("extensions.zotero.__addonRef__.destDir", "");
pref("extensions.zotero.__addonRef__.autoMove", true);
pref("extensions.zotero.__addonRef__.autoRenameOnModify", false);
pref("extensions.zotero.__addonRef__.autoRenameOnModifyDebounceEnabled", true);
pref("extensions.zotero.__addonRef__.autoRenameOnModifyDebounceMs", 1000);
pref("extensions.zotero.__addonRef__.autoRenameOnModifyDelayEnabled", false);
pref("extensions.zotero.__addonRef__.autoRenameOnModifyDelayMs", 0);

pref("extensions.zotero.__addonRef__.attachNewFile.shortcut", "Ctrl + I");
pref("extensions.zotero.__addonRef__.matchAttachment.shortcut", "Ctrl + M");
pref("extensions.zotero.__addonRef__.renameAttachment.shortcut", "Ctrl + R");
pref(
  "extensions.zotero.__addonRef__.renameMoveAttachment.shortcut",
  "Ctrl + Shift + R",
);
pref(
  "extensions.zotero.__addonRef__.moveAttachment.shortcut",
  "Ctrl + Shift + M",
);

pref("extensions.zotero.__addonRef__.attachNewFile.shortcut.enable", true);
pref("extensions.zotero.__addonRef__.matchAttachment.shortcut.enable", true);
pref("extensions.zotero.__addonRef__.renameAttachment.shortcut.enable", false);
pref(
  "extensions.zotero.__addonRef__.renameMoveAttachment.shortcut.enable",
  false,
);
pref("extensions.zotero.__addonRef__.moveAttachment.shortcut.enable", false);

pref(
  "extensions.zotero.__addonRef__.fileTypes",
  "pdf,doc,docx,txt,rtf,djvu,epub",
);
pref("extensions.zotero.__addonRef__.filenameAsPrefixRules", "");
pref("extensions.zotero.__addonRef__.filenameSkipRenameRules", "");
pref("extensions.zotero.__addonRef__.filenameSkipAutoMoveRenameRules", "");
pref("extensions.zotero.__addonRef__.autoRemoveEmptyFolder", false);

pref("extensions.zotero.__addonRef__.moveWithoutDeleting", false);
pref("extensions.zotero.__addonRef__.syncAttachmentTitle", false);

// --- PDF downloader ---
pref("extensions.zotero.__addonRef__.pdf.skipExisting", true);
pref("extensions.zotero.__addonRef__.pdf.metadataCheck", true);
pref("extensions.zotero.__addonRef__.pdf.validateContent", true);
pref("extensions.zotero.__addonRef__.pdf.embedMetadataAutomatically", false);
pref("extensions.zotero.__addonRef__.pdf.showReport", true);
pref("extensions.zotero.__addonRef__.pdf.autoOnStartup", true);
pref("extensions.zotero.__addonRef__.pdf.autoOnAdd", true);
pref("extensions.zotero.__addonRef__.pdf.periodicMinutes", 30);
pref("extensions.zotero.__addonRef__.pdf.autoAttachThreshold", 0.85);
pref("extensions.zotero.__addonRef__.pdf.reviewThreshold", 0.6);
pref("extensions.zotero.__addonRef__.pdf.addSettleMs", 1000);
pref("extensions.zotero.__addonRef__.pdf.onlineAutoDownload", true);
pref("extensions.zotero.__addonRef__.pdf.saveOaToDownloads", true);
pref("extensions.zotero.__addonRef__.pdf.onlineOnReconcile", false);
pref("extensions.zotero.__addonRef__.pdf.onlineMaxPerRun", 10);
// Hidden: library scan page size (1–2000). Default 250; aligns with ~99k scale.
pref("extensions.zotero.__addonRef__.pdf.libraryBatchSize", 250);
pref("extensions.zotero.__addonRef__.pdf.orphanMode", "report");
pref("extensions.zotero.__addonRef__.pdf.orphanMaxPerRun", 10);
pref("extensions.zotero.__addonRef__.pdf.dryRun", false);
pref("extensions.zotero.__addonRef__.scanner.scanNoSource", true);
pref("extensions.zotero.__addonRef__.scanner.scanNonfiles", false);
pref("extensions.zotero.__addonRef__.scanner.scanDuplicates", true);
pref("extensions.zotero.__addonRef__.scanner.removePubmedEntry", false);
pref("extensions.zotero.__addonRef__.scanner.removeSnapshot", false);
pref("extensions.zotero.__addonRef__.scanner.removeBroken", false);
pref("extensions.zotero.__addonRef__.scanner.monitorAttachments", false);
pref("extensions.zotero.__addonRef__.scanner.ignoredFileMasks", "");
pref("extensions.zotero.__addonRef__.scanner.tagNoSource", "#nosource");
pref("extensions.zotero.__addonRef__.scanner.tagBroken", "#broken");
pref("extensions.zotero.__addonRef__.scanner.tagDuplicate", "#duplicate");
pref("extensions.zotero.__addonRef__.scanner.tagNonfile", "#nonfile");
pref(
  "extensions.zotero.__addonRef__.pdf.sourceOrder",
  "local,doi,dergipark,pmc,core,libgen,zenodo,openaire,scihub,yoktez,archive,proxy",
);
pref("extensions.zotero.__addonRef__.pdf.localEnabled", true);
pref(
  "extensions.zotero.__addonRef__.pdf.localFolder",
  "D:\\OneDrive\\1A_E_KAYNAKLARIM",
);
// Semicolon/newline-separated roots. Empty migrates from localFolder and
// always ensures Kütüphane Dışı Kaynaklar is present (preferenceScript).
pref(
  "extensions.zotero.__addonRef__.pdf.watchRoots",
  "D:\\OneDrive\\1A_E_KAYNAKLARIM\\Kütüphane Dışı Kaynaklar",
);
pref("extensions.zotero.__addonRef__.pdf.useLinkedAttachmentBase", true);
pref("extensions.zotero.__addonRef__.pdf.localAsLink", true);
// doi = Unpaywall CAPTCHA-free OA download. arXiv is not a selectable OA source
// (pref kept false for migrate). Metadata-only leftovers: s2 / proquest
pref("extensions.zotero.__addonRef__.pdf.doiEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.arxivEnabled", false);
pref("extensions.zotero.__addonRef__.pdf.pmcEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.s2Enabled", false);
pref("extensions.zotero.__addonRef__.pdf.dergiparkEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.scihubEnabled", true);
pref(
  "extensions.zotero.__addonRef__.pdf.scihubURL",
  "https://sci-hub.se/;https://sci-hub.st/;https://sci-hub.ru/",
);
pref("extensions.zotero.__addonRef__.pdf.libgenEnabled", true);
pref(
  "extensions.zotero.__addonRef__.pdf.libgenURL",
  "https://libgen.li/;https://libgen.vg/;https://libgen.la/;https://libgen.bz/;https://libgen.gl/",
);
pref("extensions.zotero.__addonRef__.pdf.yoktezEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.proquestEnabled", false);
// zenodo/archive/openaire: open APIs, no key. core: needs a free API key
// (core.ac.uk/services/api) set as env OA_PDF_CORE_API_KEY — off by
// default until configured, else every federated search wastes a call.
pref("extensions.zotero.__addonRef__.pdf.zenodoEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.archiveEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.openaireEnabled", true);
pref("extensions.zotero.__addonRef__.pdf.coreEnabled", false);
pref("extensions.zotero.__addonRef__.pdf.proxyEnabled", false);
pref("extensions.zotero.__addonRef__.pdf.proxyURL", "");
pref("extensions.zotero.__addonRef__.pdf.oaBridgeUrl", "http://127.0.0.1:8756");
// OA Search popup: last selected source ids (comma-separated). Empty → prefs-enabled.
pref("extensions.zotero.__addonRef__.pdf.oaSearchSources", "");
// OA Search: comma-separated active criteria field ids (empty = all on).
pref("extensions.zotero.__addonRef__.pdf.oaSearchFieldActive", "");
// OA Search: fan-out one remote query per active primary field.
pref("extensions.zotero.__addonRef__.pdf.oaSearchFieldByField", false);
// Optional Ollama content check via bridge (/pdf-validate-content).
pref("extensions.zotero.__addonRef__.pdf.validateContentLlm", true);
pref("extensions.zotero.__addonRef__.pdf.metadataOnlySourcesMigratedV1", false);
pref("extensions.zotero.__addonRef__.pdf.doiUnpaywallAutoMigratedV1", false);
