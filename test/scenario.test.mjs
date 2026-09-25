import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScenarioSteps, isIosUdid, parseScenario, resolveScenarioTarget, serialCandidates } from "../src/agent.mjs";

const clients = [{ id: 1, name: "Tod" }];
const configs = [
  { id: 11, client_id: 1, name: "Web (Chrome)", aliases: '["web"]', platform: "web", enabled: 1 },
  { id: 12, client_id: 1, name: "Android", aliases: '["android"]', platform: "android", enabled: 1 },
  { id: 13, client_id: 1, name: "iOS", aliases: '["ios","iphone"]', platform: "ios", enabled: 1 },
  { id: 14, client_id: 1, name: "Eski Android", aliases: '["eski"]', platform: "android", enabled: 0 },
];

function plan(text) {
  const parsed = parseScenario(text);
  if (!parsed) return null;
  const target = resolveScenarioTarget(parsed, configs, clients);
  if (target.error) return { error: target.error };
  return {
    platform: target.platform,
    config: target.config?.id ?? null,
    target: target.launchUrl || target.packageId,
    steps: buildScenarioSteps(parsed, target.ignore).map((step) => `${step.action}: ${step.text}`),
  };
}

test("adres verilen senaryo web'de koşar; eylem ve doğrulama adımlara ayrılır", () => {
  assert.deepEqual(plan("https://example.com'u aç, More information linkine tıkla ve sayfada IANA yazdığını doğrula"), {
    platform: "web", config: null, target: "https://example.com",
    steps: ["launch: {{launchUrl}}", "aiAct: More information linkine tıkla", "aiAssert: sayfada IANA yazdığını doğrula"],
  });
  assert.deepEqual(plan("example.com.tr adresine git sonra arama kutusuna kedi yaz").steps, ["launch: {{launchUrl}}", "aiAct: arama kutusuna kedi yaz"]);
  assert.equal(plan("example.com.tr adresine git sonra arama kutusuna kedi yaz").target, "https://example.com.tr", "şemasız adrese https eklenir");
  assert.equal(plan("tod web'de https://staging.tod.tv/giris aç").config, 11, "proje adı geçerse web konfigürasyonunun hesabı ve ayarı kullanılır");
});

test("e-posta adres sanılmaz, bekleme ve doğrulama önceki eylemi yutmaz", () => {
  assert.deepEqual(plan("https://x.com aç, qa@acme.com ile giriş yap ve 2,5 saniye bekle. Yükleniyor yazısı kaybolana kadar bekle").steps, [
    "launch: {{launchUrl}}", "aiAct: qa@acme.com ile giriş yap", "sleep: 2500", "aiWaitFor: Yükleniyor yazısı kaybolana kadar bekle",
  ]);
  assert.equal(parseScenario("qa@acme.com ile giriş yap").url, "");
  assert.deepEqual(plan("https://x.com aç, giriş yap ve hoş geldin yazısının göründüğünü kontrol et").steps.slice(1), [
    "aiAct: giriş yap", "aiAssert: hoş geldin yazısının göründüğünü kontrol et",
  ]);
});

test("paket kimliği mobilde koşar; iPhone geçerse iOS, yoksa Android", () => {
  assert.deepEqual(plan("com.digiturk.tod uygulamasını iphone'da aç ve 3 saniye bekle"), {
    platform: "ios", config: 13, target: "com.digiturk.tod", steps: ["launch: {{launchUrl}}", "sleep: 3000"],
  });
  assert.equal(plan("com.digiturk.tod uygulamasını aç, oynat butonuna bas").platform, "android");
  assert.equal(parseScenario("com.digiturk.tod uygulamasını aç").url, "", "paket kimliği adres sanılmaz");
});

test("adres yoksa projenin konfigürasyonu seçilir; belirsizse sorulur", () => {
  assert.deepEqual(plan("tod android uygulamasını aç, giriş yap ve profil sayfasına git"), {
    platform: "android", config: 12, target: "", steps: ["launch: {{launchUrl}}", "aiAct: giriş yap ve profil sayfasına git"],
  });
  assert.match(plan("tod giriş yap").error, /hangi konfigürasyonda.*Web \(Chrome\), Android, iOS/);
  assert.doesNotMatch(plan("tod giriş yap").error, /Eski Android/, "devre dışı konfigürasyon önerilmez");
  assert.match(plan("profil sayfasını aç").error, /nerede koşayım/);
  assert.deepEqual(plan("tod web'de girişe tıkla").steps, ["launch: {{launchUrl}}", "aiAct: girişe tıkla"], "proje ve yer sözcükleri talimattan çıkar");
});

test("kayıtlı koşum komutları ve sohbet senaryo sayılmaz", () => {
  for (const text of ["selam", "tod android koş", "tod regresyon koş", "gece regresyonu koş", "iPhone 15'te android koş"]) {
    assert.equal(parseScenario(text), null, text);
  }
});

test("Enter/ESC tuşu ve kaydırma cümleleri tuş ve kaydırma adımına dönüşür", () => {
  assert.deepEqual(plan("https://x.com aç, arama kutusuna kedi yaz ve Enter tuşuna bas, sayfanın sonuna kadar kaydır ve sonuçların geldiğini doğrula").steps, [
    "launch: {{launchUrl}}", "aiAct: arama kutusuna kedi yaz", "aiKeyboardPress: Enter", "aiScroll: Ekran · down · scrollToBottom", "aiAssert: sonuçların geldiğini doğrula",
  ]);
  assert.deepEqual(plan("https://x.com aç, ESC'ye bas, yukarı kaydır").steps.slice(1), ["aiKeyboardPress: Escape", "aiScroll: Ekran · up"]);
});

test("mesajdaki cihaz seri numarası ve UDID adayları ayıklanır; paket, sürüm, adres aday sayılmaz", () => {
  assert.deepEqual(
    serialCandidates("00008140-001E21220240801C cihazında com.digiturk.digiturkplay uygulamasını iOS 26.2 ile test et"),
    ["00008140-001E21220240801C"],
  );
  assert.deepEqual(serialCandidates("R58M12ABCDE'de https://example.com/a1b2 aç, 172.28.34.65:12015 değil"), ["R58M12ABCDE"]);
  assert.equal(isIosUdid("00008140-001E21220240801C"), true);
  assert.equal(isIosUdid("a".repeat(40)), true);
  assert.equal(isIosUdid("R58M12ABCDE"), false);
});
