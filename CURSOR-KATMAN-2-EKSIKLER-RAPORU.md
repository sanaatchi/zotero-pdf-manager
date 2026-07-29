<!-- @ajan: codex · @etiket: katman-2, eksik-raporu, v1.0.33, exact-source-ci -->
<!-- @ajan: cursor · @etiket: katman-2, eksik-raporu, sync-codex-bulgu -->

# Cursor — Katman 2 Eksikler Raporu

> **Çalışma kuralı:** Bu katmanda düzenleme öncesi  
> **1)** bu raporu oku → **2)** açık maddeleri düzelt → **3)** ancak sonra görev.

**Tarih:** 2026-07-30  
**Kapsam:** `zotero-pdf-manager` **v1.0.33**  
**Durum:** `request changes` — ISBN public XPI ✅; exact-source CI +
`update.json` commit + checklist açık/kapanıyor.

## Codex kayıt (araç limiti sonrası — 2026-07-30)

**Karar:** `request changes`

| Madde                                   | Durum | Bulgu                                           |
| --------------------------------------- | ----- | ----------------------------------------------- |
| ISBN checksum in v1.0.33 XPI            | ✅    | SHA-512 provenance/update ile eşleşiyor         |
| Exact-source CI kanıtı                  | 🟡→🔄 | Run vardı ama provenance’da yoktu / private API |
| Repo `update.json` / `update-beta.json` | ❌→🔄 | Commit dışı dirty                               |
| Zotero checklist                        | 🟡 P1 | Boş                                             |

**Cursor görevi:** `update.json` dosyalarını commit et; provenance’a
`ciRunId`/`ciRunUrl` ekle (exact `dd2f311e` /
[30496542222](https://github.com/sanaatchi/zotero-pdf-manager/actions/runs/30496542222));
kaynak Actions üçüncü tarafça doğrulanabilsin (visibility veya kanıt alanı).

## Cursor ISBN patch notu

| Madde                   | Durum | Not                  |
| ----------------------- | ----- | -------------------- |
| Kaynak ISBN checksum    | ✅    | HEAD                 |
| Public XPI v1.0.33      | ✅    | + provenance SHA-512 |
| Gerçek Zotero checklist | 🟡    | Manuel               |
