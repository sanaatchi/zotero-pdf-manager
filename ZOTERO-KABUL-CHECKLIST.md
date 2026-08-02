<!-- @ajan: cursor · @etiket: katman-2, kabul, checklist, zotero, v1.0.52 -->

# Zotero PDF Manager — manuel kabul checklist

**Sürüm:** 1.0.52 (`package.json`)  
**Önceki imza:** 1.0.33 (2026-07-30) — A1–A6 (ikinci pencere Windows N/A)  
**XPI kanalı:** https://github.com/sanaatchi/zotero-pdf-manager-releases/releases  
_(1.0.49 XPI yayınlanmadıysa yerel `npm run build` çıktısıyla smoke.)_

| Alan             | Değer                     |
| ---------------- | ------------------------- |
| Tarih (otomatik) | 2026-08-02                |
| Otomatik kanıt   | `npm test` → **209 pass** |
| Testçi (manuel)  | _(kullanıcı doldurur)_    |
| Zotero sürümü    | _(kullanıcı doldurur)_    |

---

## A — Otomatik / sözleşme (ajan imzası)

Kod + test ile doğrulandı; Zotero UI gerekmez.

| #   | Senaryo                 | Beklenen                               | Sonuç | Kanıt                                                           |
| --- | ----------------------- | -------------------------------------- | ----- | --------------------------------------------------------------- |
| A1  | Test paketi yeşil       | fail=0                                 | ✅    | `npm test` 209 pass (2026-08-02)                                |
| A2  | ISBN 10↔13 / checksum   | geçersiz ISBN eşleşmez                 | ✅    | `metadataNormalize.test.cjs`                                    |
| A3  | DOI prefix normalize    | `doi.org` / `DOI:` temiz               | ✅    | aynı + `compareMetadata`                                        |
| A4  | B4 pages/creators/extra | ters aralık, case, Citation Key sırası | ✅    | `B4b: pages-range…` test                                        |
| A5  | B1 delete plan          | linked unlink planı doğru              | ✅    | `attachmentDeletePlan.test.cjs`                                 |
| A6  | B5 dup aday grupları    | DOI/ISBN/KP küme; yazma yok            | ✅    | `duplicateItemReport.test.cjs`                                  |
| A7  | Menü telleri            | normalize + dup-report + delete menü   | ✅    | locale FTL + `menu.ts` testleri                                 |
| A8  | Auto OA kaynakları      | `doi`,`dergipark`,`pmc` (Unpaywall)    | ✅    | `AUTOMATIC_ONLINE_SOURCE_IDS` + `oaDownloadPath` / source tests |
| A9  | Vendor provenance       | pinned SHA notices                     | ✅    | `vendorProvenance.test.cjs`                                     |

- [x] Bölüm A tamam → otomatik kabul **✅** (v1.0.49)

---

## B — Zotero UI smoke (kullanıcı imzası)

Kurulu eklenti **1.0.49** (veya bu commit’in XPI’si) ile doldur.

| #   | Senaryo                                | Beklenen                                            | Sonuç | Kanıt |
| --- | -------------------------------------- | --------------------------------------------------- | ----- | ----- |
| B1  | Eklenti yükle / güncelle               | Menü + tercihler görünür                            | ⬜    |       |
| B2  | **Normalize metadata fields**          | DOI/pages/creators/extra düzelir                    | ⬜    |       |
| B3  | **Report duplicate item candidates**   | DOI/ISBN/KP grupları; yazma yok                     | ⬜    |       |
| B4  | **Remove attachments (keep linked)**   | Kayıt çöp; dosya diskte                             | ⬜    |       |
| B5  | **Remove attachments + delete linked** | Confirm → linked dosya silinir                      | ⬜    |       |
| B6  | Auto OA (makale, PDF yok)              | Yalnız DergiPark/PMC dener; Sci-Hub/LibGen auto yok | ⬜    |       |
| B7  | Tez + **manuel** Download              | YÖKTez yolu (auto değil — G1)                       | ⬜    |       |
| B8  | Update / sürüm                         | Tercihler veya About ≈ 1.0.49                       | ⬜    |       |

- [ ] Bölüm B tamam → tam manuel kabul **✅**

### Önceki 1.0.33 taşıma notu

ISBN / DOI prefix / quarantine davranışları A2–A3 + ürün kodunda duruyor.
1.0.33 UI imzası tarihsel; B1–B8 bu sürüm için yeniden işaretlenmeli.

---

## C — Politika hatırlatma (imza öncesi oku)

| Konu             | Gerçek                                                 |
| ---------------- | ------------------------------------------------------ |
| Otomatik OA      | `dergipark` + `pmc` only                               |
| Sci-Hub / LibGen | Manuel cascade; otomatik **yok**                       |
| YÖKTez           | Manuel (G1 açık — auto politikası ayrı karar)          |
| Zoplicate        | Öğe merge = **yan XPI**; PDF Manager yalnız aday rapor |
| journal abbr     | Port yok (bilinçli skip)                               |
