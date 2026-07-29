# Otomatik Güncelleme Kurulumu

Bu eklenti, Zotero'nun yerleşik otomatik güncelleme mekanizmasını kullanır.
Kurulumu **bir kez** yaparsın; sonra her iyileştirmede sürümü artırıp tek komutla
yayınlarsın. Tüm bilgisayarlardaki Zotero güncellemeyi kendisi indirir.

## Nasıl çalışır

- Kurulu eklentinin `manifest.json`'undaki `update_url`, GitHub'daki public dist
  repo'nun `update.json`'una bakar.
- Zotero düzenli olarak `update.json`'u kontrol eder; daha yüksek bir sürüm
  görürse `.xpi`'yi indirip sessizce kurar.
- `latest/download/` yolu her zaman en yeni release'e çözülür — URL'ler sabit kalır.

## İki repo düzeni (kaynağın gizli kalır)

| Repo                                    | Görünürlük | İçerik                                               |
| --------------------------------------- | ---------- | ---------------------------------------------------- |
| `sanaatchi/zotero-pdf-manager`          | Private    | Kaynak kod (yedek + iki bilgisayar senkronu)         |
| `sanaatchi/zotero-pdf-manager-releases` | **Public** | Sadece `.xpi` + `update.json` (Zotero buradan çeker) |

> Derlenmiş `.xpi` zorunlu olarak herkese açık indirilebilir olmak zorundadır —
> Zotero güncelleyicisi dosyayı kimlik doğrulaması olmadan çeker. Kaynak kodun
> yine de private repo'da gizli kalır.

---

## TEK SEFERLİK KURULUM

### 1. GitHub'a giriş yap (kendi terminalinde — tarayıcı açar)

```bash
gh auth login
```

### 2. Public dist repo'yu oluştur (release'lerin barınacağı yer)

```bash
gh repo create sanaatchi/zotero-pdf-manager-releases --public --add-readme -d "Zotero PDF Manager - güncelleme dağıtımı"
```

### 3. (İsteğe bağlı) Private kaynak repo'yu oluştur ve gönder

Bu klasörden:

```bash
git init -b main
git add -A
git commit -m "Zotero PDF Manager"
gh repo create sanaatchi/zotero-pdf-manager --private --source . --remote origin --push
```

### 4. İlk release'i yayınla

```bash
npm run gh-release
```

Bu, eklentiyi derler ve `v1.0.7` release'ini `.xpi` + `update.json` dosyalarıyla
public repo'ya yükler.

### 5. Son kez manuel kurulum (KRİTİK — sadece bir kez)

Şu an kurulu olan eklentinin `update_url`'i eski/ölü adresi gösteriyor. Otomatik
güncellemenin devreye girmesi için, **GitHub URL'ini taşıyan yeni yapıyı bir kez**
her bilgisayara kur:

- `build/zotero-pdf-manager.xpi` dosyasını Zotero'da **Tools → Add-ons → dişli
  simgesi → Install Add-on From File** ile kur.
- Bunu **her iki bilgisayarda** bir kez yap.

Bu son manuel kurulumdan sonra bir daha asla elle kaldırıp yüklemene gerek yok.

---

## HER İYİLEŞTİRMEDE (sürekli iş akışı)

```bash
# 1. Kodu değiştir, sonra sürümü artır (Zotero yalnızca daha yüksek sürüme günceller)
npm version patch --no-git-tag-version    # 1.0.7 -> 1.0.8

# 2. Yayınla (derler + GitHub release oluşturur)
npm run gh-release

# 3. (İsteğe bağlı) kaynağı da yedekle
git add -A && git commit -m "İyileştirme: ..." && git push
```

Zotero, bir sonraki güncelleme kontrolünde (veya Add-ons penceresindeki
**Check for Updates** ile hemen) yeni sürümü indirir. Diğer bilgisayarda hiçbir
şey yapmana gerek yok.

> Sürümü artırmayı unutma: aynı sürüm numarasıyla yeniden yayınlarsan Zotero
> güncelleme algılamaz.
