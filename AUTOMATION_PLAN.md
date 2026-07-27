# Zotero PDF Manager — Tam Otomasyon Planı

**Hedef:** Kullanıcı **kök klasör(ler)i bir kez** ayarlar, bir daha hiçbir yol/tetik güncellemez.
Plugin, kütüphane ↔ klasörleri **sürekli kendisi eşitler**, PDF'leri otomatik ekler ve
**asla yanlış eşleştirmez** (güven eşiği + inceleme kuyruğu).

## Tasarım ilkeleri
1. **Config-once:** İzlenen kökler bir liste; yeni alt klasörler/dosyalar otomatik dahil. Yol güncelleme yok.
2. **Idempotent & güvenli:** Aynı dosya iki kez eklenmez; düşük güvenli eşleşme asla otomatik eklenmez.
3. **Artımlı (incremental):** Klasör indeksi kalıcı; sadece değişen dosyalar (mtime) yeniden taranır — tam tarama yok.
4. **Denetlenebilir:** Her otomatik işlem loglanır + etiketlenir; geri alınabilir.
5. **Klasör otorite:** Linked (bağlantılı) ek tercih edilir → depolama ikiye katlanmaz, klasör tek doğru kaynak.

---

## Mimari bileşenler

### 1. İzlenen Kökler (Watch Roots) — bir kez ayarlanır
- `watchRoots: string[]` — ör. `["D:\\OneDrive\\1A_E_KAYNAKLARIM"]`, birden fazla olabilir.
- Seçenek: **Zotero'nun "Linked Attachment Base Directory"** ayarını otomatik kök olarak kullan → hiç config gerekmez.
- Özyinelemeli (recursive), yeni alt klasörler otomatik kapsanır. → *"sürekli yol güncelleme" derdi biter.*

### 2. Kalıcı + Artımlı Klasör İndeksi
- İndeks kaydı: `{ path, size, mtime, normName, doi?, isbn?, pdfTitle? }`
- Plugin veri dizininde JSON olarak saklanır (kök başına).
- **Artımlı güncelleme:** mtime değişen/yeni/silinen dosyalar işlenir; gerisi cache'ten.
- Yeniden kurulma: açılışta + periyodik + istekle.
- Kötü adlandırılmış dosyalar için: **pdf-lib ile PDF gömülü metadata** (DOI/ISBN/başlık) + ilk sayfa metni okunur → eşleşme güçlenir.

### 3. Eşleştirme Motoru (mevcut + güçlendirilmiş)
Sıra:
1. **DOI / ISBN** (dosya adı **veya** PDF gömülü metadata'dan) → kesin eşleşme.
2. **Başlık içerilme (containment)** + **yazar** + **yıl** + **ince tiebreak** (rakam/kısa token) → mevcut mantık.
3. **Güven skoru** üret:
   - **Yüksek (≥ eşik, tekil)** → **otomatik ekle**.
   - **Orta / belirsiz** → **İnceleme Kuyruğu** (`#pdf-review` etiketi, EKLEME). → *asla yanlış eşleştirme.*

### 4. Tetikleyiciler (Orchestrator) — manuel tık yok
- **Zotero açılışında:** reconcile — eksik kayıtları indeksle eşleştir.
- **Öğe eklendiğinde** (Notifier `add`): anında yerel eşleştir; yoksa online indirme kuyruğuna al.
- **Öğe değiştiğinde** (`modify`, başlık/yazar): hâlâ eksikse yeniden değerlendir.
- **Periyodik zamanlayıcı** (ör. 30 dk): artımlı klasör taraması + yeni dosya/öğe reconcile.
- Not: Gerçek zamanlı dosya izleyici yerine **periyodik mtime-diff** (Zotero'da native watcher yok, bu daha sağlam).

### 5. Online Otomatik İndirme (yerel eşleşme yoksa)
- Açık erişim şelalesi: Unpaywall (`addAvailablePDF`), arXiv, PMC, Semantic Scholar.
- İndirilen PDF bir kökün `downloads/` alt klasörüne kaydedilir → indekse de girer.
- **İçerik doğrulaması** (mevcut). Sci-Hub/LibGen **opt-in/manuel** kalır.

### 6. Öksüz PDF İşleme (klasörde var, Zotero'da kayıt yok — şu an 177 adet)
- `orphanMode`:
  - `report` — sadece raporla (varsayılan güvenli).
  - `autoCreate` — PDF'ten DOI/ISBN çıkar → Zotero çevirmeni/Crossref ile metadata çekip **kayıt oluştur**; yoksa dosya adından taslak kayıt.
  - `off`.

### 7. Denetim & Rapor
- Her otomatik ekleme/kuyruk loglanır; etiketler: `#auto-attached`, `#pdf-review`, `#pdf-eksik`.
- Periyodik **HTML rapor sekmesi** (mevcut rapor altyapısı) + **dry-run** modu (canlı öncesi "ne yapardım" önizleme).

---

## Ayarlar (bir kez)
```
watchRoots            : ["D:\\OneDrive\\1A_E_KAYNAKLARIM"]   (+ Zotero base dir kullan: on/off)
autoOnStartup         : true      # açılışta reconcile
autoOnAdd             : true      # öğe eklenince yerel+online dene
periodicMinutes       : 30        # 0 = kapalı
autoAttachThreshold   : 0.85      # üstü otomatik ekle
reviewThreshold       : 0.60      # arası inceleme kuyruğu
onlineAutoDownload    : true      # OA kaynakları
orphanMode            : report    # report | autoCreate | off
attachMode            : link      # link (önerilen) | import
```

---

## Güvenlik (kusursuzluk garantisi)
- **Güven eşiği + inceleme kuyruğu** → yanlış eşleştirme yok.
- Zaten PDF'i olan öğe atlanır; aynı dosya (yol/hash) iki kez eklenmez.
- **Dry-run** ile önce simülasyon.
- Tüm otomatik işlemler etiketlerle **geri alınabilir**; linked dosyalar değiştirilmez.

---

## Aşamalı uygulama (implementasyon sırası)
| Faz | İş | Kazanım |
|-----|-----|---------|
| **1** | Kalıcı+artımlı çok-köklü indeks | Tam tarama biter, yol güncelleme derdi biter |
| **2** | Açılış + periyodik reconcile (yüksek güveni ekle, belirsizi kuyruğa) | Çekirdek otomasyon |
| **3** | `add` notifier ile anlık yerel+online getirme | Gerçek zamanlı |
| **4** | Online OA otomatik indirme → downloads/ | Boşlukları kapatma |
| **5** | Öksüz PDF → otomatik kayıt oluşturma | Klasör→kütüphane senkron |
| **6** | Denetim rapor sekmesi + dry-run | Şeffaflık/güven |

## Teknik notlar
- Attanger'ın **Notifier + debounce kuyruğu** yeniden kullanılır (zaten var).
- Geliştirilmiş **matcher** (containment+author+year+fine) çekirdek kalır.
- **pdf-lib** zaten bağımlılık → PDF gömülü DOI/ISBN/başlık okuma eklenir.
- İndeks JSON olarak plugin veri dizininde; mtime ile artımlı.
- **Linked** ek tercih → klasör tek otorite, depolama şişmez.
