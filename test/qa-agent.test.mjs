import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlainRunCommand } from "../src/agent.mjs";
import { QA_AGENT_MARKER, askQaAgent, conversationContext, normalizeDecision, parseDecision, qaCatalog, usesAccount } from "../src/qa-agent.mjs";
import { caseKey, scopeCases } from "../src/planning.mjs";

const clients = [{ id: 1, name: "Örnek Proje" }];
const configs = [
  { id: 11, client_id: 1, client_name: "Örnek Proje", name: "Web (Chrome)", aliases: '["web chrome","web"]', platform: "web", enabled: 1, launch_url: "https://example.com", account_source_id: 4, suite_id: "7", case_ids: "[]", case_tags: "[]" },
  { id: 12, client_id: 1, client_name: "Örnek Proje", name: "Android", aliases: '["android"]', platform: "android", enabled: 1, package_id: "com.firma.uygulama", account_source_id: null, case_ids: "[]", case_tags: "[]" },
  { id: 13, client_id: 1, client_name: "Örnek Proje", name: "Eski", aliases: "[]", platform: "web", enabled: 0, case_ids: "[]", case_tags: "[]" },
];
const cases = [
  { caseId: "101", title: "C101 Geçerli giriş", client: "Örnek Proje", tags: ["giris"], steps: [] },
  { caseId: "102", title: "C102 Hatalı şifre reddedilir", client: "Örnek Proje", tags: ["giris"], steps: [] },
  { caseId: "", title: "Kimliksiz case", client: "Örnek Proje", tags: [], steps: [] },
];
const catalog = qaCatalog(configs, cases);

test("yalnız kayıtlı adlardan oluşan koşum komutu doğrudan koşar; fazlası QA ajanına gider", () => {
  for (const text of ["Örnek Proje web chrome koş", "örnek proje web'de koş", "Örnek Proje android, Pixel 8 koş", "örnek proje web koş lütfen"]) {
    assert.equal(isPlainRunCommand(text, configs, clients), true, text);
  }
  for (const text of ["Örnek Proje web giriş testlerini koş", "Örnek Proje web'de login ol ve koş", "Örnek Proje'nin hatalı şifre testini koş", "login ol", "selam"]) {
    assert.equal(isPlainRunCommand(text, configs, clients), false, text);
  }
  assert.equal(isPlainRunCommand("gece regresyonu koş", configs, clients, [{ match_phrase: "gece regresyonu", config_id: 11 }]), true, "hatırlanan ifade de ad sayılır");
});

test("katalog yalnız etkin konfigürasyonları, case'lerini ve hesap olup olmadığını taşır", () => {
  assert.deepEqual(catalog.map((item) => item.id), [11, 12]);
  assert.deepEqual(catalog[0].cases.map((item) => item.key), ["101", "102", "Kimliksiz case"]);
  assert.equal(catalog[0].testAccount, true);
  assert.equal(catalog[1].testAccount, false);
  assert.equal(catalog[1].target, "com.firma.uygulama");
  assert.deepEqual(scopeCases(cases, ["102", "Kimliksiz case"]).map(caseKey), ["102", "Kimliksiz case"]);
  assert.equal(scopeCases(cases, "[]").length, 3, "boş kapsam hepsini koşar");
});

test("model kararı JSON olarak çitle veya düşünce bloğuyla gelse de okunur", () => {
  assert.deepEqual(parseDecision('<think>plan</think>```json\n{"intent":"reply","reply":"Merhaba"}\n```'), { intent: "reply", reply: "Merhaba" });
  assert.deepEqual(parseDecision('Tamam: {"intent":"reply","reply":"x"}'), { intent: "reply", reply: "x" });
  assert.throws(() => parseDecision("Merhaba"), /JSON/);
});

test("run_suite kararı katalogla doğrulanır; uydurma konfigürasyon ve case reddedilir", () => {
  assert.deepEqual(normalizeDecision({ intent: "run_suite", reply: "ok", run: { configIds: [11, 99], caseKeys: ["102", "999"] } }, catalog).runs, [{ configId: 11, caseKeys: ["102"] }]);
  assert.deepEqual(normalizeDecision({ intent: "run_suite", run: { configIds: [11] } }, catalog).runs, [{ configId: 11, caseKeys: [] }]);
  assert.throws(() => normalizeDecision({ intent: "run_suite", run: { configIds: [13] } }, catalog), /katalogda olmayan/, "devre dışı konfigürasyon seçilemez");
  assert.throws(() => normalizeDecision({ intent: "run_suite", run: { configIds: [11], caseKeys: ["999"] } }, catalog), /olmayan case/);
  assert.throws(() => normalizeDecision({ intent: "sil" }, catalog), /bilinmeyen karar/);
});

test("hedefsiz mobil senaryo 'başlatıyorum' demez; eksik paket kimliğini sorar", () => {
  const scenario = { platform: "ios", cases: [{ title: "Hatalı giriş", steps: [{ action: "aiAssert", text: "Hata görünüyor" }] }] };
  const ios = normalizeDecision({ intent: "scenario", reply: "Testi başlatıyorum.", scenario }, catalog);
  assert.equal(ios.intent, "reply");
  assert.match(ios.reply, /^Senaryo koşulmadı: iOS bundle id bilinmiyor/);
  assert.match(normalizeDecision({ intent: "scenario", reply: "x", scenario: { ...scenario, platform: "android" } }, catalog).reply, /Android applicationId bilinmiyor/);
  assert.match(normalizeDecision({ intent: "scenario", reply: "x", scenario: { ...scenario, platform: "" } }, catalog).reply, /nerede koşayım/);
  const settingsApp = normalizeDecision({ intent: "scenario", reply: "x", scenario: { ...scenario, platform: "", packageId: "com.apple.Preferences" } }, catalog);
  assert.deepEqual([settingsApp.intent, settingsApp.target.platform], ["scenario", "ios"], "com.apple.* kimliği iOS'ta açılır");
});

test("senaryo kararı çalıştırılabilir adımlara çevrilir; açılış adımını sunucu ekler", () => {
  const decision = normalizeDecision({
    intent: "scenario",
    reply: "Giriş yapacağım",
    scenario: {
      configId: 11,
      cases: [{
        title: "Giriş",
        steps: [
          { action: "launch", text: "https://kotu.example" },
          { action: "aiAct", text: "Giriş formu görünmüyorsa Giriş bağlantısına tıkla" },
          { action: "aiInput", locate: "E-posta alanı", value: "{{account.email}}" },
          { action: "type", locate: "Şifre alanı", value: "{{account.password}}" },
          { action: "click", text: "Giriş yap butonu" },
          { action: "sleep", ms: 999999 },
          { action: "back" },
          { action: "assert", text: "Hoş geldin mesajı görünür" },
        ],
      }],
    },
  }, catalog);
  assert.equal(decision.target.platform, "web");
  assert.equal(decision.target.config.id, 11);
  assert.deepEqual(decision.cases[0].steps.map((step) => [step.action, step.text]), [
    ["launch", "{{launchUrl}}"],
    ["aiAct", "Giriş formu görünmüyorsa Giriş bağlantısına tıkla"],
    ["aiInput", "E-posta alanı ← {{account.email}}"],
    ["aiInput", "Şifre alanı ← {{account.password}}"],
    ["aiTap", "Giriş yap butonu"],
    ["sleep", "60000"],
    ["aiAssert", "Hoş geldin mesajı görünür"],
  ], "modelin açılış adresi ve web'de 'back' atlanır, bekleme sınırlanır");
  assert.deepEqual(decision.cases[0].steps[3].args, { locate: "Şifre alanı", value: "{{account.password}}" });
  assert.equal(usesAccount(decision.cases), true);
});

test("senaryo hedefi: adres web'dir, paket mobildir, hedef yoksa sorulur; uydurma adım ve değişken reddedilir", () => {
  const scenario = (fields, steps = [{ action: "aiAssert", text: "Sayfa açıldı" }]) => normalizeDecision({ intent: "scenario", scenario: { ...fields, cases: [{ title: "t", steps }] } }, catalog);
  const byUrl = scenario({ url: "example.org/giris", configId: 12 });
  assert.deepEqual([byUrl.target.platform, byUrl.target.launchUrl, byUrl.target.config], ["web", "https://example.org/giris", null], "farklı platformdaki konfigürasyon ödünç alınmaz");
  assert.throws(() => scenario({ url: "javascript:alert(1)" }), /geçersiz adres/);
  const byPackage = scenario({ packageId: "com.firma.uygulama", platform: "ios" });
  assert.deepEqual([byPackage.target.platform, byPackage.target.packageId], ["ios", "com.firma.uygulama"]);
  assert.equal(scenario({}).intent, "reply", "hedef yoksa koşmak yerine sorar");
  assert.throws(() => scenario({ configId: 11 }, [{ action: "evaluateJavaScript", text: "x" }]), /desteklenmeyen adım/);
  assert.throws(() => scenario({ configId: 11 }, [{ action: "aiAct", text: "{{env.SECRET}} yaz" }]), /bilinmeyen değişken/);
  assert.throws(() => scenario({ configId: 11 }, []), /adım yok/);
  assert.throws(() => scenario({ configId: 77 }), /katalogda olmayan/);
  const invented = scenario({ url: "https://example.org/giris", configId: 1 });
  assert.deepEqual([invented.intent, invented.target.launchUrl, invented.target.config], ["scenario", "https://example.org/giris", null], "yazılı adreste uydurma konfigürasyon yok sayılır");
  assert.equal(scenario({ url: "https://example.org", configId: "null" }).target.config, null);
});

test("QA ajanı Midscene'ın modeline OpenAI uyumlu istekle katalog ve sohbetle sorar", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"reply","reply":"Merhaba"}' } }] }), { status: 200 });
  };
  const settings = { model_provider: "custom", model_base_url: "http://model.local/v1", model_api_key: "gizli-anahtar", model_name: "gpt-5-mini" };
  const conversation = conversationContext([
    { role: "user", text: "Örnek Proje web'de giriş yap", runs: [] },
    { role: "assistant", text: "Tamam", runs: [{ id: 5, client_name: "Örnek Proje", config_name: "Senaryo · Web (Chrome)", config_id: 11, platform: "web", status: "failed", message: "", scenario: true,
      cases: [{ case_key: "", title: "Giriş", status: "failed", steps: [{ action: "aiTap", text: "Giriş butonu", status: "failed", detail: "bulunamadı" }] }] }] },
  ]);
  assert.equal(conversation[1].runs[0].cases[0].failedStep, "aiTap: Giriş butonu → bulunamadı");
  const decision = await askQaAgent({ settings, text: "neden düştü?", catalog, conversation, fetchImpl, skills: [{ name: "Hata analizi", body: "Nedeni sınıflandır." }] });
  assert.deepEqual(decision, { intent: "reply", reply: "Merhaba" });
  assert.equal(calls[0].url, "http://model.local/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer gizli-anahtar");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gpt-5-mini");
  assert.ok(body.messages[0].content.startsWith(QA_AGENT_MARKER));
  assert.match(body.messages[0].content, /# QA skills[\s\S]*<skill name="Hata analizi">\nNedeni sınıflandır\.\n<\/skill>/, "seçilen beceriler sistem istemine eklenir");
  const sent = JSON.parse(body.messages[1].content);
  assert.equal(sent.message, "neden düştü?");
  assert.equal(sent.catalog.length, 2);
  assert.equal(sent.conversation[1].runs[0].status, "failed");

  const failing = async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
  await assert.rejects(askQaAgent({ settings, text: "x", catalog, fetchImpl: failing }), /401.*Invalid API key/);
  await assert.rejects(askQaAgent({ settings: {}, text: "x", catalog, fetchImpl }), /Model bağlı değil/);
});

test("modelin yeni adımları normalleşir: tuş, kaydırma, okuma/karşılaştırma; platform ve değişken kuralları uygulanır", () => {
  const plan = (steps, fields = { configId: 11 }) => normalizeDecision({ intent: "scenario", scenario: { ...fields, cases: [{ title: "t", steps }] } }, catalog);
  const decision = plan([
    { action: "press", text: "Enter'a bas" },
    { action: "aiKeyboardPress", keyName: "esc", locate: "Arama kutusu" },
    { action: "scroll", text: "Sayfayı en alta kaydır", scrollType: "untilBottom" },
    { action: "aiClearInput", locate: "Ad alanı" },
    { action: "aiNumber", prompt: "Ürün fiyatı", name: "fiyat" },
    { action: "aiNumber", prompt: "Sepet tutarı", expect: "{{saved.fiyat}}" },
    { action: "aiWaitFor", text: "Sonuçlar geldi", timeout: 999999 },
    { action: "aiAssert", text: "Sepette {{saved.fiyat}} TL görünür" },
  ]);
  assert.deepEqual(decision.cases[0].steps.slice(1), [
    { action: "aiKeyboardPress", text: "Enter", args: { keyName: "Enter" } },
    { action: "aiKeyboardPress", text: "Escape · Arama kutusu", args: { keyName: "Escape", locate: "Arama kutusu" } },
    { action: "aiScroll", text: "Ekran · down · untilBottom", args: { direction: "down", scrollType: "untilBottom" } },
    { action: "aiClearInput", text: "Ad alanı", args: { locate: "Ad alanı" } },
    { action: "aiNumber", text: "Ürün fiyatı → fiyat", args: { prompt: "Ürün fiyatı", name: "fiyat" } },
    { action: "aiNumber", text: "Sepet tutarı = {{saved.fiyat}}", args: { prompt: "Sepet tutarı", expect: "{{saved.fiyat}}" } },
    { action: "aiWaitFor", text: "Sonuçlar geldi", args: { timeout: "120000" } },
    { action: "aiAssert", text: "Sepette {{saved.fiyat}} TL görünür" },
  ], "serbest kaydırma metni öğe sanılmaz; bekleme süresi sınırlanır");
  assert.throws(() => plan([{ action: "aiAssert", text: "{{saved.fiyat}} görünür" }]), /önceki bir adımda okunmadı/);
  assert.throws(() => plan([{ action: "aiNumber", prompt: "x", name: "a b" }]), /geçersiz değişken adı/);
  assert.throws(() => plan([{ action: "aiKeyboardPress", text: "bir tuşa bas" }]), /geçersiz tuş adı/);
  assert.throws(() => plan([{ action: "aiRightClick", locate: "Satır" }], { configId: 12 }), /yalnız web/);
  assert.throws(() => plan([{ action: "aiPinch", direction: "in" }]), /yalnız mobilde/);
  assert.deepEqual(plan([{ action: "aiLongPress", locate: "Mesaj", duration: 50 }], { configId: 12 }).cases[0].steps[1],
    { action: "aiLongPress", text: "Mesaj", args: { locate: "Mesaj", duration: "200" } });
});
