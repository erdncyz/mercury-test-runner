import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";

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
});

test("hesap kaynağı her projeye göre tanımlanır: ortak liste başka client'ta kullanılır, silme korunur", async () => {
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
