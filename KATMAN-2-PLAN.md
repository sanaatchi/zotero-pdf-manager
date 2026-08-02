<!-- @ajan: cursor · @etiket: katman-2, pdf-manager, eksik-raporu, b4-lint, b5-dup-report -->

# Katman 2 — Zotero PDF Manager planı

> **Oturum başı:** [`CURSOR-KATMAN-2-EKSIKLER-RAPORU.md`](CURSOR-KATMAN-2-EKSIKLER-RAPORU.md) oku → düzelt → sonra bu plan / görev.  
> Rule: `katman-eksik-raporu.mdc`

**Strateji:** [`../../docs/uc-katman-stratejisi.md`](../../docs/uc-katman-stratejisi.md)

| Alan    | Değer                                                   |
| ------- | ------------------------------------------------------- |
| addonID | `zotero-pdf-manager@ibrahimyildiz.art`                  |
| Sürüm   | 1.0.49 (`package.json`)                                 |
| Girdi   | Katman 1’den organize PDF’ler + mevcut Zotero kayıtları |
| Çıktı   | Tutarlı ek + metadata → Katman 3 (LibRart)              |

---

## Plan belgeleri (bu katman)

| Belge                                                                      | İçerik                         |
| -------------------------------------------------------------------------- | ------------------------------ |
| [`CURSOR-KATMAN-2-EKSIKLER-RAPORU.md`](CURSOR-KATMAN-2-EKSIKLER-RAPORU.md) | **Önce oku → düzelt → görev**  |
| [`AUTOMATION_PLAN.md`](AUTOMATION_PLAN.md)                                 | P2-1…P2-6 otomasyon            |
| [`PDFMANAGER-REFERANS-PORT.md`](PDFMANAGER-REFERANS-PORT.md)               | Referans lisans + port matrisi |
| [`PDFMANAGER-VENDOR.md`](PDFMANAGER-VENDOR.md)                             | Tamamlanan vendor              |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)                         | Attribution metinleri          |

**Genel plan indeksi:** [`../../docs/PLAN-GIRIS.md`](../../docs/PLAN-GIRIS.md)

---

## Rol (Katman 2 only)

- PDF ↔ Zotero öğe **eşleştirme** (DOI, ISBN, başlık, gömülü metadata)
- Metadata **kontrol, temizleme, gömme** (`metadataCheck`, `pdfMetadata`, `metadataClean`)
- **Otomatik** klasör ↔ kütüphane reconcile (watch roots)
- Eksik PDF **indirme** (OA kaynakları)
- Öksüz PDF rapor / (opsiyonel) kayıt oluşturma

**Yapmaz:** Pipeline OCR/künye (Katman 1), Bağlantı Haritası/atıf grafiği (Katman 3).

---

## Mevcut modüller

| Modül                       | Durum     | Rol                                                    |
| --------------------------- | --------- | ------------------------------------------------------ |
| `attachmentScanner`         | ✅        | Ek tarama                                              |
| `metadataCheck`             | ✅        | Metadata doğrulama                                     |
| `pdfMetadata`               | ✅        | PDF metadata okuma/yazma                               |
| `metadataClean`             | ✅        | Temizleme                                              |
| `downloadReport`            | ✅        | İndirme raporu                                         |
| `pdfDownload`               | ✅ P2-4   | OA → downloads/ + indeks                               |
| `folderIndex`               | ✅ P2-1   | Çok-kök kalıcı indeks + linked-base + doi/isbn/title   |
| `pdfReconciler`             | ✅ P2-2/3 | Reconcile + eşikler + add coalesce                     |
| `orphanProcessor`           | ✅ P2-5   | Öksüz PDF (mode + güvenli autoCreate)                  |
| `pdfContentMetadata`        | ✅        | pdf-lib gömülü alanlar + Crossref                      |
| `automationAudit`           | ✅ P2-6   | Denetim raporu + dry-run                               |
| `duplicateAttachmentMerger` | ✅        | Yinelenen ek                                           |
| `attachmentDelete`          | ✅ B1     | Linked ek disk silme + trash (delitemwithatt)          |
| `metadataNormalize`         | ✅ B4a–c  | pages-range, creators-case, Extra sıra + menü          |
| `duplicateItemReport`       | ✅ B5     | DOI/ISBN/KP aday raporu (yazma yok); Zoplicate yan XPI |

---

## Otomasyon planı (AUTOMATION_PLAN.md özeti)

Tam metin: [`AUTOMATION_PLAN.md`](AUTOMATION_PLAN.md)

| Faz      | İş                                | Kazanım            | Durum         |
| -------- | --------------------------------- | ------------------ | ------------- |
| **P2-1** | Kalıcı + artımlı çok-köklü indeks | Tam tarama biter   | ✅            |
| **P2-2** | Açılış + periyodik reconcile      | Çekirdek otomasyon | ✅ eşikler    |
| **P2-3** | `add` notifier anlık eşleştirme   | Gerçek zamanlı     | ✅ coalesce   |
| **P2-4** | OA otomatik indirme               | Boşlukları kapatma | ✅ downloads/ |
| **P2-5** | Öksüz PDF → kayıt oluşturma       | Klasör→kütüphane   | ✅ orphanMode |
| **P2-6** | Denetim raporu + dry-run          | Güven              | ✅            |

**Tasarım:** Config-once watch roots · güven eşiği · inceleme kuyruğu · linked file öncelik.

---

## Katman 2 vs LibRart F6 (ayrım)

LibRart planındaki eski **“F6 PDF Gelen Kutusu”** (watch-folder) **Katman 2’ye taşındı**.
LibRart’ta tekrarlanmayacak; trickle/bulk PDF eşleme PDF Manager’da kalır.
Port kaynağı: [`PDFMANAGER-REFERANS-PORT.md`](PDFMANAGER-REFERANS-PORT.md).

---

## Sonraki adım (Katman 2)

1. **G1** YÖKTez otomatik OA politikası (karar) — bkz. eksikler
2. **G2** checklist v1.0.49 hazır — Bölüm A ✅; Bölüm B Zotero smoke kullanıcı
3. İsteğe bağlı P3: univ/edition lint, `tr-TR` locale, Attanger menü rename

---

## Değişiklik günlüğü

| Tarih      | Ajan   | Özet                                                       |
| ---------- | ------ | ---------------------------------------------------------- |
| 2026-08-02 | cursor | Derin analiz: G1–G10; doküman hijyeni G3–G5                |
| 2026-08-02 | cursor | B4b/c + B5: pages/creators/extra + dup rapor; v1.0.49      |
| 2026-07-30 | cursor | format-metadata selective → metadataNormalize/Check        |
| 2026-07-29 | cursor | P2-6 audit UI / dry-run polish                             |
| 2026-07-29 | cursor | P2-5 orphanMode + gated autoCreate                         |
| 2026-07-29 | cursor | P2-4 OA → downloads/ + indeks                              |
| 2026-07-29 | cursor | P2-3 add notifier coalesce / trash iptal                   |
| 2026-07-29 | cursor | P2-2 Attanger eşikleri + addSettleMs                       |
| 2026-07-29 | cursor | REFERANS-PORT + VENDOR; P2-1 linked-base + indeks alanları |
| 2026-07-29 | cursor | Katman 2 planı modül + otomasyon fazları                   |
