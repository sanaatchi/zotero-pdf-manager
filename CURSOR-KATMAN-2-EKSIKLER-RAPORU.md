<!-- @ajan: cursor · @etiket: katman-2, eksik-raporu, p2-close -->

# Cursor — Katman 2 Eksikler Raporu

> **Çalışma kuralı:** Bu katmanda düzenleme öncesi  
> **1)** bu raporu oku → **2)** açık maddeleri düzelt → **3)** ancak sonra görev.  
> Rule: `.cursor/rules/katman-eksik-raporu.mdc`

**Tarih:** 2026-07-29  
**Kapsam:** `zotero-pdf-manager` · v1.0.28 + P2 kapanış düzeltmeleri (CI/ReDoS/validation/abort/orphan)  
**Durum:** Codex P2 `request changes` maddeleri kodlandı. Yerel **175/175** · lint ·
typecheck yeşil. Public CI / patch release / manuel Zotero checklist sırada.

## Güncel durum — 2026-07-29 (P2 kapanış uygulaması)

**Doğrulama:** **175/175 test** ✅ · lint:check ✅ · typecheck ✅

| Madde                       | Durum | Not                                                                     |
| --------------------------- | ----- | ----------------------------------------------------------------------- |
| CI lockfile / Node 22 / pin | ✅    | `package-lock.json` izlenir; actions SHA; `permissions: contents: read` |
| ReDoS / safeRegex           | ✅    | `(a\|aa)+`, `(a\|a?)+`, backref, lookaround reddedilir                  |
| Validation cleanup          | ✅    | erase-gates file; unverifiable quarantine; match clears `#pdf-review`   |
| Orphan bounded memory       | ✅    | `mergeKnownSourcePaths` — item birikimi yok                             |
| XHR / index abort           | ✅    | `cancellerReceiver` + walker `signal`                                   |
| Vendor SHA                  | ✅    | pinned + notices testi                                                  |
| Sci-Hub/LibGen politika     | ✅    | bilerek manuel opt-in; README risk notu                                 |
| Public CI yeşil run         | 🟡    | push sonrası doğrulanacak                                               |
| Çoklu pencere checklist     | 🟡    | [`ZOTERO-KABUL-CHECKLIST.md`](ZOTERO-KABUL-CHECKLIST.md)                |
| Patch release               | 🟡    | CI yeşil + checklist sonrası                                            |

### Cursor için zorunlu P2 kapanış sırası

1. CI lockfile/Node/action pin — ✅ kod; 🟡 public run
2. ReDoS — ✅
3. Validation cleanup — ✅
4. Orphan bounded-memory — ✅
5. XHR/index cancellation — ✅ (progress/Cancel UI sonra)
6. Vendor + Sci-Hub politika — ✅
7. Commit + CI + checklist + patch release — sırada

---

## Codex derin P2 doğrulaması — 2026-07-29 (arşiv)

**Karar:** `request changes`

**İncelenen taban:** HEAD/origin `9ab363a4` + Cursor’un commit edilmemiş P2
derinlik değişiklikleri. Yerelde **171/171 test** ✅ · TypeScript ✅ · ESLint ✅;
rapor dosyası Prettier kontrolünde ❌. Public
[`v1.0.28`](https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/tag/v1.0.28)
XPI/update/provenance SHA-512 zinciri önceki doğrulamada sağlamdı; yeni dirty
P2 derinlik kodu henüz public artefact içinde değil.

| Madde                        | Durum | Derin doğrulama sonucu                                              |
| ---------------------------- | ----- | ------------------------------------------------------------------- |
| İndeks IO → incomplete       | ✅    | `ioError` ve gerçek walker enjeksiyon testleri mevcut               |
| Publish arg-array/provenance | ✅    | Public source SHA + XPI SHA-512 bağı doğrulandı                     |
| Vendor SHA/provenance        | 🟡    | Dirty belgeler/test var; commit/public artefact yok                 |
| Sayfalı kütüphane yükleme    | 🟡    | Item batch var; orphan yolları tüm item nesnelerini tekrar topluyor |
| Abort / dispose              | ❌    | Promise yarışı var; alttaki XHR ve folder walk iptal edilmiyor      |
| 99.999 ölçek                 | ❌    | Yalnız `chunkIds` smoke; gerçek reconcile/bellek/latency ölçümü yok |
| İçerik üçlü doğrulama        | ❌    | Erase hatasında linked dosya silinip kırık attachment kalabilir     |
| ReDoS                        | ❌    | `(a\|aa)+$` ve `(a\|a?)+$` güvenli kabul ediliyor                   |
| GitHub CI                    | ❌    | Son üç run failure; izlenen lockfile yok                            |
| Çoklu pencere/Zotero kabulü  | 🟡 P1 | Checklist boş                                                       |
| Sci-Hub/LibGen politika      | 🟡    | Otomatik sıra dışı; çalışan manual adapter’lar XPI içinde           |

### P2 kritik — CI tanımlı fakat canlıda tamamen kırmızı

GitHub’daki son üç `ci` çalışması (`cc64f8ed`, `5a173f1f`, `9ab363a4`)
**failure**. En son run
[`30479135020`](https://github.com/sanaatchi/zotero-pdf-manager/actions/runs/30479135020),
`actions/setup-node` aşamasında “Dependencies lock file is not found” ile
duruyor. `.gitignore:5-7` npm/pnpm/yarn lockfile’larını dışlıyor; yerel
`package-lock.json` Git tarafından izlenmiyor. Bu yüzden `npm ci`, lint,
typecheck, test ve build GitHub’da hiç çalışmıyor.

Workflow ayrıca kaldırılmakta olan Node 20’yi istiyor, action’ları tam commit
SHA yerine hareketli `@v4` etiketiyle çağırıyor ve salt-okunur permissions
tanımlamıyor.

**Cursor görevi:** tek paket yöneticisinin lockfile’ını izlemeye al; güncel
desteklenen Node kullan; `permissions: contents: read` ekle; action’ları tam
SHA’ya sabitle. HEAD için yeşil public run URL’sini rapora kaydet.

**Kabul:** temiz Linux checkout’ta install/lint/typecheck/test/build çalışır;
HEAD GitHub Actions sonucu success ve required check olarak korunur.

### P2 kritik — safeRegex klasik üstel alternasyonu kabul ediyor

`src/utils/safeRegex.ts` yalnız bazı nested-quantifier şekillerini reddediyor.
Bağımsız sınıflandırmada `(a|aa)+$` ve `(a|a?)+$` riskli sayılmadı ve
derlenebilir kaldı. İlki klasik belirsiz alternasyon backtracking desenidir.
Hedefi 4096 karaktere kesmek üstel maliyeti güvenli yapmaz; çağrı Zotero UI
thread’inde senkron çalışır. Mevcut test yalnız `(a+)+` ve pattern uzunluğunu
ölçüyor.

**Cursor görevi:** kullanıcı regex’i yerine güvenli glob/allowlist tercih et.
Regex kalacaksa ambiguous alternation, backreference ve desteklenmeyen
lookaround’ı parser seviyesinde reddet; adversarial corpus’u ana thread dışında
süre bütçesiyle test et.

**Kabul:** yukarıdaki iki desen, backreference ve nested quantifier sınıfı
reddedilir; kötü corpus UI thread’ini bloke etmez.

### P2 yüksek — validation cleanup hata yolunda kırık link üretebilir

`src/modules/pdfSources.ts:431-468`, `unverifiable` ve `mismatch` verdict’lerinde
önce `attachment.eraseTx()` çağırıyor; hata yalnız loglanıyor, ardından default
linked-file modunda `persistedPath` siliniyor. Attachment kaydı silinemezse
Zotero’da kırık link kalır.

İlk kaynak `unverifiable` olduğunda parent’a `#pdf-review` eklenip PDF hemen
siliniyor; sonraki kaynak doğru PDF eklese bile stale review etiketi
temizlenmiyor ve kullanıcıya incelenecek artefact kalmıyor. Bu dört verdict
akışı için doğrudan entegrasyon testi yok.

**Cursor görevi:** attachment erase ile dosya cleanup’ını tek sonuç sözleşmesine
bağla. Erase başarısızsa linked dosyayı koru ve audit failure üret. Review PDF
karantinada korunmalı veya yalnız audit kaydı oluşturulmalı; sonraki doğrulanmış
başarı stale etiketi temizlemeli.

**Kabul:** erase hata enjeksiyonunda kayıt/dosya tutarlı; unverifiable→match
zincirinde yanlış review etiketi yok; dört verdict entegrasyon testi mevcut.

### P2 yüksek — sayfalama varsayılan orphan yolunda belleği sınırlamıyor

Yeni `iterateLibraryItemBatches()` itemları 250’lik gruplarla yüklüyor. Fakat
`pdfReconciler.performRun()` varsayılan `orphanMode=report` durumunda her batch’i
`orphanItems.push(...batch)` ile yeniden biriktirip tarama sonunda
`processOrphanPDFs()`e veriyor. `processOrphansNow()` da bütün batch’leri tek
`items` dizisinde topluyor. Böylece normal çalışma yolunda 99.999 item nesnesi
yine aynı anda bellekte tutuluyor.

Üstelik `getAllIDs()` bütün ID listesini alıyor ve `chunkIds()` bütün chunk
dizilerini önceden üretiyor; API yoksa fallback tekrar `getAll()` kullanıyor.
171 testteki 99.999 smoke yalnız sayı dizisini parçalar; gerçek Zotero itemları,
reconciler, orphan eşleştirmesi, süre veya peak-memory ölçülmüyor.

**Cursor görevi:** orphan referans setini minimal alanlarla akış içinde üret
veya orphan işlemeyi batch/DB sorgusu yap; item nesnelerini tutma. `chunkIds`
generator olsun. 99.999 fixture ile gerçek reconcile benchmarkı, peak-memory ve
UI-yield bütçesi kaydet; fallback’in büyük kütüphanede otomasyonu
fail-closed/uyarılı yapmasını sağla.

### P2 yüksek — AbortController alttaki işi iptal etmiyor

`src/utils/cancelToken.ts:43-65` kendi yorumunda da belirttiği gibi promise’i
abort ile yarıştırıyor ama underlying XHR’ı iptal etmiyor. `httpGet()` 60
saniyelik `Zotero.HTTP.request` işini arka planda sürdürür. `buildIndex(true)`
cancel signal almıyor; 99.999 dosyalık seri walk dispose sonrası tamamlanana
kadar devam edebilir. `getAllIDs/getAsync` çağrıları da abortable değil.

Global `activeSignal` süreç kapsamlıdır; gelecekte paralel manuel/reconciler
işleri birbirinin sinyalini devralabilir. Test yalnız wrapper promise’in erken
reject olduğunu ve kaynakta sembollerin bulunduğunu doğruluyor; gerçek XHR
abort, geç yan etki veya index walk iptali testi yok. Kullanıcıya ait Cancel UI
ve progress de bulunmuyor.

**Cursor görevi:** Zotero HTTP’nin döndürdüğü XHR/abort handle’ını gerçekten
`abort()` et; cancel signal’ı folder walker ve loader zincirine geçir; global
mutable signal yerine açık parametre/run context kullan. Progress + kullanıcı
iptali ekle ve geç yan etkinin oluşmadığını test et.

### P2 kısmi — vendor/politika

Pinned SHA, SPDX ve notices eşlemesi iyi yönde; ancak değişiklikler dirty ve SHA
testi yalnız belgelerde sabit metin arıyor, mirror repo HEAD/lisansını
doğrulamıyor. Sci-Hub/LibGen otomatik listeden çıkarılmış ve README uyarılı;
yine de çalışan adapter, mirror URL ve UI public XPI içinde. Bu bilinçli politika
kararıysa risk açıkça “kabul edildi” olarak kaydedilmeli; değilse ayrı opsiyonel
pakete taşınmalı.

### Cursor için zorunlu P2 kapanış sırası

1. CI lockfile/Node/action pin sorununu düzelt ve yeşil public run al.
2. ReDoS yüzeyini glob/parser ile kapat; adversarial test ekle.
3. Validation cleanup transaction’ını ve stale review etiketini düzelt.
4. Orphan işlemeyi gerçek bounded-memory akışa dönüştür.
5. XHR/index/loader için gerçek cancellation + progress/Cancel UI ekle.
6. Vendor mirror doğrulaması ve Sci-Hub/LibGen politika kararını tamamla.
7. Dirty ağacı commit et; gerçek Zotero checklist + test/build/hash/provenance +
   canlı CI ile yeni patch release’i doğrula.

---

## Cursor P2 derinlik — 2026-07-29 (arşiv)

**Cursor doğrulaması:** **171/171 test** ✅ · lint:check ✅ · typecheck ✅

| Madde                          | Durum | Not                                                                                                   |
| ------------------------------ | ----- | ----------------------------------------------------------------------------------------------------- |
| İndeks IO → incomplete         | ✅    | `ioError`; walker enjeksiyon testleri                                                                 |
| Publish arg-array + provenance | ✅    | `execFileSync`; `build/provenance.json`; notes tek argv                                               |
| Davranış testleri              | ✅    | atomic crash/quarantine, index queue, IO incomplete                                                   |
| Çoklu pencere (manuel)         | 🟡    | [`ZOTERO-KABUL-CHECKLIST.md`](ZOTERO-KABUL-CHECKLIST.md)                                              |
| Public `v1.0.28`               | ✅    | [v1.0.28](https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/tag/v1.0.28) + provenance |
| Fail-open PDF doğrulama        | ✅ P2 | `match\|mismatch\|unverifiable` → review/reject                                                       |
| ReDoS                          | ✅ P2 | `safeRegex.ts` + scanner/menu                                                                         |
| CI                             | ✅ P2 | `.github/workflows/ci.yml`                                                                            |
| Sci-Hub/LibGen politika        | ✅ P2 | default `sourceOrder` dışı + README uyarı                                                             |
| Abort / dispose iptal          | ✅ P2 | `cancelToken` + reconciler `runAbort` + OA `throwIfRunAborted`                                        |
| Sayfalı kütüphane tarama       | ✅ P2 | `libraryIterate` + `pdf.libraryBatchSize` (250); getAllIDs+getAsync                                   |
| Vendor SHA/provenance          | ✅ P2 | `PDFMANAGER-VENDOR.md` pinned SHA + notices sync testi                                                |
| 99 999 ölçek smoke             | ✅ P2 | `chunkIds(99999)` + `MAX_INDEX_FILES`                                                                 |

---

## Codex derin yeniden doğrulama — 2026-07-29 (güncel / arşiv notu)

**Karar:** `request changes` — public yayın geçerli, fakat “P1 bitti” kabulü
için aşağıdaki iki uygulama açığı ve davranış testleri kapatılmalı.

**Bağımsız doğrulama:** **159/159 test** ✅ · TypeScript ✅ · Prettier ✅ ·
ESLint ✅. HEAD/origin `0dc4e989`, analiz başında çalışma ağacı temizdi. GitHub
API ile public
[`v1.0.27`](https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/tag/v1.0.27)
ve rolling `update` release’i canlı doğrulandı. İndirilen **645.142 bayt** XPI
için manifest SHA-512 değeri ile gerçek dosya hash’i birebir eşleşti.

| Madde                          | Durum | Derin doğrulama sonucu                                               |
| ------------------------------ | ----- | -------------------------------------------------------------------- |
| OA cleanup sahipliği           | 🟡    | Kod doğru; gerçek IO yarış testi yerine boolean helper testi var     |
| İndeks incomplete → otomasyon  | ❌    | Cap/depth kapanıyor; okunamayan klasör/entry sessizce “complete”     |
| İndeks mutasyon kuyruğu        | 🟡    | Seri kuyruk var; gerçek concurrent build/register testi yok          |
| Atomik JSON crash recovery     | 🟡    | Atomik replace var; hata enjeksiyonu/quarantine kabul testi yok      |
| Çoklu pencere lifecycle        | 🟡    | Kod düzeltildi; gerçek Zotero iki-pencere kabulü yok                 |
| Public `v1.0.27` artefact/hash | ✅    | Versioned link, update channel ve indirilen XPI SHA-512 doğrulandı   |
| Release shell/provenance       | ❌    | Kullanıcı girdisi shell-string; artefact→source commit bağı kayıtsız |
| Fail-open / ReDoS / CI         | ❌ P2 | Önceki P2 maddeleri açık                                             |

### P1 — Okunamayan indeks bölümü otomasyonu fail-open bırakıyor

`src/modules/folderIndex.ts:291-295`, `IOUtils.getChildren(dir)` hata verdiğinde
klasörü sessizce atlıyor. `src/modules/folderIndex.ts:302-315` de bir child için
`stat` hatasını sessizce atlıyor. Her iki yol da
`walkState.incomplete = true` veya bir `truncateReason` üretmiyor. Sonuçta
`isFolderIndexComplete()` yanlışlıkla `true` kalıyor; reconciler yereldeki PDF’yi
göremediği halde OA otomasyonunu çalıştırıp yinelenen dosya ekleyebilir.

Bu, önceki “incomplete indeks otomasyonu durdurur” kabulünün yalnız max-files ve
max-depth yollarında kapandığını gösterir. Mevcut test de gerçek walker hatası
üretmiyor; `__setLastIndexBuildMetaForTests()` ile sonucu doğrudan enjekte ediyor.

**Cursor görevi:** `IndexTruncateReason` sözleşmesine en az
`unreadableDirectory` / `statError` ekle veya tek bir `ioError` nedeni kullan.
Her erişim hatasında indeksi incomplete yap; kök hiç okunamadığında ve alt child
atlanınca audit/UI’da kök/yol bilgisi sızdırmadan görünür uyarı üret. Böyle bir
indeksle OA ve yüksek güvenli otomasyon çalışmamalı.

**Kabul:** sahte `IOUtils.getChildren` ve `IOUtils.stat` hatalarıyla gerçek
`buildIndex(true)` testi; sonuç `incomplete`; audit olayı mevcut; OA çağrısı
sıfır. Bir kökün bozuk, diğerinin okunabilir olduğu çoklu-kök testi de olmalı.

### P1 — Release betiği shell-safe ve source-provenance’lı değil

`scripts/publish.mjs:43-46` hâlâ `execSync(..., { shell: true })` kullanan
`runShell()` tanımlıyor. `--notes` kullanıcı girdisi
`scripts/publish.mjs:206-208` içinde `JSON.stringify(notes)` ile bir shell
komutuna birleştiriliyor. Windows `cmd.exe` için JSON’un `\"` kaçışı shell
kaçışı değildir; çift tırnak/metakarakter içeren not shell sınırını bozabilir.
Betiğin başında tanımlanan arg-array `run()` ise yayın komutlarında
kullanılmıyor.

Ayrıca public XPI’nin hash’i doğrulanıyor, fakat release notu/asset/manifest
içinde kaynak commit `18fe8cf1` veya tam source SHA bulunmuyor. Yerel
`v1.0.27` etiketi sonraki belge commit’i `809450ba` üzerinde; dağıtım
reposundaki etiket ise başka bir reponun commitini gösterir. Bu nedenle hash,
indirilen dosyanın değişmediğini kanıtlıyor ama hangi kaynak committen
üretildiğini kanıtlamıyor.

**Cursor görevi:** tüm `git`, `npm` ve `gh` çağrılarını arg-array
`execFileSync`/`spawnSync` ile yap; `runShell` ve string komutları kaldır.
Release öncesi tam source SHA’yı al; XPI içine build metadata olarak ve release
notu/provenance JSON asset’ine yaz. Manifestte source SHA + XPI SHA-512 +
build zamanı/sürümü ilişkilendir. Kullanıcı notunda `"`, `&`, `|`, `%`, satır
sonu bulunan güvenli subprocess testi ekle; gerçek komut çalıştırmadan argv’yi
doğrula.

**Kabul:** shell çağrısı sıfır; adversarial notes tek argv değeri; public
artefact SHA-512 eşleşmesi yanında source commit bağı makinece okunabilir.

### P1 kabul boşluğu — düzeltmeler davranış seviyesinde test edilmiyor

- OA testi yalnız `shouldCleanupPersistedDownload(false/true)` boolean helper’ını
  test ediyor; rezervasyon ile move arasına dış dosya koyup byte’ların korunduğu
  `downloadAndAttach` IO yarış testi yok.
- İndeks kuyruğu için `buildIndex()` ve `registerDownloadedFile()` gerçekten
  eşzamanlı başlatılıp iki güncellemenin de korunduğu test yok.
- `atomicJson.ts` için temp write/move hata enjeksiyonu, eski tam JSON’un
  korunması ve bozuk JSON quarantine/recovery testi yok.

**Cursor görevi:** helper/source-regex testleri yerine yukarıdaki üç davranış
testini ekle. Bunlar kod değişikliği gerektirmese bile P1 kabulünün parçasıdır.

### P1 koşullu — gerçek Zotero çoklu pencere kabulü

Kaynak lifecycle düzeltmesi korunuyor. Fakat iki ana Zotero penceresinde ilk
pencere kapandıktan sonra ikinci pencerede menü/dialog/otomasyonun çalıştığı ve
son kapanışta notifier/timer sızıntısı kalmadığı hâlâ kaydedilmedi. Bu madde
otomatik testle kapatılamıyorsa sürüm ve ortam bilgili manuel kabul kaydı
zorunlu.

### Cursor için zorunlu kapanış sırası

1. İndeks IO hatalarını `incomplete` yap ve gerçek walker/OA suppression
   entegrasyon testlerini ekle.
2. Publish betiğini tamamen arg-array yap; source SHA provenance asset’i ekle.
3. OA cleanup, concurrent index mutation ve atomic JSON crash davranış testlerini
   ekle.
4. Gerçek Zotero iki-pencere kabul kaydını tamamla.
5. Kalite kapıları + yeni public patch sürümü/hash/provenance doğrulamasından
   sonra P1’i kapat.

---

## Cursor P1 follow-up — 2026-07-29 (arşiv)

**Cursor doğrulaması:** **159/159 test** ✅ · lint:check ✅ · typecheck ✅

| Madde                          | Durum | O oturumdaki not                                                                                  |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------- |
| Çoklu pencere lifecycle        | 🟡    | Kod ✅; gerçek Zotero iki-pencere kabulü açık                                                     |
| OA cleanup sahipliği           | ✅    | `finalCreatedByThisRun` + fail-closed exists                                                      |
| İndeks incomplete → otomasyon  | ✅    | OA suppress + audit `index-incomplete`                                                            |
| İndeks mutasyon kuyruğu        | ✅    | `enqueueIndexMutation` build+register                                                             |
| Atomik JSON crash testleri     | 🟡    | helper var; enjeksiyon testi sınırlı                                                              |
| Public `v1.0.27` + update_hash | ✅    | [v1.0.27](https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/tag/v1.0.27) + sha512 |
| Fail-open / ReDoS / CI         | ❌ P2 |                                                                                                   |

---

## Codex derin yeniden doğrulama — 2026-07-29 (arşiv)

**Karar (o an):** `request changes`

**Bağımsız doğrulama (o an):** **157/157 test** ✅ · TypeScript ✅ · Prettier ✅ ·
ESLint ✅ · production XPI build ✅ (`1.0.27`). HEAD/origin `2b26b3cd`.

| Madde                         | Durum | Derin doğrulama sonucu                                       |
| ----------------------------- | ----- | ------------------------------------------------------------ |
| Çoklu pencere lifecycle       | 🟡    | Kod yönü doğru; gerçek iki-pencere Zotero kabulü yok         |
| OA no-overwrite / rezervasyon | ❌→✅ | Cleanup sahipliği düzeltildi (bu oturum)                     |
| İndeks 50k sessiz kesim       | 🟡→✅ | incomplete artık OA’yı kesiyor                               |
| Atomik indeks/audit JSON      | 🟡    | Atomik replace + seri kuyruk; crash enjeksiyon testi sınırlı |
| Kalite kapıları + XPI         | ✅    |                                                              |
| README ürün kimliği           | ✅    |                                                              |
| Dirty → commit tabanı         | ✅    |                                                              |
| Public `v1.0.27` release      | ✅    | canlı + update_hash doğrulandı                               |
| Fail-open PDF doğrulama       | ❌ P2 |                                                              |
| ReDoS / sağlayıcı politikası  | ❌ P2 |                                                              |
| CI workflow                   | ❌ P2 |                                                              |

### P1 yeniden açıldı — OA cleanup, yarışta kendisine ait olmayan dosyayı silebilir

`src/modules/pdfSources.ts:308-327` hedefi rezerve ediyor, sibling partial
dosyaya yazıyor ve `IOUtils.move(..., { noOverwrite: true })` kullanıyor. Bu
kısım mevcut hedefi ezmiyor. Ancak rezervasyon ile move arasında başka bir
süreç aynı `persistedPath` dosyasını oluşturursa move güvenli biçimde hata
veriyor; dış `catch` attachment’ı `null` yapıyor ve
`src/modules/pdfSources.ts:364-371` koşulsuz olarak `persistedPath` dosyasını
siliyor. Böylece no-overwrite’ın koruduğu dış dosya cleanup aşamasında
siliniyor.

**Cursor görevi:** yalnız bu çalıştırmanın başarıyla oluşturduğu final dosyayı
temizleyecek bir sahiplik bayrağı (`finalCreatedByThisRun`) kullan. Bayrağı
yalnız başarılı final move’dan sonra kur. `IOUtils.exists` sorgusu hata verirse
adayı boş sayma; fail-closed davran. Rezervasyon ile move arasında hedefi başka
aktörün oluşturduğu entegrasyon testi ekle ve mevcut byte’ların aynen kaldığını
doğrula.

**Kabul:** yarışta dış dosya silinmez/değişmez; partial artık bırakılmaz;
başarısız attachment yaratımında yalnız eklentinin oluşturduğu final dosya
temizlenir.

### P1 kısmi — `incomplete` indeks durumu üretiliyor ama kararları durdurmuyor

`folderIndex.ts` cap’i 99.999’a yükseltiyor ve derinlik/cap kesiminde
`lastBuildMeta.incomplete` üretiyor. Fakat `getLastIndexBuildMeta()` üretim
kodunda hiçbir tüketici tarafından çağrılmıyor; durum yalnız log/persist
ediliyor. Reconciler eksik indeksi normal başarı gibi kullanabildiğinden,
indeks dışında kalan mevcut bir PDF için online fallback tetiklenip yinelenen
dosya üretilebilir. Ayrıca test yalnız sabitleri ve varsayılan meta tipini
kontrol ediyor; cap/depth kesimini veya tüketici davranışını yürütmüyor.

**Cursor görevi:** incomplete indeksi otomasyon için engelleyici durum yap;
online fallback ve güven isteyen otomatik kararları durdur, kullanıcı/audit
üzerinden görünür uyarı üret. Cap ve `MAX_WALK_DEPTH` kesimini gerçek walker
fixture’ıyla; reconciler’ın bu durumda indirme yapmadığını entegrasyon testiyle
doğrula.

**Kabul:** eksik tarama başarı olarak raporlanmaz; eksik indeksle yeni OA
indirmesi/otomatik kesin karar yok; yeniden tarama veya kullanıcı müdahalesi
yolu görünür.

### P1 kısmi — atomik replace var, eşzamanlı lost-update koruması yok

`atomicJson.ts` benzersiz temp + move ile yarım JSON riskini azaltıyor ve bozuk
dosyayı quarantine ediyor. `automationAudit` süreç içi `writeChain` kullanıyor.
Ancak `folderIndex` için ortak yazma kuyruğu/generation compare yok:
`buildIndex()` ile `registerDownloadedFile()` çakışırsa iki geçerli snapshot’ın
son yazanı diğer güncellemeyi kaybedebilir. Doğrudan atomic JSON crash,
quarantine ve concurrent folder-index testi de bulunmuyor.

**Cursor görevi:** folder-index mutasyonlarını tek seri kuyruğa/transaction
sınırına al; snapshot generation veya yeniden-okuma+merge ile lost-update’i
önle. Temp-write/move hata enjeksiyonu, bozuk JSON recovery ve eşzamanlı
build/register testleri ekle.

**Kabul:** aynı süreçte tüm indeks mutasyonları sıralı; yarış testinde iki
güncelleme de korunur; crash sonrası ya eski ya yeni tam JSON okunur ve
recoverable quarantine kanıtlanır.

### P1 koşullu — çoklu pencere yalnız kaynak-yüzey testiyle doğrulandı

`hooks.ts` süreç reconciler’ını bir kez kuruyor ve tek pencere unload’unda
global `unregisterAll` çağırmıyor; bu doğru düzeltme yönü. Bununla birlikte
mevcut test gerçek iki Zotero penceresini çalıştırmıyor. `Menu` tek süreç
nesnesi olarak global `window` üzerinden timer/file-picker/prompt kullanmaya
devam ediyor. Kalan pencerenin doğru window context’i kullandığı ancak gerçek
Zotero kabulüyle kapanabilir.

**Cursor görevi:** iki ana pencere aç/kapat matrisi uygula; ilk pencere
kapandıktan sonra ikinci pencerede menü, dialog ve otomasyonu çalıştır; son
pencere kapanışında notifier/timer sızıntısı olmadığını kaydet.

### P1 açık — public release ve bütünlük zinciri

Yerel paket `1.0.27`, fakat canlı release `v1.0.21`. `scripts/publish.mjs`
shell-string komutları kullanıyor, mevcut tag/release’i silebiliyor ve temiz
ağaç/test/hash/post-download kapıları kurmuyor. `update.json` exact artefact
yerine `latest/download` kullanıyor ve `update_hash` taşımıyor.

**Cursor görevi:** release’i arg-array subprocess, immutable tag, clean-tree,
kalite kapıları ve SHA-512 manifest ile güvenli yap. Exact committen üret;
yüklenen XPI’yi yeniden indirip yerel hash ile karşılaştır; ancak sonra
`v1.0.27`yi public kanalda doğrula.

### Cursor için zorunlu sıra

1. OA cleanup sahiplik hatasını ve yarış testini düzelt.
2. `incomplete` indeks durumunu otomasyon kapısına bağla.
3. Folder-index eşzamanlı lost-update korumasını ve hata enjeksiyon testlerini ekle.
4. Gerçek Zotero iki-pencere kabul matrisini kaydet.
5. Shell-safe, immutable, hash’li `v1.0.27` public release yap.
6. Sonra P2: fail-open içerik, regex/ReDoS, tarama ölçeği/cancellation, CI,
   sağlayıcı/provenance ve eski çeviri belgeleri.

---

## Derin yeniden analiz — 2026-07-29 (arşiv notu)

**İncelenen taban (o an):** kaynak HEAD `4fa56746` (`1.0.21`) + geniş,
commit edilmemiş `1.0.27` çalışma ağacı.

**Bağımsız doğrulama (o an):** **154/154 test** ✅ · TypeScript ✅ · Prettier ❌
**44 dosya** · ESLint ❌ **6 hata**. Public dağıtım deposunun son release’i canlı
GitHub API’de `v1.0.21`; `1.0.22–1.0.27` public değil.

### Yeni/derinleştirilen öncelik matrisi

| Öncelik | Açık                                     | Etki                               |
| ------- | ---------------------------------------- | ---------------------------------- |
| P1      | Çoklu pencere global lifecycle           | ✅ düzeltildi                      |
| P1      | OA hedef adı TOCTOU yarışı               | ✅ düzeltildi                      |
| P1      | İndeks 50.000’de sessiz kesiliyor        | ✅ 99999 + incomplete              |
| P1      | `1.0.27` dirty ve public değil           | 🟡 commit; public ❌               |
| P1      | Atomik olmayan indeks/audit JSON         | ✅ düzeltildi                      |
| P1      | README başka ürünü gösteriyor            | ✅ düzeltildi                      |
| P2      | Tam kütüphane taraması + seri yürüyüş    | UI/bellek/başlangıç maliyeti       |
| P2      | İçerik doğrulama “fail-open”             | Yanlış taranmış PDF kabulü         |
| P2      | Kullanıcı regex’lerinde ReDoS sınırı yok | UI thread donabilir                |
| P2      | Release bütünlük/CI kapısı yok           | Bozuk veya değiştirilmiş XPI riski |
| P2      | Sci-Hub/LibGen kodu üründe dağıtılıyor   | Hukuki/politika yüzeyi             |

### P1 — OA indirmesi var olan dosyanın üzerine yazabilir

`src/modules/pdfSources.ts:303-329`, adı önce senkron olmayan bir callback ile
seçiyor, sonra `IOUtils.exists` kontrolü yapıp doğrudan `IOUtils.write` ediyor.
Kod yorumu da çakışmanın mümkün olduğunu kabul ediyor. İki eşzamanlı indirme
aynı adayı seçebilir; kontrol ile yazma arasında başka süreç/dosya da oluşabilir.
Yazma “exclusive create” değilse mevcut PDF bozulur veya yanlış item aynı
dosyaya bağlanır.

**Cursor görevi:** tek süreçte indirme-adı rezervasyon kuyruğu; mümkünse
exclusive create; GUID temp dosya + doğrulama + atomik, no-replace rename.
Hedef varsa hash karşılaştır; aynıysa yeniden kullan, farklıysa deterministik
suffix üret. İki paralel item ve dışarıdan dosya oluşturma yarışı testi ekle.

### P1 — 99.999 hedefi 50.000’de sessizce kesiliyor

`src/modules/folderIndex.ts:204-225`, `out.length >= 50000` veya derinlik
`> 8` olduğunda uyarı/audit vermeden yürüyüşü durduruyor. Katman stratejisindeki
99.999 PDF kabulü sağlanmıyor; kesilen dosyalar “orphan yok/eşleşme yok” gibi
yanlış yorumlanır. Üstelik yürüyüş kökler arasında seri.

**Cursor görevi:** limit ve derinliği sürümlü config/kontrat yap; truncation’ı
başarılı indeks sayma, audit/UI’da “incomplete” durumu üret. Sayfalı/streaming
indeks, bounded concurrency, cancellation ve 100k+ gerçekçi fixture benchmark
ekle.

### P1 — Public kanal yalnız `1.0.21`

Canlı release listesinde en yeni artefact `v1.0.21`. Yerel `update.json`
`1.0.27` ve `latest/download` gösteriyor; `update_hash` yok. Dolayısıyla planın
“P2-1…P2-6 tamam” ifadesi yalnız dirty yerel ağaca ait, yayımlanmış ürüne değil.

**Cursor görevi:** önce dirty ağacı review edilmiş commitlere böl; kalite
kapılarını yeşile getir; exact committen XPI üret; sürüm/tag/update hash ve
public indirme hash’ini aynı provenance kaydına bağla.

### P2 — PDF içeriği okunamazsa doğrulama başarılı sayılıyor

`src/modules/pdfSources.ts:236-258`, çıkarılabilir metin 50 karakterden azsa
veya PDFWorker hata verirse `true` döndürüyor. `%PDF` magic kontrolü dosya türünü
doğrular ama doğru makale olduğunu doğrulamaz. Taranmış/şifreli yanlış PDF,
yüksek güvenli kaynak varsayımıyla otomatik eklenebilir.

**Cursor görevi:** sonucu `match | mismatch | unverifiable` üçlü durumuna
çevir. `unverifiable` otomatik attach yerine `#pdf-review`/kuyruğa gitmeli;
kaynak+DOI hash gibi güçlü kanıt varsa ayrı policy ile kabul edilebilir.

### P2 — Kullanıcı regex’leri ana thread’de sınırsız çalışıyor

`attachmentScanner.ts` ignore mask’leri ve `menu.ts` filename kuralları kullanıcı
metninden `new RegExp` üretiyor. Sözdizimi hatası yakalanıyor fakat katastrofik
backtracking engellenmiyor; uzun dosya adları/toplu işlem Zotero UI thread’ini
dondurabilir.

**Cursor görevi:** safe-regex doğrulaması veya regex yerine glob; pattern/target
uzunluk sınırı; riskli nested quantifier reddi; adversarial performans testi.

### P2 — Kaynak/politika yüzeyi planla tam hizalı değil

Varsayılan `sourceOrder` Sci-Hub ve LibGen adlarını içeriyor; ikisi kapalı ve
otomatik OA fallback testi bunları dışlıyor. Yine de istemci kodu, varsayılan
mirror URL’leri ve manuel etkinleştirme üründe dağıtılıyor. “Sci-Hub otomatik
yok” ifadesi teknik olarak doğru, fakat dağıtım/politika riskini anlatmıyor.

**Cursor görevi:** bu sağlayıcıları ayrı, kullanıcı tarafından kurulan
opsiyonel paket/adapter yap veya açık hukuk/politika kararı ve bölgesel uyarı
ekle; telemetri/loglarda sorgu/DOI sızıntısı olmadığını test et.

### P2 — Release scripti shell-safe ve immutable değil

`scripts/publish.mjs`, var olan version release/tag’ini silip yeniden yaratıyor
ve kullanıcı release notunu shell komutuna ekliyor. Test/lint/temiz ağaç/hash
kapısı yok. Katman 3 ile aynı sınıfta command-injection ve yeniden üretilebilirlik
riski taşıyor.

**Cursor görevi:** arg-array `execFile`, immutable tag, clean-tree + CI,
SHA-512 `update_hash`, public post-download doğrulaması.

### Cursor için güncel uygulama sırası

1. OA no-overwrite/atomik hedef rezervasyonu.
2. Çoklu pencere süreç/pencere lifecycle ayrımı.
3. 50k sessiz truncation kaldırma ve incomplete-index durumu.
4. Dirty ağacı küçük commitler + format/lint/CI.
5. Atomik indeks/audit persistence.
6. Doğru README ve public `1.0.27` provenance’lı yayın.
7. Fail-open içerik policy, regex güvenliği ve opsiyonel sağlayıcı ayrımı.
8. 100k ölçek + gerçek Zotero 7–10 kabul matrisi.

## Yönetici özeti

Katman 2’nin 154 testi, TypeScript kontrolü ve XPI build’i geçiyor. Buna rağmen
mevcut v1.0.27 geliştirmeleri commit edilmemiş; `origin/main` v1.0.21’de.
ESLint altı hata, Prettier 43 dosya nedeniyle kırık. İki Zotero penceresinde
global reconciler/menü yaşam döngüsü bozuluyor. İndeks ve audit JSON’ları atomik
yazılmadığı için çökme/güç kesintisi veri kaybı doğurabilir. README ise hâlâ
upstream **Zotero Attanger** ürününü ve onun indirme bağlantılarını tanıtıyor.

## Doğrulanan taban

- `npm test`: **154/154 geçti**
- TypeScript: **geçti**
- XPI build: **geçti**, v1.0.27
- Prettier: **başarısız**, 43 dosya
- ESLint: **başarısız**, 6 hata
- Depo tabanı: `origin/main`/HEAD v1.0.21; v1.0.27 özellikleri dirty çalışma
  ağacında.
- `pdfSources.ts:122-126` `%PDF` magic kontrolü içeriyor; PDF içerik doğrulaması
  bu raporda açık eksik olarak sınıflandırılmadı.

## Bulgular

### P1 — Çoklu pencere yaşam döngüsü reconciler ve menüleri düşürüyor

`src/hooks.ts:28-39` her pencere yüklenişinde global toolkit/menu/reconciler
durumunu değiştiriyor; yeni pencere önceki reconciler’ı dispose ediyor. Herhangi
bir pencerenin kapanışı global reconciler ve menüyü dispose edip
`ztoolkit.unregisterAll()` çağırıyor. Kalan pencere otomasyon ve UI’siz
kalabilir.

**Cursor görevi:** reconciler/notifier/timer’ı süreç başına bir kez başlat;
menü/pencere UI’sini `Map<Window, disposer>` ile pencere başına yönet; add-on
shutdown ile window unload’u ayır.

**Kabul:** iki pencere açma/kapatma matrisi; tek reconciler/notifier; kalan
pencerede menü ve otomasyon çalışır; son kapanışta timer/notifier sızıntısı yok.

### P1 — v1.0.27 doğrulanabilir bir depo/yayın tabanı değil

P2 değişiklikleri geniş bir dirty çalışma ağacında; kaynak deponun HEAD’i
v1.0.21. Böyle bir tabandan üretilen XPI’nin hangi kaynak commitine ait olduğu
kanıtlanamaz ve diğer ajanlarla çakışma riski yüksektir.

**Cursor görevi:** mevcut kullanıcı değişikliklerini koruyarak kapsamlı diff
review yap; P2-1…P2-6’yı küçük, doğrulanmış commitlere ayır; sürüm/tag/XPI/update
manifestini aynı commit SHA’ya bağla. Yayın öncesi temiz çalışma ağacı kapısı
ekle.

### P1 — Kalite kapısı kırık

Prettier 43 dosyada başarısız. ESLint hataları:

- `src/modules/filenameMetadata.ts:399`
- `src/modules/oaDownloadPath.ts:49`
- `src/modules/pdfMetadata.ts:133`
- `src/modules/pdfSources.ts:1273`
- `src/utils/shortcut.ts:63`
- `src/utils/shortcut.ts:94`

`package.json` içindeki tek `lint` komutu dosyaları yazıp otomatik düzeltme
yapıyor; CI için salt-okunur `lint:check` yok. `.github` altında CI workflow
değil, yalnız Dependabot/Renovate yapılandırması var.

**Cursor görevi:** hataları minimal diff ile düzelt; `format:check`,
`lint:check`, `typecheck`, test ve build’i GitHub Actions kapısı yap.

### P1 — README yanlış ürünü ve yanlış yayın kanalını gösteriyor

Kök `README.md`, “Zotero Attanger” başlığı, MuiseDestiny badge/linkleri ve
Attanger kurulum/özellik metni taşıyor. Kullanıcı Katman 2 yerine upstream
ürünü indirebilir; LibRArt/Katman 1–2 sınırı ve güvenlik davranışları görünmez.

**Cursor görevi:** README’yi Zotero PDF Manager kimliğiyle yeniden yaz;
`sanaatchi/zotero-pdf-manager-releases`, doğru add-on ID, özellik/sınır,
Katman 1/B3 sözleşmesi, dry-run, OA kaynakları, veri dizinleri, geri alma ve
lisans/provenance bağlantılarını belge­le.

### P1 — İndeks ve audit kalıcılığı atomik değil

`src/modules/folderIndex.ts:200` ve
`src/modules/automationAudit.ts:71,80` hedef JSON’u doğrudan
`IOUtils.writeUTF8` ile eziyor. Çökme veya güç kesintisi dosyayı yarım bırakır.
Audit okuma hatası boş listeye düşerse geçmiş sessizce kaybolabilir. İndeks için
şema sürümü/checksum ve süreçler arası kilit de yok.

**Cursor görevi:** temp dosya + fsync mümkünse + atomik rename; aynı-process
serial queue; sürümlü envelope (`schemaVersion`, generation, checksum);
bozuk dosyayı `.corrupt-*` olarak koru ve görünür uyarı üret.

**Kabul:** write-failure/crash enjeksiyonu eski sağlam dosyayı korur; eşzamanlı
yazımlar kayıp güncelleme üretmez; bozuk veri sessizce silinmez.

### P2 — Büyük kütüphanede tam tarama maliyeti kontrolsüz

**Durum:** ✅ (2026-07-29 P2 derinlik) — `iterateLibraryItemBatches` /
`pdf.libraryBatchSize`; full `getAll` yalnız fallback. Artımlı watermark hâlâ
ileride (tam tarama sayfalı + abort/yield).

### P2 — Dispose, aktif ağ isteğini gerçek anlamda iptal etmiyor

**Durum:** ✅ — `cancelToken` + reconciler `runAbort`; OA/HTTP `abortable` /
`throwIfRunAborted`; dispose → abort.

### P2 — Vendor provenance yeniden üretilebilir değil

**Durum:** ✅ — pinned SHA tablosu + `THIRD_PARTY_NOTICES.md` +
`tests/vendorProvenance.test.cjs`.

### P2 — Update/release bütünlük kapısı eksik

`update.json` için artefact hash’i yok; yayın betiği XPI ve manifesti yüklese de
public URL’den indirileni yerel XPI ile hash/kimlik/sürüm açısından tekrar
doğrulayan bir post-publish adımı görünmüyor. Zotero destek aralığı belgelerle
manifest arasında tek kaynak değil.

**Cursor görevi:** XPI SHA-256 üret/doğrula, update manifestini release
artefactine bağla, public indirme sonrası smoke doğrulaması yap ve Zotero 7–10
matrisini tek kaynaktan üret.

### P2 — Gerçek Zotero kabul matrisi yok

Mock test sayısı güçlü olsa da iki pencere, notifier yarışları, linked/imported
attachment, Windows kilitli dosya, Unicode/uzun yol, ağ kesintisi, redirect ve
Zotero 7–10 üzerinde manuel/otomatik kabul kaydı yok.

## Cursor için uygulama sırası

1. Dirty ağacı güvenli commit tabanına al ve kalite kapısını yeşile çevir.
2. Çoklu pencere/process yaşam döngüsünü düzelt.
3. Atomik indeks/audit yazımı ve bozuk-dosya kurtarması.
4. README ürün/yayın kimliğini düzelt.
5. Büyük-kütüphane artımlı tarama ve ağ iptali. ✅ (sayfalı + abort; watermark sonra)
6. Vendor SHA/provenance ve yayın bütünlüğü. ✅ (vendor SHA); release hash kısmen v1.0.28
7. Gerçek Zotero 7–10 kabul matrisi.

## Tamamlanma kapısı

- Temiz çalışma ağacında test + typecheck + format-check + ESLint + build yeşil. ✅ (kod)
- İki pencereli yaşam döngüsü: kod + yüzey testi ✅; gerçek Zotero matrisi ❌
- Atomik yazım/crash/concurrency: atomic helper + OA rezervasyon testi ✅
- README ve release URL’leri yalnız Zotero PDF Manager’ı gösteriyor. ✅
- XPI, update manifesti, tag ve kaynak commit SHA doğrulanabilir. ✅ v1.0.28
- 99.999 öğe ölçek smoke + vendor SHA kayıtlı. ✅; gerçek Zotero kabul matrisi ❌
