import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERRUPTION_HINT, MIDSCENE_FAMILIES, MIDSCENE_FAMILY_OPTIONS, canRecover, caseCacheId, realUserAgent, detectFamily, executeCases, midsceneModel, resolveText, redactSecrets, screenshotFromDataUrl, shouldRetry, stepLabel, stepTimeoutMs, withMidsceneFamily } from "../src/midscene.mjs";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("her adımdan sonra ekran görüntüsü alınır; Midscene raporu koşum sürerken şifresi maskeli yayınlanır", async () => {
  const reportDir = mkdtempSync(join(tmpdir(), "mtr-live-"));
  const source = join(mkdtempSync(join(tmpdir(), "mtr-src-")), "report.html");
  const agent = {
    reportFile: undefined,
    async aiAct(text) { writeFileSync(source, `<html>${text} · şifre Gizli-Parola-1</html>`); this.reportFile = source; },
    async aiAssert() { throw new Error("Assertion failed"); },
    async destroy() {},
  };
  let shots = 0;
  const seen = [];
  const outcome = await executeCases({
    runId: 9,
    cases: [{ caseId: "", fileKey: "41", title: "Senaryo", steps: [
      { action: "launch", text: "{{launchUrl}}" },
      { action: "aiAct", text: "girişe tıkla" },
      { action: "aiAct", text: "profili aç" },
      { action: "aiAssert", text: "kırmızı buton" },
      { action: "aiAct", text: "çıkış yap" },
    ] }],
    vars: { launchUrl: "https://x.test", account: { password: "Gizli-Parola-1" } },
    model: { config: {} },
    reportDir,
    onProgress: (index, steps, files) => seen.push({
      statuses: steps.map((step) => step.status),
      report: files.report && existsSync(join(reportDir, files.report)) ? readFileSync(join(reportDir, files.report), "utf8") : "",
    }),
    openCase: async () => ({
      agent,
      launch: async () => {},
      screenshot: async () => {
        shots += 1;
        if (shots === 3) throw new Error("ekran alınamadı");
        return { data: Buffer.from(`jpg-${shots}`), ext: "jpg" };
      },
    }),
  });
  const [result] = outcome.results;
  assert.deepEqual(result.steps.map((step) => [step.status, step.shot || ""]), [
    ["passed", "shot-41-1.jpg"], ["passed", "shot-41-2.jpg"], ["passed", ""], ["failed", "shot-41-4.jpg"], ["skipped", ""],
  ], "görüntü alınamayan adımın sonucu değişmez, atlanan adımın görüntüsü olmaz");
  assert.equal(readFileSync(join(reportDir, "shot-41-4.jpg"), "utf8"), "jpg-4", "başarısız adımın ekranı saklanır");
  const live = seen.find((item) => item.report && item.statuses.includes("pending"));
  assert.ok(live, "rapor koşum bitmeden yayınlanır");
  assert.match(live.report, /girişe tıkla/);
  assert.doesNotMatch(live.report, /Gizli-Parola-1/, "canlı raporda şifre maskelenir");
  assert.equal(result.files.report, "midscene-41.html");
  assert.doesNotMatch(readFileSync(join(reportDir, "midscene-41.html"), "utf8"), /Gizli-Parola-1/);
  assert.ok(!existsSync(source), "maskesiz asıl rapor case bitince silinir");
  assert.ok(!readdirSync(reportDir).some((name) => name.startsWith(".")), "geçici dosya kalmaz");
});

test("mobil ekran görüntüsü JPEG'e çevrilir; bozuk veri yok sayılır", async () => {
  const shot = await screenshotFromDataUrl(PNG_1PX);
  assert.ok(shot.data.length > 0);
  if (shot.ext === "jpg") assert.deepEqual([...shot.data.subarray(0, 2)], [0xff, 0xd8]);
  else assert.equal(shot.ext, "png", "dönüştürülemezse asıl görüntü kalır");
  assert.equal(await screenshotFromDataUrl("bozuk"), null);
  assert.equal(await screenshotFromDataUrl(undefined), null);
});

test("Midscene model ailesi model adından algılanır", () => {
  assert.equal(detectFamily("qwen3-vl-plus"), "qwen3-vl");
  assert.equal(detectFamily("qwen3.7-plus"), "qwen3");
  assert.equal(detectFamily("qwen3.5-vl"), "qwen3.5");
  assert.equal(detectFamily("gemini-3.5-flash"), "gemini");
  assert.equal(detectFamily("openai/gpt-5.6-sol"), "gpt-5");
  assert.equal(detectFamily("gpt-6-astra"), "gpt-6");
  assert.equal(detectFamily("doubao-seed-2-1-turbo-260628"), "doubao-seed");
  assert.equal(detectFamily("UI-TARS-1.5-7B"), "vlm-ui-tars-doubao-1.5");
  assert.equal(detectFamily("gpt-4.1"), "");
  assert.equal(detectFamily("auto/best-coding"), "", "yönlendirici takma adından aile çıkarılmaz");
  assert.equal(detectFamily("kr/qwen3-coder-next"), "", "metin/kod modeli ekran süremez");
  assert.equal(detectFamily("deepseek-r1-distill-qwen-32b"), "");
  assert.equal(detectFamily("gemini-embedding-001"), "");
  assert.equal(detectFamily("gpt-5-codex"), "gpt-5");
});

test("aile listesi kurulu Midscene'dan gelir; sağlayıcı modelleri aileyle işaretlenir", async () => {
  const { MODEL_FAMILY_VALUES } = await import("@midscene/shared/env");
  assert.deepEqual(MIDSCENE_FAMILIES, MODEL_FAMILY_VALUES);
  assert.ok(MIDSCENE_FAMILY_OPTIONS.every((option) => MIDSCENE_FAMILIES.includes(option.id) && option.label));
  assert.deepEqual(withMidsceneFamily([
    { id: "qwen/qwen3-vl-235b", label: "qwen/qwen3-vl-235b" },
    { id: "auto/best-coding", label: "auto/best-coding" },
    { id: "m-1", label: "Gemini 3.5 Flash" },
  ]).map((model) => model.midsceneFamily), ["qwen3-vl", "", "gemini"]);
});

test("model ayarı Midscene modelConfig'e çevrilir", () => {
  const gemini = midsceneModel({ model_provider: "gemini", model_name: "gemini-3.5-flash", model_api_key: "k", model_base_url: "https://generativelanguage.googleapis.com/v1beta" });
  assert.deepEqual(gemini.config, {
    MIDSCENE_MODEL_NAME: "gemini-3.5-flash",
    MIDSCENE_MODEL_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    MIDSCENE_MODEL_API_KEY: "k",
    MIDSCENE_MODEL_FAMILY: "gemini",
  });
  const override = midsceneModel({ model_provider: "openrouter", model_name: "my-vl", model_api_key: "k", midscene_model_family: "qwen3-vl" });
  assert.equal(override.config.MIDSCENE_MODEL_FAMILY, "qwen3-vl");
  const local = midsceneModel({ model_provider: "ollama", model_name: "qwen2.5-vl:7b" });
  assert.equal(local.config.MIDSCENE_MODEL_API_KEY, "not-needed");
  assert.match(midsceneModel({ model_provider: "openai", model_name: "gpt-4.1", model_api_key: "k" }).error, /ailesi belirlenemedi/);
  assert.match(midsceneModel({ model_provider: "bedrock-iam", model_name: "x", model_aws_secret: "s" }).error, /Bedrock IAM/);
  assert.match(midsceneModel({ model_provider: "openai", model_name: "gpt-5", model_api_key: "" }).error, /anahtarı yok/);
  assert.match(midsceneModel({}).error, /bağlı değil/);
});

test("adım değişkenleri çözülür, eksikse açık hata verir", () => {
  const vars = { launchUrl: "https://x.test", account: { email: "a@b.c", password: "p" } };
  assert.equal(resolveText("{{launchUrl}}/giris", vars), "https://x.test/giris");
  assert.equal(resolveText("{{ account.email }}", vars), "a@b.c");
  assert.throws(() => resolveText("{{account.phone}}", vars), /Değişken çözülemedi: account.phone/);
});

test("rapordaki test kullanıcısı şifresi her kaçış biçiminde maskelenir", () => {
  const secret = `P@ss"<w&rd>'1`;
  const report = [
    `{"param":{"value":${JSON.stringify(secret)}}}`,
    `<script>{"v":"${JSON.stringify(secret).slice(1, -1).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}"}</script>`,
    `<td>P@ss&quot;&lt;w&amp;rd&gt;&#39;1</td>`,
    "plain P@ss\"<w&rd>'1 end",
  ].join("\n");
  const clean = redactSecrets(report, [secret, "", "ab", undefined]);
  assert.doesNotMatch(clean, /P@ss/);
  assert.equal(clean.split("••••••••").length - 1, 4);
  assert.equal(redactSecrets("ab abc", ["ab"]), "ab abc", "çok kısa değerler maskelenmez");
});

// A fake Midscene agent that records calls; `script` decides what each call does.
function recordingAgent(script = {}) {
  const calls = [];
  const agent = { reportFile: undefined, async destroy() {} };
  for (const method of ["aiAct", "aiTap", "aiInput", "aiAssert", "aiWaitFor", "aiScroll", "aiKeyboardPress", "aiClearInput", "aiDoubleClick", "aiRightClick", "aiLongPress", "aiPinch", "aiBoolean", "aiNumber", "aiString", "aiQuery"]) {
    agent[method] = async (...args) => {
      calls.push([method, ...args]);
      return script[method] ? script[method](...args) : undefined;
    };
  }
  return { agent, calls };
}

async function runOne(steps, agent, options = {}) {
  const outcome = await executeCases({
    runId: 1, cases: [{ caseId: "", fileKey: "7", title: "t", steps, context: options.context }],
    vars: { launchUrl: "https://x.test", account: {} }, model: { config: {} }, reportDir: mkdtempSync(join(tmpdir(), "mtr-steps-")),
    openCase: async ({ agentOptions }) => { options.seen?.push(agentOptions); return { agent, launch: async () => {} }; },
    retryDelayMs: 1, ...options.run,
  });
  return outcome.results[0];
}

test("yeni adımlar Midscene'a doğru argümanlarla gider; okunan değer saklanıp karşılaştırılır", async () => {
  const { agent, calls } = recordingAgent({ aiNumber: () => 129.9, aiString: () => "Sepetim", aiBoolean: () => true });
  const result = await runOne([
    { action: "aiKeyboardPress", text: "Enter" },
    { action: "aiKeyboardPress", text: "Escape · Arama kutusu", args: { keyName: "Escape", locate: "Arama kutusu" } },
    { action: "aiScroll", text: "Ürün listesi" },
    { action: "aiScroll", text: "Ekran · down · untilBottom", args: { direction: "down", scrollType: "untilBottom", distance: "300" } },
    { action: "aiClearInput", text: "Ad alanı" },
    { action: "aiDoubleClick", text: "Resim" },
    { action: "aiRightClick", text: "Satır", args: { locate: "Satır" } },
    { action: "aiLongPress", text: "Mesaj", args: { locate: "Mesaj", duration: "1500" } },
    { action: "aiPinch", text: "Ekran · in", args: { direction: "in" } },
    { action: "aiNumber", text: "Ürün fiyatı → fiyat", args: { prompt: "Ürün fiyatı", name: "fiyat" } },
    { action: "aiNumber", text: "Sepet tutarı = {{saved.fiyat}}", args: { prompt: "Sepet tutarı", expect: "{{saved.fiyat}}" } },
    { action: "aiString", text: "Başlık", args: { prompt: "Başlık", expect: "sepetim" } },
    { action: "aiBoolean", text: "Sepet dolu mu?", args: { prompt: "Sepet dolu mu?", expect: "evet" } },
    { action: "aiAct", text: "{{saved.fiyat}} TL yazısına tıkla" },
  ], agent);
  assert.equal(result.status, "passed", result.message);
  assert.deepEqual(calls, [
    ["aiKeyboardPress", undefined, { keyName: "Enter" }],
    ["aiKeyboardPress", "Arama kutusu", { keyName: "Escape" }],
    ["aiScroll", "Ürün listesi", { direction: "down", scrollType: "singleAction", distance: null }],
    ["aiScroll", undefined, { direction: "down", scrollType: "untilBottom", distance: 300 }],
    ["aiClearInput", "Ad alanı"],
    ["aiDoubleClick", "Resim"],
    ["aiRightClick", "Satır"],
    ["aiLongPress", "Mesaj", { duration: 1500 }],
    ["aiPinch", undefined, { direction: "in", distance: undefined, duration: undefined }],
    ["aiNumber", "Ürün fiyatı"],
    ["aiNumber", "Sepet tutarı"],
    ["aiString", "Başlık"],
    ["aiBoolean", "Sepet dolu mu?"],
    ["aiAct", "129.9 TL yazısına tıkla"],
  ]);
  assert.equal(result.steps[9].detail, "fiyat = 129.9");
});

test("beklenen değer tutmazsa okuma bir kez yeniden denenir ve açık mesajla düşer", async () => {
  let reads = 0;
  const { agent, calls } = recordingAgent({ aiNumber: () => (reads++ === 0 ? 100 : 90) });
  const result = await runOne([
    { action: "aiNumber", text: "Fiyat → fiyat", args: { prompt: "Fiyat", name: "fiyat" } },
    { action: "aiNumber", text: "Sepet = {{saved.fiyat}}", args: { prompt: "Sepet", expect: "{{saved.fiyat}}" } },
    { action: "aiAct", text: "devam et" },
  ], agent);
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "failed", "skipped"]);
  assert.equal(result.steps[1].attempts, 2);
  assert.equal(result.steps[1].detail, '2 denemede de başarısız: Beklenen "100", ekranda okunan "90"');
  assert.equal(calls.filter(([method]) => method === "aiNumber").length, 3);
});

test("yeniden deneme yalnız güvenli durumlarda: okuma/doğrulama ve bulunamayan öğe; aiAct, zaman aşımı ve model reddi denenmez", async () => {
  assert.equal(shouldRetry({ action: "aiAssert" }, new Error("Assertion failed: x")), true);
  assert.equal(shouldRetry({ action: "aiTap" }, new Error("Element not found: Giriş")), true);
  assert.equal(shouldRetry({ action: "aiTap" }, new Error("click intercepted")), false, "tıklama olmuş olabilir");
  assert.equal(shouldRetry({ action: "aiAct" }, new Error("Element not found")), false);
  assert.equal(shouldRetry({ action: "aiAssert" }, Object.assign(new Error("zaman aşımı"), { timeout: true })), false);
  assert.equal(shouldRetry({ action: "aiAssert" }, new Error("401 Invalid API key")), false);
  assert.equal(shouldRetry({ action: "aiScroll" }, Object.assign(new Error("Geçersiz kaydırma yönü"), { fatal: true })), false);

  let taps = 0;
  const { agent } = recordingAgent({ aiTap: () => { taps += 1; if (taps === 1) throw new Error("Element not found: Giriş"); } });
  const flaky = await runOne([{ action: "aiTap", text: "Giriş" }], agent);
  assert.equal(flaky.status, "passed");
  assert.match(flaky.steps[0].detail, /^2\. denemede geçti · ilk deneme: Element not found: Giriş/);
  const noRetry = await runOne([{ action: "aiTap", text: "Giriş", args: { retry: "0" } }], recordingAgent({ aiTap: () => { throw new Error("Element not found"); } }).agent);
  assert.equal(noRetry.steps[0].attempts, undefined, "adımda retry: 0 yeniden denemeyi kapatır");
});

test("takılan adım zaman aşımıyla düşer, sonrakiler atlanır; bekleme adımları kendi süresini alır", async () => {
  const { agent } = recordingAgent({ aiAct: () => new Promise(() => {}) });
  const started = Date.now();
  const result = await runOne([{ action: "aiAct", text: "sonsuza kadar bekle" }, { action: "aiAssert", text: "x" }], agent, { run: { stepTimeout: 50 } });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(result.steps.map((step) => step.status), ["failed", "skipped"]);
  assert.match(result.steps[0].detail, /zaman aşımı/);
  assert.equal(stepTimeoutMs({ action: "aiWaitFor", args: { timeout: "200000" } }, 180_000), 230_000);
  assert.equal(stepTimeoutMs({ action: "sleep", text: "2000" }, 180_000), 7_000);
  assert.equal(stepTimeoutMs({ action: "aiAct", args: { stepTimeout: "5000" } }, 180_000), 5_000);
  assert.equal(stepTimeoutMs({ action: "aiTap" }, 180_000), 180_000);
});

test("case bağlamı Midscene'a ajan düzeyinde AI bağlamı olarak verilir; hatalı adım argümanı yeniden denenmez", async () => {
  const seen = [];
  const { agent, calls } = recordingAgent();
  await runOne([{ action: "aiAct", text: "giriş yap" }], agent, { context: "Giriş Hesabım menüsünde.", seen });
  assert.equal(seen[0].aiContexts.default, "Giriş Hesabım menüsünde.");
  assert.match(seen[0].aiContexts.aiAct, /^Unexpected interruptions[\s\S]*cookie consent[\s\S]*\n\nGiriş Hesabım menüsünde\.$/, "aiAct engel ipucunu ve case bağlamını birlikte alır");
  await runOne([{ action: "aiAct", text: "x" }], agent, { seen });
  assert.equal(seen[1].aiContexts.default, undefined, "bağlam yoksa Midscene varsayılanı kalır");
  assert.equal(seen[1].aiContexts.aiAct, INTERRUPTION_HINT);
  const bad = await runOne([{ action: "aiScroll", text: "Ekran · yan", args: { direction: "yan" } }], agent);
  assert.equal(bad.steps[0].detail, "Geçersiz kaydırma yönü: yan");
  assert.equal(bad.steps[0].attempts, undefined);
  assert.equal(calls.filter(([method]) => method === "aiScroll").length, 0);
  assert.equal(stepLabel("aiNumber", { prompt: "Tutar", name: "t", expect: "5" }), "Tutar = 5 → t");
});

test("Midscene cache'i case, platform ve açılış adresine göre ayrılır; şifre içeren aiAct cache'e yazılmaz", async () => {
  const item = { path: "/cases/a/giris.yaml", caseId: "12", title: "Giriş" };
  const id = caseCacheId("web", item, "https://x.test");
  assert.match(id, /^web-[0-9a-f]{16}$/);
  assert.equal(caseCacheId("web", { ...item, title: "Yeni ad" }, "https://x.test"), id, "dosyalı case'in adı değişse de cache kalır");
  assert.notEqual(caseCacheId("android", item, "https://x.test"), id);
  assert.notEqual(caseCacheId("web", item, "https://prod.x.test"), id);
  assert.notEqual(caseCacheId("web", { ...item, path: "/cases/a/cikis.yaml" }, "https://x.test"), id);
  assert.equal(caseCacheId("", item, "https://x.test"), "", "platformu bilinmeyen koşum cache kullanmaz");
  process.env.MERCURY_MIDSCENE_CACHE = "0";
  try { assert.equal(caseCacheId("web", item, "https://x.test"), ""); } finally { delete process.env.MERCURY_MIDSCENE_CACHE; }

  const seen = [];
  const { agent, calls } = recordingAgent();
  await runOne([
    { action: "aiAct", text: "giriş yap" },
    { action: "aiAct", text: "şifre alanına {{account.password}} yaz" },
  ], agent, { seen, run: { platform: "web", vars: { launchUrl: "https://x.test", account: { password: "Gizli-Parola-1" } } } });
  assert.match(seen[0].cache.id, /^web-/);
  assert.deepEqual(calls.filter(([method]) => method === "aiAct").map((call) => call.length > 2 ? call[2] : null), [null, { cacheable: false }]);
  await runOne([{ action: "aiAct", text: "x" }], agent, { seen });
  assert.equal(seen[1].cache, undefined, "platform verilmezse cache kapalı");
});

test("adım bir engel yüzünden düşerse AI çerez/pop-up'ı kapatır, yuttuğu önceki eylemi yeniden yapar ve adımı tekrar dener", async () => {
  let blocked = true;
  const { agent, calls } = recordingAgent({
    aiBoolean: (prompt) => (/just failed/.test(prompt) ? blocked : /swallowed/.test(prompt)),
    aiAct: (prompt) => { if (/Only clear the interruption/.test(prompt)) blocked = false; },
    aiWaitFor: () => { if (blocked || calls.filter(([method]) => method === "aiTap").length < 2) throw new Error("waitFor timeout: cookie consent modal is shown"); },
  });
  const result = await runOne([
    { action: "aiTap", text: "Giriş Yap butonu" },
    { action: "aiWaitFor", text: "Profil simgesi görünüyor" },
    { action: "aiAssert", text: "Hesabım görünür" },
  ], agent);
  assert.equal(result.status, "passed", result.message);
  assert.deepEqual(calls.map(([method]) => method), ["aiTap", "aiWaitFor", "aiBoolean", "aiAct", "aiBoolean", "aiTap", "aiWaitFor", "aiAssert"]);
  assert.deepEqual(calls[3][2], { cacheable: false }, "kurtarma eylemi cache'e yazılmaz");
  assert.match(calls[2][1], /aiWaitFor: Profil simgesi görünüyor/);
  assert.match(calls[4][1], /aiTap: Giriş Yap butonu/);
  assert.equal(result.steps[1].attempts, 2);
  assert.match(result.steps[1].detail, /^2\. denemede geçti · Ekrandaki engel kapatıldı · önceki adım yeniden yapıldı · ilk deneme: waitFor timeout/);
});

test("ekranda engel yoksa AI hiçbir şey yapmaz; gerçek hata olduğu gibi düşer; kurtarma kapatılabilir", async () => {
  const { agent, calls } = recordingAgent({ aiBoolean: () => false, aiWaitFor: () => { throw new Error("waitFor timeout: no profile icon"); } });
  const result = await runOne([{ action: "aiWaitFor", text: "Profil" }], agent);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0].detail, "waitFor timeout: no profile icon");
  assert.deepEqual(calls.map(([method]) => method), ["aiWaitFor", "aiBoolean"], "engel yoksa kapatma denenmez");

  const off = recordingAgent({ aiBoolean: () => true, aiWaitFor: () => { throw new Error("waitFor timeout"); } });
  await runOne([{ action: "aiWaitFor", text: "Profil", args: { recover: false } }], off.agent);
  await runOne([{ action: "aiWaitFor", text: "Profil" }], off.agent, { run: { recovery: false } });
  assert.deepEqual(off.calls.map(([method]) => method), ["aiWaitFor", "aiWaitFor"], "adımda recover: false ve MERCURY_STEP_RECOVERY=0 kapatır");

  assert.equal(canRecover({ action: "aiAssert" }, new Error("Assertion failed")), true);
  assert.equal(canRecover({ action: "aiTap" }, Object.assign(new Error("zaman aşımı"), { timeout: true })), false, "hâlâ çalışıyor olabilir");
  assert.equal(canRecover({ action: "aiTap" }, new Error("401 Invalid API key")), false);
  assert.equal(canRecover({ action: "launch" }, new Error("net::ERR")), false);
  assert.equal(canRecover({ action: "aiScroll" }, Object.assign(new Error("Geçersiz"), { fatal: true })), false);
});

test("başsız tarayıcı 'HeadlessChrome' kimliğini gizler; kimlik tarayıcı başına bir kez okunur", async () => {
  let probes = 0;
  const browser = {
    async newContext() {
      probes += 1;
      return { async newPage() { return { evaluate: async () => "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 HeadlessChrome/153.0 Safari/537.36" }; }, async close() {} };
    },
  };
  assert.equal(await realUserAgent(browser), "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/153.0 Safari/537.36");
  await realUserAgent(browser);
  assert.equal(probes, 1);
  assert.equal(await realUserAgent({ newContext: async () => { throw new Error("kapalı"); } }), "", "okunamazsa varsayılan kalır");
});
