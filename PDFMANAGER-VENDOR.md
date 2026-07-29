<!-- @ajan: cursor · @etiket: katman-2, vendor, lisans, provenance, p2 -->

# PDF Manager — vendor / port kayıtları

Fiili tamamlanan üçüncü parti kodlar. Port planı: [`PDFMANAGER-REFERANS-PORT.md`](PDFMANAGER-REFERANS-PORT.md).
Lisans metinleri: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Ölçek sözleşmesi:** indeks/tarama üst sınırı `MAX_INDEX_FILES = 99999`
(`folderIndex.ts`, Katman `MAX_LIBRARY_PDFS` ile hizalı).

## Tamamlanan (pinned SHA)

Yerel mirror: `zotero-eklentiler/referanslar/<klasör>/` (`git rev-parse HEAD`).
GitHub URL’leri upstream kimlik; SHA yerel mirror ile doğrulanır.

| Kaynak             | Upstream                                                                                         | Pinned SHA                                                                     | SPDX                | Kaynak yollar (mirror)               | Hedef                                                       | Yöntem / uyarlama                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------- | ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Attachment Scanner | [SciImage/zotero-attachment-scanner](https://github.com/SciImage/zotero-attachment-scanner)      | `bd64d535edb265a336bbdeb661fd4cd896aacf22` (upstream HEAD 2026-07; mirror yok) | MIT                 | upstream `chrome/` / scan logic      | `src/modules/attachmentScanner.ts`                          | selective — tag/scan UX adapted                                                          |
| ZotMoov            | [wileyyugioh/zotmoov](https://github.com/wileyyugioh/zotmoov)                                    | `8fb20ab8baebe6976b2a281b40bc48910bc3ca62`                                     | GPL-3.0             | `referanslar/zotmoov`                | `folderIndex.ts` (linked base merge)                        | behavior-only — no line copy                                                             |
| Watch Folder       | [josesiqueira/zotero-watch-folder](https://github.com/josesiqueira/zotero-watch-folder) (mirror) | `07068206dce23a4ad261c208734d318078108425`                                     | GPL-3.0             | `referanslar/zotero-watch-folder`    | `folderIndex.ts`, `orphanProcessor.ts`                      | selective/behavior — mtime index + gated orphanMode                                      |
| Attanger           | [MuiseDestiny/zotero-attanger](https://github.com/MuiseDestiny/zotero-attanger)                  | `a1f98bfab1dc487ee84fdd9d2533d20596d4aea1`                                     | AGPL-3.0            | `referanslar/zotero-attanger`        | `pdfReconciler.ts`, `pdfSources.ts`, `automationAudit.ts`   | selective — thresholds, settle, drain coalesce, audit UX                                 |
| Zotadata           | [ydeng11/zotero-zotadata](https://github.com/ydeng11/zotero-zotadata) (mirror; pkg AGPL)         | `ad1a8143ae48ea2750fa5bd647921c529a4b17a7`                                     | AGPL-3.0 (treat as) | `referanslar/zotero-zotadata`        | `oaDownloadPath.ts`, `pdfDownload.ts`, `pdfSources.ts`      | selective — OA → downloads/; Sci-Hub not in auto cascade                                 |
| Format Metadata    | [northword/zotero-format-metadata](https://github.com/northword/zotero-format-metadata)          | `39db0a31f5848329d2c34ffe3470bbcabb3ffc34`                                     | AGPL-3.0            | `referanslar/zotero-format-metadata` | `metadataNormalize.ts`, `metadataCheck.ts`, `pdfSources.ts` | selective — DOI prefix, pages connector, title trailing-dot, ISBN 10↔13; not full linter |

## Planlı (henüz vendor satırı yok)

| Kaynak | Lisans | Hedef | Faz |
| ------ | ------ | ----- | --- |
| —      | —      | —     | —   |

## Kural

- Yeni port → bu tabloya satır (repo + **tam SHA** + SPDX + kaynak/hedef yollar) + `THIRD_PARTY_NOTICES.md` + kök `Changes.md`
- OCR / Sci-Hub varsayılan yolu bu tabloya **eklenmez** (bkz. REFERANS-PORT §2)
- Notices ↔ vendor tutarlılığı: `tests/vendorProvenance.test.cjs`
