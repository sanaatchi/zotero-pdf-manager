<!-- @ajan: cursor · @etiket: katman-2, kabul, checklist, zotero, v1.0.30 -->

# Zotero PDF Manager — manuel kabul checklist

**Sürüm:** 1.0.30 · **Kaynak:** `3c97ed96` (fix `a0cdccdc`)  
**XPI:** https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/tag/v1.0.30

| Alan          | Değer            |
| ------------- | ---------------- |
| Tarih         |                  |
| Testçi        |                  |
| OS            | Windows          |
| Zotero sürümü | (7 / 8 / 9 / 10) |
| XPI           | v1.0.30 public   |

| #   | Senaryo                          | Beklenen                                          | Sonuç | Kanıt |
| --- | -------------------------------- | ------------------------------------------------- | ----- | ----- |
| 1   | Eklenti yükle                    | Menü + tercihler                                  |       |       |
| 2   | İkinci ana pencere               | Menü her ikisinde; tek reconciler                 |       |       |
| 3   | İlk pencereyi kapat              | İkinci pencere menü/otomasyon çalışır             |       |       |
| 4   | Son pencereyi kapat              | Shutdown’da sızıntı yok (log)                     |       |       |
| 5   | Incomplete watch root (izin yok) | Audit `index-incomplete`; OA yok                  |       |       |
| 6   | OA indirme                       | downloads/ altına yazar; üzerine yazmaz           |       |       |
| 7   | Update kanalı                    | 1.0.30 + sha512 kabul                             |       |       |
| 8   | Dispose sırasında OA iptal       | Abort; geç attach yok                             |       |       |
| 9   | Unverifiable PDF                 | `#pdf-review` + tek attachment; ikinci kaynak yok |       |       |
