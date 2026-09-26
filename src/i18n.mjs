// Server-side language support. Server code keeps writing its messages in Turkish (and the database keeps storing
// them that way); they are translated on the way out, in `send`, according to the `x-mercury-lang` request header.
// Keys are the Turkish messages; `{name}` placeholders capture the variable parts, which are translated again
// recursively, so composed messages ("Konfigürasyon hazır değil: a; b") come out fully translated. Anything without
// a translation is returned unchanged.

export const LANGS = ["tr", "en"];
export const DEFAULT_LANG = "tr";

export function requestLang(req) {
  const value = String(req?.headers?.["x-mercury-lang"] || "").trim().toLowerCase();
  return LANGS.includes(value) ? value : DEFAULT_LANG;
}

const plural = (count, one, many) => (Number(count) === 1 ? one : many);

const EN = {
  /* ---------- Auth & access ---------- */
  "E-posta veya şifre hatalı": "Incorrect e-mail or password",
  "Hesap admin onayı bekliyor": "Account is awaiting admin approval",
  "Geçerli e-posta ve en az 8 karakter şifre gerekli": "A valid e-mail and a password of at least 8 characters are required",
  "Bu e-posta kayıtlı": "This e-mail is already registered",
  "Giriş gerekli": "Login required",
  "Bu alan yalnız admin içindir": "This area is for admins only",
  "Bu hesap değiştirilemez": "This account cannot be changed",
  "Yok": "Not found",
  "Rapor yok": "Report not found",

  /* ---------- Skills ---------- */
  "Beceri kimliği küçük harf, rakam ve tire olmalı (2–60 karakter)": "Skill id must use lowercase letters, digits and hyphens (2–60 characters)",
  "Bu kimlikte özel beceri yok; yerleşik beceriler silinmez": "No custom skill with this id; built-in skills cannot be deleted",
  "Beceri metni boş": "Skill text is empty",
  "Beceri en fazla 20.000 karakter olabilir": "A skill can be at most 20,000 characters",
  "Ön bilgiye tetikleyici sözcükler (triggers: …) veya always: true yaz; yoksa beceri hiç seçilmez":
    "Add trigger words (triggers: …) or always: true to the front matter; otherwise the skill is never selected",

  /* ---------- Model & providers ---------- */
  "Sağlayıcı seç": "Choose a provider",
  "Sağlayıcı yok": "No provider",
  "Model seç": "Choose a model",
  "API anahtarı gerekli": "API key required",
  "Access key ve secret gerekli": "Access key and secret required",
  "Adres gerekli": "Address required",
  "Adres http veya https olmalı": "Address must be http or https",
  "Model listesi alınamadı": "Could not fetch the model list",
  "Model bağlı değil. Ayarlar → Model'den bağla.": "No model connected. Connect one under Settings → Model.",
  "Model API anahtarı yok.": "No model API key.",
  "Geçersiz Midscene model ailesi: {family}": "Invalid Midscene model family: {family}",
  "Amazon Bedrock IAM, Midscene'ın OpenAI uyumlu istemcisiyle çalışmaz. Bedrock API anahtarı veya OpenAI uyumlu bir sağlayıcı seç.":
    "Amazon Bedrock IAM does not work with Midscene's OpenAI-compatible client. Choose a Bedrock API key or an OpenAI-compatible provider.",
  "\"{name}\" için Midscene model ailesi belirlenemedi. Ayarlar → Model'den aileyi seç ya da ekranda öğe bulabilen bir model kullan (Qwen3-VL, Gemini, GPT-5, Doubao Seed, UI-TARS).":
    "Could not determine the Midscene model family for \"{name}\". Choose the family under Settings → Model or use a model that can locate elements on screen (Qwen3-VL, Gemini, GPT-5, Doubao Seed, UI-TARS).",
  "AutoGLM çok dilli (Zhipu)": "AutoGLM multilingual (Zhipu)",
  "Bulut": "Cloud",
  "Ağ geçidi": "Gateway",
  "Yerel": "Local",
  "OpenAI uyumlu": "OpenAI compatible",
  "{name} anahtarı": "{name} key",
  "Kaynak adresi ve anahtar. Model, deployment adıdır.": "Resource address and key. The model is the deployment name.",
  "Bedrock API anahtarı. Bölge adresin içinde.": "Bedrock API key. The region is part of the address.",
  "Access key, secret ve bölge. Modeller ListFoundationModels ile gelir.": "Access key, secret and region. Models come from ListFoundationModels.",
  "Mantle uç noktası ve Bedrock API anahtarı": "Mantle endpoint and Bedrock API key",
  "OpenAI uyumlu Vertex adresi": "OpenAI-compatible Vertex address",
  "Sonar modelleri. Liste kapalıysa model adını elle yaz.": "Sonar models. If listing is disabled, type the model name.",
  "DashScope uyumlu anahtar": "DashScope-compatible key",
  "Dashboard → Endpoints anahtarı. Model listesi GET /v1/models.": "Dashboard → Endpoints key. Model list via GET /v1/models.",
  "Proxy anahtarı ve adresi": "Proxy key and address",
  "Helicone üzerinden OpenAI": "OpenAI via Helicone",
  "Portkey sanal anahtarı": "Portkey virtual key",
  "Anahtar gerekmez. Modeller /api/tags ile gelir.": "No key needed. Models come from /api/tags.",
  "Yerel sunucu. Anahtar boş kalabilir.": "Local server. The key can be left empty.",
  "OpenAI uyumlu yerel sunucu": "OpenAI-compatible local server",
  "Kendi adresin. /v1 ile bitsin.": "Your own address. It should end with /v1.",

  /* ---------- QA agent ---------- */
  "model JSON karar döndürmedi": "the model did not return a JSON decision",
  "modelin kararı okunamadı (geçersiz JSON)": "could not read the model's decision (invalid JSON)",
  "model {seconds} sn içinde yanıt vermedi": "the model did not respond within {seconds} s",
  "modele ulaşılamadı ({error})": "could not reach the model ({error})",
  "model {status} döndü: {error}": "the model returned {status}: {error}",
  "model {status} döndü": "the model returned {status}",
  "adımda bilinmeyen değişken: {name}": "unknown variable in step: {name}",
  "desteklenmeyen adım: {action}": "unsupported step: {action}",
  "aiInput adımında alan tarifi yok": "the aiInput step has no field description",
  "{action} adımının metni boş": "the text of the {action} step is empty",
  "model boş yanıt verdi": "the model returned an empty reply",
  "model katalogda olmayan bir konfigürasyon seçti": "the model chose a configuration that is not in the catalog",
  "model konfigürasyonda olmayan case'ler seçti": "the model chose cases that are not in the configuration",
  "bilinmeyen karar: {intent}": "unknown decision: {intent}",
  "geçersiz adres: {url}": "invalid address: {url}",
  "{index}. case'te adım yok": "case {index} has no steps",
  "model senaryo adımı üretmedi": "the model produced no scenario steps",
  "(boş)": "(empty)",
  "{{saved.{name}}} önceki bir adımda okunmadı": "{{saved.{name}}} was not read in an earlier step",
  "{action} yalnız web'de kullanılabilir": "{action} can only be used on web",
  "aiPinch yalnız mobilde kullanılabilir": "aiPinch can only be used on mobile",
  "geçersiz tuş adı: {value}": "invalid key name: {value}",
  "{action} yönü geçersiz: {value}": "invalid {action} direction: {value}",
  "geçersiz kaydırma türü: {value}": "invalid scroll type: {value}",
  "{action} adımında öğe tarifi yok": "the {action} step has no element description",
  "{action} adımında ne okunacağı yok": "the {action} step does not say what to read",
  "geçersiz değişken adı: {value}": "invalid variable name: {value}",
  "Senaryoyu nerede koşayım? Bir adres, bir paket kimliği ya da kayıtlı bir proje adı yaz.":
    "Where should I run the scenario? Write an address, a package id or a saved project name.",
  "Senaryo koşulmadı: {kind} bilinmiyor. Paket kimliğini yaz (örn. com.firma.app) ya da uygulamayı bu kimlikle bir proje konfigürasyonu olarak kaydet.":
    "The scenario did not run: the {kind} is unknown. Write the package id (e.g. com.company.app) or save the app with this id as a project configuration.",

  /* ---------- Chat ---------- */
  "Bir cümle yaz.": "Write a sentence.",
  "Bunu belleğe yazdım. Sonraki cümlelerde kullanacağım.": "Saved to memory. I will use it in upcoming messages.",
  "Ayarları yalnız admin değiştirebilir.": "Only an admin can change settings.",
  "Ayar biçimi: ayar testrail host https://...": "Setting format: settings testrail host https://...",
  "{label} güncellendi.": "{label} updated.",
  "QA ajanı bu cümleyi planlayamadı ({error}); cümleyi kurallarla yorumladım.": "The QA agent could not plan this sentence ({error}); I interpreted it with rules.",
  "Koşum için proje ve konfigürasyonu söyle (örn. <proje adı> web koş) ya da bir senaryo yaz (örn. https://example.com'u aç, More information'a tıkla, IANA yazdığını doğrula).":
    "Name the project and configuration to run (e.g. <project name> web run) or describe a scenario (e.g. open https://example.com, click More information, verify it says IANA).",
  "Bu cümle kayıtlı bir proje veya konfigürasyonla eşleşmedi.": "This sentence did not match a saved project or configuration.",
  "{count} koşum, konfigürasyon ön kontrolü geçemedi. Eksikleri tamamladıktan sonra yeniden başlat.": (p) =>
    `${p.count} ${plural(p.count, "run", "runs")} did not pass the configuration preflight check. Fix what is missing and start again.`,
  "Yürütme planı hazırlandı ve yeni koşum açıldı. Adımları aşağıda canlı izleyebilirsin.": "The execution plan is ready and a new run was opened. You can follow the steps live below.",
  "Senaryoyu nerede koşayım? Bir adres (örn. https://example.com), bir paket kimliği (com.firma.app) ya da kayıtlı bir proje adı yaz.":
    "Where should I run the scenario? Write an address (e.g. https://example.com), a package id (com.company.app) or a saved project name.",
  "\"{client}\" projesinde hangi konfigürasyonda koşayım? {list}": "Which configuration of the \"{client}\" project should I run? {list}",
  "\"{client}\" projesinde {platform} için etkin bir konfigürasyon yok.": "The \"{client}\" project has no enabled configuration for {platform}.",
  "\"{client}\" projesinde etkin bir konfigürasyon yok.": "The \"{client}\" project has no enabled configuration.",
  "\"{name}\" konfigürasyonunun test hesabı kaynağı yok, giriş için kullanıcı alamıyorum. Kullanıcı adı ve şifreyi mesajda yaz ya da konfigürasyona bir hesap kaynağı bağla.":
    "The \"{name}\" configuration has no test account source, so I cannot get a user to log in with. Write the username and password in your message or attach an account source to the configuration.",
  "Bu hedefin test hesabı kaynağı yok, giriş için kullanıcı alamıyorum. Kullanıcı adı ve şifreyi mesajda yaz ya da konfigürasyona bir hesap kaynağı bağla.":
    "This target has no test account source, so I cannot get a user to log in with. Write the username and password in your message or attach an account source to the configuration.",
  "Senaryo ön kontrolü geçemedi. Eksikleri tamamladıktan sonra yeniden yaz.": "The scenario did not pass the preflight check. Fix what is missing and send it again.",
  "Senaryoyu {steps} adıma böldüm ve koşumu başlattım ({where}). Adımları aşağıda canlı izleyebilirsin.": (p) =>
    `I split the scenario into ${p.steps} ${plural(p.steps, "step", "steps")} and started the run (${p.where}). You can follow the steps live below.`,
  "{cases} test case ({steps} adım) hazırladım ve koşumu başlattım ({where}). Adımları aşağıda canlı izleyebilirsin.": (p) =>
    `I prepared ${p.cases} test ${plural(p.cases, "case", "cases")} (${p.steps} ${plural(p.steps, "step", "steps")}) and started the run (${p.where}). You can follow the steps live below.`,
  "{index}. {title} ({steps} adım)": (p) => `${p.index}. ${p.title} (${p.steps} ${plural(p.steps, "step", "steps")})`,
  "{count} case": (p) => `${p.count} ${plural(p.count, "case", "cases")}`,

  /* ---------- Runs & scenarios ---------- */
  "Anlık senaryo": "Ad-hoc scenario",
  "başlangıç adresi yok": "no launch URL",
  "paket kimliği yok": "no package id",
  "TestRail'e yazılmaz, sonuç yerel raporda": "Not written to TestRail; results are in the local report",
  "Senaryo koşulamıyor: {issues}": "Scenario cannot run: {issues}",
  "Konfigürasyon hazır değil: {issues}": "Configuration is not ready: {issues}",
  "Cihaz daraltıldı: {hint}": "Device narrowed to: {hint}",
  "Cihaz: {serials}": "Device: {serials}",
  "Farm cihaz bağlantısını açamadı ({attempts} deneme): {error}": "Farm could not open the device connection ({attempts} attempts): {error}",
  "Zamanlanmış koşum": "Scheduled run",
  "TestRail run açılamadı ({error}); sonuçlar yalnız yerel raporda": "Could not open a TestRail run ({error}); results are only in the local report",
  "\"{client}\" projesinin TestRail projesi yok; konfigürasyonda TestRail suite'i seç": "The \"{client}\" project has no TestRail project; choose a TestRail suite in the configuration",
  "TestRail projesi seçili değil; Ayarlar'da varsayılan TestRail projesini seç": "No TestRail project selected; choose the default TestRail project in Settings",
  "Koşum yok": "Run not found",
  "Yalnız kendi başlattığın koşumları silebilirsin": "You can only delete runs you started",
  "Koşum #{id} tamamlanmadan silinemez": "Run #{id} cannot be deleted until it finishes",
  "Konuşma bulunamadı": "Conversation not found",
  "Sunucu yeniden başladı; koşum yarıda kaldı": "The server restarted; the run was interrupted",
  "Smart TV için yürütücü yok": "No runner for Smart TV",
  "Bu konfigürasyonun case kapsamında YAML case yok": "This configuration's case scope has no YAML cases",
  "{error} Midscene çalıştırılmadı.": "{error} Midscene was not run.",
  "Midscene koşuyor ({family})": "Midscene running ({family})",
  "{count} tarayıcı, {cases} case": (p) => `${p.count} ${plural(p.count, "browser", "browsers")}, ${p.cases} ${plural(p.cases, "case", "cases")}`,
  "{count} cihaz, {cases} case": (p) => `${p.count} ${plural(p.count, "device", "devices")}, ${p.cases} ${plural(p.cases, "case", "cases")}`,
  "Hat {lane}": "Lane {lane}",
  "{failed}/{total} case başarısız. {detail}": "{failed}/{total} cases failed. {detail}",
  "{count} case geçti": (p) => `${p.count} ${plural(p.count, "case", "cases")} passed`,
  "{count} paralel hat": (p) => `${p.count} parallel ${plural(p.count, "lane", "lanes")}`,
  "{message} TestRail sonucu yazılamadı: {error}": "{message} Could not write the TestRail result: {error}",
  "TestRail sonucu yazılamadı: {error}": "Could not write the TestRail result: {error}",
  "Opsiyonel test hesabı alınamadı: {reason}": "Could not get the optional test account: {reason}",
  "Konfigürasyonun hesap kaynağı bulunamadı": "The configuration's account source was not found",
  "Zorunlu test hesabı alınamadı": "Could not get the required test account",
  "Boş cihaz bekleniyor": "Waiting for a free device",
  "{minutes} dk içinde boş cihaz bulunamadı: {error}": "No free device found within {minutes} min: {error}",
  "Farm senaryo sonucu yazılamadı: {error}": "Could not write the scenario result to Farm: {error}",
  "Farm cihazı bırakılamadı: {error}": "Could not release the Farm device: {error}",

  /* ---------- Midscene steps ---------- */
  "zaman aşımı": "timeout",
  "Değişken çözülemedi: {name}": "Could not resolve variable: {name}",
  "Sayı bekleniyordu: {value}": "Expected a number: {value}",
  "{method} bu platformda desteklenmiyor": "{method} is not supported on this platform",
  "Beklenen \"{expected}\", ekranda okunan \"{shown}\"": "Expected \"{expected}\", read on screen \"{shown}\"",
  "Açılış adresine ulaşılamadı ({code}): {target}": "Could not reach the launch address ({code}): {target}",
  "Geçersiz kaydırma yönü: {value}": "Invalid scroll direction: {value}",
  "Geçersiz kaydırma türü: {value}": "Invalid scroll type: {value}",
  "aiKeyboardPress için tuş adı (keyName) gerekli, örn. Enter": "aiKeyboardPress needs a key name (keyName), e.g. Enter",
  "aiPinch yönü in veya out olmalı: {value}": "aiPinch direction must be in or out: {value}",
  "Desteklenmeyen adım: {action}": "Unsupported step: {action}",
  "Cihaz oturumu açılamadı: {error}": "Could not open a device session: {error}",
  "Önceki adım başarısız olduğu için atlandı": "Skipped because a previous step failed",
  "Adım {seconds} sn içinde bitmedi (zaman aşımı)": "The step did not finish within {seconds} s (timeout)",
  "{attempt}. denemede geçti": "Passed on attempt {attempt}",
  "ilk deneme: {error}": "first attempt: {error}",
  "{attempts} denemede de başarısız: {error}": "Failed in all {attempts} attempts: {error}",
  "Yeniden deneniyor: {error}": "Retrying: {error}",
  "Ekran denetleniyor: {error}": "Checking the screen: {error}",
  "Ekrandaki engel kapatıldı": "Closed an interruption on the screen",
  "önceki adım yeniden yapıldı": "redid the previous step",
  "yeniden deneniyor": "retrying",
  "Tüm adımlar geçti": "All steps passed",
  "Midscene kurulu değil ({error}). Sunucuda `npm run setup` çalıştır.": "Midscene is not installed ({error}). Run `npm run setup` on the server.",
  "Chromium kurulu değil. Sunucuda `npm run setup` çalıştır.": "Chromium is not installed. Run `npm run setup` on the server.",
  "Midscene {platform} paketi kurulu değil ({error}). Sunucuda `npm run setup` çalıştır.": "The Midscene {platform} package is not installed ({error}). Run `npm run setup` on the server.",

  /* ---------- Devices, ADB & Farm ---------- */
  "ADB kurulu değil. Sunucuda `npm run setup` çalıştır.": "ADB is not installed. Run `npm run setup` on the server.",
  "adb connect {target} başarısız: {output}": "adb connect {target} failed: {output}",
  "Cihaz bu sunucunun ADB anahtarını reddetti. Ayarlar → Mercury Farm → 'Bağlantıyı dene' anahtarı Farm'a kaydeder.":
    "The device rejected this server's ADB key. Settings → Mercury Farm → 'Test connection' registers the key with Farm.",
  "{target} ADB üzerinden hazır olmadı": "{target} did not become ready over ADB",
  "Farm ayarı eksik": "Farm settings missing",
  "Farm {amount} cihaz istedi, {count} döndü": "Farm was asked for {amount} devices and returned {count}",
  "Farm'da bu {platform} UDID bulunamadı: {list}": "These {platform} UDIDs were not found in Farm: {list}",
  "Farm'da \"{filter}\" filtresine uyan {platform} cihaz tanımlı değil": "Farm has no {platform} device matching the \"{filter}\" filter",
  "{amount} boş {platform} cihaz gerekiyor, havuzda {count} boş cihaz var": (p) =>
    `${p.amount} free ${p.platform} ${plural(p.amount, "device is", "devices are")} needed; the pool has ${p.count} free`,
  "Farm cihaz bağlantı adresi döndürmedi": "Farm did not return a device connection address",

  /* ---------- TestRail ---------- */
  "TestRail ayarı eksik": "TestRail settings missing",
  "TestRail projesi seçilmedi": "No TestRail project selected",
  "TestRail'e ulaşılamadı ({reason})": "Could not reach TestRail ({reason})",
  "TestRail yanıtı JSON değil": "TestRail response is not JSON",
  "TestRail'de #{id} numaralı açık proje yok": "TestRail has no open project #{id}",
  "TestRail projesi #{id} içinde açık suite yok": "TestRail project #{id} has no open suite",

  /* ---------- Jira & Confluence ---------- */
  "Jira'ya ulaşılamadı ({reason})": "Could not reach Jira ({reason})",
  "Confluence'a ulaşılamadı ({reason})": "Could not reach Confluence ({reason})",
  "Jira kimlik bilgilerini reddetti ({status})": "Jira rejected the credentials ({status})",
  "Confluence kimlik bilgilerini reddetti ({status})": "Confluence rejected the credentials ({status})",
  "Ayarlar → Jira & Confluence": "Settings → Jira & Confluence",
  "Jira'da bu kayıt yok ya da hesabın erişimi yok (404)": "Jira has no such issue or the account cannot access it (404)",
  "Confluence'ta bu sayfa yok ya da hesabın erişimi yok (404)": "Confluence has no such page or the account cannot access it (404)",
  "Jira yanıtı JSON değil": "Jira response is not JSON",
  "Confluence yanıtı JSON değil": "Confluence response is not JSON",
  "Jira ayarı eksik": "Jira settings missing",
  "Jira ayarı eksik (Ayarlar → Jira & Confluence)": "Jira settings missing (Settings → Jira & Confluence)",
  "Confluence ayarı eksik (Ayarlar → Jira & Confluence)": "Confluence settings missing (Settings → Jira & Confluence)",
  "Confluence sayfası {id}": "Confluence page {id}",
  "Jira/Confluence kaydı okunamadı:": "Could not read the Jira/Confluence item:",
  "Okunamayan kayıtlar": "Items that could not be read",
  "{keys} okundu, ama test case çıkarmak için bir model bağlı olmalı (Ayarlar → Model).": "{keys} was read, but a model must be connected to design test cases (Settings → Model).",

  /* ---------- Configurations & planning ---------- */
  "Proje seç veya yeni proje adı yaz": "Choose a project or enter a new project name",
  "\"{name}\" adlı proje başka bir TestRail suite'ine ({suite}) bağlı; farklı bir ad seç": "The project \"{name}\" is linked to another TestRail suite ({suite}); choose a different name",
  "Hesap kaynağı bu projeye ait değil ve ortak değil": "The account source neither belongs to this project nor is shared",
  "Bu projede \"{name}\" adlı konfigürasyon zaten var": "A configuration named \"{name}\" already exists in this project",
  "\"{alias}\" takma adı \"{owner}\" konfigürasyonunda kullanılıyor; chat hangisini koşacağını ayıramaz":
    "The alias \"{alias}\" is used by the \"{owner}\" configuration; chat could not tell which one to run",
  "Konfigürasyon bulunamadı": "Configuration not found",
  "Konfigürasyon #{id} numaralı koşum tamamlanmadan silinemez": "The configuration cannot be deleted until run #{id} finishes",
  "Konfigürasyon devre dışı": "Configuration is disabled",
  "Case kapsamıyla eşleşen YAML case yok": "No YAML case matches the case scope",
  "Web başlangıç adresi eksik": "Web launch URL missing",
  "Zorunlu hesap kaynağı seçilmemiş": "Required account source not selected",
  "Seçili hesap kaynağı bulunamadı": "Selected account source not found",
  "\"{name}\" hesap kaynağında {issue}": "Account source \"{name}\": {issue}",
  "eksik ayar var": "settings are incomplete",
  "Midscene modeli hazır değil": "Midscene model is not ready",
  "Mercury Farm bağlantısı hazır değil": "Mercury Farm connection is not ready",
  "Bu sunucuda ADB kurulu değil (npm run setup)": "ADB is not installed on this server (npm run setup)",
  "Android paket kimliği (applicationId) eksik": "Android package id (applicationId) missing",
  "iOS bundle id eksik": "iOS bundle id missing",
  "Paralel koşum en fazla {max} olabilir": "Parallel runs can be at most {max}",
  "{parallel} paralel koşum için {needed} UDID gerekir, {count} girildi": "{parallel} parallel runs need {needed} UDIDs; {count} entered",
  "Uygulama dosyası adresi yok; cihazda kurulu sürüm açılır": "No app file address; the version installed on the device is opened",
  "{count} case var; {lanes} paralel hat kullanılır": (p) => `${p.count} ${plural(p.count, "case", "cases")}; ${p.lanes} parallel ${plural(p.lanes, "lane is", "lanes are")} used`,
  "Bu sunucuda aynı anda en fazla {limit} tarayıcı açılır; bu koşum en fazla {lanes} hatla koşar":
    "This server opens at most {limit} browsers at once; this run uses at most {lanes} lanes",
  "Smart TV yürütücüsü henüz bağlı değil": "Smart TV runner is not connected yet",
  "Konfigürasyon adı zorunlu": "Configuration name is required",
  "Geçerli platform seç": "Choose a valid platform",
  "Paralel koşum 1–{max} arasında olmalı": "Parallel runs must be between 1 and {max}",
  "Boş cihaz bekleme süresi 1–1440 dakika olmalı": "Free-device wait time must be 1–1440 minutes",
  "Zamanlama sıklığı 1–{max} gün olmalı": "Schedule frequency must be 1–{max} days",
  "Zamanlama saati SS:DD biçiminde olmalı (örn. 09:00)": "Schedule time must be HH:MM (e.g. 09:00)",
  "Zamanlama başlangıç tarihi YYYY-AA-GG biçiminde olmalı": "Schedule start date must be YYYY-MM-DD",
  "Geçersiz saat dilimi: {zone}": "Invalid time zone: {zone}",

  /* ---------- Test account sources ---------- */
  "{label} geçerli JSON değil": "{label} is not valid JSON",
  "{label} bir JSON nesnesi olmalı": "{label} must be a JSON object",
  "Kaynak tanımı": "Source definition",
  "Giriş isteği gövdesi": "Login request body",
  "Kullanıldı isteği gövdesi": "Mark-used request body",
  "Ek alanlar": "Extra fields",
  "Hesap listesi parametreleri": "Account list parameters",
  "{label}: servise ulaşılamadı ({reason})": "{label}: could not reach the service ({reason})",
  "{label}: yanıt JSON değil": "{label}: response is not JSON",
  "{label}: HTTP {status}": "{label}: HTTP {status}",
  "Servis girişi": "Service login",
  "Hesap listesi": "Account list",
  "Kullanıldı işareti": "Mark as used",
  "Servis girişi: yanıtta \"{path}\" alanında token yok": "Service login: no token in the \"{path}\" field of the response",
  "Listedeki uygun hesapların hepsi başka koşumlarda": "All matching accounts in the list are in use by other runs",
  "Uygun test hesabı yok": "No matching test account",
  "Test hesabı kilitlenemedi: {error}": "Could not lock the test account: {error}",
  "Kaynak adı zorunlu": "Source name is required",
  "Geçersiz proje": "Invalid project",
  "Servis adresi http:// veya https:// ile başlamalı": "Service address must start with http:// or https://",
  "Hesap listesi yolu": "Account list path",
  "Giriş yolu": "Login path",
  "Kullanıldı isteği yolu": "Mark-used request path",
  "{label} / ile başlamalı": "{label} must start with /",
  "{line}. satırda kullanıcı adı/e-posta eksik": "Username/e-mail missing on line {line}",
  "{email} listede iki kez var": "{email} appears twice in the list",
  "listede hesap yok": "no accounts in the list",
  "Listede hesap yok": "No accounts in the list",
  "kullanılabilir hesap kalmadı": "no available accounts left",
  "Kullanılabilir hesap kalmadı": "No available accounts left",
  "servis adresi eksik": "service address missing",
  "Servis adresi eksik": "Service address missing",
  "hesap listesi yolu eksik": "account list path missing",
  "giriş yolu eksik": "login path missing",
  "servis giriş bilgileri eksik": "service credentials missing",
  "API anahtarı eksik": "API key missing",
  "Listedeki tüm hesaplar şu an başka koşumlarda": "All accounts in the list are currently in use by other runs",
  "{email} için şifre gir": "Enter a password for {email}",
  "Proje bulunamadı": "Project not found",
  "Bu kapsamda \"{name}\" adlı kaynak zaten var": "A source named \"{name}\" already exists in this scope",
  "Başka projelerdeki konfigürasyonlar bu kaynağı kullanıyor: {list}": "Configurations in other projects use this source: {list}",
  "Kaynak bulunamadı": "Source not found",
  "Önce bu konfigürasyonlardan kaynağı kaldır: {list}": "First remove the source from these configurations: {list}",
  "Şifresi eksik hesap: {list}": "Accounts missing a password: {list}",
  "Servisten bir test hesabı okundu (kilitlenmedi)": "Read one test account from the service (not locked)",
  "alındı": "received",
  "boş": "empty",
  "REST servis · token ile giriş": "REST service · token login",
  "REST servis · API anahtarı": "REST service · API key",
  "REST servis · Basic auth": "REST service · Basic auth",
  "REST servis · kimlik doğrulama yok": "REST service · no authentication",

  /* ---------- Built-in QA skills (skills/*.md front matter) ---------- */
  "QA çekirdeği": "QA core",
  "Kıdemli QA bakışı: isteği anlama, kayıtlı case mi yeni senaryo mu, test tasarımı, görsel ajan için adım yazımı, güvenlik.":
    "A senior QA view: understanding the request, saved case or new scenario, test design, writing steps for the vision agent, safety.",
  "Giriş ve oturum": "Login and session",
  "Web ve mobilde giriş, çıkış, oturum ve kimlik bilgisi kontrolleri.": "Login, logout, session and credential checks on web and mobile.",
  "Sepet, ödeme ve sipariş": "Cart, checkout and orders",
  "Ürün detayı, sepet, adet, kupon, ödeme adımları ve sipariş; güvenli durma noktalarıyla.": "Product details, cart, quantity, coupons, checkout steps and orders, with safe stopping points.",
  "Hata analizi ve raporlama": "Failure analysis and reporting",
  "Düşen koşumu açıklama, kök neden sınıfı, önem derecesi, bug raporu ve sonraki koşum önerisi.": "Explaining a failed run, root-cause class, severity, bug report and a suggestion for the next run.",
  "Formlar ve doğrulama": "Forms and validation",
  "İletişim, profil, adres, ayarlar gibi her veri giriş formu; doğrulama ve sınır değer kontrolleri.": "Any data-entry form such as contact, profile, address or settings; validation and boundary-value checks.",
  "Video ve medya oynatma": "Video and media playback",
  "Video/ses oynatıcı, canlı yayın, içerik sayfası, oynatma kontrolleri, altyazı ve reklam.": "Video/audio player, live streams, content pages, playback controls, subtitles and ads.",
  "Mobil uygulama": "Mobile app",
  "Android ve iOS: izinler, tanıtım ekranları, sekme çubuğu, geri, klavye, soğuk açılış.": "Android and iOS: permissions, onboarding screens, tab bar, back, keyboard, cold start.",
  "Arama, filtre ve listeleme": "Search, filters and listings",
  "Arama kutusu, öneriler, sonuç listesi, filtre, sıralama ve sayfalama.": "Search box, suggestions, result list, filters, sorting and pagination.",
  "Kayıt ve şifre sıfırlama": "Sign-up and password reset",
  "Üye olma, kayıt formları, doğrulama ekranları ve şifremi unuttum akışı.": "Signing up, registration forms, verification screens and the forgot-password flow.",
  "Smoke, navigasyon ve keşif": "Smoke, navigation and exploration",
  "Hızlı sağlık kontrolü, ana menüler, sayfa açılışları, bozuk durumlar ve keşif testi.": "Quick health check, main menus, page loads, broken states and exploratory testing.",
  "Görsel, içerik ve erişilebilirlik": "Visuals, content and accessibility",
  "Görsel düzen, içerik kalitesi, responsive görünüm ve ekran görüntüsünden erişilebilirlik.": "Visual layout, content quality, responsive view and accessibility from screenshots.",
};

// Response fields that carry server-written text. User data (names, case titles, step texts, the user's own chat
// messages) is left alone; `text` is only translated on assistant chat messages.
const TRANSLATABLE = new Set([
  "error", "message", "reply", "issue", "issues", "warning", "warnings", "detail", "reason", "note", "testrail_error",
  "hint", "group", "label", "client_name", "password",
]);

// Tried in order when no whole-string translation exists; newlines always split first.
const SEPARATORS = [" — ", " · ", "; ", ": "];

// Placeholders with these names only ever hold numbers; matching them as such keeps a template from swallowing a
// longer composed message ("1/3 case başarısız. Hat 1: … 2 denemede de başarısız: …").
const NUMERIC = new Set([
  "count", "attempt", "attempts", "failed", "total", "index", "seconds", "minutes", "steps", "cases", "lanes", "lane",
  "line", "amount", "id", "status", "max", "limit", "parallel", "needed",
]);

const exact = new Map();
const templates = [];
for (const [key, value] of Object.entries(EN)) {
  if (!/\{\w+\}/.test(key)) {
    exact.set(key, value);
    continue;
  }
  const names = [];
  const pattern = key.split(/(\{\w+\})/).map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(name);
    return NUMERIC.has(name) ? `(?<${name}>\\d+)` : `(?<${name}>.*?)`;
  }).join("");
  templates.push({ regex: new RegExp(`^${pattern}$`), value, weight: key.replace(/\{\w+\}/g, "").length });
}
// The most specific template (the most literal text) wins.
templates.sort((a, b) => b.weight - a.weight);

function fill(value, params) {
  return typeof value === "function" ? value(params) : value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? params[name] : match));
}

// Untranslated Turkish left in a candidate; the candidate with the least wins.
const TURKISH_LETTER = /[çğıöşüÇĞİÖŞÜ]/g;
const residue = (value) => (value.match(TURKISH_LETTER) || []).length;

const cache = new Map();

function translate(text, depth) {
  if (depth > 8 || !text.trim()) return text;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  let value;
  if (text.includes("\n")) {
    value = text.split("\n").map((line) => translate(line, depth + 1)).join("\n");
  } else {
    const core = text.trim();
    const start = text.slice(0, text.indexOf(core));
    const end = text.slice(start.length + core.length);
    value = text;
    if (exact.has(core)) {
      value = `${start}${fill(exact.get(core), {})}${end}`;
    } else {
      // A composed message may fit several templates or splits ("Hat 2: … · Farm cihazı bırakılamadı: HTTP 500");
      // each is tried and the one leaving the least Turkish behind is kept (earlier = more specific on ties).
      const candidates = [];
      for (const template of templates) {
        const match = template.regex.exec(core);
        if (!match) continue;
        const params = {};
        for (const [name, part] of Object.entries(match.groups || {})) params[name] = translate(part, depth + 1);
        candidates.push(fill(template.value, params));
      }
      for (const separator of SEPARATORS) {
        const at = core.indexOf(separator);
        if (at < 0) continue;
        // ": " only splits once (a label and its message); the others split a list.
        const parts = separator === ": " ? [core.slice(0, at), core.slice(at + separator.length)] : core.split(separator);
        const translated = parts.map((part) => translate(part, depth + 1));
        if (translated.some((part, index) => part !== parts[index])) candidates.push(translated.join(separator));
      }
      let best = null;
      for (const candidate of candidates) if (best === null || residue(candidate) < residue(best)) best = candidate;
      if (best !== null) value = `${start}${best}${end}`;
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(text, value);
  return value;
}

export function localize(text, lang = DEFAULT_LANG) {
  if (lang !== "en" || typeof text !== "string" || !text) return text;
  return translate(text, 0);
}

// Translates the server-written fields of a JSON response body; returns the body itself for Turkish.
export function localizeBody(body, lang = DEFAULT_LANG) {
  if (lang !== "en") return body;
  const walk = (value, key, owner) => {
    if (typeof value === "string") {
      const translatable = TRANSLATABLE.has(key) || (key === "text" && owner?.role === "assistant");
      return translatable ? localize(value, lang) : value;
    }
    if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? walk(item, key, owner) : walk(item, "", null)));
    if (value && typeof value === "object") {
      const out = {};
      for (const [name, item] of Object.entries(value)) out[name] = walk(item, name, value);
      return out;
    }
    return value;
  };
  return walk(body, "", null);
}

// A line for the QA agent's system prompt, so its reply and scenario use the tester's interface language.
export function agentLanguageNote(lang = DEFAULT_LANG) {
  return lang === "en"
    ? "The tester is using the English interface: write reply, title and case titles in English unless their message is clearly in another language."
    : "The tester is using the Turkish interface: write reply, title and case titles in Turkish unless their message is clearly in another language.";
}
