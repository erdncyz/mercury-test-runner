import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { agentLanguageNote, localize, localizeBody, requestLang } from "../src/i18n.mjs";

test("dil başlığı yoksa veya tanınmıyorsa Türkçe seçilir", () => {
  assert.equal(requestLang({ headers: {} }), "tr");
  assert.equal(requestLang({ headers: { "x-mercury-lang": "de" } }), "tr");
  assert.equal(requestLang({ headers: { "x-mercury-lang": "EN" } }), "en");
});

test("sunucu mesajları İngilizceye çevrilir, Türkçede olduğu gibi kalır", () => {
  assert.equal(localize("Konfigürasyon bulunamadı", "tr"), "Konfigürasyon bulunamadı");
  assert.equal(localize("Konfigürasyon bulunamadı", "en"), "Configuration not found");
  assert.equal(localize("Koşum #12 tamamlanmadan silinemez", "en"), "Run #12 cannot be deleted until it finishes");
  assert.equal(localize("Bilinmeyen bir metin", "en"), "Bilinmeyen bir metin", "çevirisi olmayan metin değişmez");
});

test("birleşik mesajların parçaları da çevrilir", () => {
  assert.equal(
    localize("Konfigürasyon hazır değil: Web başlangıç adresi eksik; Midscene modeli hazır değil", "en"),
    "Configuration is not ready: Web launch URL missing; Midscene model is not ready",
  );
  assert.equal(
    localize("Cihaz daraltıldı: iphone · TestRail run açılamadı (TestRail ayarı eksik); sonuçlar yalnız yerel raporda", "en"),
    "Device narrowed to: iphone · Could not open a TestRail run (TestRail settings missing); results are only in the local report",
  );
  assert.equal(
    localize("1/3 case başarısız. Hat 2: aiTap: Önceki adım başarısız olduğu için atlandı · Farm cihazı bırakılamadı: HTTP 500", "en"),
    "1/3 cases failed. Lane 2: aiTap: Skipped because a previous step failed · Could not release the Farm device: HTTP 500",
  );
  assert.equal(localize("1 case geçti · 2 paralel hat", "en"), "1 case passed · 2 parallel lanes");
  assert.equal(
    localize("1/3 case başarısız. Hat 1: aiAssert: 2 denemede de başarısız: Assertion failed: Üye oturumu açılmış · TestRail run açılamadı (TestRail 503); sonuçlar yalnız yerel raporda", "en"),
    "1/3 cases failed. Lane 1: aiAssert: Failed in all 2 attempts: Assertion failed: Üye oturumu açılmış · Could not open a TestRail run (TestRail 503); results are only in the local report",
    "sayı yer tutucuları birleşik mesajın tamamını yutmaz; case'in kendi metni çevrilmez",
  );
  assert.equal(
    localize("Senaryo ön kontrolü geçemedi. Eksikleri tamamladıktan sonra yeniden yaz.\n#4 Giriş · Web — Senaryo koşulamıyor: Midscene modeli hazır değil", "en"),
    "The scenario did not pass the preflight check. Fix what is missing and send it again.\n#4 Giriş · Web — Scenario cannot run: Midscene model is not ready",
  );
});

test("yanıtta yalnız sunucunun yazdığı alanlar çevrilir; kullanıcı verisi korunur", () => {
  const body = {
    error: "Koşum yok",
    plan: { issues: ["Konfigürasyon devre dışı"], warnings: [] },
    name: "Konfigürasyon devre dışı",
    messages: [
      { role: "user", text: "Bir cümle yaz." },
      { role: "assistant", text: "Bir cümle yaz." },
    ],
    cases: [{ title: "Tüm adımlar geçti", steps: [{ text: "Tüm adımlar geçti", detail: "Tüm adımlar geçti" }] }],
  };
  assert.equal(localizeBody(body, "tr"), body, "Türkçede gövde aynen döner");
  assert.deepEqual(localizeBody(body, "en"), {
    error: "Run not found",
    plan: { issues: ["Configuration is disabled"], warnings: [] },
    name: "Konfigürasyon devre dışı",
    messages: [
      { role: "user", text: "Bir cümle yaz." },
      { role: "assistant", text: "Write a sentence." },
    ],
    cases: [{ title: "Tüm adımlar geçti", steps: [{ text: "Tüm adımlar geçti", detail: "All steps passed" }] }],
  });
});

test("QA ajanına arayüz dili söylenir", () => {
  assert.match(agentLanguageNote("en"), /English/);
  assert.match(agentLanguageNote("tr"), /Turkish/);
});

const dir = mkdtempSync(join(tmpdir(), "mtr-i18n-"));
const port = 19080 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(port), DATA_DIR: dir, REPORTS_DIR: join(dir, "reports") },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${port}`;
after(() => child.kill());

async function ready() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

test("API x-mercury-lang başlığına göre Türkçe veya İngilizce yanıt verir", async () => {
  await ready();
  const login = (lang) => fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(lang ? { "x-mercury-lang": lang } : {}) },
    body: JSON.stringify({ email: "mercury@test.com", password: "yanlis" }),
  }).then((response) => response.json());
  assert.equal((await login()).error, "E-posta veya şifre hatalı");
  assert.equal((await login("en")).error, "Incorrect e-mail or password");

  const auth = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mercury@test.com", password: "Mercury" }),
  });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const chat = (message, lang) => fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie, "x-mercury-lang": lang }, body: JSON.stringify({ message }),
  }).then((response) => response.json());
  const english = await chat("merhaba", "en");
  assert.match(english.reply, /^Name the project and configuration to run/);
  const history = await fetch(`${base}/api/chat/history/${english.conversationId}`, { headers: { cookie, "x-mercury-lang": "en" } }).then((response) => response.json());
  assert.deepEqual(history.map((item) => item.text.slice(0, 20)), ["merhaba", "Name the project and"], "kullanıcının mesajı çevrilmez");
  const turkish = await fetch(`${base}/api/chat/history/${english.conversationId}`, { headers: { cookie } }).then((response) => response.json());
  assert.match(turkish[1].text, /^Koşum için proje ve konfigürasyonu söyle/, "kayıtlı yanıt Türkçe saklanır, dile göre çevrilir");
});
