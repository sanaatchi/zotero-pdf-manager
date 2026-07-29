<!-- @ajan: cursor · @etiket: katman-2, kabul, checklist, zotero, v1.0.29 -->

# Zotero PDF Manager — manuel kabul checklist

**Sürüm:** 1.0.29 · **Kaynak:** (release commit SHA — yayın sonrası doldur)  
**Rule:** [`CURSOR-KATMAN-2-EKSIKLER-RAPORU.md`](CURSOR-KATMAN-2-EKSIKLER-RAPORU.md)

| Alan          | Değer                 |
| ------------- | --------------------- |
| Tarih         |                       |
| Testçi        |                       |
| OS            | Windows               |
| Zotero sürümü | (7 / 8 / 9 / 10)      |
| XPI           | v1.0.29 / yerel build |

| #   | Senaryo                          | Beklenen                                | Sonuç | Kanıt |
| --- | -------------------------------- | --------------------------------------- | ----- | ----- |
| 1   | Eklenti yükle                    | Menü + tercihler                        |       |       |
| 2   | İkinci ana pencere               | Menü her ikisinde; tek reconciler       |       |       |
| 3   | İlk pencereyi kapat              | İkinci pencere menü/otomasyon çalışır   |       |       |
| 4   | Son pencereyi kapat              | Shutdown’da sızıntı yok (log)           |       |       |
| 5   | Incomplete watch root (izin yok) | Audit `index-incomplete`; OA yok        |       |       |
| 6   | OA indirme                       | downloads/ altına yazar; üzerine yazmaz |       |       |
| 7   | Update kanalı                    | 1.0.29 + sha512 kabul                   |       |       |
| 8   | Dispose sırasında OA iptal       | Abort; geç attach yok                   |       |       |
