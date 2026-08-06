<!-- @ajan: cursor · @etiket: katman-2, eksik-raporu, periodical, console-group-polyfill, author-line-gate, no-validate-subtitle-enrich -->

# Cursor — Katman 2 Eksikler Raporu

**Tarih:** 2026-08-06 · **Sürüm:** PDF Manager **v1.0.137**  
**Analiz:** ürün ↔ `referanslar/katman-2/` ↔ GitHub (Attanger, Zotadata, Zoplicate,
ZotAssets, File Utility, Attachment Scanner, ozefe/yoktez).

## Özet hüküm

| Soru                      | Cevap                                           |
| ------------------------- | ----------------------------------------------- |
| Açık **P1** ürün boşluğu? | **Yok** — P2-1…P2-6 + B1–B5 + G0/G1 kapalı      |
| Gerçek açık iş?           | Checklist Bölüm B (kullanıcı) + isteğe bağlı P3 |
| Yeni zorunlu XPI portu?   | **Yok** — GitHub taraması yeni P1 üretmedi      |

### Son eklenen (v1.0.137)

| Madde                                           | Not                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Validate ≠ alt başlık enrich                    | `validateAttachmentContentDetailed` künye title yazmaz; bridge `enriched_title` yok sayılır; Python heuristic temiz |
| Cümle-bazlı TR İ-ı güvenlik ağı                 | `titleSentenceSimilarity` + İ-ı-only missing → coverage 1; false #pdf-mismatch (136)                                |
| Alt başlık ≠ yazar satırı (Altınkurt)           | `looksLikeAuthorLine` — ALLCAPS soyad / `*` / initial / creator örtüşmesi enrich yok; Python parity (135)           |
| Alt başlık ≠ yayınevi adresi                    | Sokak/Cadde/No/posta kodu HQ satırı enrich yok; Seargeant topical OK; Python+K2 parity (111)                        |
| Validate match → mismatch etiket temizle        | Content-audit `match` → `clearSuccessfulMatchTags` (#pdf-mismatch/#pdf-review/#pdf-quarantine); mismatch keep (110) |
| `#pdf-mismatch` → Match/reconcile rematch       | Skip gates ignore tagged parents; Match also scans downloads/; old wrong PDF kept (109)                             |
| Match/local link → rename+move                  | Content match sonrası künye adı + destDir; mismatch keep; autoMove/destDir prefs (109)                              |
| Ghost/dimmed Match attachment stub              | fileExists gate + purge siblings; relocate link-before-erase; no inaccessible stub after success (108)              |
| Match attachment → `#pdf-mismatch` temizle      | Local finalize + menü Match Attachment; match veya skipped+DOI/ISBN; mismatch etiketi kalır (v1.0.107)              |
| Alt başlık boşluğu → künye enrich + match       | **Kaldırıldı validate yolundan (137)** — helper OA/attach için kalır; validate title mutate etmez                   |
| Validate attached mismatch: ek kaldırma yok     | Content-audit yalnız `#pdf-mismatch`/`#pdf-review`; confirm-detach + eraseTx kaldırıldı (v1.0.105)                  |
| Watch root = `1A_E_KAYNAKLARIM` (tüm altklasör) | Varsayılan + migrate parent; nested Dışı düşer; indeks recursive (`MAX_WALK_DEPTH` 8) (v1.0.104)                    |
| Seargeant alt başlık çekirdek trust (v1.0.103)  | LibGen kısa core + boş yazar; `titleCorePhrase` colon-before-fold; Devlet thrash korunur; köprü + XPI               |
| LibGen başlık ISBN/edition/`b l` temizliği      | Adorno attach; `cleanLibgenTitle` + ISBN bypass (v1.0.102)                                                          |
| 100’lük alan skoru + Şarkiyatçılık (v1.0.101)   | Federated Σ(puan/100×kalite); paren sameWork; LibGen ov&lt;0.7 ISBN/same-work; OA attach ISBN                       |
| Uyumsuz PDF otomatik silme iptal (v1.0.100)     | mismatch → ek kalır + `#pdf-mismatch`; auto-detach yok; manuel audit de detach etmez (v1.0.105)                     |
| Doğru PDF false-positive / yeniden indir (99)   | Güçlü başlıkta yazarsız match; LLM ezemez; rejectedUrls                                                             |
| Prefetch bar / thrash kapısı (v1.0.98)          | Kısa başlık yazar zorunlu; LibGen ov≥0.7; sibling MD5 skip; köprü restart + XPI                                     |
| LibGen agresif eşleştirme kapısı (v1.0.97)      | Sahte ov=1.0 / ISBN false-friend / kısa TR başlık / tek-token; köprü restart + XPI                                  |
| Download & attach yanlış PDF kapısı (v1.0.96)   | LibGen phase1 early-stop yok (yalnız DOI/Zenodo/PMC); yerel kısa başlık+unverifiable reject; köprü restart          |
| OA Search çoklu kaynak fan-out (v1.0.95)        | Checkbox N kaynak → hepsi sorgulanır (ISBN LibGen phase1 short-circuit yok); köprüyü de yeniden başlat              |
| `#pdf-mismatch` yanlış PDF kapısı (v1.0.94)     | (süperseeded by 1.0.100 keep) eski: unlink+disk; etiketli «done» değildi                                            |
| TR ALL-CAPS / yapışık başlık güveni (v1.0.93)   | `toLocaleLowerCase("tr")` I→ı hatası + `_expand_glued_tokens` parity; DergiPark hit→attach                          |
| Post-truth era yanlış makale (v1.0.92)          | Keyes kitabı ≠ Ponce/Arendt SSRN; kısa başlık Jaccard + tire birleşimi; yerel içerik doğrula                        |
| Yanlış kitap / inceleme / makale kapısı (91)    | Rengin≠İlkel; Sinema≠Deleuze tezi; book-review yok; Avangard≠makale                                                 |
| DOI paywall ipucu (v1.0.90)                     | «Açık PDF yok (ücretli/paywall)…» — köprü HTTP 500 crash metni yok                                                  |
| OA Search’ten arXiv çıkarıldı (v1.0.89)         | Kaynak chip / prefs checkbox / federated `full` yok; adapter CLI’da kalır                                           |
| OA attach 502 fallback (v1.0.88)                | `X-OA-Fetch-Error`; doi 502 → diğer hit (DergiPark); çıplak HTTP 502 yok                                            |
| İndirme raporu panoya kopyalanmaz               | Sekme / toast kalır; clipboard fallback kaldırıldı (v1.0.87)                                                        |
| İndirme raporu → OA JSONL (v1.0.86)             | `POST /pdf-search-log`; TR makale / tez kaçırma `cache/logs/oa_pdf_search/`                                         |
| OA Arama popup + menü çubuğu (v1.0.58)          | `PDF Manager → OA Arama…`; Attanger federated aynı pencere                                                          |

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

---

## Claude — `#pdf-mismatch` kalıcılık teşhisi (2026-08-06, v1.0.119)

**Bağlam:** Kullanıcı 1.0.118'e rağmen ~21 kayıtta `#pdf-mismatch` etiketinin
kalkmadığını / Clear sonrası geri geldiğini bildirdi.

**Ekarte edilen hipotezler (kanıtlı):**

- (a) XPI 1.0.118 değil → **hayır**, `gh release view` + `update.json` doğru
  1.0.118'i işaret ediyor (K3'te bulunan `/releases/latest` sınıfı bug burada yok).
- Guard/reconciler mantığı kendi içinde tutarlı ve test edilmiş
  (`mismatchRetagGuard.test.cjs`) — `canReconcileItem` temizlenmiş item'ları
  30 gün atlıyor, `clearSuccessfulMatchTags` `#` normalizasyonlu tek `saveTx`.

**Bulunan gerçek kök neden (b/c karışımı):** `pdfAutomationTagGuard.ts`'teki
`explicitTagSessionDepth` **global** sayaçtı. `downloadPdfForSelectedItems`
eşzamanlı (mapPool, CONCURRENCY≤3) her item'ı bu sayaçla "explicit" işaretliyordu
— parti sürerken aynı anda tetiklenen **başka bir item'ın** pasif reconcile
add-flush'ı da yanlışlıkla "explicit" sayılıp o item'ın kullanıcı-temizleme
guard'ını es geçiyordu. **Fix:** sayaç `Map<itemID, depth>`'e taşındı,
`isExplicitMismatchTagSession(itemID)` yalnız o item'a bakıyor artık.

**Kasıtlı olarak DEĞİŞTİRİLMEYEN:** `content-audit` (Validate) kaynağı hâlâ
guard'ı her zaman bypass eder — kullanıcı elle Validate çalıştırıp heuristic
gerçekten mismatch derse etiket tekrar yazılabilir (bilinçli tasarım, görev
tanımında da onaylandı). Bu, OCR/heuristic doğruluk sorunu olup bu oturumun
kapsamı dışında (eşik gevşetme yasak).

**Doğrulama:** `npx tsc --noEmit` temiz · `npm test` 299/299 (yeni concurrency
regresyon testi dahil, eski kodda fail ettiği teyit edildi).

**Dosyalar:** `src/modules/pdfAutomationTagGuard.ts`, `src/modules/pdfDownload.ts`,
`tests/mismatchRetagGuard.test.cjs`, `package.json` (→ **v1.0.119**)

**Yayın:** Kullanıcı "yayınla" demeden commit/push/gh-release yok.

---

## Claude — canlı doğrulama: `#pdf-mismatch` ~100 kayıt, ISBN checksum kök nedeni (2026-08-06, v1.0.120)

**Bağlam:** Kullanıcı "canlı kontrol etmelisin" — Zotero MCP ile gerçek
kütüphane sorgulandı. `#pdf-mismatch` etiketli kayıt sayısı **21 değil,
en az ~100** (arama limiti 100'de kesildi, muhtemelen daha fazla) ve
kullanıcıya göre "sayı giderek artıyor".

**İki alt-kategori canlı doğrulandı:**

1. **Ek yok (`#nosource` + `#pdf-mismatch` birlikte):** ör. "Devlet" (Platon),
   "Sanat sevdası" (Bourdieu), "Sapiens", "Tietze I" — `zotero_get_items_children`
   ile sıfır çocuk item doğrulandı. v1.0.100'den beri hiçbir yol otomatik
   silme yapmıyor (`applyPdfMismatchTags` her zaman "keep"), o yüzden bu
   ek-kaybı K2 dışı (disk reorg / kırık link temizliği) → `#nosource` doğru
   ama `#pdf-mismatch` artık anlamsız/temizlenemez kalıyordu. **v1.0.119'da
   `attachmentScanner.ts` fix'i bunu kapsıyor.**
2. **Ek VAR, gerçek PDF doğru, hâlâ mismatch:** "Dakikalar içinde Selçuklular"
   (Piyadeoğlu) — PDF'in kapağı/telif sayfası/gövde metni (sayfa 16-20) elle
   okunup doğrulandı, %100 doğru kitap. Zotero ISBN alanı `970-625-6774-03-4`,
   gerçek kitap ISBN'i (telif sayfası) `978-625-6774-83-4`. **Kullanıcı teyidi:**
   "ocr'de sans serif farkından dolayı 0,8,3 birbirine karıştırılabiliyor" +
   "13 rakamlılar 978 ile başlar bu kesin". ISBN-13 kontrol basamağı ile
   kanıtlandı: saklanan değer kendi checksum'ını GEÇMİYOR (hesaplanan=0,
   son hane=4) — matematiksel olarak bozuk veri, muhtemelen K1 OCR/kataloglama
   adımından. `metadataCheck.ts`'in `cleanISBN`'i uzunluk dışında hiçbir
   doğrulama yapmıyordu → bozuk ISBN, PDF'teki gerçek ISBN'le eşleşmeyince
   `criticalMismatch` → `decideContentValidation`'da koşulsuz "mismatch"
   override (başlık+yazar ne kadar güçlü olursa olsun). **Fix v1.0.120:**
   saklanan ISBN `isValidIsbn10/13` + `978`/`979` önek testinden geçmezse
   (kendi checksum'ını geçmiyorsa) ISBN karşılaştırması atlanır (warning,
   sert mismatch DEĞİL); iki GERÇEKTEN farklı checksum-geçerli ISBN hâlâ sert
   mismatch sayılır — eşik gevşetme yok, yalnız kanıtlı bozuk veriye güvenmeme.

**Hâlâ tam çözülmemiş (Sinisgalli örneği):** "Perspective in the Visual
Culture of Classical Antiquity" — DOI VE ISBN ikisi de canlı doğrulamada TAM
eşleşiyor (Cambridge Books Online kapak sayfası: Book DOI + Hardback ISBN
ikisi de Zotero kaydıyla birebir aynı), kodun mantığına göre `hasIdMatch`
anında "match" dönüp temizlemesi gerekirdi — ama etiket hâlâ duruyor. Bu,
reconciler'ın bu kayda pratikte hiç uğramadığını düşündürüyor. Kesinleştirmek
için kullanıcının `zpdfmanager-automation-audit.json` dosyası gerekiyor
(bu ortamdan erişilemiyor) — **açık madde, sonraki oturuma**.

**Kapsam ölçülmedi:** ISBN-checksum bug'ının 100 kayıttan kaçını açıkladığı
tam sayılmadı (örneklem: 14 kayıt manuel incelendi, 3'ünde ISBN alanı vardı,
1'i (Selçuklular) kanıtlı bozuk). Kullanıcı "Scan All Attachments" çalıştırıp
audit log paylaşırsa kapsam netleşir.

**Doğrulama:** `npx tsc --noEmit` temiz · `npm test` 303/303 (2 yeni ISBN
checksum testi dahil: bozuk ISBN → mismatch DEĞİL; iki geçerli farklı ISBN →
hâlâ mismatch).

**Dosyalar:** `src/modules/metadataCheck.ts`, `tests/metadataCheck.test.cjs`,
`package.json` (→ **v1.0.120**)

**Yayın:** v1.0.120 kullanıcı "yayınla" onayıyla yayınlandı.

---

## Claude — ASIL kök neden: `AbortController is not defined`, reconciler hiç çalışmıyordu (2026-08-06, v1.0.121)

**Bağlam:** v1.0.120 yayınlandıktan sonra kullanıcı "mismatch-tag sorunu
devam ediyor neden" dedi ve canlı Zotero hata ayıklama çıkışını paylaştı.

**Canlı log kanıtı:**

```
appName => Zotero, version => 9.0.6 ... Zotero PDF Manager (1.0.120, extension)
[JavaScript Error: "ReferenceError: AbortController is not defined"
  {file: ".../zpdfmanager.js" line: 33860}]
```

1.0.120'nin gerçekten yüklü olduğu doğrulandı — sorun sürüm değil, **arka
plan reconciler'ın hiç çalışmamasıydı**. `pdfReconciler.ts` üç yerde
(`performRun`, `flushAddedItems`, `processOrphansNow`) `new
AbortController()` çağırıyor. Zotero'nun eklenti bootstrap/arka plan süreç
kapsamı — bir tarayıcı penceresinin aksine — Web-platform constructor'larını
otomatik sağlamıyor; `Components.utils.importGlobalProperties(["AbortController"])`
ile açıkça import edilmesi gerekiyordu, **hiç yapılmamıştı**.

**Zincir:** `performRun`'un ilk satırında `ReferenceError` → async
fonksiyon promise'i reject eder → `run()` bunu hiç `.catch` etmiyordu →
`start()`'taki `void this.run("startup")` / `void this.run("periodic")`
unhandled rejection olarak sessizce yutuluyordu. **Sonuç: startup/periyodik/
add-notifier reconcile — üçü de — kurulumdan beri hiç iş yapmıyordu.**

**Bu, önceki oturumdaki "Sinisgalli" gizemini açıklıyor:** DOI+ISBN ikisi de
zaten doğru eşleşiyordu ama etiket hiç temizlenmedi çünkü reconciler zaten
mismatch-tag'li item'ları asla ziyaret etmiyordu — kodun mantığı doğruydu,
çalışma zamanı hiç çalışmıyordu.

**Neden test suite'te yakalanmadı:** Node.js'te `AbortController` zaten
global — yalnız gerçek Zotero bootstrap ortamında (`Components`/pencere
globalleri farklı) ortaya çıkıyor. Canlı debug log olmadan bulunamazdı.

**Fix:**

- Modül yüklenirken `typeof AbortController === "undefined"` ise
  `Components.utils.importGlobalProperties(["AbortController"])` çağrılır.
- `run()` artık kendi reddini `.catch` edip `reconcile-crash` audit event'i
  yazıyor + boş stats'a düşüyor — aynı sınıf bir hata bir daha sessizce
  sistemi öldürmesin diye (savunma derinliği).

**Etki:** Reconciler artık gerçekten çalıştığı için, 1.0.118-1.0.120'de
yazılan TÜM guard/tag-clear mantığı (concurrency fix, stale-tag-on-no-file,
ISBN checksum) artık pratikte devreye girecek — önceden kod doğruydu ama
hiç tetiklenmiyordu.

**Doğrulama:** `npx tsc --noEmit` temiz · `npm test` 305/305 (2 yeni test:
AbortController olmadan modül yükleniyor + import ediyor; `run()` kendi
reddini yakalıyor — static + davranışsal).

**Dosyalar:** `src/modules/pdfReconciler.ts`, `tests/pdfReconciler.test.cjs`,
`package.json` (→ **v1.0.121**)

**Yayın:** Az önce yayınlanmış 1.0.120'nin kritik hotfix'i — otomatik yayın
politikası (`AGENTS.md`) uyarınca commit/push/gh-release bekletilmeden yapıldı.

---

## Cursor — runtime triage (2026-08-06, restart doğrulaması)

| ID     | Bug                                                                                                                                                                                                                                                                                                | Durum                                                                                                                                                                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | `_console.group is not a function` — v1.0.122 polyfill ataması Zotero 9 sandbox'ta non-writable `undefined` üzerinde no-op; toolkit `BasicTool.log` hâlâ `group` çağırıyordu                                                                                                                       | ✅ kod **v1.0.128** — `defineProperty` + erken bootstrap + `_console` yaması + `log` sarmalayıcı; XPI yayın bekliyor («yayınla»)                                                                                                                                                                                     |
| **R2** | v1.0.128 sonrası mutasyon: `_console.trace is not a function` (çok sayıda). Toolkit `BasicTool.log`: `groupCollapsed`/`group` → **koşulsuz `_console.trace()`** → `groupEnd()`. R1 polyfill'i yalnız `group`/`groupCollapsed`/`groupEnd`'i yamıyordu, `trace` set dışında kalmıştı (whack-a-mole). | ✅ kod **v1.0.129** — `ensureConsoleGroupPolyfill` artık tam ConsoleAPI stub kurulumu yapıyor (`trace`, `table`, `dir`, `dirxml`, `debug`, `info` → `log`'a yönlendirir; `groupEnd`, `count`, `time*`, `assert`, `clear`, `profile*` → no-op; eksik `error`/`warn` → `log`'a düşer). XPI yayın bekliyor («yayınla»). |

Canlı log doğruladı: restart sonrası hâlâ mevcut; reconciler `PDF reconcile started (startup)` çalışıyor; `#pdf-review` tag purge Zotero tarafı (beklenen).
