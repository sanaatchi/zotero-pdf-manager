<!-- @ajan: cursor · @etiket: katman-2, eksik-raporu, doi-auto, 2026-08-02 -->

# Cursor — Katman 2 Eksikler Raporu

**Tarih:** 2026-08-02 · **Sürüm:** PDF Manager **v1.0.55**  
**Analiz:** ürün ↔ `referanslar/katman-2/` ↔ GitHub (Attanger, Zotadata, Zoplicate,
ZotAssets, File Utility, Attachment Scanner, ozefe/yoktez).

## Özet hüküm

| Soru                      | Cevap                                           |
| ------------------------- | ----------------------------------------------- |
| Açık **P1** ürün boşluğu? | **Yok** — P2-1…P2-6 + B1–B5 + G0/G1 kapalı      |
| Gerçek açık iş?           | Checklist Bölüm B (kullanıcı) + isteğe bağlı P3 |
| Yeni zorunlu XPI portu?   | **Yok** — GitHub taraması yeni P1 üretmedi      |

---

## Kapalı (doğrulandı)

| Madde                                                   | v         | Not                                             |
| ------------------------------------------------------- | --------- | ----------------------------------------------- |
| P2-1…P2-6 otomasyon                                     | ≤1.0.27+  | indeks, reconcile, OA downloads/, orphan, audit |
| OA bridge / DergiPark / LibGen / YÖK / Sci-Hub (manuel) | 1.0.43–46 | bridge `:8756`                                  |
| **B1** linked ek silme                                  | 1.0.47    | delitemwithatt behavior                         |
| **B2–B3** port yolları / plan drift (kısmi)             | —         | `katman-2/` kuratör; kalan drift aşağıda        |
| **B4a–c** selective lint                                | 1.0.48–49 | journal abbr **skip**                           |
| **B5** Zoplicate yan XPI + DOI/ISBN/KP rapor            | 1.0.49    | merge port yok                                  |

### Referans klasör → ürün

| `referanslar/katman-2/…`                 | Ürün                              | Durum             |
| ---------------------------------------- | --------------------------------- | ----------------- |
| `ek-silme/delitemwithatt`                | `attachmentDelete*`               | ✅                |
| `metadata-linter/zotero-format-metadata` | `metadataNormalize*`              | ✅ selective      |
| `yinelenen/zoplicate`                    | yan XPI + `duplicateItemReport*`  | ✅ companion      |
| `ek-dosya/zotmoov`                       | `folderIndex` linked-base         | ✅ behavior       |
| `cnki-metadata/jasminum`                 | —                                 | **skip**          |
| `katman-1/klasor-izleme` (watch)         | `folderIndex` / `orphanProcessor` | ✅ (Mode 2/3 yok) |

**Mirror yok (VENDOR SHA):** Attanger, Zotadata, Attachment Scanner — ürün içinde
selective/behavior mevcut.

---

## Açık — sıralı

| ID      | Öncelik         | Madde                                                                | Kanıt                                                                                                  | Öneri                                       |
| ------- | --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **G0**  | ✅              | OA bridge SSRF loopback                                              | `oaBridgeUrl.ts` v1.0.50 — K1/K3 parity                                                                |
| **G0b** | ✅              | Delete confirm: empty parent folder                                  | `formatDeleteConfirmLines` + locale footer · **v1.0.51**                                               |
| **G0c** | ✅              | KP helper DRY mirror                                                 | `src/utils/kpToken.ts` = K1 `normalizeKp` · **v1.0.51**                                                |
| **G1**  | ✅              | YÖKTez auto politikası                                               | **B kilit:** tez = yalnız manuel; auto = **doi**+dergipark+pmc. TR makale: dergipark + (DOI varsa) doi | dokümante 2026-08-02                        |
| **G2**  | ✅ ajan / ⬜ UI | Checklist **v1.0.49** yenilendi                                      | `ZOTERO-KABUL-CHECKLIST.md` — Bölüm A otomatik ✅ (209 test); Bölüm B Zotero smoke kullanıcı           | Kullanıcı B1–B8 işaretleyince tam kapanır   |
| **G3**  | ✅              | README Sci-Hub/LibGen metin                                          | düzeltildi 2026-08-02                                                                                  | auto yasak / manuel prefs ayrı              |
| **G4**  | ✅              | REFERANS-PORT §4 stale                                               | düzeltildi                                                                                             | merger + contentMetadata ✅                 |
| **G5**  | ✅              | AUTOMATION_PLAN durum bandı                                          | eklendi                                                                                                | teslim notu                                 |
| **G6**  | **P3**          | `tr-TR` locale yok                                                   | `addon/locale/` = de / en-US / it-IT                                                                   | İsteğe bağlı                                |
| **G7**  | **P3**          | format-metadata kalan (univ place, edition, preprint/webpage guard…) | rules dir vs `metadataNormalize.ts`                                                                    | Düşük ROI; journal abbr skip kalır          |
| **G8**  | **P3**          | Menü hâlâ “Attanger” markası                                         | `menu.ts`                                                                                              | Kimlik cilası                               |
| **G9**  | **P3**          | arxiv-workflow preprint↔published                                    | mirror yok                                                                                             | EN preprint ağır değilse skip               |
| **G10** | **P3**          | Çoklu ek rol (ZotAssets benzeri)                                     | GitHub: Lyz-623/ZotAssets                                                                              | TR arşiv için zorunlu değil; araştırma notu |

### Yapılmaz (kilitli)

- OCR / üç XPI birleştirme / zoplicate tam merge gömme / journal abbr / jasminum
- Sci-Hub **otomatik** şelale (`AUTOMATIC_ONLINE_SOURCE_IDS`)
- YÖKTez **otomatik** şelale — tez yalnız manuel Download (politika B)
- watch-folder Mode 2/3 koleksiyon↔klasör aynalama

---

## format-metadata kural özeti (~40)

| Durum   | Örnek                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ✅ port | DOI prefix, pages connector/range, title trailing-dot, zeros, thesis type, language guess, creators-case, Extra order, ISBN 10↔13   |
| skip    | `require-abbr`, pinyin, chemical formula, full rule engine / tool-update-metadata                                                   |
| P3 aday | `require-university-place`, `correct-edition-numeral`, `no-article-webpage`, `no-journal-preprint`, sentence-case (TR başlık riski) |

---

## GitHub araştırması (2026-08)

| Kaynak                                                         | Sonuç                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Attanger / Zotmoov / Zotadata / Zoplicate / Attachment Scanner | Zaten kapsanmış veya companion                                        |
| **ZotAssets**                                                  | Ek rolleri (main/supplement); P3 aday, port şart değil                |
| **zotero-file-utility**                                        | title↔filename sync, stored→linked; Attanger mirası ile örtüşür       |
| **ozefe/yoktez** (Python)                                      | Zotero XPI değil; köprü/`oa_pdf_search` iyileştirmesi olarak ayrı hat |
| tezara / yoktez-mcp                                            | UI/MCP — Katman 2 XPI’ye gömme yok                                    |

Yeni **zorunlu** mirror veya port önerilmez.

---

## Sonraki 3 adım (öneri)

1. **G1** — YÖKTez auto politikası (A gated / B manuel-only)
2. **G2 kalan** — `ZOTERO-KABUL-CHECKLIST.md` Bölüm B (Zotero UI smoke) kullanıcı imzası
3. İsteğe bağlı P3 — G6–G10

_(G2 ajan tarafı: checklist v1.0.49 + otomatik Bölüm A imzalandı. G3–G5 doküman hijyeni uygulandı.)_
