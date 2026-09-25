import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createAccountStore, fetchHttpAccount, filterFields, normalizeSourceInput, normalizeSpec, parseAccountLines } from "../src/accounts.mjs";
import { openDb, seed, accountTemplates } from "../src/db.mjs";

const hits = [];
const service = createServer(async (req, res) => {
  const url = new URL(req.url, "http://svc");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  hits.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
  const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (url.pathname === "/login") {
    return body?.user === "svc" && body?.pass === "s3cret" ? reply(200, { data: { accessToken: "tok-1" } }) : reply(401, { message: "bad login" });
  }
  if (url.pathname === "/users") {
    const auth = req.headers.authorization || req.headers["x-api-key"] || "";
    if (!["Bearer tok-1", "key-9", `Basic ${Buffer.from("svc:s3cret").toString("base64")}`].includes(auth)) return reply(403, { message: "no auth" });
    return reply(200, { result: { items: [
      { uid: 7, login: "a@t", secret: "pa", tel: "1", profile: { pin: "1111" } },
      { uid: 8, login: "b@t", secret: "pb", tel: "2", profile: { pin: "2222" } },
    ] } });
  }
  if (url.pathname.startsWith("/users/") && req.method === "PATCH") return reply(200, { ok: true });
  if (url.pathname === "/legacy/api/auth") return reply(200, { token: "lt" });
  if (url.pathname === "/legacy/api/package-users") return reply(200, [{ _id: "x1", email: "old@t", password: "p", phoneNumber: "5" }]);
  return reply(404, { message: "nope" });
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${service.address().port}`;
after(() => service.close());

const genericSpec = {
  auth: { type: "login", method: "POST", path: "/login", body: { user: "{{username}}", pass: "{{password}}" }, tokenPath: "data.accessToken", tokenHeader: "Authorization", tokenPrefix: "Bearer " },
  list: { method: "GET", path: "/users", params: { environment: "test", isFree: true, plan: "basic" }, itemsPath: "result.items" },
  fields: { email: "login", password: "secret", phone: "tel", id: "uid" },
  extras: { pin: "profile.pin" },
  markUsed: { method: "PATCH", path: "/users/{{id}}", body: { owner: "mercury", user: "{{email}}" } },
};

test("genel HTTP servis: giriş token'ı, liste yolu, alan eşlemesi, ek alanlar ve kullanıldı işareti", async () => {
  hits.length = 0;
  const source = { id: 1, base_url: `${base}/`, spec: genericSpec };
  const account = await fetchHttpAccount(source, { username: "svc", password: "s3cret" }, { environment: "regression", filters: { plan: "premium", isFree: "false" } });
  assert.deepEqual({ ...account }, { email: "a@t", password: "pa", phone: "1", id: "7", extras: { pin: "1111" }, lockKey: "1:7" });
  const [login, list, mark] = hits;
  assert.deepEqual(login.body, { user: "svc", pass: "s3cret" });
  assert.equal(list.headers.authorization, "Bearer tok-1");
  assert.deepEqual(list.query, { environment: "regression", isFree: "true", plan: "premium" }, "ortam konfigürasyondan, is* bayrakları filtrelenemez");
  assert.equal(mark.method, "PATCH");
  assert.equal(mark.path, "/users/7");
  assert.deepEqual(mark.body, { owner: "mercury", user: "a@t" });

  const second = await fetchHttpAccount(source, { username: "svc", password: "s3cret" }, { exclude: new Set(["1:7"]), markUsed: false });
  assert.equal(second.email, "b@t", "başka hatta verilen hesap atlanır");
  await assert.rejects(fetchHttpAccount(source, { username: "svc", password: "s3cret" }, { exclude: new Set(["1:7", "1:8"]) }), /başka koşumlarda/);
  await assert.rejects(fetchHttpAccount(source, { username: "svc", password: "yanlis" }), /Servis girişi: HTTP 401 · bad login/);
});

test("API anahtarı ve basic auth desteklenir; sır hata mesajına sızmaz", async () => {
  const listOnly = { ...genericSpec, markUsed: null };
  const header = await fetchHttpAccount({ id: 2, base_url: base, spec: { ...listOnly, auth: { type: "header", tokenHeader: "x-api-key" } } }, { secret: "key-9" });
  assert.equal(header.email, "a@t");
  const basic = await fetchHttpAccount({ id: 3, base_url: base, spec: { ...listOnly, auth: { type: "basic" } } }, { username: "svc", password: "s3cret" });
  assert.equal(basic.id, "7");
  const error = await fetchHttpAccount({ id: 4, base_url: base, spec: { ...listOnly, auth: { type: "header", tokenHeader: "x-api-key" } } }, { secret: "wrong-key-XYZ" }).catch((err) => err);
  assert.match(error.message, /HTTP 403/);
  assert.doesNotMatch(error.message, /wrong-key-XYZ/);
});

// The shape older installations stored: top-level tokenHeader/tokenPath, list.query, {{serviceEmail}} variables.
const legacySpec = {
  auth: { method: "POST", path: "/api/auth", body: { email: "{{serviceEmail}}", password: "{{servicePassword}}" } },
  tokenHeader: "x-auth-token",
  tokenPath: "token",
  list: { method: "GET", path: "/api/package-users", query: { isLocked: "false", isValid: "true", userPackage: "FULL", environment: "TEST", userType: "" } },
  fields: { email: "email", password: "password", phone: "phoneNumber", id: "_id" },
};

test("eski kurulumların kaynak biçimi değişmeden çalışır ve filtre alanları çıkarılır", async () => {
  const spec = normalizeSpec(legacySpec);
  assert.equal(spec.auth.type, "login");
  assert.equal(spec.auth.tokenHeader, "x-auth-token");
  assert.deepEqual(filterFields(spec).map((field) => field.key), ["userPackage", "userType"]);
  hits.length = 0;
  const account = await fetchHttpAccount({ id: 5, base_url: `${base}/legacy`, spec }, { username: "u", password: "p" }, { markUsed: false, filters: { userPackage: "SPORT" } });
  assert.equal(account.email, "old@t");
  assert.deepEqual(hits[0].body, { email: "u", password: "p" }, "{{serviceEmail}} eski değişkeni çalışır");
  assert.equal(hits[1].headers["x-auth-token"], "lt");
  assert.equal(hits[1].query.userPackage, "SPORT");
  assert.equal(hits[1].query.environment, "test");
});

function store() {
  const db = openDb(mkdtempSync(join(tmpdir(), "mtr-src-")));
  seed(db);
  return { db, accounts: createAccountStore({ db, key: randomBytes(32) }) };
}

test("elle girilen liste: tekrar kullanılabilir hesaplar sırayla döner, kilitli hesap verilmez", async () => {
  const { db, accounts } = store();
  const id = accounts.save(normalizeSourceInput({ name: "QA listesi", type: "manual", accounts: "a@x, p1, 555\nb@x;p2\nc@x\tp3" }));
  const source = accounts.sourceById(id);
  assert.deepEqual(accounts.status(source), { ready: true, issue: "" });
  const first = await accounts.acquire(source);
  const second = await accounts.acquire(source, { exclude: new Set([first.lockKey]) });
  assert.deepEqual([first.email, first.password, first.phone], ["a@x", "p1", "555"]);
  assert.equal(second.email, "b@x");
  const third = await accounts.acquire(source, { exclude: new Set([first.lockKey, second.lockKey]) });
  assert.equal(third.password, "p3");
  await assert.rejects(accounts.acquire(source, { exclude: new Set([first.lockKey, second.lockKey, third.lockKey]) }), /başka koşumlarda/);
  const again = await accounts.acquire(source);
  assert.equal(again.email, "a@x", "en uzun süredir kullanılmayan hesap önce gelir");
  const stored = db.prepare("SELECT password FROM source_accounts WHERE source_id = ?").all(id).map((row) => row.password);
  assert.ok(stored.every((value) => value.startsWith("v1$")), "şifreler şifreli saklanır");
});

test("tek kullanımlık liste tükenir, sıfırlanır; maskeli şifre korunur, kopya şifreleri taşır", async () => {
  const { accounts } = store();
  const id = accounts.save(normalizeSourceInput({ name: "Tek", type: "manual", useMode: "once", accounts: "a@x, p1\nb@x, p2" }));
  let source = accounts.sourceById(id);
  await accounts.acquire(source);
  await accounts.acquire(source);
  assert.deepEqual(accounts.status(source), { ready: false, issue: "kullanılabilir hesap kalmadı" });
  assert.equal(accounts.resetUsed(id), 2);

  const masked = accounts.accountLines(id).map((line) => `${line.email}, ${line.password}`).join("\n");
  accounts.save(normalizeSourceInput({ name: "Tek", type: "manual", useMode: "once", accounts: `${masked}\nc@x, p3` }), { id });
  source = accounts.sourceById(id);
  const passwords = [];
  for (let index = 0; index < 3; index += 1) passwords.push((await accounts.acquire(source)).password);
  assert.deepEqual(passwords.sort(), ["p1", "p2", "p3"]);
  assert.throws(() => accounts.save(normalizeSourceInput({ name: "Tek", type: "manual", accounts: "yeni@x, ••••••••" }), { id }), /yeni@x için şifre gir/);

  const copy = accounts.save(normalizeSourceInput({ name: "Tek kopya", type: "manual", accounts: masked }), { cloneOf: id });
  assert.equal((await accounts.acquire(accounts.sourceById(copy))).password, "p1");
});

test("HTTP kaynak: giriş bilgileri kaynağa özel şifreli saklanır, listede maskelenir, eksikse hazır sayılmaz", () => {
  const { db, accounts } = store();
  const input = { name: "Staging", type: "http", baseUrl: base, spec: genericSpec, credentials: { username: "svc", password: "" } };
  const id = accounts.save(normalizeSourceInput(input));
  assert.deepEqual(accounts.status(accounts.sourceById(id)), { ready: false, issue: "servis giriş bilgileri eksik" });
  accounts.save(normalizeSourceInput({ ...input, credentials: { username: "svc", password: "s3cret" } }), { id });
  accounts.save(normalizeSourceInput({ ...input, credentials: { username: "svc", password: "••••••••cret" } }), { id });
  assert.equal(accounts.sourceById(id).credentials.password, "s3cret", "maskeli değer kayıtlı şifreyi korur");
  const listed = accounts.list().find((item) => item.id === id);
  assert.equal(listed.ready, true);
  assert.equal(listed.client_id, null, "kapsam boşsa kaynak tüm client'lara ortaktır");
  assert.doesNotMatch(JSON.stringify(accounts.list()), /s3cret/);
  assert.doesNotMatch(db.prepare("SELECT credentials FROM sources WHERE id = ?").get(id).credentials, /s3cret/);
  assert.throws(() => accounts.save(normalizeSourceInput({ ...input })), /zaten var/);
  assert.throws(() => normalizeSourceInput({ ...input, baseUrl: "ftp://x" }), /http/);
  assert.throws(() => normalizeSourceInput({ ...input, spec: { ...genericSpec, list: { path: "users" } } }), /\/ ile başlamalı/);
  assert.throws(() => normalizeSourceInput({ ...input, spec: { ...genericSpec, list: { path: "/u", params: "{bozuk" } } }), /geçerli JSON değil/);

  const config = db.prepare("SELECT id FROM configs LIMIT 1").get();
  db.prepare("UPDATE configs SET account_source_id = ? WHERE id = ?").run(id, config.id);
  assert.throws(() => accounts.remove(id), /konfigürasyonlardan kaynağı kaldır/);
  db.prepare("UPDATE configs SET account_source_id = NULL WHERE id = ?").run(config.id);
  accounts.remove(id);
  assert.equal(accounts.sourceById(id), undefined);
});

test("hesap satırları sekme, noktalı virgül ve virgülle ayrılır", () => {
  assert.deepEqual(parseAccountLines("a@x, p, 1\n\n b ; q \nc\tr,with,comma\t2"), [
    { email: "a@x", password: "p", phone: "1" },
    { email: "b", password: "q", phone: "" },
    { email: "c", password: "r,with,comma", phone: "2" },
  ]);
  assert.throws(() => normalizeSourceInput({ name: "x", type: "manual", accounts: "a, 1\nA, 2" }), /iki kez/);
});

test("hazır şablonlar geneldir: adres taşımaz ve hepsi geçerli bir kaynak tanımıdır", () => {
  const templates = accountTemplates();
  assert.deepEqual(templates.map((item) => item.spec.auth.type ?? "none"), ["login", "header", "basic", "none"]);
  for (const template of templates) {
    assert.equal(template.base_url, "");
    const spec = normalizeSpec(template.spec);
    assert.equal(spec.list.path, "/test-users");
    assert.deepEqual(filterFields(spec), [], "hazır şablonda yalnız ortam ve is* bayrakları var");
  }
});

test("yeni kurulumda yalnız nötr örnek proje gelir, silinirse bir daha eklenmez", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "mtr-seed-")));
  seed(db);
  assert.deepEqual(db.prepare("SELECT name FROM clients").all().map((row) => row.name), ["Örnek Proje"]);
  assert.deepEqual(db.prepare("SELECT platform FROM configs ORDER BY id").all().map((row) => row.platform), ["web", "android", "ios"]);
  assert.equal(db.prepare("SELECT launch_url FROM configs WHERE platform = 'web'").get().launch_url, "https://example.com");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sources").get().n, 0);
  db.prepare("DELETE FROM configs").run();
  db.prepare("DELETE FROM clients").run();
  seed(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients").get().n, 0);
});
