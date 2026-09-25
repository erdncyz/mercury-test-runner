import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, seed } from "../src/db.mjs";
import { encrypt, loadAppKey } from "../src/security.mjs";

// Installs from before per-source credentials kept one global login; the server must move it onto the sources.
test("eski genel test hesap servisi girişi kaynaklara taşınır ve ayarlardan silinir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mtr-mig-"));
  const key = loadAppKey(dir);
  const db = openDb(dir);
  seed(db);
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  set.run("account_service_email", "legacy@svc");
  set.run("account_service_password", encrypt(key, "legacy-pass"));
  set.run("account_base_url", "https://legacy.example");
  const legacy = JSON.stringify({ auth: { method: "POST", path: "/api/auth", body: { email: "{{serviceEmail}}", password: "{{servicePassword}}" } }, tokenHeader: "x-auth-token", list: { method: "GET", path: "/api/users" } });
  const addSource = db.prepare("INSERT INTO sources (client_id, name, template, base_url, spec_json) VALUES (NULL, ?, '', ?, ?)");
  addSource.run("Eski servis A", "", legacy);
  addSource.run("Eski servis B", "https://b.example", legacy);
  db.close();

  const port = 19100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, REPORTS_DIR: join(dir, "reports") },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i += 1) {
      if (await fetch(`${base}/api/health`).then((res) => res.ok, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mercury@test.com", password: "Mercury" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const sources = await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json();
    assert.equal(sources.length, 2);
    assert.ok(sources.every((item) => item.credentials.username === "legacy@svc" && item.credentials.password.endsWith("pass")));
    assert.equal(sources.find((item) => item.name === "Eski servis A").base_url, "https://legacy.example");
    assert.equal(sources.find((item) => item.name === "Eski servis B").base_url, "https://b.example", "kendi adresi olan kaynağa dokunulmaz");
    assert.ok(sources.every((item) => item.ready));
    const settings = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
    assert.equal(settings.account_service_email, undefined);
    assert.equal(settings.account_service_password, undefined);
  } finally {
    child.kill();
  }
});

test("genel bekleme süresi konfigürasyonlara taşınır, Android/iOS genel sınırları silinir", () => {
  const dir = mkdtempSync(join(tmpdir(), "mtr-mig2-"));
  let db = openDb(dir);
  seed(db);
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  set.run("device_wait_minutes", "90");
  set.run("android_concurrency", "3");
  set.run("ios_concurrency", "1");
  db.exec("ALTER TABLE configs DROP COLUMN device_wait_minutes");
  db.close();

  db = openDb(dir);
  assert.deepEqual([...new Set(db.prepare("SELECT device_wait_minutes AS m FROM configs").all().map((row) => row.m))], [90]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('device_wait_minutes', 'android_concurrency', 'ios_concurrency')").get().n, 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'web_concurrency'").get().value, "2", "sunucunun tarayıcı sınırı kalır");
  db.close();
});
