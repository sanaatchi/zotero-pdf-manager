<!-- @ajan: cursor · @etiket: katman-2, eksik-raporu, max-path -->

# Cursor — Katman 2 Eksikler Raporu

**Tarih:** 2026-07-30 · **Sürüm:** v1.0.34  
**Durum:** Kod/CI/provenance ✅. Checklist ✅ kapandı. Hotfix: MAX_PATH metadata write.

| Madde                                | Durum | Not                                                                                                       |
| ------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------- |
| ISBN / exact-source CI / update.json | ✅    |                                                                                                           |
| Zotero checklist                     | ✅    | Kullanıcı gerçek Zotero'da 6/6 yürüttü (`226a418c`, v1.0.33) — #2 (ikinci ana pencere) Windows'ta N/A.    |
| Metadata gömme MAX_PATH              | ✅    | v1.0.34: `.zpm-{key}.tmp` kısa kardeş temp; uzun OneDrive yollarında `NS_ERROR_FILE_NOT_FOUND` giderildi. |
