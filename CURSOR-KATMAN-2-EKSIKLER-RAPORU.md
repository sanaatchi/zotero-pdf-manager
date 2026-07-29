<!-- @ajan: cursor · @etiket: katman-2, derin-analiz, eksik-raporu, p1-fix -->

# Cursor — Katman 2 Eksikler Raporu

> **Çalışma kuralı:** Bu katmanda düzenleme öncesi  
> **1)** bu raporu oku → **2)** açık maddeleri düzelt → **3)** ancak sonra görev.  
> Rule: `.cursor/rules/katman-eksik-raporu.mdc`

**Tarih:** 2026-07-29  
**Kapsam:** `zotero-pdf-manager` · v1.0.27  
**Durum:** P1 kod düzeltmeleri (cleanup / incomplete gate / index queue /
publish hash) uygulandı; public release bu oturumda hedefleniyor.

## Güncel durum — 2026-07-29 (P1 follow-up)

**Doğrulama:** **159/159 test** ✅ · lint:check ✅ · typecheck ✅

| Madde                          | Durum | Not                                            |
| ------------------------------ | ----- | ---------------------------------------------- |
| Çoklu pencere lifecycle        | 🟡    | Kod ✅; gerçek Zotero iki-pencere kabulü açık  |
| OA cleanup sahipliği           | ✅    | `finalCreatedByThisRun` + fail-closed exists   |
| İndeks incomplete → otomasyon  | ✅    | OA suppress + audit `index-incomplete`         |
| İndeks mutasyon kuyruğu        | ✅    | `enqueueIndexMutation` build+register          |
| Atomik JSON crash testleri     | 🟡    | helper var; enjeksiyon testi sınırlı           |
| Public `v1.0.27` + update_hash | 🟡    | publish.mjs güçlendirildi; yayın sıradaki adım |
| Fail-open / ReDoS / CI         | ❌ P2 |                                                |

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
| Public `v1.0.27` release      | ❌    | Canlı kanal `v1.0.21` (yayın bekliyor)                       |
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

`src/modules/pdfReconciler.ts:168` ve `:322` `Zotero.Items.getAll` ile tüm
kütüphaneyi belleğe alıyor. Startup/periyodik uzlaştırma ve orphan işleme
99.999 öğede UI gecikmesi ve bellek baskısı oluşturabilir. İptal/progress ve
sayfalama sınırı yok.

**Cursor görevi:** değişiklik watermark’ı/queue, sayfalı sorgu ve bounded batch;
yield/cancel/progress; ilk tam taramadan sonra artımlı uzlaştırma.

### P2 — Dispose, aktif ağ isteğini gerçek anlamda iptal etmiyor

Reconciler `disposed` kontrolleri ve timer/notifier temizliği yapıyor; ancak
çalışan OA isteği için `AbortController` benzeri iptal zinciri yok. Kapanıştan
sonra istek tamamlanıp geç yan etki üretebilir veya shutdown’u uzatabilir.

**Cursor görevi:** run-scoped cancellation token’ı bütün source/download
zincirine geçir; attach/index/audit öncesi iptal kontrolü ve rollback testi ekle.

### P2 — Vendor provenance yeniden üretilebilir değil

`PDFMANAGER-VENDOR.md` kaynak repo ve lisansı söylüyor ama port edilen kesin
commit SHA, dosya/fonksiyon eşlemesi ve değişiklik özeti yok. “AGPL gibi işle”
lisans tanımı değildir. Bu haliyle hangi upstream kodun kullanıldığı ve notice
uyumu bağımsız doğrulanamaz.

**Cursor görevi:** her port için repo, commit SHA, lisans SPDX, kaynak yollar,
hedef yollar, uyarlama özeti ve testleri kaydet; `THIRD_PARTY_NOTICES.md` ile
otomatik tutarlılık kontrolü kur.

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
5. Büyük-kütüphane artımlı tarama ve ağ iptali.
6. Vendor SHA/provenance ve yayın bütünlüğü.
7. Gerçek Zotero 7–10 kabul matrisi.

## Tamamlanma kapısı

- Temiz çalışma ağacında test + typecheck + format-check + ESLint + build yeşil. ✅ (kod)
- İki pencereli yaşam döngüsü: kod + yüzey testi ✅; gerçek Zotero matrisi ❌
- Atomik yazım/crash/concurrency: atomic helper + OA rezervasyon testi ✅
- README ve release URL’leri yalnız Zotero PDF Manager’ı gösteriyor. ✅
- XPI, update manifesti, tag ve kaynak commit SHA doğrulanabilir. ❌ public yayın
- 99.999 öğe ölçek testi ve gerçek Zotero kabul matrisi kayıtlı. ❌ (cap sabit; smoke yok)
