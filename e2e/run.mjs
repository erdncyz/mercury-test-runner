#!/usr/bin/env node
// End-to-end check of a web run, the way an admin and a tester would use Mercury:
// connect a model, TestRail and a test-user source through the API, create a configuration,
// start the run from chat, then verify every observable result (steps, statuses, parallel lanes,
// locked test users, reports, video, TestRail results, chat history, secret hygiene).
// Usage: npm run test:e2e            (add --keep to leave Mercury running for browser inspection)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { USERS, startFakes, state } from "./fakes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");
const port = Number(process.env.E2E_PORT || 18950);
const base = `http://127.0.0.1:${port}`;
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let fakes;
try {
  fakes = await startFakes();
} catch (error) {
  console.error(`Sahte servisler başlatılamadı (${error.message}). Önceki bir e2e koşumu hâlâ açık olabilir.`);
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), "mercury-e2e-"));
const serverLog = [];
const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DATA_DIR: join(dir, "data"), REPORTS_DIR: join(dir, "reports"), CASES_DIR: join(root, "e2e", "cases") },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

let cookie = "";
async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return data;
}

// Remembers, per run, whether a report link or a step screenshot was visible while steps were still running.
const liveSeen = new Map();
async function waitRun(id, timeoutMs = 240_000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const run = await api(`/api/runs/${id}`);
    const progress = run.cases.map((item) => `${item.case_key}:${item.status}`).join(" ");
    if (progress !== last) console.log(`  #${id} ${run.status} · ${progress} · ${run.message || ""}`);
    last = progress;
    if (run.status === "running") {
      const unfinished = run.cases.filter((item) => item.steps.some((step) => ["pending", "running"].includes(step.status)));
      const seen = liveSeen.get(id) || { report: false, shot: false };
      seen.report ||= unfinished.some((item) => item.files?.report);
      seen.shot ||= unfinished.some((item) => item.steps.some((step) => step.shot));
      const liveReport = unfinished.find((item) => item.files?.report)?.files.report;
      if (liveReport && !seen.html) {
        const response = await fetch(`${base}/reports/${id}/${liveReport}`, { headers: { cookie } });
        if (response.ok) seen.html = await response.text();
      }
      liveSeen.set(id, seen);
    }
    if (["passed", "failed", "blocked"].includes(run.status)) return run;
    await wait(400);
  }
  throw new Error(`#${id} ${timeoutMs / 1000} sn içinde bitmedi`);
}

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`${base}/api/health`).then((res) => res.ok, () => false)) break;
    await wait(200);
  }
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mercury@test.com", password: "Mercury" }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
  check("Admin giriş yapar", login.ok);

  // 1. Model, the way Ayarlar → Model does it: list models from the endpoint, then pick one.
  const listed = await api("/api/models/list", { method: "POST", body: { provider: "custom", baseUrl: fakes.urls.model, apiKey: "fake-model-key" } });
  check("Model uç noktasından model listesi gelir", listed.models.some((item) => item.id === "gpt-5-mini"), listed.models.map((item) => item.id).join(", "));
  const status = await api("/api/models/select", { method: "POST", body: { provider: "custom", baseUrl: fakes.urls.model, apiKey: "••••••••", model: "gpt-5-mini" } });
  check("Model bağlanır, Midscene ailesi algılanır", status.ready && status.midscene.family === "gpt-5", `aile=${status.midscene.family}`);

  // 2. TestRail.
  await api("/api/settings", { method: "PUT", body: { testrail_host: fakes.urls.testrail, testrail_user: "qa@demo.test", testrail_api_key: "tr-key", testrail_project_id: "1" } });
  const projects = await api("/api/settings/testrail-test", { method: "POST" });
  check("TestRail bağlantısı çalışır", projects.projects?.[0]?.name === "Demo");

  // 3. Test-user source: a generic REST service with token login, tested before saving.
  const source = {
    name: "Demo kullanıcı servisi",
    type: "http",
    clientId: null,
    baseUrl: fakes.urls.users,
    credentials: { username: fakes.service.username, password: fakes.service.password },
    spec: {
      auth: { type: "login", method: "POST", path: "/auth/login", body: { email: "{{username}}", password: "{{password}}" }, tokenPath: "data.accessToken", tokenHeader: "Authorization", tokenPrefix: "Bearer " },
      list: { method: "GET", path: "/test-users", params: { environment: "test", isLocked: false, plan: "premium" }, itemsPath: "items" },
      fields: { email: "email", password: "password", phone: "phone", id: "id" },
      extras: { plan: "plan" },
      markUsed: { method: "PATCH", path: "/test-users/{{id}}", body: { isLocked: true } },
    },
  };
  const tried = await api("/api/sources/test", { method: "POST", body: source });
  check("Hesap kaynağı kaydetmeden denenir, kilitlemez", tried.preview.email === "ayse@demo.test" && tried.preview.password === "alındı" && !USERS[0].isLocked, JSON.stringify(tried.preview));
  const { id: sourceId } = await api("/api/sources", { method: "POST", body: source });
  const savedSource = (await api("/api/sources")).find((item) => item.id === sourceId);
  check("Kaynak hazır, servis şifresi yanıtta maskeli", savedSource.ready && !JSON.stringify(savedSource).includes(fakes.service.password));

  // 4. Configuration: 3 cases split over 2 parallel browsers, each with its own locked test user.
  const { id: configId } = await api("/api/configs", {
    method: "POST",
    body: {
      client: "Demo Mağaza", suiteId: "7", name: "Web (Chrome)", platform: "web", aliases: ["web chrome", "web"],
      launchUrl: fakes.urls.site, parallel: 2, accountPolicy: "required", accountSourceId: sourceId, caseTags: ["giris"],
    },
  });
  const config = (await api("/api/configs")).find((item) => item.id === configId);
  check("Konfigürasyon ön kontrolü geçer", config.plan.ready, config.plan.issues.join("; ") || `${config.plan.caseCount} case, ${config.plan.lanes} hat`);
  check("3 case 2 paralel hatta bölünür", config.plan.caseCount === 3 && config.plan.lanes === 2);

  // 5. Start from chat, exactly as a tester would.
  const chat = await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza web chrome koş" } });
  const runId = chat.runs?.[0]?.id;
  check("Chat komutu koşum açar", runId && chat.runs[0].status === "queued", chat.reply.split("\n")[0]);
  check("Yeni TestRail run'ı açılır", chat.runs[0].testrail_run_id === "501" && state.testrail.runs[0]?.case_ids?.join(",") === "101,102,103",
    `run=${chat.runs[0].testrail_run_id} case_ids=${state.testrail.runs[0]?.case_ids}`);

  const run = await waitRun(runId);
  const byKey = Object.fromEntries(run.cases.map((item) => [item.case_key, item]));
  check("Koşum sonucu başarısız (negatif kontrol yüzünden)", run.status === "failed", run.message);
  check("C101 geçerli kullanıcıyla gerçekten giriş yapar", byKey["101"]?.status === "passed" && byKey["101"].steps.every((step) => step.status === "passed"),
    byKey["101"]?.steps.map((step) => `${step.action}:${step.status}`).join(" "));
  check("C102 hatalı şifre uyarısını doğrular", byKey["102"]?.status === "passed", byKey["102"]?.detail);
  const c103 = byKey["103"]?.steps.map((step) => step.status) || [];
  check("C103 doğru adımda düşer, sonraki adım atlanır", byKey["103"]?.status === "failed" && c103.join(",") === "passed,failed,skipped", c103.join(","));
  check("Düşen doğrulama bir kez yeniden denenir, sonuç değişmez", byKey["103"]?.steps[1].attempts === 2 && /^2 denemede de başarısız: Assertion failed/.test(byKey["103"].steps[1].detail),
    byKey["103"]?.steps[1].detail.slice(0, 80));
  check("Kayıtlı case'lerde de beceri notları Midscene'a gider", state.model.withContext > 0, `${state.model.withContext} model isteğinde`);
  check("Site tarafında gerçek giriş denemeleri görülür", state.logins.some((item) => item.ok) && state.logins.some((item) => !item.ok),
    state.logins.map((item) => `${item.email}:${item.ok ? "ok" : "red"}`).join(" "));

  const emails = run.account_email.split(", ").filter(Boolean);
  const typed = run.cases.map((item) => [item.case_key, item.account_email, item.steps.find((step) => step.action === "aiInput")?.text || ""]);
  check("Adımlarda her case'in kendi kullanıcısı görünür", typed.filter(([key]) => key !== "103").every(([, email, text]) => email && text.endsWith(email) && !text.includes(",")),
    typed.map(([key, email]) => `${key}:${email || "-"}`).join(" "));
  check("Her paralel hat ayrı test kullanıcısı alır", emails.length === 2 && new Set(emails).size === 2, emails.join(", "));
  check("Alınan kullanıcılar serviste kilitlenir", USERS.filter((user) => user.isLocked).map((user) => user.email).sort().join() === [...emails].sort().join(), state.lockedIds.join(","));
  check("Premium filtresi uygulanır, basic kullanıcı verilmez", emails.every((email) => USERS.find((user) => user.email === email)?.plan === "premium"));

  const results = state.testrail.results.find((item) => item.runId === 501)?.results || [];
  const statusOf = Object.fromEntries(results.map((item) => [item.case_id, item.status_id]));
  check("TestRail'e yalnız yeni run'a doğru sonuç yazılır", statusOf[101] === 1 && statusOf[102] === 1 && statusOf[103] === 5, JSON.stringify(statusOf));

  const reportDir = join(dir, "reports", String(runId));
  const files = existsSync(reportDir) ? readdirSync(reportDir) : [];
  check("Midscene raporu ve webm video her case için yazılır",
    ["101", "102", "103"].every((key) => files.includes(`midscene-${key}.html`) && files.includes(`video-${key}.webm`)), files.join(", "));
  check("Geçici video klasörleri temizlenir", !files.some((name) => name.startsWith(".video")));
  const executed = run.cases.flatMap((item) => item.steps.filter((step) => ["passed", "failed"].includes(step.status)).map((step) => ({ key: item.case_key, step })));
  const missingShots = executed.filter(({ step }) => !step.shot || !files.includes(step.shot));
  check("Yürütülen her adımın ekran görüntüsü saklanır", executed.length > 0 && !missingShots.length,
    missingShots.length ? missingShots.map(({ key, step }) => `${key}:${step.action}`).join(", ") : `${executed.length} adım`);
  const firstShot = await fetch(`${base}/reports/${runId}/${executed[0]?.step.shot}`, { headers: { cookie } });
  check("Adım ekranı oturumla JPEG olarak açılır", firstShot.ok && firstShot.headers.get("content-type") === "image/jpeg"
    && [...new Uint8Array(await firstShot.arrayBuffer()).subarray(0, 2)].join() === "255,216", `${firstShot.status} ${firstShot.headers.get("content-type")}`);
  check("Case'in rapor ve video bağlantısı koşum ayrıntısında", run.cases.every((item) => item.files?.report === `midscene-${item.case_key}.html` && item.files?.video === `video-${item.case_key}.webm`));
  check("Koşum sürerken adım ekranı ve Midscene raporu görünür", liveSeen.get(runId)?.shot && liveSeen.get(runId)?.report, JSON.stringify({ ...liveSeen.get(runId), html: undefined }));
  // The mid-run copy must be a working Midscene report, not just a file: render it in a real browser.
  const liveHtml = liveSeen.get(runId)?.html || "";
  const livePath = join(dir, "live-report.html");
  writeFileSync(livePath, liveHtml);
  const { chromium } = await import("playwright");
  const viewer = await chromium.launch();
  let rendered = "";
  try {
    const page = await viewer.newPage();
    await page.goto(`file://${livePath}`);
    await page.waitForFunction(() => /Report\s+v\d/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {});
    rendered = await page.evaluate(() => document.body.innerText);
  } finally {
    await viewer.close();
  }
  check("Koşum ortasındaki Midscene raporu tarayıcıda açılır", liveHtml.length > 0 && /Report\s+v\d/.test(rendered) && /\b(Act|Tap|Input|Assert|Wait)\b/.test(rendered),
    rendered.replace(/\s+/g, " ").slice(0, 120));
  check("Koşum ortasındaki raporda da şifre maskeli", !USERS.some((user) => liveHtml.includes(user.password)));
  check("Canlı rapor kopyasından geçici dosya kalmaz", !files.some((name) => name.startsWith(".")), files.filter((name) => name.startsWith(".")).join(", "));
  const index = await fetch(`${base}/reports/${runId}/index.html`, { headers: { cookie } });
  const indexHtml = await index.text();
  check("Rapor sayfası oturumla açılır", index.ok && indexHtml.includes("C101"));
  check("Rapor oturumsuz açılmaz", (await fetch(`${base}/reports/${runId}/index.html`)).status === 401);
  const clip = await fetch(`${base}/reports/${runId}/video-101.webm`, { headers: { cookie, range: "bytes=0-99" } });
  check("Video parça parça sunulur (Safari oynatma/sarma)", clip.status === 206 && (await clip.arrayBuffer()).byteLength === 100 && clip.headers.get("content-type") === "video/webm",
    `${clip.status} ${clip.headers.get("content-range")}`);
  const secrets = [fakes.service.password, ...USERS.map((user) => user.password), "fake-model-key", "tr-key"];
  const exposed = [indexHtml, JSON.stringify(await api(`/api/runs/${runId}`)), JSON.stringify(await api("/api/runs")), JSON.stringify(await api("/api/chat/history")), JSON.stringify(await api("/api/settings"))]
    .flatMap((text) => secrets.filter((secret) => text.includes(secret)));
  check("Hiçbir şifre/anahtar rapor, koşum, geçmiş veya ayar yanıtında yok", !exposed.length, exposed.join(", "));

  const userPasswords = USERS.map((user) => user.password);
  const midsceneLeaks = files.filter((name) => name.endsWith(".html"))
    .filter((name) => userPasswords.some((secret) => readFileSync(join(reportDir, name), "utf8").includes(secret)));
  check("Midscene raporlarında yazılan şifre maskelenir", !midsceneLeaks.length && readFileSync(join(reportDir, "midscene-101.html"), "utf8").includes("••••••••"), midsceneLeaks.join(", "));
  const scan = (folder) => (existsSync(folder) ? readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)) : []);
  const runDirLeaks = scan(join(dir, "data")).filter((file) => !/mercury\.sqlite|app\.key/.test(file))
    .filter((file) => userPasswords.some((secret) => readFileSync(file).includes(secret)));
  check("Midscene çalışma klasöründe (günlük, orijinal rapor) şifre kalmaz", !runDirLeaks.length, runDirLeaks.map((file) => file.replace(dir, "")).join(", "));

  const history = await api("/api/chat/history?q=demo");
  check("Chat geçmişinde komut ve canlı koşum kartı var", history.some((item) => item.role === "assistant" && item.runs?.[0]?.id === runId));
  check("Model tüm istek türlerini aldı", ["locate", "insight", "plan"].every((kind) => state.model.kinds[kind] > 0), JSON.stringify(state.model.kinds));

  // 6. Second run: only one premium user is left for two lanes; that lane runs, the other fails clearly.
  const again = await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza web koş" } });
  const second = await waitRun(again.runs[0].id);
  const lanesWithoutUser = second.cases.filter((item) => /Uygun test hesabı yok|hesap/i.test(item.detail));
  check("Kullanıcı biterse ilgili hat açık hatayla düşer, diğeri koşar", second.status === "failed" && lanesWithoutUser.length > 0 && second.cases.some((item) => item.status === "passed"),
    second.cases.map((item) => `${item.case_key}:${item.status}`).join(" "));
  check("İkinci koşum da yeni TestRail run'ı açar", again.runs[0].testrail_run_id === "502");

  // 6b. Ad-hoc scenario typed in chat: no YAML, no configuration; real browser and Midscene. Its case is filed in TestRail.
  const trRuns = state.testrail.runs.length;
  const adhoc = await api("/api/chat", { method: "POST", body: { message: `${fakes.urls.site} adresini aç, çerez bandını kabul et ve giriş formunun göründüğünü doğrula` } });
  check("Chat senaryosu adımlara bölünür ve koşum açar", adhoc.runs[0]?.status === "queued" && adhoc.runs[0].scenario
    && adhoc.runs[0].cases[0].steps.map((step) => step.action).join(",") === "launch,aiAct,aiAssert", adhoc.reply.split("\n")[0]);
  const adhocRun = await waitRun(adhoc.runs[0].id);
  const [openStep, actStep] = adhocRun.cases[0].steps;
  check("Adımlarda süre, sayfa açılış ölçüleri ve Midscene'in AI kullanımı kaydedilir",
    openStep.metrics?.load?.domContentLoadedMs > 0 && openStep.metrics.load.requests >= 1 && /^Chromium /.test(openStep.metrics.env?.browser || "")
    && actStep.metrics?.durationMs > 0 && actStep.metrics.ai?.calls > 0 && actStep.metrics.ai.totalTokens > 0,
    JSON.stringify([openStep.metrics, actStep.metrics]));
  check("Chat senaryosu gerçek tarayıcıda Midscene ile geçer", adhocRun.status === "passed" && adhocRun.cases[0].steps.every((step) => step.status === "passed"),
    adhocRun.cases[0].steps.map((step) => `${step.action}:${step.status}`).join(" "));
  const wrong = await waitRun((await api("/api/chat", { method: "POST", body: { message: `${fakes.urls.site} aç, çerez bandını kabul et ve hata uyarısının göründüğünü doğrula` } })).runs[0].id);
  check("Yanlış beklenti doğrulama adımında düşer", wrong.status === "failed" && wrong.cases[0].steps.map((step) => step.status).join(",") === "passed,passed,failed",
    wrong.cases[0].steps.map((step) => `${step.action}:${step.status}`).join(" "));
  const scenarioRuns = state.testrail.runs.slice(trRuns);
  const filed = state.testrail.cases.filter((item) => item.title === "Sayfa kontrolü");
  check("Chat senaryosu adıyla TestRail run'ı açar, case'i Mercury bölümüne bir kez yazılır",
    adhocRun.config_name === "Sayfa kontrolü · Web" && scenarioRuns.length === 2 && scenarioRuns.every((item) => item.name === "Sayfa kontrolü · Web" && item.suite_id === 9)
    && filed.length === 1 && state.testrail.sections.some((item) => item.name === "Mercury · Anlık senaryolar") && adhocRun.testrail_run_id === String(scenarioRuns[0].id),
    `${adhocRun.config_name} · ${JSON.stringify(scenarioRuns.map((item) => [item.name, item.case_ids]))} · cases=${filed.length}`);
  const scenarioResults = (id) => state.testrail.results.find((item) => item.runId === id)?.results || [];
  check("Chat senaryosunun sonucu TestRail'e yazılır",
    scenarioResults(scenarioRuns[0]?.id)[0]?.case_id === filed[0]?.id && scenarioResults(scenarioRuns[0]?.id)[0]?.status_id === 1 && scenarioResults(scenarioRuns[1]?.id)[0]?.status_id === 5,
    JSON.stringify(scenarioRuns.map((item) => scenarioResults(item.id))));
  check("Serbest senaryoyu QA ajanı (model) planlar", state.model.kinds.qa >= 2 && /Adresi açıp/.test(adhoc.reply), JSON.stringify(state.model.kinds));

  // 6c. QA agent: "login ol" names neither a page nor a field; the agent designs the case, Midscene finds the form.
  for (const user of USERS) user.isLocked = false;
  const loginsBefore = state.logins.length;
  const qaLogin = await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza'da login ol" } });
  const qaRun = qaLogin.runs?.[0];
  check("\"login ol\" projenin konfigürasyonunda test kullanıcılı senaryoya çevrilir",
    qaRun?.status === "queued" && qaRun.scenario && qaRun.config_name === "Test kullanıcısıyla giriş · Web (Chrome)" && /test kullanıcısıyla oturum/.test(qaLogin.reply)
    && qaRun.cases[0].steps.map((step) => step.action).join(",") === "launch,aiAct,aiAct,aiInput,aiInput,aiKeyboardPress,aiWaitFor,aiString,aiBoolean,aiScroll,aiString,aiAssert", qaLogin.reply.split("\n")[0]);
  const qaDone = await waitRun(qaRun.id);
  const typedEmail = qaDone.cases[0].steps.find((step) => step.action === "aiInput")?.text || "";
  check("QA ajanının login senaryosu gerçek tarayıcıda test kullanıcısıyla geçer",
    qaDone.status === "passed" && state.logins.slice(loginsBefore).some((item) => item.ok && item.email === qaDone.account_email) && typedEmail.endsWith(qaDone.account_email),
    `${qaDone.cases[0].steps.map((step) => `${step.action}:${step.status}`).join(" ")} · ${qaDone.account_email}`);
  const loginPrompt = state.qa.systems.at(-1) || "";
  check("QA ajanına çekirdek ve giriş becerisi yüklenir, alakasızlar yüklenmez",
    /<skill name="QA çekirdeği">/.test(loginPrompt) && /<skill name="Giriş ve oturum">/.test(loginPrompt) && !/<skill name="Video ve medya oynatma">/.test(loginPrompt)
    && qaLogin.skills?.includes("Giriş ve oturum"), (qaLogin.skills || []).join(" · "));
  const readSteps = qaDone.cases[0].steps.filter((step) => ["aiString", "aiBoolean"].includes(step.action));
  check("Enter tuşu formu gönderir; ekrandan okunan değer saklanıp sonraki adımda karşılaştırılır",
    readSteps.length === 3 && readSteps[0].detail === "baslik = Demo Mağaza · Üye alanı" && readSteps.every((step) => step.status === "passed")
    && qaDone.cases[0].steps.find((step) => step.action === "aiKeyboardPress")?.text === "Enter",
    readSteps.map((step) => `${step.action}:${step.status}:${step.detail}`).join(" | "));
  check("Beceri notları Midscene'a AI bağlamı olarak gider", state.model.withContext > 0, `${state.model.withContext} model isteğinde`);
  check("Senaryo adımlarında ve koşum yanıtında şifre yok", !USERS.some((user) => JSON.stringify(qaDone).includes(user.password)));
  const followUp = await api("/api/chat", { method: "POST", body: { message: "son koşum ne oldu?", conversationId: qaLogin.conversationId } });
  check("Sonuç sorusunda hata analizi becerisi yüklenir", /<skill name="Hata analizi ve raporlama">/.test(state.qa.systems.at(-1) || ""), (followUp.skills || []).join(" · "));
  check("QA ajanı sohbetteki önceki koşumu bilir", !followUp.runs && followUp.reply.includes(`#${qaRun.id} passed`), followUp.reply);
  const sent = JSON.stringify(state.qa.inputs);
  check("QA ajanına şifre, anahtar veya hesap servisi bilgisi gitmez",
    ![fakes.service.password, fakes.service.username, fakes.urls.users, "fake-model-key", "tr-key", ...USERS.map((user) => user.password)].some((secret) => sent.includes(secret)));

  const trBefore = state.testrail.runs.length;
  const subset = await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza'nın hatalı şifre testini koş" } });
  const subsetRun = subset.runs?.[0];
  check("QA ajanı TestRail case'ini adından bulur, yalnız onu yeni run'a ekler",
    subsetRun && !subsetRun.scenario && state.testrail.runs.length === trBefore + 1 && state.testrail.runs.at(-1).case_ids.join(",") === "102"
    && subsetRun.cases.map((item) => item.case_key).join(",") === "102", `${subset.reply.split("\n")[0]} · case_ids=${state.testrail.runs.at(-1)?.case_ids}`);
  const subsetDone = await waitRun(subsetRun.id);
  check("Seçilen tek case koşar ve geçer", subsetDone.status === "passed" && subsetDone.cases.length === 1 && subsetDone.cases[0].case_key === "102",
    subsetDone.cases.map((item) => `${item.case_key}:${item.status}`).join(" "));
  const hello = await api("/api/chat", { method: "POST", body: { message: "selam, neler yapabilirsin?" } });
  check("Soru ve sohbet koşum açmadan yanıtlanır", !hello.runs && /Demo Mağaza/.test(hello.reply), hello.reply);

  // 7. Things that break in real life: TestRail down, application down, wrong model key.
  for (const user of USERS) user.isLocked = false;
  state.fail.testrail = true;
  const trDown = await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza web koş" } });
  check("TestRail kapalıyken chat bunu açıkça söyler, koşum yine yerelde başlar",
    trDown.runs[0].status === "queued" && !trDown.runs[0].testrail_run_id && /TestRail run açılamadı \(TestRail 503\)/.test(trDown.reply), trDown.reply.split("\n")[1]);
  const trDownRun = await waitRun(trDown.runs[0].id);
  check("TestRail uyarısı koşum bitince de mesajda kalır", /sonuçlar yalnız yerel raporda/.test(trDownRun.message) && trDownRun.testrail_error, trDownRun.message);
  state.fail.testrail = false;

  await api(`/api/configs/${configId}`, { method: "PUT", body: { launchUrl: "http://127.0.0.1:18919/", accountPolicy: "none", parallel: 1 } });
  const siteDown = await waitRun((await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza web koş" } })).runs[0].id);
  const firstSteps = siteDown.cases.map((item) => `${item.steps[0].status}/${item.steps.slice(1).every((step) => step.status === "skipped")}`);
  check("Uygulama kapalıysa açılış adımı düşer, kalan adımlar atlanır", siteDown.status === "failed" && firstSteps.every((item) => item === "failed/true") && /ERR_CONNECTION_REFUSED/.test(siteDown.cases[0].steps[0].detail),
    siteDown.cases[0].steps[0].detail);

  await api(`/api/configs/${configId}`, { method: "PUT", body: { launchUrl: fakes.urls.site } });
  await api("/api/models/select", { method: "POST", body: { provider: "custom", baseUrl: fakes.urls.model, apiKey: "yanlis-anahtar", model: "gpt-5-mini" } });
  const startedAt = Date.now();
  const badKey = await waitRun((await api("/api/chat", { method: "POST", body: { message: "Demo Mağaza web koş" } })).runs[0].id, 180_000);
  const aiStep = badKey.cases[0].steps.find((step) => step.status === "failed");
  check("Model anahtarı yanlışsa ilk AI adımı açık hatayla düşer, koşum takılmaz",
    badKey.status === "failed" && aiStep && /401|Invalid API key/i.test(aiStep.detail), `${Math.round((Date.now() - startedAt) / 1000)} sn · ${aiStep?.action}: ${aiStep?.detail}`);
} catch (error) {
  check("Beklenmeyen hata", false, error.stack || error.message);
} finally {
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log("\nSunucu günlüğünün sonu:\n" + serverLog.join("").split("\n").slice(-30).join("\n"));
  }
  if (process.env.E2E_INSPECT) console.log(`INSPECT_DIR=${dir}`);
  if (keep || process.env.E2E_INSPECT) {
    console.log(`\nMercury açık: ${base} (mercury@test.com / Mercury) · veri: ${dir}\nKapatmak için Ctrl+C.`);
    const shutdown = () => {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    server.kill();
    await fakes.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  }
}
