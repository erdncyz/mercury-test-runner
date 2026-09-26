import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { addRun } from "../src/integrations.mjs";

const dir = mkdtempSync(join(tmpdir(), "mtr-"));
const port = 18080 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(port), DATA_DIR: dir, REPORTS_DIR: join(dir, "reports") },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${port}`;

async function ready() {
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(child.stderr?.read()?.toString() || "server did not start");
}

async function login(email, password) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, cookie: response.headers.get("set-cookie")?.split(";")[0] || "", body: await response.json() };
}

after(() => child.kill());

test("chat'te yazılan senaryo ön kontrolden geçip adımlarıyla koşum açar; kayıtlı koşum komutları değişmez", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const post = (message) => fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify({ message }),
  }).then((response) => response.json());
  const steps = (run) => run.cases[0].steps.map((step) => [step.action, step.text]);

  const adhoc = await post("https://example.com'u aç, More information'a tıkla ve IANA yazdığını doğrula");
  const run = adhoc.runs[0];
  assert.match(adhoc.reply, /Senaryo ön kontrolü geçemedi/);
  assert.deepEqual([run.client_name, run.config_name, run.platform, run.scenario, run.status],
    ["Anlık senaryo", "https://example.com'u aç, More information'a tıkla ve IANA yazdığını doğrula · Web", "web", true, "blocked"], "koşum senaryonun adını taşır");
  assert.match(run.message, /Midscene modeli hazır değil/, "senaryo da aynı ön kontrolden geçer");
  assert.equal(run.testrail_run_id, "");
  assert.deepEqual(steps(run), [["launch", "https://example.com"], ["aiAct", "More information'a tıkla"], ["aiAssert", "IANA yazdığını doğrula"]]);
  const detail = await (await fetch(`${base}/api/runs/${run.id}`, { headers: { cookie: admin.cookie } })).json();
  assert.deepEqual(steps(detail), steps(run), "koşum ayrıntısı senaryonun adımlarını gösterir");
  assert.equal(detail.scenario_json, undefined);

  const onProject = (await post("Örnek Proje web chrome'da More information'a tıkla")).runs[0];
  assert.deepEqual([onProject.client_name, onProject.config_name], ["Örnek Proje", "Örnek Proje web chrome'da More information'a tıkla · Web (Chrome)"]);
  assert.deepEqual(steps(onProject), [["launch", "https://example.com"], ["aiAct", "More information'a tıkla"]], "adres konfigürasyondan gelir");

  assert.match((await post("Örnek Proje'de giriş yap")).reply, /hangi konfigürasyonda koşayım\? Web \(Chrome\), Android, iOS/);
  assert.match((await post("profil sayfasını aç")).reply, /nerede koşayım/);
  const saved = await post("Örnek Proje web chrome koş");
  assert.equal(saved.runs[0].config_name, "Web (Chrome)", "kayıtlı konfigürasyon komutu senaryoya dönmez");
  assert.equal(saved.runs[0].scenario, false);

  const pinned = (await post("com.demo.app uygulamasını iPhone'da aç, 00008140-001E21220240801C cihazında giriş yap")).runs[0];
  assert.equal(pinned.platform, "ios");
  const stored = new DatabaseSync(join(dir, "mercury.sqlite")).prepare("SELECT device_serials, device_hint FROM runs WHERE id = ?").get(pinned.id);
  assert.deepEqual([JSON.parse(stored.device_serials), stored.device_hint], [["00008140-001E21220240801C"], ""], "UDID koşumu o cihaza sabitler");
});

test("adım ekranları önbelleklenir, canlı rapor her istekte tazedir, MP4 parça parça sunulur; hepsi oturum ister", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const folder = join(dir, "reports", "9001");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "shot-41-1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  writeFileSync(join(folder, "midscene-41.html"), "<html>canlı</html>");
  writeFileSync(join(folder, "video-41-1.mp4"), Buffer.alloc(300, 1));
  writeFileSync(join(folder, ".midscene-41.html.tmp"), "yarım");
  const get = (name, headers = {}) => fetch(`${base}/reports/9001/${name}`, { headers: { cookie: admin.cookie, ...headers } });

  const shot = await get("shot-41-1.jpg");
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.match(shot.headers.get("cache-control"), /immutable/, "kart her yenilendiğinde görüntü baştan inmez");
  const live = await get("midscene-41.html");
  assert.equal(live.headers.get("cache-control"), "private, no-store", "koşum sürerken büyüyen rapor önbelleğe alınmaz");
  const clip = await get("video-41-1.mp4", { range: "bytes=0-99" });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get("content-type"), "video/mp4");
  assert.equal((await clip.arrayBuffer()).byteLength, 100);
  assert.equal((await get(".midscene-41.html.tmp")).status, 404, "yarım yazılmış geçici dosya sunulmaz");
  assert.equal((await fetch(`${base}/reports/9001/shot-41-1.jpg`)).status, 401, "ekran görüntüsü oturumsuz açılmaz");
});

test("admin girer, kayıt onaysız kalır, chat koşum ve bellek çalışır", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  assert.equal(admin.status, 200);
  assert.equal(admin.body.role, "admin");
  const pending = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "qa@example.com", password: "password1" }),
  });
  assert.equal(pending.status, 201);
  assert.equal((await login("qa@example.com", "password1")).status, 403);
  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ message: "Örnek Proje web chrome koş" }),
  });
  const result = await chat.json();
  assert.match(result.reply, /konfigürasyon ön kontrolü geçemedi/);
  assert.match(result.reply, /Midscene modeli hazır değil/);
  assert.equal(result.runs[0].config_name, "Web (Chrome)");
  const memory = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ message: "gece regresyonu Örnek Proje web chrome demek" }),
  });
  assert.match((await memory.json()).reply, /belleğe/);
  const again = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ message: "gece regresyonu koş" }),
  });
  const second = await again.json();
  assert.equal(second.runs[0].config_name, "Web (Chrome)");
  const providers = await fetch(`${base}/api/providers`, { headers: { cookie: admin.cookie } });
  const catalog = await providers.json();
  assert.ok(catalog.some((item) => item.id === "bedrock"));
  assert.ok(catalog.some((item) => item.id === "omniroute" && item.base.includes("20128")));
  const status = await fetch(`${base}/api/models/status`, { headers: { cookie: admin.cookie } });
  assert.equal((await status.json()).ready, false);
  const missing = await fetch(`${base}/api/models/select`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ provider: "openai", model: "gpt-4.1" }),
  });
  assert.equal(missing.status, 400);
});

test("chat geçmişi kullanıcıya özeldir, aranır ve koşum adımlarını taşır", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const post = (cookie, message) => fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  }).then((response) => response.json());
  const history = (cookie, q = "") => fetch(`${base}/api/chat/history${q ? `?q=${encodeURIComponent(q)}` : ""}`, { headers: { cookie } });

  const started = await post(admin.cookie, "örnek proje web chrome koş");
  const steps = started.runs[0].cases[0].steps;
  assert.deepEqual(steps.map((step) => step.action), ["launch", "aiAssert", "aiAssert"]);
  assert.equal(steps[0].text, "https://example.com");

  const all = await (await history(admin.cookie)).json();
  const last = all.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.runs[0].id, started.runs[0].id);
  assert.equal(all.at(-2).text, "örnek proje web chrome koş");

  const found = await (await history(admin.cookie, "WEB CHROME")).json();
  assert.ok(found.length >= 2 && found.every((item) => found.some((other) => other.turn === item.turn)));
  assert.equal((await (await history(admin.cookie, "hiç-olmayan-kelime")).json()).length, 0);

  const configs = await (await fetch(`${base}/api/configs`, { headers: { cookie: admin.cookie } })).json();
  const web = configs.find((item) => item.platform === "web");
  assert.equal(web.client_name, "Örnek Proje");
  assert.equal(web.account_policy, "none");
  assert.equal(web.plan.caseCount, 1);
  assert.equal(web.plan.ready, false);
  const json = (path, method, body, cookie = admin.cookie) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  });
  const staging = await (await json("/api/sources", "POST", {
    name: "Staging", type: "http", clientId: null,
    spec: { auth: { type: "none" }, list: { method: "GET", path: "/test-users", params: { environment: "test", isLocked: false, plan: "premium" } } },
  })).json();
  assert.equal((await json(`/api/configs/${web.id}`, "PUT", { accountPolicy: "required", accountSourceId: staging.id })).status, 200);
  const required = (await (await fetch(`${base}/api/configs`, { headers: { cookie: admin.cookie } })).json()).find((item) => item.id === web.id);
  assert.ok(required.plan.issues.some((issue) => /"Staging" hesap kaynağında servis adresi eksik/.test(issue)));
  const update = await json(`/api/configs/${web.id}`, "PUT", { accountPolicy: "optional", caseIds: [], caseTags: ["smoke"] });
  assert.equal(update.status, 200);
  const updated = await (await fetch(`${base}/api/configs`, { headers: { cookie: admin.cookie } })).json();
  const android = configs.find((item) => item.platform === "android");
  const clone = await json("/api/configs", "POST", {
    clientId: android.client_id, cloneOf: android.id, name: "Android Paralel", platform: "android", aliases: ["android paralel"],
    packageId: "com.demo", parallel: 2, deviceSerials: ["UDID-1", "UDID-2"], accountPolicy: "optional",
    accountSourceId: staging.id, accountFilters: { plan: "basic" },
  });
  assert.equal(clone.status, 201);
  const conflict = await json("/api/configs", "POST", { clientId: android.client_id, name: "Çakışan", platform: "android", aliases: ["android"] });
  assert.equal(conflict.status, 400);
  assert.match((await conflict.json()).error, /android.*kullanılıyor/);
  const duplicateName = await json("/api/configs", "POST", { clientId: android.client_id, name: "android paralel", platform: "android" });
  assert.equal(duplicateName.status, 400);
  const fresh = await json("/api/configs", "POST", { client: "Yeni Client", suiteId: "77", name: "Web", platform: "web", launchUrl: "https://example.com", parallel: 3 });
  assert.equal(fresh.status, 201);
  const options = await (await fetch(`${base}/api/config-options`, { headers: { cookie: admin.cookie } })).json();
  assert.ok(options.clients.some((item) => item.name === "Yeni Client" && item.suite_id === "77"));
  assert.deepEqual(options.sources.find((item) => item.id === staging.id).filters, [{ key: "plan", default: "premium" }]);
  assert.ok(!options.sources.flatMap((item) => item.filters).some((field) => /^is[A-Z]/.test(field.key) || field.key === "environment"));
  const listed = await (await fetch(`${base}/api/configs`, { headers: { cookie: admin.cookie } })).json();
  const saved = listed.find((item) => item.name === "Android Paralel");
  assert.deepEqual(JSON.parse(saved.device_serials), ["UDID-1", "UDID-2"]);
  assert.equal(saved.parallel, 2);
  assert.equal(saved.plan.lanes, 1, "tek case olduğu için tek hat");
  assert.deepEqual(JSON.parse(saved.account_filters), { plan: "basic" });
  assert.equal((await json(`/api/configs/${saved.id}`, "PUT", { parallel: 99 })).status, 400);
  assert.equal(listed.find((item) => item.client_name === "Yeni Client").parallel, 3);
  const moved = await json(`/api/configs/${saved.id}`, "PUT", {
    client: "Yeni Proje", suiteId: "88", name: "Android Paralel", platform: "android",
    packageId: "com.demo", parallel: 2, deviceSerials: ["UDID-1", "UDID-2"], accountPolicy: "none",
  });
  assert.equal(moved.status, 200);
  const movedConfig = (await (await fetch(`${base}/api/configs`, { headers: { cookie: admin.cookie } })).json()).find((item) => item.id === saved.id);
  assert.equal(movedConfig.client_name, "Yeni Proje");
  assert.equal((await (await fetch(`${base}/api/config-options`, { headers: { cookie: admin.cookie } })).json()).clients.find((item) => item.name === "Yeni Proje").suite_id, "88");
  assert.equal((await json(`/api/configs/${saved.id}`, "DELETE")).status, 200);
  assert.ok(!(await (await fetch(`${base}/api/configs`, { headers: { cookie: admin.cookie } })).json()).some((item) => item.id === saved.id));
  const updatedWeb = updated.find((item) => item.id === web.id);
  assert.equal(updatedWeb.plan.caseCount, 1, "etiketle seçilen örnek case");
  assert.equal(updatedWeb.plan.ready, false);
  assert.ok(!updatedWeb.plan.issues.some((issue) => issue.includes("hesap kaynağında")));
  assert.ok(updatedWeb.plan.warnings.some((issue) => issue.includes("hesap kaynağında")), "opsiyonel kaynağın eksiği uyarı olarak kalır");
  assert.ok(updatedWeb.plan.issues.some((issue) => issue.includes("Midscene modeli")));

  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "other@example.com", password: "password1" }),
  });
  const users = await (await fetch(`${base}/api/users`, { headers: { cookie: admin.cookie } })).json();
  const other = users.find((item) => item.email === "other@example.com");
  await fetch(`${base}/api/users/${other.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "user" }),
  });
  const user = await login("other@example.com", "password1");
  assert.deepEqual(await (await history(user.cookie)).json(), []);
  assert.equal((await fetch(`${base}/api/sources`, { headers: { cookie: user.cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/sources/templates`, { headers: { cookie: user.cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/sources/test`, { method: "POST", headers: { cookie: user.cookie } })).status, 403);
  assert.equal((await history("")).status, 401);

  const remove = (cookie, path = "") => fetch(`${base}/api/chat/history${path}`, { method: "DELETE", headers: { cookie } });
  await post(user.cookie, "kendi mesajım");
  const adminTurns = await (await history(admin.cookie)).json();
  const firstTurn = adminTurns[0].turn;
  assert.equal((await remove(user.cookie, `/${firstTurn}`)).status, 404, "başkasının konuşması silinemez");
  assert.equal((await remove(admin.cookie, `/${firstTurn}`)).status, 200);
  const remaining = await (await history(admin.cookie)).json();
  assert.ok(!remaining.some((item) => item.turn === firstTurn), "konuşmanın iki mesajı birlikte silinir");
  assert.equal(remaining.length, adminTurns.length - 2);
  const runsBefore = (await (await fetch(`${base}/api/runs`, { headers: { cookie: admin.cookie } })).json()).length;
  assert.equal((await (await remove(admin.cookie)).json()).removed, remaining.length);
  assert.deepEqual(await (await history(admin.cookie)).json(), []);
  assert.equal((await (await fetch(`${base}/api/runs`, { headers: { cookie: admin.cookie } })).json()).length, runsBefore, "koşumlar silinmez");
  assert.equal((await (await history(user.cookie)).json()).length, 2, "diğer kullanıcının geçmişi korunur");

  const say = (cookie, message, conversationId) => fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message, conversationId }),
  }).then((response) => response.json());
  const userTexts = (messages) => messages.filter((item) => item.role === "user").map((item) => item.text);
  const first = await say(admin.cookie, "ilk soru");
  assert.ok(first.conversationId);
  assert.equal((await say(admin.cookie, "devam sorusu", first.conversationId)).conversationId, first.conversationId, "aynı konuşmaya eklenir");
  const topic = await say(admin.cookie, "yeni konu");
  assert.notEqual(topic.conversationId, first.conversationId, "konuşma kimliği yoksa yeni konuşma başlar");
  await say(admin.cookie, "eski konuya dönüş", first.conversationId);
  const grouped = await (await history(admin.cookie)).json();
  assert.deepEqual([...new Set(grouped.map((item) => item.conversation_id))], [topic.conversationId, first.conversationId], "son hareket eden konuşma en sonda");
  const opened = await (await fetch(`${base}/api/chat/history/${first.conversationId}`, { headers: { cookie: admin.cookie } })).json();
  assert.deepEqual(userTexts(opened), ["ilk soru", "devam sorusu", "eski konuya dönüş"]);
  assert.equal(opened.filter((item) => item.role === "assistant").length, 3);
  assert.deepEqual(userTexts(await (await history(admin.cookie, "DEVAM SORUSU")).json()), ["ilk soru", "devam sorusu", "eski konuya dönüş"], "arama konuşmanın tamamını getirir");
  assert.equal((await fetch(`${base}/api/chat/history/${first.conversationId}`, { headers: { cookie: user.cookie } })).status, 404, "başkasının konuşması açılamaz");
  assert.notEqual((await say(user.cookie, "araya girme", first.conversationId)).conversationId, first.conversationId, "başkasının konuşmasına yazılamaz");
  assert.deepEqual(userTexts(await (await fetch(`${base}/api/chat/history/${first.conversationId}`, { headers: { cookie: admin.cookie } })).json()).length, 3);
  assert.equal((await remove(admin.cookie, `/${first.conversationId}`)).status, 200);
  assert.deepEqual(userTexts(await (await history(admin.cookie)).json()), ["yeni konu"], "silme konuşmanın tüm mesajlarını kaldırır");
});

test("hesap kaynağı her projeye göre tanımlanır: ortak liste başka projede kullanılır, silme korunur", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const call = (path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", cookie: admin.cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const templates = await (await call("/api/sources/templates")).json();
  assert.ok(templates.some((item) => item.template === "rest-login" && item.spec.auth.type === "login"));
  assert.ok(templates.every((item) => item.base_url === ""), "şablonlar hiçbir şirketin adresini taşımaz");
  assert.equal((await call("/api/sources/test", "POST", { name: "Boş", type: "manual", accounts: "" })).status, 400);
  const checked = await (await call("/api/sources/test", "POST", { name: "QA", type: "manual", accounts: "qa1@acme.io, Gizli-1\nqa2@acme.io, Gizli-2" })).json();
  assert.match(checked.message, /2 hesap/);

  const created = await call("/api/sources", "POST", { name: "Acme QA", type: "manual", clientId: null, useMode: "reuse", accounts: "qa1@acme.io, Gizli-1\nqa2@acme.io, Gizli-2" });
  assert.equal(created.status, 201);
  const { id: sourceId } = await created.json();
  const sources = await (await call("/api/sources")).json();
  const shared = sources.find((item) => item.id === sourceId);
  assert.equal(shared.client_id, null);
  assert.deepEqual(shared.accounts, { total: 2, available: 2 });
  assert.doesNotMatch(JSON.stringify(sources), /Gizli-/);
  assert.doesNotMatch(JSON.stringify(await (await call(`/api/sources/${sourceId}/accounts`)).json()), /Gizli-/);

  const acme = await (await call("/api/configs", "POST", { client: "Acme", name: "Acme Web", platform: "web", launchUrl: "https://acme.io", accountPolicy: "required", accountSourceId: sourceId })).json();
  const config = (await (await call("/api/configs")).json()).find((item) => item.id === acme.id);
  assert.ok(!config.plan.issues.some((issue) => /hesap kaynağ/.test(issue)), "ortak ve hazır kaynak engel oluşturmaz");
  const options = await (await call("/api/config-options")).json();
  assert.ok(options.sources.some((item) => item.id === sourceId && item.ready));

  const blocked = await call(`/api/sources/${sourceId}`, "DELETE");
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Acme Web/);
  const narrowed = await call(`/api/sources/${sourceId}`, "PUT", { name: "Acme QA", type: "manual", clientId: options.clients.find((item) => item.name === "Örnek Proje").id });
  assert.equal(narrowed.status, 400, "kullanan başka client varken kapsam daraltılamaz");
  await call(`/api/configs/${acme.id}`, "PUT", { accountPolicy: "none", accountSourceId: null });
  assert.equal((await call(`/api/sources/${sourceId}`, "DELETE")).status, 200);
});

test("TestRail bağlanınca tüm projelerin suite'leri listelenir, suite seçilince proje TestRail projesiyle eklenir", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const call = (path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", cookie: admin.cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const runsOpened = [];
  const fake = createServer(async (req, res) => {
    const auth = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    const path = decodeURIComponent(req.url.split("?")[1] || "");
    const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (auth !== "qa@acme.io:tr-key") return reply(401, { error: "Authentication failed" });
    if (path.startsWith("/api/v2/get_projects") && !path.includes("offset=")) {
      return reply(200, { offset: 0, size: 1, _links: { next: "/api/v2/get_projects&is_completed=0&limit=1&offset=1" }, projects: [{ id: 3, name: "Mobil", suite_mode: 1 }] });
    }
    if (path.startsWith("/api/v2/get_projects")) return reply(200, { offset: 1, size: 1, _links: { next: null }, projects: [{ id: 5, name: "Web", suite_mode: 3 }] });
    if (path === "/api/v2/get_suites/3") return reply(200, [{ id: 31, name: "Master" }]);
    if (path === "/api/v2/get_suites/5") return reply(200, [{ id: 51, name: "Giriş" }, { id: 52, name: "Sepet" }, { id: 53, name: "Eski", is_completed: true }]);
    const run = path.match(/^\/api\/v2\/add_run\/(\d+)$/);
    if (run && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      runsOpened.push({ project: run[1], ...JSON.parse(Buffer.concat(chunks).toString()) });
      return reply(200, { id: 700 + runsOpened.length });
    }
    return reply(404, { error: "unknown" });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${fake.address().port}/`;
  try {
    assert.match((await (await call("/api/settings/testrail-suites")).json()).reason, /eksik/);
    await call("/api/settings", "PUT", { testrail_host: host, testrail_user: "qa@acme.io", testrail_api_key: "wrong" });
    const denied = await call("/api/settings/testrail-test", "POST");
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error, /401/);

    await call("/api/settings", "PUT", { testrail_api_key: "tr-key" });
    const tested = await (await call("/api/settings/testrail-test", "POST")).json();
    assert.deepEqual(tested.projects, [{ id: "3", name: "Mobil", suiteMode: 1 }, { id: "5", name: "Web", suiteMode: 3 }], "sayfalı yanıtın tüm sayfaları okunur");
    assert.deepEqual((await (await call("/api/settings/testrail-projects")).json()).projects.map((item) => item.id), ["3", "5"]);

    const all = (await (await call("/api/settings/testrail-suites")).json()).suites;
    assert.deepEqual(all.map((item) => [item.project_id, item.id, item.name]), [["3", "31", "Master"], ["5", "51", "Giriş"], ["5", "52", "Sepet"]],
      "Tüm projeler seçiliyken her projenin açık suite'leri gelir");
    assert.equal(all[0].project_name, "Mobil");
    assert.equal(all[0].suite_mode, 1);

    await call("/api/settings", "PUT", { testrail_project_id: "5" });
    const scoped = (await (await call("/api/settings/testrail-suites")).json()).suites;
    assert.deepEqual(scoped.map((item) => item.id), ["51", "52"], "tek proje seçilince yalnız onun suite'leri gelir");
    await call("/api/settings", "PUT", { testrail_project_id: "99" });
    assert.match((await (await call("/api/settings/testrail-suites")).json()).reason, /#99/);
    await call("/api/settings", "PUT", { testrail_project_id: "" });

    const created = await call("/api/configs", "POST", { client: "Mobil", suiteId: "31", projectId: "3", name: "Mobil Web", platform: "web", launchUrl: "https://acme.io" });
    assert.equal(created.status, 201);
    const project = (await (await call("/api/config-options")).json()).clients.find((item) => item.name === "Mobil");
    assert.deepEqual([project.suite_id, project.project_id], ["31", "3"], "suite ve TestRail projesi Mercury projesine yazılır");
    const config = (await (await call("/api/configs")).json()).find((item) => item.client_name === "Mobil");
    assert.equal(config.testrail_project_id, "3");
    const after = (await (await call("/api/settings/testrail-suites")).json()).suites;
    assert.equal(after.find((item) => item.id === "31").client_id, project.id, "eklenen suite projeye bağlı görünür");
    assert.equal(after.find((item) => item.id === "51").client_id, null);

    const clash = await call("/api/configs", "POST", { client: "Mobil", suiteId: "51", projectId: "5", name: "Başka", platform: "web" });
    assert.equal(clash.status, 400, "aynı adlı proje başka bir suite'i yutmaz");
    assert.match((await clash.json()).error, /başka bir TestRail suite/);

    const settingsFor = { testrail_host: host, testrail_user: "qa@acme.io", testrail_api_key: "tr-key", testrail_project_id: "5" };
    await addRun(settingsFor, { projectId: "3", suiteId: "31", name: "r1", caseIds: [1] });
    await addRun(settingsFor, { suiteId: "51", name: "r2", caseIds: [2] });
    assert.deepEqual(runsOpened.map((item) => [item.project, item.suite_id]), [["3", 31], ["5", 51]], "run projenin TestRail projesinde, yoksa varsayılanda açılır");
    assert.equal((await call(`/api/configs/${(await created.json()).id}`, "DELETE")).status, 200);
  } finally {
    await call("/api/settings", "PUT", { testrail_host: "", testrail_user: "", testrail_api_key: "", testrail_project_id: "" });
    fake.close();
  }
});

test("koşum silinir: admin hepsini, kullanıcı yalnız kendisininkini; aktif koşum korunur, rapor ve chat bağlantısı kalkar", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const call = (cookie, path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  await call("", "/api/auth/register", "POST", { email: "runner@example.com", password: "password1" });
  const users = await (await call(admin.cookie, "/api/users")).json();
  await call(admin.cookie, `/api/users/${users.find((item) => item.email === "runner@example.com").id}/approve`, "POST", { role: "user" });
  const user = await login("runner@example.com", "password1");
  const start = async (cookie) => (await (await call(cookie, "/api/chat", "POST", { message: "Örnek Proje web chrome koş" })).json()).runs[0];

  const adminRun = await start(admin.cookie);
  const userRun = await start(user.cookie);
  const listed = await (await call(user.cookie, "/api/runs")).json();
  assert.equal(listed.find((item) => item.id === adminRun.id).can_delete, false);
  assert.equal(listed.find((item) => item.id === userRun.id).can_delete, true);
  assert.equal(listed[0].started_by, undefined, "kullanıcı kimliği listede dönmez");
  assert.equal((await call(user.cookie, `/api/runs/${adminRun.id}`, "DELETE")).status, 403, "başkasının koşumu silinemez");

  const folder = join(dir, "reports", String(userRun.id));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.html"), "<html>rapor</html>");
  assert.equal((await call(user.cookie, `/api/runs/${userRun.id}`, "DELETE")).status, 200);
  assert.equal((await call(user.cookie, `/api/runs/${userRun.id}`)).status, 404);
  assert.equal(existsSync(folder), false, "yerel rapor da silinir");
  assert.equal((await call(user.cookie, `/api/runs/${userRun.id}`, "DELETE")).status, 404);
  const turn = (await (await call(user.cookie, "/api/chat/history")).json()).find((item) => item.role === "assistant");
  assert.deepEqual(turn.runs, [], "chat geçmişi silinen koşumu göstermez");

  const db = new DatabaseSync(join(dir, "mercury.sqlite"));
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(adminRun.id);
  assert.equal((await call(admin.cookie, `/api/runs/${adminRun.id}`, "DELETE")).status, 409, "çalışan koşum silinmez");
  db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(adminRun.id);
  db.close();
  assert.equal((await call(admin.cookie, `/api/runs/${adminRun.id}`, "DELETE")).status, 200, "admin herkesin koşumunu siler");
});

test("koşum listesi her koşumun case sayılarını durumlarına göre döndürür", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const call = (path) => fetch(`${base}${path}`, { headers: { cookie: admin.cookie } }).then((response) => response.json());
  const run = (await (await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify({ message: "Örnek Proje web chrome koş" }),
  })).json()).runs[0];
  const empty = (await call("/api/runs")).find((item) => item.id === run.id);
  assert.deepEqual(empty.case_counts, { total: 0, passed: 0, failed: 0, blocked: 0, running: 0 });

  const db = new DatabaseSync(join(dir, "mercury.sqlite"));
  const insert = db.prepare("INSERT INTO run_cases (run_id, case_key, title, status) VALUES (?, ?, ?, ?)");
  ["passed", "passed", "passed", "failed", "blocked", "running"].forEach((status, index) => insert.run(run.id, String(index), `Case ${index}`, status));
  db.close();
  const listed = (await call("/api/runs")).find((item) => item.id === run.id);
  assert.deepEqual(listed.case_counts, { total: 6, passed: 3, failed: 1, blocked: 1, running: 1 });
});

test("QA becerileri: admin listeler, özel beceri ekler, yerleşiği ezer ve siler; user erişemez", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const call = (cookie, path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  await call("", "/api/auth/register", "POST", { email: "skills@example.com", password: "password1" });
  const users = await (await call(admin.cookie, "/api/users")).json();
  await call(admin.cookie, `/api/users/${users.find((item) => item.email === "skills@example.com").id}/approve`, "POST", { role: "user" });
  const user = await login("skills@example.com", "password1");

  const listed = await (await call(admin.cookie, "/api/skills")).json();
  const core = listed.find((skill) => skill.id === "qa-core");
  assert.deepEqual([core.source, core.always, core.overrides], ["builtin", true, false]);
  assert.match(core.text, /^---\nname: QA çekirdeği/);
  assert.equal((await call(user.cookie, "/api/skills")).status, 403);
  assert.equal((await call(user.cookie, "/api/skills/proje", "PUT", { text: "---\ntriggers: x\n---\ny" })).status, 403);

  assert.equal((await call(admin.cookie, "/api/skills/..%2Fetc", "PUT", { text: "---\ntriggers: x\n---\ny" })).status, 400, "dosya yolu kaçışı reddedilir");
  assert.equal((await call(admin.cookie, "/api/skills/proje", "PUT", { text: "tetikleyicisiz metin" })).status, 400, "seçilemeyecek beceri kaydedilmez");
  const saved = await (await call(admin.cookie, "/api/skills/proje-giris", "PUT", { text: "---\nname: Proje girişi\ntriggers: giris\n---\nGiriş Hesabım menüsünde." })).json();
  assert.deepEqual(saved.find((skill) => skill.id === "proje-giris")?.source, "custom");
  const overridden = await (await call(admin.cookie, "/api/skills/auth-login", "PUT", { text: "---\nname: Bizim giriş\ntriggers: login\n---\nÖzel." })).json();
  assert.deepEqual(overridden.filter((skill) => skill.id === "auth-login").map((skill) => [skill.name, skill.overrides]), [["Bizim giriş", true]]);
  const reverted = await (await call(admin.cookie, "/api/skills/auth-login", "DELETE")).json();
  assert.equal(reverted.find((skill) => skill.id === "auth-login").source, "builtin", "özel kopya silinince yerleşik geri gelir");
  assert.equal((await call(admin.cookie, "/api/skills/qa-core", "DELETE")).status, 404, "yerleşik beceri silinmez");
  assert.equal((await call(admin.cookie, "/api/skills/proje-giris", "DELETE")).status, 200);
});

test("Jira kaydı chat'te okunur ve QA ajanına gider; token maskelenir, bağlantı testi çalışır", async () => {
  await ready();
  const admin = await login("mercury@test.com", "Mercury");
  const call = (path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", cookie: admin.cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const modelBodies = [];
  const fake = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith("/v1/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      modelBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      return reply(200, { choices: [{ message: { content: '{"intent":"reply","reply":"PROJ-7 iki kabul kriteri içeriyor."}' } }] });
    }
    if (req.headers.authorization !== "Bearer pat-jira") return reply(401, {});
    if (req.url.startsWith("/rest/api/2/myself")) return reply(200, { displayName: "QA Bot" });
    if (req.url.startsWith("/rest/api/2/issue/PROJ-7/remotelink")) return reply(200, []);
    if (req.url.startsWith("/rest/api/2/issue/PROJ-7")) {
      return reply(200, { key: "PROJ-7", names: { customfield_1: "Kabul Kriterleri" }, fields: { summary: "Şifre sıfırlama", description: "Kullanıcı şifresini sıfırlar.", customfield_1: "Bağlantı e-postayla gelir" } });
    }
    return reply(404, { errorMessages: ["Issue does not exist"] });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${fake.address().port}`;
  try {
    assert.equal((await call("/api/settings/atlassian-test", "POST")).status, 400, "ayar yokken bağlantı testi hata verir");
    const saved = await (await call("/api/settings", "PUT", { jira_host: host, jira_user: "", jira_api_token: "pat-jira" })).json();
    assert.notEqual(saved.jira_api_token, "pat-jira", "token yanıtta maskelenir");
    const checked = await (await call("/api/settings/atlassian-test", "POST")).json();
    assert.deepEqual([checked.ok, checked.jiraUser, checked.confluence], [true, "QA Bot", "missing"]);

    const missing = await (await call("/api/chat", "POST", { message: "PROJ-99 task'ı için test case çıkar ve koş" })).json();
    assert.match(missing.reply, /Jira\/Confluence kaydı okunamadı:\nPROJ-99: Jira'da bu kayıt yok/);
    const noModel = await (await call("/api/chat", "POST", { message: "PROJ-7 için test case çıkar ve koş" })).json();
    assert.match(noModel.reply, /PROJ-7 okundu, ama test case çıkarmak için bir model bağlı olmalı/);

    await call("/api/settings", "PUT", { model_provider: "custom", model_base_url: `${host}/v1`, model_api_key: "model-key", model_name: "gpt-5-mini" });
    const first = await (await call("/api/chat", "POST", { message: "PROJ-7'ye bir bakalım" })).json();
    const followUp = await (await call("/api/chat", "POST", { message: "bu task için test case çıkart ve koş", conversationId: first.conversationId })).json();
    assert.equal(followUp.reply, "PROJ-7 iki kabul kriteri içeriyor.");
    assert.deepEqual(followUp.references, [{ kind: "jira", key: "PROJ-7", url: `${host}/browse/PROJ-7`, title: "Şifre sıfırlama" }]);
    const sent = JSON.parse(modelBodies.at(-1).messages[1].content);
    assert.equal(sent.references[0].key, "PROJ-7", "'bu task' önceki mesajdaki kaydı bulur");
    assert.match(sent.references[0].text, /Kabul Kriterleri:\nBağlantı e-postayla gelir/);
    assert.doesNotMatch(JSON.stringify(modelBodies), /pat-jira/, "Jira token'ı modele gitmez");
  } finally {
    await call("/api/settings", "PUT", { jira_host: "", jira_api_token: "", model_provider: "", model_base_url: "", model_api_key: "", model_name: "" });
    fake.close();
  }
});
