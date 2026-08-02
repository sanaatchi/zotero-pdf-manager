<!-- @ajan: cursor · @etiket: katman-2, vendor, lisans, provenance, b4-lint, b5 -->

# PDF Manager — vendor / port kayıtları

Fiili tamamlanan üçüncü parti kodlar. Port planı: [`PDFMANAGER-REFERANS-PORT.md`](PDFMANAGER-REFERANS-PORT.md).
Lisans metinleri: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Ölçek sözleşmesi:** indeks/tarama üst sınırı `MAX_INDEX_FILES = 99999`
(`folderIndex.ts`, Katman `MAX_LIBRARY_PDFS` ile hizalı).

Kuratör kök (2026-08): `zotero-eklentiler/referanslar/katman-2/` (+ eski düz yollar
bazı SHA’lar için hâlâ geçerli olabilir).

## Tamamlanan (pinned SHA)

| Kaynak             | Upstream                                                                                         | Pinned SHA                                                                     | SPDX                | Kaynak yollar (mirror)                                         | Hedef                                                       | Yöntem / uyarlama                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Attachment Scanner | [SciImage/zotero-attachment-scanner](https://github.com/SciImage/zotero-attachment-scanner)      | `bd64d535edb265a336bbdeb661fd4cd896aacf22` (upstream HEAD 2026-07; mirror yok) | MIT                 | upstream `chrome/` / scan logic                                | `src/modules/attachmentScanner.ts`                          | selective — tag/scan UX adapted                                                          |
| ZotMoov            | [wileyyugioh/zotmoov](https://github.com/wileyyugioh/zotmoov)                                    | `8fb20ab8baebe6976b2a281b40bc48910bc3ca62`                                     | GPL-3.0             | `referanslar/katman-2/ek-dosya/zotmoov`                        | `folderIndex.ts` (linked base merge)                        | behavior-only — no line copy                                                             |
| Watch Folder       | [josesiqueira/zotero-watch-folder](https://github.com/josesiqueira/zotero-watch-folder) (mirror) | `07068206dce23a4ad261c208734d318078108425`                                     | GPL-3.0             | `referanslar/katman-1/klasor-izleme` (K2 port; K1 ref klasörü) | `folderIndex.ts`, `orphanProcessor.ts`                      | selective/behavior — mtime index + gated orphanMode                                      |
| Attanger           | [MuiseDestiny/zotero-attanger](https://github.com/MuiseDestiny/zotero-attanger)                  | `a1f98bfab1dc487ee84fdd9d2533d20596d4aea1`                                     | AGPL-3.0            | (mirror taşındıysa eski SHA)                                   | `pdfReconciler.ts`, `pdfSources.ts`, `automationAudit.ts`   | selective — thresholds, settle, drain coalesce, audit UX                                 |
| Zotadata           | [ydeng11/zotero-zotadata](https://github.com/ydeng11/zotero-zotadata) (mirror; pkg AGPL)         | `ad1a8143ae48ea2750fa5bd647921c529a4b17a7`                                     | AGPL-3.0 (treat as) | (OA cascade)                                                   | `oaDownloadPath.ts`, `pdfDownload.ts`, `pdfSources.ts`      | selective — OA → downloads/; Sci-Hub not in auto cascade                                 |
| Format Metadata    | [northword/zotero-format-metadata](https://github.com/northword/zotero-format-metadata)          | `39db0a31f5848329d2c34ffe3470bbcabb3ffc34`                                     | AGPL-3.0            | `referanslar/katman-2/metadata-linter/zotero-format-metadata`  | `metadataNormalize.ts`, `metadataCheck.ts`, `pdfSources.ts` | selective — DOI prefix, pages connector, title trailing-dot, ISBN 10↔13; not full linter |
| Del Item With Att  | [redleafnew/delitemwithatt](https://github.com/redleafnew/delitemwithatt)                        | `d2eaeedb40619f4d2fbe0b7b615016c01e85bdbd`                                     | GPL-3.0             | `referanslar/katman-2/ek-silme/delitemwithatt`                 | `attachmentDelete.ts`, `attachmentDeletePlan.ts`            | selective/behavior — linked-file unlink + trash; confirm; no lang/export port            |

## Companion XPI (port yok)

| Kaynak                                                | Lisans   | Mirror SHA                                                                              | Rol                                                                                    |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Zoplicate](https://github.com/ChenglongMa/zoplicate) | AGPL-3.0 | `6e93d9fc53d14e8c971b74882d9ac55295374a37` (`referanslar/katman-2/yinelenen/zoplicate`) | **Yan XPI** — öğe master merge. PDF Manager yalnız ince DOI/ISBN/KP aday raporu verir. |

## Planlı (henüz vendor satırı yok)

| Kaynak   | Lisans | Hedef | Faz  |
| -------- | ------ | ----- | ---- |
| jasminum | —      | CNKI  | skip |

## Kural

- Yeni port → bu tabloya satır (repo + **tam SHA** + SPDX + kaynak/hedef yollar) + `THIRD_PARTY_NOTICES.md` + kök `Changes.md`
- OCR / Sci-Hub varsayılan yolu bu tabloya **eklenmez** (bkz. REFERANS-PORT §2)
- Notices ↔ vendor tutarlılığı: `tests/vendorProvenance.test.cjs`
