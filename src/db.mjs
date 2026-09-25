import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "./security.mjs";

const SECRET_KEYS = new Set([
  "model_api_key",
  "model_aws_access_key",
  "model_aws_secret",
  "model_aws_session",
  "testrail_api_key",
  "farm_token",
  "account_service_password",
]);

export { SECRET_KEYS };

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "mercury.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      suite_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS configs (
      id INTEGER PRIMARY KEY,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      platform TEXT NOT NULL,
      farm_type TEXT NOT NULL DEFAULT '',
      device_filter TEXT NOT NULL DEFAULT '',
      app_url TEXT NOT NULL DEFAULT '',
      package_id TEXT NOT NULL DEFAULT '',
      launch_url TEXT NOT NULL DEFAULT '',
      regression INTEGER NOT NULL DEFAULT 0,
      environment TEXT NOT NULL DEFAULT 'test',
      account_source_id INTEGER,
      account_policy TEXT NOT NULL DEFAULT 'none',
      case_ids TEXT NOT NULL DEFAULT '[]',
      case_tags TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      client_id INTEGER,
      name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      spec_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      match_phrase TEXT NOT NULL DEFAULT '',
      config_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      client_name TEXT NOT NULL,
      config_id INTEGER,
      config_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      testrail_run_id TEXT NOT NULL DEFAULT '',
      testrail_plan_id TEXT NOT NULL DEFAULT '',
      started_by INTEGER,
      device_label TEXT NOT NULL DEFAULT '',
      account_email TEXT NOT NULL DEFAULT '',
      report_dir TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS run_cases (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL,
      case_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      turn INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      run_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_user ON chat_messages (user_id, id);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const runCaseColumns = db.prepare("PRAGMA table_info(run_cases)").all().map((column) => column.name);
  if (!runCaseColumns.includes("steps_json")) db.exec("ALTER TABLE run_cases ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]'");
  // With parallel lanes each case runs with its own test user; the run row only holds the combined list.
  if (!runCaseColumns.includes("account_email")) db.exec("ALTER TABLE run_cases ADD COLUMN account_email TEXT NOT NULL DEFAULT ''");
  const configColumns = new Set(db.prepare("PRAGMA table_info(configs)").all().map((column) => column.name));
  const configMigrations = {
    environment: "ALTER TABLE configs ADD COLUMN environment TEXT NOT NULL DEFAULT 'test'",
    account_source_id: "ALTER TABLE configs ADD COLUMN account_source_id INTEGER",
    account_policy: "ALTER TABLE configs ADD COLUMN account_policy TEXT NOT NULL DEFAULT 'none'",
    case_ids: "ALTER TABLE configs ADD COLUMN case_ids TEXT NOT NULL DEFAULT '[]'",
    case_tags: "ALTER TABLE configs ADD COLUMN case_tags TEXT NOT NULL DEFAULT '[]'",
    enabled: "ALTER TABLE configs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
  };
  for (const [column, statement] of Object.entries(configMigrations)) {
    if (!configColumns.has(column)) db.exec(statement);
  }
  const runColumns = new Set(db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name));
  if (!runColumns.has("device_hint")) db.exec("ALTER TABLE runs ADD COLUMN device_hint TEXT NOT NULL DEFAULT ''");
  if (!runColumns.has("retry_at")) db.exec("ALTER TABLE runs ADD COLUMN retry_at TEXT");
  if (!runColumns.has("lanes")) db.exec("ALTER TABLE runs ADD COLUMN lanes INTEGER NOT NULL DEFAULT 1");
  if (!runColumns.has("testrail_error")) db.exec("ALTER TABLE runs ADD COLUMN testrail_error TEXT NOT NULL DEFAULT ''");
  const laneColumns = {
    device_serials: "ALTER TABLE configs ADD COLUMN device_serials TEXT NOT NULL DEFAULT '[]'",
    parallel: "ALTER TABLE configs ADD COLUMN parallel INTEGER NOT NULL DEFAULT 1",
    account_filters: "ALTER TABLE configs ADD COLUMN account_filters TEXT NOT NULL DEFAULT '{}'",
    device_wait_minutes: "ALTER TABLE configs ADD COLUMN device_wait_minutes INTEGER NOT NULL DEFAULT 30",
  };
  const currentConfigColumns = new Set(db.prepare("PRAGMA table_info(configs)").all().map((column) => column.name));
  for (const [column, statement] of Object.entries(laneColumns)) {
    if (!currentConfigColumns.has(column)) db.exec(statement);
  }
  // Parallelism and device waiting are per configuration now; carry an old global wait time over,
  // and drop the global Android/iOS caps (the farm's free devices and each UDID pool are the real limit).
  const oldWait = db.prepare("SELECT value FROM settings WHERE key = 'device_wait_minutes'").get();
  if (oldWait) {
    if (!currentConfigColumns.has("device_wait_minutes") && Number(oldWait.value) > 0) {
      db.prepare("UPDATE configs SET device_wait_minutes = ?").run(Math.min(1440, Math.trunc(Number(oldWait.value))));
    }
    db.prepare("DELETE FROM settings WHERE key = 'device_wait_minutes'").run();
  }
  db.prepare("DELETE FROM settings WHERE key IN ('android_concurrency', 'ios_concurrency')").run();
  const sourceColumns = new Set(db.prepare("PRAGMA table_info(sources)").all().map((column) => column.name));
  const sourceMigrations = {
    type: "ALTER TABLE sources ADD COLUMN type TEXT NOT NULL DEFAULT 'http'",
    use_mode: "ALTER TABLE sources ADD COLUMN use_mode TEXT NOT NULL DEFAULT 'reuse'",
    credentials: "ALTER TABLE sources ADD COLUMN credentials TEXT NOT NULL DEFAULT ''",
  };
  for (const [column, statement] of Object.entries(sourceMigrations)) {
    if (!sourceColumns.has(column)) db.exec(statement);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_accounts (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      used_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS source_accounts_source ON source_accounts (source_id, id);
  `);
  return db;
}

export function seed(db) {
  const admin = db.prepare("SELECT id FROM users WHERE email = ?").get("mercury@test.com");
  if (!admin) {
    db.prepare(
      "INSERT INTO users (email, password_hash, role, status, builtin) VALUES (?, ?, 'admin', 'active', 1)",
    ).run("mercury@test.com", hashPassword("Mercury"));
  }
  const defaults = {
    model_provider: "",
    model_api_key: "",
    model_name: "",
    model_base_url: "",
    model_family: "",
    model_region: "us-east-1",
    model_aws_access_key: "",
    model_aws_secret: "",
    model_aws_session: "",
    model_azure_api_version: "2024-10-21",
    testrail_host: "",
    testrail_user: "",
    testrail_api_key: "",
    testrail_project_id: "",
    farm_base_url: "",
    farm_token: "",
    web_concurrency: "2",
    update_manifest_url: "",
    public_base_url: "",
  };
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

  // A fresh installation gets one neutral, runnable example. It is added only once, so deleting it stays deleted.
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'sample_seeded'").get();
  const hasClients = db.prepare("SELECT COUNT(*) AS n FROM clients").get().n > 0;
  if (!seeded && !hasClients) {
    const clientId = Number(db.prepare("INSERT INTO clients (name, suite_id, project_id) VALUES (?, '', '')").run(SAMPLE_CLIENT).lastInsertRowid);
    const add = db.prepare(
      `INSERT INTO configs
        (client_id, name, aliases, platform, farm_type, device_filter, app_url, package_id, launch_url, regression)
       VALUES (?, ?, ?, ?, ?, '', '', '', ?, 1)`,
    );
    add.run(clientId, "Web (Chrome)", JSON.stringify(["web chrome", "web"]), "web", "", "https://example.com");
    add.run(clientId, "Android", JSON.stringify(["android"]), "android", "android", "");
    add.run(clientId, "iOS", JSON.stringify(["ios", "iphone"]), "ios", "ios", "");
  }
  if (!seeded) db.prepare("INSERT INTO settings (key, value) VALUES ('sample_seeded', '1')").run();
}

export const SAMPLE_CLIENT = "Örnek Proje";

// Starting points for the "Yeni kaynak" dialog. They describe common API shapes, not any company's service;
// the admin fills in the address and adapts paths and fields.
export function accountTemplates() {
  const fields = { email: "email", password: "password", phone: "phone", id: "id" };
  const list = { method: "GET", path: "/test-users", params: { environment: "test", isLocked: false }, itemsPath: "" };
  const markUsed = { method: "PATCH", path: "/test-users/{{id}}", body: { isLocked: true } };
  return [
    {
      name: "REST servis · token ile giriş",
      template: "rest-login",
      base_url: "",
      spec: {
        auth: { type: "login", method: "POST", path: "/auth/login", body: { email: "{{username}}", password: "{{password}}" }, tokenPath: "token", tokenHeader: "Authorization", tokenPrefix: "Bearer " },
        list, fields, markUsed,
      },
    },
    {
      name: "REST servis · API anahtarı",
      template: "rest-api-key",
      base_url: "",
      spec: { auth: { type: "header", tokenHeader: "x-api-key", tokenPrefix: "" }, list, fields, markUsed },
    },
    {
      name: "REST servis · Basic auth",
      template: "rest-basic",
      base_url: "",
      spec: { auth: { type: "basic" }, list, fields, markUsed },
    },
    {
      name: "REST servis · kimlik doğrulama yok",
      template: "rest-open",
      base_url: "",
      spec: { auth: { type: "none" }, list, fields, markUsed: null },
    },
  ];
}

export function audit(db, actor, action, detail) {
  db.prepare("INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)").run(
    actor,
    action,
    detail,
    new Date().toISOString(),
  );
}
