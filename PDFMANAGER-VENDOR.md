<!-- @ajan: cursor · @etiket: katman-2, vendor, lisans, provenance -->

# PDF Manager — vendor / port kayıtları

Fiili tamamlanan üçüncü parti kodlar. Port planı: [`PDFMANAGER-REFERANS-PORT.md`](PDFMANAGER-REFERANS-PORT.md).
Lisans metinleri: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Tamamlanan

| Kaynak                                                                             | Lisans         | Konum                                                          | Kullanım                                                   |
| ---------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| [zotero-attachment-scanner](https://github.com/SciImage/zotero-attachment-scanner) | MIT            | `attachmentScanner` (adapted)                                  | Ek tarama davranışı                                        |
| [zotmoov](https://github.com/wileyyugioh/zotmoov)                                  | GPL-3          | `folderIndex` (behavior)                                       | Linked Attachment Base → watch root birleştirme (P2-1)     |
| [zotero-watch-folder](https://github.com/ArgilDD/zotero-watch-folder)              | GPL-3          | `folderIndex` + `orphanProcessor` (behavior/selective)         | P2-1 indeks; P2-5 orphanMode + identifier-gated autoCreate |
| [zotero-attanger](https://github.com/MuiseDestiny/zotero-attanger)                 | AGPL           | `pdfSources` / `pdfReconciler` / `automationAudit` (selective) | P2-2/3 eşik+coalesce; P2-6 audit rapor UX                  |
| [zotero-zotadata](https://github.com/PanagiotisKaraliolios/zotero-zotadata)        | AGPL gibi işle | `oaDownloadPath` / `pdfDownload` (selective)                   | P2-4 OA → `{watchRoot}/downloads/` + indeks; Sci-Hub hariç |

## Planlı (henüz vendor satırı yok)

| Kaynak                 | Lisans | Hedef           | Faz |
| ---------------------- | ------ | --------------- | --- |
| zotero-format-metadata | AGPL   | `metadataCheck` | P2  |

## Kural

- Yeni port → bu tabloya satır + `THIRD_PARTY_NOTICES.md` + kök `Changes.md`
- OCR / Sci-Hub varsayılan yolu bu tabloya **eklenmez** (bkz. REFERANS-PORT §2)
