<!-- @ajan: cursor · @etiket: katman-2, kabul, checklist, zotero, v1.0.33 -->

# Zotero PDF Manager — manuel kabul checklist

**Sürüm:** 1.0.33 · **Kaynak:** `dd2f311e` · [CI](https://github.com/sanaatchi/zotero-pdf-manager/actions/runs/30496542222)  
**XPI:** https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/tag/v1.0.33

| Alan   | Değer                        |
| ------ | ---------------------------- |
| Tarih  | 2026-07-30                   |
| Testçi | kullanıcı (sohbet)           |
| Zotero | (sürümü sonra yaz)           |
| Özet   | A1–A6 tamam (A2 Windows N/A) |

| #   | Senaryo                | Beklenen               | Sonuç | Kanıt                          |
| --- | ---------------------- | ---------------------- | ----- | ------------------------------ |
| 1   | Eklenti yükle          | Menü + tercihler       | ✅    | tercihler paneli + 1.0.33      |
| 2   | İkinci ana pencere     | Menü her ikisinde      | ⏭     | Windows’ta 2. ana pencere yok  |
| 3   | ISBN checksum          | Geçersiz ISBN eşleşmez | ✅    | 0 updated, 1 skipped; ISBN boş |
| 4   | Metadata DOI normalize | Prefix temiz           | ✅    | Normalize: doi-prefix          |
| 5   | Update kanalı          | v1.0.33 + sha512       | ✅    | kurulu 1.0.33                  |
| 6   | Quarantine / review    | `#pdf-quarantine`      | ✅    | kullanıcı: A6 ok               |

- [x] Manuel matris tamam → rapor checklist `✅`
