<!-- @ajan: cursor · @etiket: katman-2, eksik-raporu, isbn-checksum -->

# Cursor — Katman 2 Eksikler Raporu

> **Çalışma kuralı:** Bu katmanda düzenleme öncesi  
> **1)** bu raporu oku → **2)** açık maddeleri düzelt → **3)** ancak sonra görev.  
> Rule: `.cursor/rules/katman-eksik-raporu.mdc`

**Tarih:** 2026-07-30

**Kapsam:** `zotero-pdf-manager`

**Durum:** `in progress` — ISBN checksum P1 kodda kapandı (test yeşil); patch
release/checklist ayrı adım.

## 2026-07-30 — Cursor düzeltmesi

| Madde | Durum | Not |
| ----- | ----- | --- |
| ISBN 10↔13 checksum | ✅ | `isValidIsbn10/13`; dönüşüm/eşdeğerlik yalnızca geçerli checksum |
| Testler | ✅ | 187/187 (fixture ISBN check digit düzeltildi) |
| Gerçek Zotero checklist | 🟡 | Manuel |
| Cancellation / 99.999 kabul | 🟡 P2 | Önceki rapor |

**Doğrulama:** `npm test` → 187 pass
