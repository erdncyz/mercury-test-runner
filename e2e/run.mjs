#!/usr/bin/env node
// End-to-end check of a web run, the way an admin and a tester would use Mercury:
// connect a model, TestRail and a test-user source through the API, create a configuration,
// start the run from chat, then verify every observable result (steps, statuses, parallel lanes,
// locked test users, reports, video, TestRail results, chat history, secret hygiene).
// Usage: npm run test:e2e            (add --keep to leave Mercury running for browser inspection)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

async function waitRun(id, timeoutMs = 240_000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const run = await api(`/api/runs/${id}`);
    const progress = run.cases.map((item) => `${item.case_key}:${item.status}`).join(" ");
    if (progress !== last) console.log(`  #${id} ${run.status} · ${progress} · ${run.message || ""}`);
    last = progress;
    if (["passed", "failed", "blocked"].includes(run.status)) return run;
    await wait(1000);
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
