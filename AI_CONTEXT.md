# AI Context — Mercury Test Runner

Bu dosya, AI ajanlarının bu repository'yi güvenli ve tutarlı biçimde anlaması için kısa proje bağlamıdır. Kod değiştirirken önce bu dosyayı, sonra ilgili kaynak dosyalarını ve testleri okuyun.

## Proje özeti

Mercury Test Runner, her şirketin kendi makinesinde çalıştırdığı yerel bir web uygulamasıdır. Kullanıcılar chat üzerinden web, Android veya iOS test koşumu başlatır; koşumlar kuyruğa alınır, TestRail ile ilişkilendirilir ve yerel HTML raporu üretir.

- Node.js `>=22`
- ESM (`"type": "module"`)
- Harici framework yerine Node'un HTTP, SQLite ve test API'leri ağırlıklı kullanılır. Çalışma zamanı bağımlılıkları tam sürümle sabitlenmiş `@midscene/web`, `@midscene/android`, `@midscene/ios` ve `playwright`'tır; sürüm değiştirmek için `npm run midscene:upgrade`
- Başlatma: `npm start`
- Test: `npm test`
- Varsayılan adres: `http://localhost:8080`

## Ana akış

```text
login
  -> chat
  -> agent komut çözümleme
  -> yeni TestRail run
  -> yerel kuyruk
  -> web worker veya Mercury Farm worker
  -> test hesabı / cihaz
  -> reports/{runId}/index.html
  -> koşumlar ekranı ve TestRail sonucu
```

Her test komutu yeni bir TestRail run açmalıdır. Eski bir run'a sonuç yazılmamalıdır. Eşzamanlı koşumlar birbirini beklememeli; kaynaklar koşumlar arasında ayrılmalıdır.

## Genel ürün kuralı

Mercury Test Runner herhangi bir şirketin herhangi bir projesinde kullanılacak genel bir üründür. Kaynak koda, varsayılan verilere, şablonlara, örnek case'lere, arayüz metinlerine, testlere ve belgelere müşteri, marka veya ürün adı, şirket alan adı ya da şirkete özgü API yolu yazılmaz. Örnekler `Örnek Proje`, `example.com`, `com.firma.uygulama` gibi nötr değerlerle verilir; projeye özgü her şey kurulumdan sonra admin tarafından arayüzden girilir.

## Kaynak dosyaları

- `src/server.mjs`: HTTP sunucusu, route'lar, oturum, auth, chat ve admin API'leri
- `src/db.mjs`: SQLite bağlantısı, şema, seed verileri ve veritabanı işlemleri
- `src/security.mjs`: uygulama anahtarı, parola doğrulama, AES-256-GCM sır şifreleme ve maskeleme
- `src/agent.mjs`: chat cümlelerinin koşum, ayar ve bellek komutlarına ayrıştırılması; `isPlainRunCommand` (yalnız kayıtlı adlardan oluşan komut → modele sorulmadan koşar) ve model yokken kullanılan kurallı senaryo bölücü
- `src/qa-agent.mjs`: chat QA ajanı. `qaCatalog` (etkin konfigürasyonlar + case'leri, sır yok), `conversationContext` (sohbetin son turları ve koşum sonuçları), `askQaAgent` (Midscene modelinin OpenAI uyumlu `chat/completions` ucu), `normalizeDecision` (model kararını katalogla doğrular: `run_suite` / `scenario` / `reply`)
- `src/skills.mjs` ve `skills/*.md`: QA becerileri. `qa-core` her istekte, diğerleri `triggers` sözcükleri mesajda (Türkçe ekli hâlleri dâhil) veya son turlarda geçince sistem istemine eklenir (`SKILL_BUDGET`). `DATA_DIR/skills/` özel becerileri yerleşikleri kimlikle ezer; `GET/PUT/DELETE /api/skills[/:id]` yalnız admin. Beceri metinleri de genel ürün kuralına uyar: marka, müşteri veya alan adı yazılmaz
- `src/planning.mjs`: konfigürasyon girdisi normalizasyonu, case kapsamı ve yürütme ön kontrolü
- `src/schedule.mjs`: konfigürasyon zamanlaması (`configs.schedule_json` = `{ enabled, everyDays, time, startDate, timeZone, since, userId }`, son tetiklenen sıra `configs.schedule_last_at`). `server.mjs` `runSchedules` 30 sn'de bir (`MERCURY_SCHEDULE_INTERVAL_MS`) vadesi gelen sırayı önce `schedule_last_at`'e yazar, sonra `createExecution` ile `Zamanlanmış koşum` notlu ve `runs.trigger_kind = 'schedule'` koşum açar; `GET /api/schedules` Koşumlar ekranındaki zamanlama tablosunu besler. Kayıttan önceki sıralar koşmaz; `SCHEDULE_GRACE_MS`'ten geç kalınan sıra ve önceki koşumu `queued`/`running` olan konfigürasyon atlanır
- `src/worker.mjs`: web/farm koşum kuyruğu, eşzamanlılık, worker yaşam döngüsü ve case YAML `steps:` okuyucusu (`parseSteps`)
- `src/midscene.mjs`: model ayarını Midscene ajan başına `modelConfig`'e çevirir, model ailesini algılar; `executeCases` ortak adım motorudur (adım başına zaman aşımı `stepTimeoutMs`, güvenli tek yeniden deneme `shouldRetry`, case başına `{{saved.*}}` değerleri, `item.context` → `aiContexts.default`). `runStep` adım türlerini Midscene API'lerine eşler; yeni adım türü eklerken `stepLabel`, `parseSteps` (`INLINE_ARG`), `qa-agent.mjs` (`ACTION_ALIASES`/`normalizeStep`/istem) ve README tablosu birlikte güncellenir. `runWebCases` Playwright + `@midscene/web/playwright/agent`, `runMobileCases` `@midscene/android` (`AndroidDevice`/`AndroidAgent`) ve `@midscene/ios` (`IOSDevice`/`IOSAgent`) kullanır
- `src/farm.mjs`: Mercury Farm automation API istemcisi (cihaz ayırma/filtre, `useDevice`, APK/IPA kurulumu, senaryo sonucu, bırakma, ADB anahtarı kaydı, WDA adresi çözümleme)
- `src/browser-pool.mjs`: web hatlarının paylaştığı Chromium havuzu (`createBrowserPool`: tarayıcı başına en fazla `LANES_PER_BROWSER` hat, çöken tarayıcı düşer, boşta kalan `IDLE_CLOSE_MS` sonra kapanır); `midscene.mjs` `webBrowserPool` sunucu genelinde tek havuz tutar
- `src/adb.mjs`: ADB ikilisini bulma, `adb connect/disconnect`, anahtar okuma
- `scripts/setup.mjs`: `npm start` öncesi (`prestart`) çalışır; sabit sürümlü paketleri, Chromium'u ve gerekirse Android platform-tools (ADB) kurar/eşitler
- `src/integrations.mjs`: TestRail ve Mercury Farm HTTP istemcisi
- `src/accounts.mjs`: test hesap kaynakları. `normalizeSpec` (eski kurulumların üst düzey `tokenHeader`/`list.query` biçimini de okur), `fetchHttpAccount` (auth: none/login/header/basic, liste, alan ve ek alan eşlemesi, kullanıldı işareti), `createAccountStore` (kaynak CRUD, kaynağa özel şifreli giriş bilgileri, elle girilen liste `source_accounts`, `status`, `acquire`, `test`)
- `src/providers.mjs`: model sağlayıcıları ve model API yardımcıları
- `src/i18n.mjs`: sunucu mesajlarının TR/EN çevirisi. Sunucu mesajları Türkçe yazılır ve Türkçe saklanır; `send` yanıtı `x-mercury-lang` başlığına göre (`requestLang`) `localizeBody` ile çevirir. Anahtarlar Türkçe mesajlardır, `{ad}` yer tutucuları yakalanıp yeniden çevrilir; birleşik mesajlar (`" · "`, `" — "`, `"; "`, `": "`, satır sonu) parça parça çevrilir. Yalnız sunucunun yazdığı alanlar (`error`, `message`, `reply`, `issues`, `detail` …; `text` yalnız asistan mesajında) çevrilir, kullanıcı verisi dokunulmaz. Yeni bir sunucu mesajı eklerseniz İngilizcesini `EN` sözlüğüne ekleyin
- `public/index.html`: tek sayfa kullanıcı arayüzü
- `public/i18n.js`: arayüz dil desteği (varsayılan TR, seçim `localStorage` `mercury.lang`). Arayüz metinleri Türkçe yazılır ve kendi çeviri anahtarıdır: `t("Türkçe metin", { param })`, İngilizcesi `EN` sözlüğünde. `index.html` içindeki statik metin ve `placeholder`/`aria-label`/`title`/`alt` öznitelikleri otomatik çevrilir; karışık içerikli öğeler `data-i18n-html="id"` + `EN_HTML` kullanır. Dil değişince `langchange` olayı yayılır ve `app.js` görünen ekranı yeniden çizer. `api()` her isteğe `x-mercury-lang` başlığını ekler
- `public/app.js`: UI state'i, chat, ayarlar, koşumlar ve admin işlemleri
- `public/app.css`: arayüz stilleri
- `test/api.test.mjs`: HTTP/API ve auth davranışları
- `test/providers.test.mjs`: model sağlayıcı yardımcıları
- `cases/`: kurulumla gelen test case YAML dosyaları

## Roller ve güvenlik

İki rol vardır: `admin` ve `user`. Yeni kayıtlar önce `pending` durumundadır.

- Kurulum admin'i: `mercury@test.com` / `Mercury`
- Admin; kullanıcı, ayar, model, TestRail, farm ve kaynak yönetebilir.
- User; chat, koşum listesi ve raporları kullanabilir.
- Yetki kontrolü yalnız UI'da değil, her ilgili API route'unda yapılmalıdır.
- Model, TestRail ve farm sırları veritabanında şifreli tutulur.
- Parolalar düz metin tutulmaz.
- Sırları loglara, HTML raporlara veya kullanıcı yanıtlarına yazmayın.

## Durum ve hata sözleşmesi

- Model anahtarı yoksa web koşumu `blocked` olmalıdır; `passed` sayılmamalıdır.
- Mobil cihaz yalnız Mercury Farm'dadır; bu sunucuya telefon bağlanmaz. Android: Farm `useDevice` → `adb connect` → `AndroidAgent`. iOS: Farm `useDevice` → WDA `host:port` → `IOSAgent`. Cihaz her durumda `finally` içinde `adb disconnect` + `DELETE /api/v1/autotests?group=…&result=…` ile bırakılmalıdır.
- Farm `409` (boş cihaz yok) koşumu `queued` + `retry_at` ile bekletir; hesap alınmadan ve `run_cases` yazılmadan önce cihaz ayrılır. Konfigürasyonun `device_wait_minutes` süresi dolarsa koşum `failed` olur.
- Paralellik (`configs.parallel`) ve cihaz bekleme süresi konfigürasyon başınadır. Genel tek kapasite ayarı `web_concurrency` (bu makinede açık web hattı toplamı; boşsa `autoWebLimit` RAM/CPU'dan hesaplar). Worker boş web hatlarını `fairLaneGrants` ile bekleyen kullanıcılara adil böler; koşum verilen hat kadar shard'a bölünür. Web hatları `src/browser-pool.mjs` ortak Chromium havuzunu kullanır, her case ayrı context. Android/iOS için genel sınır eklemeyin, Farm ve UDID havuzu sınırlar.
- Farm'ın `model` filtresi tam eşleşmedir; konfigürasyon cihaz filtresi bookable listede üretici/model/pazar adı/seri üzerinden eşlenip `serials` ile ayrılır.
- Paralel koşum: `laneCount` (paralel ∧ UDID havuzu ∧ case sayısı) ve `shardCases` (round-robin) `src/planning.mjs` içindedir. Worker her hat için ayrı cihaz, ayrı Midscene oturumu ve ayrı test kullanıcısı kullanır; kullanıcılar sıralı alınır, `exclude` ile çakışma önlenir ve alındığı anda `markUsed` ile kilitlenir. `runs.lanes` platform sınırı hesabında kullanılır.
- Konfigürasyon oluşturma/kopyalama/düzenleme `saveConfig` (server.mjs) üzerinden geçer; aynı client'ta ad ve chat takma adı benzersiz olmalıdır.
- Test hesap kaynakları proje bağımsızdır: kaynak bir client'a veya tüm client'lara (`client_id IS NULL`) aittir. Servis giriş bilgileri kaynağa özeldir (`sources.credentials`, şifreli JSON); genel `account_service_*` ayarı yoktur, eski kurulumlarda açılışta kaynaklara taşınır. Hesap şifresi, servis şifresi veya API anahtarı hiçbir API yanıtında, raporda veya hata mesajında dönmemelidir. `acquire` hesabı alındığı anda kilitler; `lockKey` = `kaynakId:hesapId`.
- `DELETE /api/runs/:id` koşumu, `run_cases` satırlarını ve `reports/{runId}/` klasörünü siler; chat geçmişindeki `run_ids` bağlantısını da kaldırır (id yeniden kullanılabilir). Admin her koşumu, user yalnız `started_by` kendisi olanı siler (`403`); `queued`/`running` koşum `409` döner. TestRail'deki run silinmez.
- TestRail ayarı yoksa yerel koşum yine anlaşılır bir durumla sonuçlanmalı, dış sisteme yazma başarılıymış gibi gösterilmemelidir.
- Entegrasyon hataları sessizce yutulmamalı; kullanıcıya ve koşum kaydına açık hata durumu yazılmalıdır.
- Kullanıcıya ait şifre, token ve API key hiçbir response içinde geri verilmemelidir.
- TestRail run açılamazsa koşum yerelde yine koşar ama bu `runs.testrail_error` ile chat yanıtında, koşum mesajında ve kartta gösterilmelidir; sessizce yutulmamalıdır.
- Midscene raporları kopyalanırken `redactSecrets` ile test kullanıcısı şifresi maskelenir ve `MIDSCENE_RUN_DIR` içindeki orijinal silinir. Midscene dosya günlükleri varsayılan kapalıdır (`MERCURY_MIDSCENE_LOGS=1` açar); yazılan değerleri içerdikleri için bu varsayılanı değiştirmeyin.
- Adım yalnız güvenliyse yeniden denenir (okuma/doğrulama ya da öğesi bulunamamış eylem); `aiAct`, bekleme, açılış, zaman aşımı ve model yetki hatası denenmez; bu kuralı gevşetmek çift gönderim/çift sipariş riskidir. Beceri `## Midscene` notları Midscene'ın her AI çağrısına gider; sır, müşteri adı veya alan adı içeremez ve kısa tutulur (`MIDSCENE_CONTEXT_LIMIT`).
- Paralel hatlarda her case'in kullanıcısı `run_cases.account_email` içindedir; adım metinlerindeki `{{account.email}}` bununla doldurulur.
- Konfigürasyon ön kontrolü geçmeden TestRail run açılmamalıdır. `account_policy=required` ise seçili `account_source_id`, hesap servisi kimlik bilgileri ve uygun hesap zorunludur.
- Case seçimi sırası `case_ids` → `case_tags` → client'ın tüm YAML case'leridir. Konfigürasyonun seçmediği case koşulmamalı ve TestRail'e eklenmemelidir. QA ajanı bunun içinden alt küme seçebilir (`runs.case_keys`, `scopeCases`); TestRail run'ı yalnız o case'lerle açılır.
- QA ajanı yalnız plan yapar; kararı `normalizeDecision` doğrulamadan hiçbir şey kuyruğa girmez. Modele şifre, API anahtarı, hesap servisi adresi/girişi gönderilmez. Model hatası sessizce yutulmaz: `qa_agent_failed` audit'i yazılır, yanıtta söylenir ve kurallı yola düşülür. Chat senaryosu birden çok case taşıyabilir (`scenario_json.cases`, tek hatta sırayla); `{{account.*}}` kullanan senaryo hesap kaynağı olmadan açılmaz ve hesabı `required` alır (`scenario_json.accountPolicy`).

## Kalıcı veriler

- Chat geçmişi `chat_messages` tablosunda kullanıcıya özeldir; `GET /api/chat/history` yalnız oturumdaki kullanıcının mesajlarını döner. Case adımları `run_cases.steps_json` içinde tutulur; adım yalnız Midscene gerçekten yürüttüyse `passed`/`failed` olur, yürütülmeyenler `not_run`, ilk hatadan sonrakiler `skipped` olmalıdır.
- Konfigürasyonlar `environment`, `account_source_id`, `account_policy`, `case_ids`, `case_tags` ve `enabled` alanlarıyla deterministik yürütme planını saklar. Worker test hesabını koşum başında yalnız seçili kaynaktan alır.
- `data/mercury.sqlite`: yerel veritabanı
- `data/app.key`: uygulama şifreleme anahtarı
- `reports/{runId}/`: koşum raporları ve varsa medya çıktıları
- Docker ortamında bu yollar `/data` volume'u ile kalıcıdır.

Veri kaybına neden olabilecek schema veya dosya değişikliklerinde önce mevcut migration/seed desenlerini inceleyin. Kullanıcının açık onayı olmadan kalıcı veriyi silmeyin.

## Geliştirme kuralları

1. Önce ilgili route, helper ve testleri okuyun; yeni paralel helper yazmak yerine mevcut deseni kullanın.
2. Değişikliği dar tutun; ilgisiz refactor yapmayın.
3. Yeni davranış için en yakın test dosyasına regresyon testi ekleyin.
4. `npm test` çalıştırmadan tamamlandı demeyin. Koşum, worker, Midscene, rapor veya arayüz akışını değiştirdiyseniz `npm run test:e2e` de çalıştırın (gerçek Chromium, yerel sahte site/servis/TestRail/model; dış anahtar gerekmez).
5. Node 22 uyumluluğunu koruyun.
6. API hatalarında uygun HTTP status kodu ve açıklayıcı JSON kullanın.
7. Auth ve role kontrollerini route seviyesinde koruyun.
8. TestRail'e yalnızca yeni oluşturulan run kimliğiyle sonuç gönderin.
9. Arayüze eklenen her metni `t()` ile yazın ve İngilizcesini `public/i18n.js` içine ekleyin; sunucunun kullanıcıya dönen yeni mesajlarının İngilizcesini `src/i18n.mjs` içine ekleyin (`test/i18n.test.mjs`).

## Desteklenen kullanıcı örnekleri

```text
örnek proje web chrome koş
örnek proje regresyonunu başlat
örnek proje ios, iPhone 15 koş
ayar testrail host https://testrail.example
gece regresyonu örnek proje web chrome demek
örnek proje'de login ol                      (model bağlıysa QA ajanı senaryo yazar)
örnek proje'nin giriş testlerini koş          (QA ajanı case alt kümesi seçer)
```

## Mevcut kapsam ve bilinçli eksikler

Mevcut ilk sürüm; chat tabanlı koşum başlatma, auth/roller, ayarların şifreli saklanması, TestRail/Farm HTTP iskeleti, web kuyruğu ve yerel rapor ekranını kapsar.

Henüz tam uygulanmış kabul edilmemesi gereken işler:

- Smart TV sürüşü
- Gerçek Farm + gerçek model ile uçtan uca mobil doğrulama (birim/entegrasyon testleri sahte Farm ve sahte Midscene SDK ile yapılır)
- TestRail'den case çekip YAML üretme
- koşum sırasında DB sorgusu
- imaj çekip güncelleme

## İlişkili dış proje

Graphify ile `garrytan/gstack` kod grafiği de bu projenin `graphify-out/graph.json` dosyasına birleştirilmiştir. Bu birleşik grafik mimari keşif içindir; gstack kaynak kodu bu repository'nin çalışma zamanı bağımlılığı değildir.

Graph çıktıları:

- `graphify-out/graph.html`: 5.000 düğüm üzerindeki grafikler için topluluk-özet görünümü
- `graphify-out/graph.json`: Mercury + gstack birleşik grafik verisi
- `graphify-out/GRAPH_REPORT.md`: topluluklar, bağlantılar ve Graphify analiz raporu

Birleşik grafiğin son tarama özeti yaklaşık 13.710 düğüm, 37.780 bağlantı ve 486 topluluktur. gstack API anahtarı olmadan kod-odaklı AST taramasıyla eklenmiştir; gstack dokümanlarının anlamsal çıkarımı bu çıktıda yoktur.
