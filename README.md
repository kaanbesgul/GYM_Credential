# GYM Enter

QR ile spor salonu girişi, birden çok salonun kullanabileceği bir hizmet (SaaS) olarak tasarlandı.
Kapıdaki ekran dönen bir QR gösterir, üye telefon uygulamasıyla okutur, sunucu o salondaki üyeliği
doğrular ve kapıya "aç" komutu gönderir. Salon sahipleri üyelerini, paketlerini ve kapılarını web panelinden yönetir.

```
                          ┌─────────────── Web paneli (salon sahibi, tarayıcı) ───────────────┐
                          │                                                                   │
 Üye uygulaması ──QR + oturum──▶  Sunucu (API + panel)  ──"aç"──▶  Kapı (Raspberry Pi) ──▶ Röle ──▶ Kapı/turnike
```

| Klasör | Durum | Açıklama |
|---|---|---|
| `server/` | ✅ hazır, 63 test | Node.js API + WebSocket + SQLite, çoklu salon. Derlenmiş web panelini de sunar |
| `web/` | ✅ hazır | Salon sahibi paneli (React + Vite + TypeScript) |
| `gate/` | ✅ hazır | Kapı uygulaması (Python, ekranlı/ekransız, röle simülasyonu + GPIO) |
| `member_app/` | ✅ derleniyor, testli | Üye uygulaması (Flutter, Android/iOS). Gerçek telefonda henüz denenmedi |

> **Windows notu:** Proje yolunda Türkçe karakter (`Masaüstü` gibi) olmamalı. Android derlemesi ve Dart analizi bu yüzden
> çalışmaz. Bu kopyayı `C:\dev\GYM_Enter` gibi sade bir yolda tutun.

## Veri modeli (kısaca)

- **`users`**: küresel hesaplar. Aynı kişi (aynı e-posta) birden çok salona üye olabilir, tek şifre, tek uygulama.
- **`gyms`**, **`gym_staff`**: salonlar ve onları web panelinden yönetenler (`owner` / `staff`).
- **`gym_members`**: kişi ↔ salon ilişkisi (salon bazında devre dışı bırakılabilir).
- **`plans`**, **`memberships`**: paketler ve üyelikler salona aittir. Aynı kişinin iki salonda ayrı üyeliği olur.
- **`gates`**, **`entries`**: kapılar ve giriş kayıtları salona aittir. QR hangi kapıdansa o salonun kuralları uygulanır.

## Çalıştırma (geliştirme)

**1. Sunucu ve web paneli** (Node.js 22.5+)

```bash
cd web
npm install
npm run build          # web/dist üretir; sunucu bunu otomatik sunar

cd ../server
npm install
npm run setup          # .env (rastgele sırlar; örnek: .env.example), veritabanı, örnek salon sahibi, salon ve ilk kapı
npm start              # http://localhost:3000 → panel
npm test               # entegrasyon testleri
```

Panele `http://localhost:3000` adresinden girilir. İlk deneme için "Salonunu kaydet" ile kendi salonunuzu oluşturabilir ya da
`server/.env` içindeki örnek salon sahibi hesabını kullanabilirsiniz.

Panelde arayüzü geliştirirken (`web/` klasöründe `npm run dev`) Vite 5173 portunda çalışır ve API'yi 3000'e yönlendirir.

**2. Kapı uygulaması** (Python 3.10+)

```bash
cd gate
pip install -r requirements.txt
python gate.py                       # ekranlı
python gate.py --headless            # ekransız (QR kodları konsola yazılır)
```

Gerçek bir salonun kapısı için panelde **Kapılar → Kapı ekle** der, çıkan ayarı (kapı kimliği + anahtar)
`gate/config.json` içine yapıştırırsınız. Anahtar yalnızca o anda gösterilir. Yerel denemede `npm run setup`'ın
ürettiği kapı anahtarı `server/.env` içindedir.
Varsayılan röle modu `sim`: kapı açılınca yalnızca log yazar.

> `gate/config.example.json` ve `server/.env.example` **örnek (DUMMY) dosyalardır**: içlerindeki değerler sahtedir ve
> herkes görebilir. Gerçek `config.json` ve `.env` dosyaları git'e eklenmez (`.gitignore`). Örnek değerlerle sunucu,
> kurulum betiği ve kapı uygulaması bilerek çalışmayı reddeder.

**3. Üye uygulaması** (Flutter kurulu olmalı)

```powershell
cd member_app
flutter pub get
flutter run            # bağlı Android telefonda çalıştırır
```

(İskelet ilk kez kuruluyorsa önce `powershell -ExecutionPolicy Bypass -File .\init.ps1`.)
Telefon ve sunucu aynı Wi-Fi'de olmalı. Giriş ekranındaki "Sunucu ayarları"na `http://<bilgisayarın-IP'si>:3000` yazın
(Android emülatöründe `http://10.0.2.2:3000`). Üyenin girebilmesi için panelden salona üye eklenip paket tanımlanmış olmalı.

## Raspberry Pi'ye kurulum

```bash
sudo apt install python3-tk python3-pil.imagetk python3-gpiozero
pip install websockets qrcode
```

`config.json` içinde:

```json
"fullscreen": true,
"relay": { "mode": "gpio", "pin": 17, "active_high": false, "open_seconds": 3 }
```

- Röle modülünü Pi'nin 3.3 V / GPIO pinine bağlayın, kilit/turnike kendi güç kaynağıyla çalışmalı.
  Çoğu röle kartı "active low" çalışır (`active_high: false`). Kartınız tersiyse `true` yapın.
- Açılışta otomatik başlatmak için `systemd` servisi veya masaüstü autostart kullanın.
- Pi'ye mümkünse kablolu ağ bağlayın: internet kopunca kimse içeri giremez.

## Güvenlik notları

- QR kodları sunucuda üretilir ve saklanır. Her biri 30 sn geçerli ve **tek kullanımlıktır**;
  ekrandaki kod 20 sn'de bir yenilenir.
- Aynı üye aynı salonda 2 dk içinde tekrar geçemez (`ANTI_PASSBACK_MS`).
- Salon çalışanları yalnızca kendi salonlarının verisine erişir (başka salonun kimliği denenince 404 döner).
- Bir salon, var olan bir e-postayı üye/çalışan olarak eklediğinde yalnızca ilişkiyi kurar; kişinin adı ve şifresi değişmez.
- Kapı cihazı `gate_id` + `gate_key` ile kimlik doğrular. Sunucu anahtarın yalnızca özetini saklar.
  Anahtar panelden yenilenebilir ve kapı silinebilir; her ikisinde bağlı cihaz anında düşer.
- **Hız sınırı ve hesap kilidi:** Giriş (dakikada 10), salon kaydı (saatte 5), şifre değiştirme, kapı bağlantısı ve panel API'si
  IP başına sınırlıdır. QR okutma oturum başına sayılır. Art arda 5 hatalı girişte hesap 15 dakika kilitlenir.
  Sınırlar `server/src/config.js` içindedir; ters vekil arkasında `TRUST_PROXY=true` verin, yoksa herkes tek IP görünür.
- **Oturumlar:** Anahtar 14 gün geçerlidir (`JWT_TTL`). Şifre değişince veya "Tüm cihazlardan çıkış" denince hesabın tüm
  eski anahtarları geçersiz olur.
- **Güvenlik başlıkları:** Sıkı CSP (yalnızca kendi dosyaları), `X-Content-Type-Options`, `frame-ancestors 'none'`, API yanıtlarında
  `no-store`. HTTPS ile yayındayken `HSTS=true` verin.
- **Roller:** `owner` her şeyi yapar. `staff` üye ekleme, paket tanımlama, giriş kayıtları ve elle kapı açma gibi günlük işleri
  yapar; paket fiyatı, kapı, çalışan ve denetim kaydına erişemez. Salonun en az bir sahibi her zaman kalır.
- **Denetim kaydı:** Üye/paket/kapı/çalışan değişiklikleri ve elle kapı açma, kimin yaptığıyla birlikte kaydedilir (yalnızca sahip görür).

### Bilinen ödünleşimler

- Hesap kilidi, bir saldırganın bilinen bir e-postayı 15 dakikalığına kilitlemesine izin verir ve kilit mesajı o e-postanın
  kayıtlı olduğunu belli eder. Hız sınırı bunu sınırlar; e-posta doğrulaması ve CAPTCHA ile daha da azaltılabilir.
- Üye veya çalışan eklerken "oluşturuldu / bağlandı" farkı, e-postanın sistemde olup olmadığını sızdırır.
- Panel oturum anahtarını tarayıcı deposunda tutar. Sıkı CSP buna karşı koruma sağlar; ileride `HttpOnly` çerezine geçilebilir.
- Kapı silinince giriş geçmişinde kapı adı yerine kimliği görünür.

### Canlıya çıkmadan önce yapılacaklar

- Sunucuyu HTTPS/WSS arkasında çalıştırın (ör. Caddy). Android'deki düz HTTP izni yalnızca geliştirme içindir, `member_app` içinde kaldırın.
- Salon kaydı (`signup-gym`) herkese açık: e-posta doğrulaması ve kötüye kullanıma karşı önlem ekleyin.
- Şifre sıfırlama (e-posta gönderen bir hizmet gerekir).
- SQLite yerine PostgreSQL ve düzenli yedekleme.
- Üye telefonunun konumunu doğrulama (kapıdaki QR'ın fotoğrafıyla uzaktan girişi zorlaştırır).
- KVKK: aydınlatma metni, hesap silme ve veri dışa aktarma.

## Sunucu API özeti

| Uç nokta | Kim | Ne yapar |
|---|---|---|
| `POST /api/auth/login` | herkes | `{email, password}` → `{token, name, gyms}` |
| `POST /api/auth/signup-gym` | herkes | Salon sahibi kaydı: hesap + salon + varsayılan paketler |
| `POST /api/gyms` | giriş yapmış | Mevcut hesaba ek salon açar |
| `POST /api/auth/change-password` | giriş yapmış | Şifre değiştirir, eski oturumları iptal eder, yeni anahtar döner |
| `POST /api/auth/logout-all` | giriş yapmış | Tüm cihazlardaki oturumları kapatır |
| `GET /api/me` | giriş yapmış | Üye olunan salonlar (üyelik durumlarıyla) ve yönetilen salonlar |
| `POST /api/scan` | üye | `{code}` okutulan QR ile giriş; salon kapıdan bulunur |
| `GET /api/gyms/:gymId` | salon çalışanı | Salon özeti ve sayılar |
| `GET /api/gyms/:gymId/plans` | salon çalışanı | Paketleri listeler |
| `GET/POST /api/gyms/:gymId/members`, `PATCH .../:userId` | salon çalışanı | Üyeler (ekle, devre dışı bırak). Listede son geliş tarihi de var |
| `GET /api/gyms/:gymId/members/:userId` | salon çalışanı | Üye detayı: bilgiler, üyelik geçmişi, giriş istatistikleri. Geldiği günler için `GET .../entries?userId=` kullanılır |
| `POST /api/gyms/:gymId/members/:userId/memberships` | salon çalışanı | Üyeye paket tanımla (süre uzar) |
| `GET /api/gyms/:gymId/entries` | salon çalışanı | Giriş geçmişi. Sorgu: `from`, `to` (ISO zaman, `to` hariç), `result` (`all`/`allowed`/`denied`), `userId` (tek üye), `limit` (≤500), `offset` |
| `GET /api/gyms/:gymId/entries/export` | **sahip** | Aynı aralık ve filtreyi Excel'de açılan CSV olarak indirir (UTF-8 + BOM, `;` ayırıcı, en fazla `MAX_EXPORT_ROWS`). Her indirme denetim kaydına yazılır |
| `GET /api/gyms/:gymId/entries/summary` | salon çalışanı | Aralığın özeti: geçen/reddedilen, farklı üye, gün gün döküm. `from` ve `to` zorunlu, `tzOffsetMinutes` günleri istemcinin saat dilimine göre gruplar |
| `GET /api/gyms/:gymId/gates`, `POST .../:gateId/open` | salon çalışanı | Kapıları listeler, elle açar |
| `POST /api/gyms/:gymId/gates`, `POST .../:gateId/rotate-key`, `DELETE .../:gateId` | **sahip** | Kapı ekle, anahtarı yenile, sil |
| `POST/PATCH /api/gyms/:gymId/plans` | **sahip** | Paket oluştur / düzenle |
| `GET/POST /api/gyms/:gymId/staff`, `PATCH/DELETE .../:userId` | **sahip** | Çalışanlar ve roller |
| `GET /api/gyms/:gymId/audit` | **sahip** | Denetim kaydı |
| `WS /ws/gate` | kapı cihazı | `hello` → `qr` / `open` / `deny` mesajları |
