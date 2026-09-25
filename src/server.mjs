import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, seed, audit, SECRET_KEYS, accountTemplates } from "./db.mjs";
import { decrypt, encrypt, hashPassword, loadAppKey, maskSecret, verifyPassword } from "./security.mjs";
import { fold, isSettingsUtterance, parseMemory, parseSetting, resolveConfigs, wantsRun } from "./agent.mjs";
import { addPlan, addRun, farmRequest, testrail } from "./integrations.mjs";
import { createAccountStore, normalizeSourceInput, normalizeSpec } from "./accounts.mjs";
import { createWorker, listCases } from "./worker.mjs";
import { MIDSCENE_FAMILIES, detectFamily, midsceneModel, midsceneVersion } from "./midscene.mjs";
import { assertCredentials, listModels, providerById, publicProviders } from "./providers.mjs";
import { configurationPlan, normalizeConfigInput, selectCases } from "./planning.mjs";
import { adbPublicKey, ensureAdbServer, resolveAdb } from "./adb.mjs";
import { registerAdbKey } from "./farm.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || join(root, "data");
const reportsDir = process.env.REPORTS_DIR || join(root, "reports");
const casesDir = process.env.CASES_DIR || join(root, "cases");
const publicDir = join(root, "public");
const key = loadAppKey(dataDir);
const db = openDb(dataDir);
seed(db);
const version = JSON.parse(readFileSync(join(root, "version.json"), "utf8")).version;
process.env.MIDSCENE_RUN_DIR ||= join(dataDir, "midscene_run");

const accountStore = createAccountStore({ db, key });

function settings() {
  const out = {};
  for (const row of db.prepare("SELECT key, value FROM settings").all()) {
    out[row.key] = SECRET_KEYS.has(row.key) && row.value ? decrypt(key, row.value) : row.value;
  }
  return out;
}

function saveSetting(name, value) {
  const stored = SECRET_KEYS.has(name) && value ? encrypt(key, value) : value;
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(name, stored);
}

// Older installs kept one global test-account login and address; move them onto the HTTP sources that relied on them.
function migrateLegacyAccountSettings() {
  const current = settings();
  const username = current.account_service_email || "";
  const password = current.account_service_password || "";
  const baseUrl = current.account_base_url || "";
  if (!username && !password && !baseUrl) return;
  for (const row of db.prepare("SELECT id, base_url FROM sources WHERE type = 'http'").all()) {
    if (!row.base_url && baseUrl) db.prepare("UPDATE sources SET base_url = ? WHERE id = ?").run(baseUrl, row.id);
    const { credentials } = accountStore.sourceById(row.id);
    if (!credentials.username && !credentials.password && (username || password)) {
      db.prepare("UPDATE sources SET credentials = ? WHERE id = ?").run(encrypt(key, JSON.stringify({ username, password, secret: "" })), row.id);
    }
  }
  db.prepare("DELETE FROM settings WHERE key IN ('account_service_email', 'account_service_password', 'account_base_url')").run();
}
migrateLegacyAccountSettings();

function publicSettings() {
  const current = settings();
  for (const name of SECRET_KEYS) if (name in current) current[name] = maskSecret(current[name]);
  return current;
}

function modelStatus() {
  const current = settings();
  const provider = providerById(current.model_provider);
  const connected = Boolean(current.model_api_key || current.model_aws_secret);
  return {
    connected,
    ready: connected && Boolean(current.model_name),
    provider: current.model_provider || "",
    providerLabel: provider?.label || "",
    modelName: current.model_name || "",
    baseUrl: current.model_base_url || "",
    family: current.model_family || "",
    region: current.model_region || "",
    auth: provider?.auth || "",
    keyMask: maskSecret(current.model_api_key || current.model_aws_secret),
    midscene: {
      version: midsceneVersion(),
      familySetting: current.midscene_model_family || "",
      detectedFamily: detectFamily(current.model_name),
      family: midsceneModel(current).family || "",
      error: current.model_name ? midsceneModel(current).error || "" : "",
      families: MIDSCENE_FAMILIES,
    },
  };
}

function credential(body, name, stored) {
  const value = String(body[name] ?? "");
  if (!value || value.includes("•")) return stored || "";
  return value;
}

function modelInput(body) {
  const current = settings();
  const provider = providerById(body.provider || current.model_provider);
  if (!provider) throw new Error("Sağlayıcı seç");
  return {
    provider: provider.id,
    apiKey: credential(body, "apiKey", current.model_api_key),
    baseUrl: String(body.baseUrl ?? current.model_base_url ?? provider.base).trim(),
    region: String(body.region || current.model_region || "us-east-1").trim(),
    awsAccessKey: credential(body, "awsAccessKey", current.model_aws_access_key),
    awsSecret: credential(body, "awsSecret", current.model_aws_secret),
    awsSession: credential(body, "awsSession", current.model_aws_session),
    azureApiVersion: String(body.azureApiVersion || current.model_azure_api_version || "2024-10-21").trim(),
  };
}

function saveModel(input, modelName) {
  const provider = providerById(input.provider);
  saveSetting("model_provider", provider.id);
  saveSetting("model_family", provider.family);
  saveSetting("model_base_url", input.baseUrl || provider.base);
  saveSetting("model_region", input.region);
  saveSetting("model_azure_api_version", input.azureApiVersion);
  saveSetting("model_api_key", input.apiKey);
  saveSetting("model_aws_access_key", input.awsAccessKey);
  saveSetting("model_aws_secret", input.awsSecret);
  saveSetting("model_aws_session", input.awsSession);
  if (modelName) saveSetting("model_name", modelName);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function cookie(req) {
  const hit = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("mtr="));
  return hit ? hit.slice(4) : "";
}

function userFrom(req) {
  const token = cookie(req);
  if (!token) return null;
  return db.prepare(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ? AND sessions.expires_at > ? AND users.status = 'active'`,
  ).get(token, Date.now()) || null;
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length, ...headers });
  res.end(payload);
}

function setSession(userId) {
  const token = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, Date.now() + 1000 * 60 * 60 * 24 * 7);
  return `mtr=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
}

function loadConfigs() {
  const current = settings();
  const cases = listCases(casesDir);
  return db.prepare(
    `SELECT configs.*, clients.name AS client_name, clients.suite_id,
            sources.name AS account_source_name
     FROM configs
     JOIN clients ON clients.id = configs.client_id
     LEFT JOIN sources ON sources.id = configs.account_source_id
     ORDER BY configs.id`,
  ).all().map((row) => {
    const source = row.account_source_id ? accountStore.sourceById(row.account_source_id) : null;
    const sourceState = source ? accountStore.status(source) : null;
    const config = { ...row, account_source_ready: sourceState?.ready ?? null, account_source_issue: sourceState?.issue ?? "" };
    return {
    ...config,
    plan: configurationPlan(config, cases, {
      modelReady: Boolean(current.model_name && (current.model_api_key || current.model_aws_secret)),
      farmReady: Boolean(current.farm_base_url && current.farm_token),
      adbReady: Boolean(resolveAdb()),
      limits: platformLimits(current),
    }),
    };
  });
}

function platformLimits(current) {
  return { web: Number(current.web_concurrency) || 2 };
}

// Shared by create, clone and edit: validates ownership and chat alias uniqueness, then writes the row.
function saveConfig(input, clientId, id = null) {
  if (input.accountSourceId && !db.prepare("SELECT id FROM sources WHERE id = ? AND (client_id = ? OR client_id IS NULL)").get(input.accountSourceId, clientId)) {
    throw new Error("Hesap kaynağı bu client'a ait değil ve ortak değil");
  }
  const siblings = db.prepare("SELECT id, name, aliases FROM configs WHERE client_id = ? AND id IS NOT ?").all(clientId, id);
  if (siblings.some((item) => fold(item.name) === fold(input.name))) throw new Error(`Bu client'ta "${input.name}" adlı konfigürasyon zaten var`);
  for (const alias of input.aliases) {
    const owner = siblings.find((item) => [item.name, ...JSON.parse(item.aliases || "[]")].some((name) => fold(name) === fold(alias)));
    if (owner) throw new Error(`"${alias}" takma adı "${owner.name}" konfigürasyonunda kullanılıyor; chat hangisini koşacağını ayıramaz`);
  }
  const values = [
    input.name, JSON.stringify(input.aliases), input.platform, input.farmType, input.deviceFilter,
    input.appUrl, input.packageId, input.launchUrl, input.regression ? 1 : 0, input.environment,
    input.accountSourceId, input.accountPolicy, JSON.stringify(input.caseIds), JSON.stringify(input.caseTags),
    input.enabled ? 1 : 0, JSON.stringify(input.deviceSerials), input.parallel, JSON.stringify(input.accountFilters),
    input.deviceWaitMinutes,
  ];
  if (id) {
    db.prepare(
      `UPDATE configs SET name = ?, aliases = ?, platform = ?, farm_type = ?, device_filter = ?,
       app_url = ?, package_id = ?, launch_url = ?, regression = ?, environment = ?,
       account_source_id = ?, account_policy = ?, case_ids = ?, case_tags = ?, enabled = ?,
       device_serials = ?, parallel = ?, account_filters = ?, device_wait_minutes = ? WHERE id = ?`,
    ).run(...values, id);
    return id;
  }
  return Number(db.prepare(
    `INSERT INTO configs
      (name, aliases, platform, farm_type, device_filter, app_url, package_id, launch_url, regression, environment,
       account_source_id, account_policy, case_ids, case_tags, enabled, device_serials, parallel, account_filters, device_wait_minutes, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...values, clientId).lastInsertRowid);
}

function caseIds(config) {
  return selectCases(config, listCases(casesDir)).filter((item) => item.caseId).map((item) => Number(item.caseId));
}

function fillStepText(text, accountEmail, launchUrl) {
  return String(text || "")
    .replaceAll("{{launchUrl}}", launchUrl || "{{launchUrl}}")
    .replaceAll("{{account.email}}", accountEmail || "{{account.email}}");
}

function runDetail(id) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!run) return null;
  delete run.report_dir;
  const config = run.config_id ? db.prepare("SELECT * FROM configs WHERE id = ?").get(run.config_id) : {};
  const scopedConfig = { ...config, client_name: run.client_name };
  const launchUrl = config?.launch_url || "";
  const recorded = db.prepare("SELECT case_key, title, status, detail, steps_json, account_email FROM run_cases WHERE run_id = ? ORDER BY id").all(id);
  const cases = recorded.length
    ? recorded.map(({ steps_json: stepsJson, ...item }) => ({ ...item, steps: JSON.parse(stepsJson || "[]") }))
    : selectCases(scopedConfig, listCases(casesDir))
      .map((item) => ({ case_key: item.caseId, title: item.title, status: "pending", detail: "", steps: item.steps.map((step) => ({ ...step, status: "pending", detail: "" })) }));
  // Older runs have no per-case user; fall back to the run's only if it used a single one.
  const runEmail = run.account_email && !run.account_email.includes(",") ? run.account_email : "";
  for (const item of cases) for (const step of item.steps) step.text = fillStepText(step.text, item.account_email || runEmail, launchUrl);
  return { ...run, cases };
}

function saveChatTurn(userId, text, reply, runIds) {
  const now = new Date().toISOString();
  const asked = db.prepare("INSERT INTO chat_messages (user_id, role, text, created_at) VALUES (?, 'user', ?, ?)").run(userId, text, now);
  const turn = Number(asked.lastInsertRowid);
  db.prepare("UPDATE chat_messages SET turn = ? WHERE id = ?").run(turn, turn);
  db.prepare("INSERT INTO chat_messages (user_id, turn, role, text, run_ids, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)").run(
    userId, turn, reply, JSON.stringify(runIds), now,
  );
}

function chatHistory(userId, query) {
  const rows = db.prepare("SELECT id, turn, role, text, run_ids, created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 2000").all(userId).reverse();
  let visible = rows;
  const needle = fold(query).trim();
  if (needle) {
    const turns = new Set(rows.filter((row) => fold(row.text).includes(needle)).map((row) => row.turn));
    visible = rows.filter((row) => turns.has(row.turn));
  }
  return visible.slice(-200).map(({ run_ids: runIds, ...row }) => ({ ...row, runs: JSON.parse(runIds || "[]").map(runDetail).filter(Boolean) }));
}

async function createExecution({ user, configs, deviceHint }) {
  const current = settings();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  let planId = "";
  if (configs.length > 1 && current.testrail_project_id) {
    try {
      const plan = await addPlan(current, {
        name: `${configs[0].client_name || "plan"} ${stamp}`,
        entries: configs.map((item) => ({ suite_id: Number(item.suite_id) || undefined, name: item.name, include_all: false, case_ids: caseIds(item) })),
      });
      planId = String(plan.id || "");
    } catch (error) {
      audit(db, user.email, "testrail_plan_failed", error.message);
    }
  }
  const created = [];
  for (const config of configs) {
    const name = `${config.client_name} (${config.name}) ${stamp}`;
    let testrailRunId = "";
    let testrailError = "";
    if (config.plan.ready && current.testrail_project_id) {
      try {
        const run = await addRun(current, { suiteId: config.suite_id, name, caseIds: caseIds(config) });
        if (run.skipped) testrailError = run.reason;
        else testrailRunId = String(run.id || "");
      } catch (error) {
        testrailError = error.message;
        audit(db, user.email, "testrail_run_failed", error.message);
      }
    }
    // The run still executes locally; the tester must know its results will not reach TestRail.
    const testrailNote = testrailError ? `TestRail run açılamadı (${testrailError}); sonuçlar yalnız yerel raporda` : "";
    const status = config.plan.ready ? "queued" : "blocked";
    const message = config.plan.ready
      ? [deviceHint ? `Cihaz daraltıldı: ${deviceHint}` : "", testrailNote].filter(Boolean).join(" · ")
      : `Konfigürasyon hazır değil: ${config.plan.issues.join("; ")}`;
    const row = db.prepare(
      `INSERT INTO runs (status, client_name, config_id, config_name, platform, testrail_run_id, testrail_plan_id, started_by, message, created_at, device_hint, testrail_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(status, config.client_name, config.id, config.name, config.platform, testrailRunId, planId, user.id, message, new Date().toISOString(), deviceHint || "", testrailNote);
    created.push(db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(row.lastInsertRowid)));
  }
  return created;
}

async function handleChat(user, message) {
  const text = String(message || "").trim();
  if (!text) return { reply: "Bir cümle yaz." };
  if (parseMemory(text) || /^(hatirla|hatırla|bundan sonra|şöyle yap|soyle yap)\b/i.test(text)) {
    const parsed = parseMemory(text.replace(/^(hatırla|hatirla|bundan sonra|şöyle yap|soyle yap)\s+/i, ""));
    const configs = loadConfigs();
    const clients = db.prepare("SELECT * FROM clients").all();
    const match = parsed ? resolveConfigs(parsed.rest, configs, clients, []) : { configs: [] };
    const phrase = parsed?.phrase || fold(parsed?.rest || "").replace(fold(match.configs[0]?.name || ""), "").replace(fold(match.configs[0]?.client_name || ""), "").trim();
    db.prepare(
      "INSERT INTO memories (kind, text, match_phrase, config_id, created_by, created_at) VALUES ('correction', ?, ?, ?, ?, ?)",
    ).run(text, phrase, match.configs[0]?.id || null, user.id, new Date().toISOString());
    audit(db, user.email, "memory", text);
    return { reply: "Bunu belleğe yazdım. Sonraki cümlelerde kullanacağım." };
  }
  if (isSettingsUtterance(text)) {
    if (user.role !== "admin") return { reply: "Ayarları yalnız admin değiştirebilir." };
    const setting = parseSetting(text);
    if (!setting || !setting.value) return { reply: "Ayar biçimi: ayar testrail host https://..." };
    saveSetting(setting.key, setting.value);
    audit(db, user.email, "setting", setting.key);
    return { reply: `${setting.label} güncellendi.` };
  }
  if (!wantsRun(text)) {
    return { reply: "Koşum için client ve konfigürasyonu söyle. Örnek: örnek proje web chrome koş. Düzeltme için: gece regresyonu örnek proje web chrome demek." };
  }
  const resolved = resolveConfigs(text, loadConfigs(), db.prepare("SELECT * FROM clients").all(), db.prepare("SELECT * FROM memories ORDER BY id DESC").all());
  if (!resolved.configs.length) return { reply: "Bu cümle kayıtlı bir client veya konfigürasyonla eşleşmedi." };
  const runs = await createExecution({ user, configs: resolved.configs, deviceHint: resolved.deviceHint });
  audit(db, user.email, "run", runs.map((item) => item.id).join(","));
  const blocked = runs.filter((item) => item.status === "blocked");
  const heading = blocked.length
    ? `${blocked.length} koşum, konfigürasyon ön kontrolü geçemedi. Eksikleri tamamladıktan sonra yeniden başlat.`
    : "Yürütme planı hazırlandı ve yeni koşum açıldı. Adımları aşağıda canlı izleyebilirsin.";
  return {
    reply: `${heading}\n${runs.map((item) => `#${item.id} ${item.client_name} · ${item.config_name}${item.message ? ` — ${item.message}` : ""}`).join("\n")}`,
    runs,
  };
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, version });
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(req);
      const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(body.email || "").toLowerCase());
      if (!user || !verifyPassword(body.password || "", user.password_hash)) return send(res, 401, { error: "E-posta veya şifre hatalı" });
      if (user.status !== "active") return send(res, 403, { error: "Hesap admin onayı bekliyor" });
      return send(res, 200, { email: user.email, role: user.role }, { "set-cookie": setSession(user.id) });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readBody(req);
      const email = String(body.email || "").toLowerCase().trim();
      if (!email.includes("@") || String(body.password || "").length < 8) return send(res, 400, { error: "Geçerli e-posta ve en az 8 karakter şifre gerekli" });
      try {
        db.prepare("INSERT INTO users (email, password_hash, role, status, builtin) VALUES (?, ?, 'user', 'pending', 0)").run(email, hashPassword(body.password));
      } catch {
        return send(res, 409, { error: "Bu e-posta kayıtlı" });
      }
      audit(db, email, "register", "pending");
      return send(res, 201, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(cookie(req));
      return send(res, 200, { ok: true }, { "set-cookie": "mtr=; HttpOnly; Path=/; Max-Age=0" });
    }
    const user = userFrom(req);
    if (url.pathname.startsWith("/api/") && !user && url.pathname !== "/api/version") return send(res, 401, { error: "Giriş gerekli" });
    if (req.method === "GET" && url.pathname === "/api/me") return send(res, 200, { email: user.email, role: user.role, version });
    if (req.method === "GET" && url.pathname === "/api/version") {
      let update = null;
      const manifest = settings().update_manifest_url;
      if (manifest) {
        try {
          const remote = await fetch(manifest).then((response) => response.json());
          if (remote.version && remote.version !== version) update = { version: remote.version, notes: remote.notes || "" };
        } catch {
          update = null;
        }
      }
      return send(res, 200, { version, midscene: midsceneVersion(), update });
    }
    if ((url.pathname.startsWith("/api/settings") || url.pathname.startsWith("/api/users") || url.pathname.startsWith("/api/sources")) && user.role !== "admin") {
      return send(res, 403, { error: "Bu alan yalnız admin içindir" });
    }
    if (req.method === "GET" && url.pathname === "/api/settings") return send(res, 200, publicSettings());
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      const family = body.midscene_model_family;
      if (typeof family === "string" && family && !MIDSCENE_FAMILIES.includes(family)) return send(res, 400, { error: `Geçersiz Midscene model ailesi: ${family}` });
      for (const [name, value] of Object.entries(body)) {
        if (typeof value !== "string" || (SECRET_KEYS.has(name) && value.includes("•"))) continue;
        saveSetting(name, value);
      }
      audit(db, user.email, "settings", Object.keys(body).join(","));
      return send(res, 200, publicSettings());
    }
    if (req.method === "GET" && url.pathname === "/api/models/status") return send(res, 200, modelStatus());
    if ((url.pathname === "/api/providers" || url.pathname.startsWith("/api/models/")) && user.role !== "admin") {
      return send(res, 403, { error: "Bu alan yalnız admin içindir" });
    }
    if (req.method === "GET" && url.pathname === "/api/providers") return send(res, 200, publicProviders());
    if (req.method === "POST" && url.pathname === "/api/models/list") {
      try {
        const input = modelInput(await readBody(req));
        const listed = await listModels(input);
        saveModel({ ...input, baseUrl: listed.base || input.baseUrl }, "");
        audit(db, user.email, "model_list", input.provider);
        return send(res, 200, { models: listed.models, baseUrl: listed.base || input.baseUrl });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/models/select") {
      try {
        const body = await readBody(req);
        const name = String(body.model || "").trim();
        if (!name) return send(res, 400, { error: "Model seç" });
        const input = modelInput(body);
        assertCredentials(input);
        saveModel(input, name);
        audit(db, user.email, "model_select", `${input.provider}:${name}`);
        return send(res, 200, modelStatus());
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/settings/testrail-test") return send(res, 200, await testrail(settings(), "get_projects"));
    if (req.method === "POST" && url.pathname === "/api/settings/farm-test") {
      const current = settings();
      const farmUser = await farmRequest(current, "/api/v1/user");
      if (farmUser.skipped) return send(res, 400, { error: farmUser.reason });
      // Android devices only accept `adb connect` from keys registered on the farm; do it for the admin.
      let adbKey = "missing";
      if (resolveAdb()) {
        const publicKey = adbPublicKey() || (await ensureAdbServer().catch(() => ""));
        adbKey = await registerAdbKey(current, publicKey).catch((error) => `failed: ${error.message}`);
      }
      audit(db, user.email, "farm_test", adbKey);
      return send(res, 200, { ok: true, adbKey });
    }
    if (req.method === "GET" && url.pathname === "/api/settings/adb") {
      const adbPath = resolveAdb();
      // Starting ADB once creates ~/.android/adbkey.pub, which the farm must know before Android runs.
      const publicKey = adbPublicKey() || (adbPath ? await ensureAdbServer().catch(() => "") : "");
      return send(res, 200, { adbPath, publicKey, title: publicKey.split(" ").slice(1).join(" ") });
    }
    if (req.method === "GET" && url.pathname === "/api/users") return send(res, 200, db.prepare("SELECT id, email, role, status, builtin FROM users ORDER BY id").all());
    const userAction = url.pathname.match(/^\/api\/users\/(\d+)\/(approve|reject)$/);
    if (req.method === "POST" && userAction) {
      const target = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(userAction[1]));
      if (!target || target.builtin) return send(res, 400, { error: "Bu hesap değiştirilemez" });
      if (userAction[2] === "reject") db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(target.id);
      else {
        const body = await readBody(req);
        db.prepare("UPDATE users SET status = 'active', role = ? WHERE id = ?").run(body.role === "admin" ? "admin" : "user", target.id);
      }
      audit(db, user.email, userAction[2], target.email);
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/configs") return send(res, 200, loadConfigs());
    if (req.method === "GET" && url.pathname === "/api/config-options") {
      return send(res, 200, {
        clients: db.prepare("SELECT id, name, suite_id FROM clients ORDER BY name").all(),
        sources: accountStore.list().map(({ id, client_id: clientId, name, type, template, filters, ready, issue }) => ({ id, client_id: clientId, name, type, template, filters, ready, issue })),
        cases: listCases(casesDir).map((item) => ({
          id: String(item.caseId), title: item.title, client: item.client, tags: item.tags,
        })),
        limits: platformLimits(settings()),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/configs") {
      if (user.role !== "admin") return send(res, 403, { error: "Bu alan yalnız admin içindir" });
      const body = await readBody(req);
      try {
        const input = normalizeConfigInput(body);
        let client = body.clientId ? db.prepare("SELECT * FROM clients WHERE id = ?").get(Number(body.clientId)) : null;
        if (!client) {
          const name = String(body.client || "").trim();
          if (!name) return send(res, 400, { error: "Client seç veya yeni client adı yaz" });
          client = db.prepare("SELECT * FROM clients WHERE name = ?").get(name);
          if (!client) {
            const inserted = db.prepare("INSERT INTO clients (name, suite_id, project_id) VALUES (?, ?, ?)").run(name, String(body.suiteId || "").trim(), body.projectId || "");
            client = { id: Number(inserted.lastInsertRowid) };
          }
        }
        const id = saveConfig(input, client.id);
        audit(db, user.email, body.cloneOf ? "config_clone" : "config_create", `${id}${body.cloneOf ? ` <- ${body.cloneOf}` : ""}`);
        return send(res, 201, { id });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    const configUpdate = url.pathname.match(/^\/api\/configs\/(\d+)$/);
    if (req.method === "PUT" && configUpdate) {
      if (user.role !== "admin") return send(res, 403, { error: "Bu alan yalnız admin içindir" });
      const current = db.prepare("SELECT * FROM configs WHERE id = ?").get(Number(configUpdate[1]));
      if (!current) return send(res, 404, { error: "Konfigürasyon bulunamadı" });
      try {
        saveConfig(normalizeConfigInput(await readBody(req), current), current.client_id, current.id);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      audit(db, user.email, "config_update", String(current.id));
      return send(res, 200, { ok: true });
    }
    // /api/sources* is admin-only (checked above with the settings routes).
    if (req.method === "GET" && url.pathname === "/api/sources") return send(res, 200, accountStore.list());
    if (req.method === "GET" && url.pathname === "/api/sources/templates") {
      return send(res, 200, accountTemplates().map((item) => ({ template: item.template, name: item.name, base_url: item.base_url, spec: normalizeSpec(item.spec) })));
    }
    if (req.method === "POST" && url.pathname === "/api/sources/test") {
      const body = await readBody(req);
      try {
        return send(res, 200, await accountStore.test(normalizeSourceInput({ ...body, name: body.name || "Deneme" }), {
          id: Number(body.id) || null, cloneOf: Number(body.cloneOf) || null, environment: String(body.environment || "test"),
        }));
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/sources") {
      const body = await readBody(req);
      try {
        const id = accountStore.save(normalizeSourceInput(body), { cloneOf: Number(body.cloneOf) || null });
        audit(db, user.email, body.cloneOf ? "source_clone" : "source_create", String(id));
        return send(res, 201, { id });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    const sourceRoute = url.pathname.match(/^\/api\/sources\/(\d+)(?:\/(accounts|reset))?$/);
    if (sourceRoute) {
      const id = Number(sourceRoute[1]);
      if (!accountStore.sourceById(id)) return send(res, 404, { error: "Kaynak bulunamadı" });
      const action = sourceRoute[2];
      if (req.method === "PUT" && !action) {
        try {
          accountStore.save(normalizeSourceInput(await readBody(req)), { id });
        } catch (error) {
          return send(res, 400, { error: error.message });
        }
        audit(db, user.email, "source_update", String(id));
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && !action) {
        try {
          accountStore.remove(id);
        } catch (error) {
          return send(res, 409, { error: error.message });
        }
        audit(db, user.email, "source_delete", String(id));
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && action === "accounts") return send(res, 200, accountStore.accountLines(id));
      if (req.method === "POST" && action === "reset") {
        const reset = accountStore.resetUsed(id);
        audit(db, user.email, "source_reset", `${id}: ${reset}`);
        return send(res, 200, { reset });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/runs") {
      return send(res, 200, db.prepare("SELECT id, status, client_name, config_name, platform, testrail_run_id, testrail_plan_id, device_label, account_email, message, created_at, finished_at FROM runs ORDER BY id DESC").all());
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const run = runDetail(Number(url.pathname.split("/").pop()));
      if (!run) return send(res, 404, { error: "Koşum yok" });
      return send(res, 200, run);
    }
    if (req.method === "GET" && url.pathname.startsWith("/reports/")) {
      if (!user) return send(res, 401, { error: "Giriş gerekli" });
      const [, , id, name = ""] = url.pathname.split("/");
      const fileName = name || "index.html";
      if (!/^\d+$/.test(id) || !/^[\w-]+\.(html|webm|png|json)$/.test(fileName)) return send(res, 404, { error: "Rapor yok" });
      const file = join(reportsDir, id, fileName);
      if (!existsSync(file)) return send(res, 404, { error: "Rapor yok" });
      const reportTypes = { ".html": "text/html; charset=utf-8", ".webm": "video/webm", ".png": "image/png", ".json": "application/json" };
      const body = readFileSync(file);
      const headers = { "content-type": reportTypes[extname(file)], "accept-ranges": "bytes", "cache-control": "private, no-store" };
      // Safari only plays and seeks video when byte ranges are honoured.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${body.length}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { ...headers, "content-length": body.length });
      return res.end(body);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(req);
      const text = String(body.message || "").trim();
      const result = await handleChat(user, text);
      if (result.runs) result.runs = result.runs.map((item) => runDetail(item.id) || item);
      if (text) saveChatTurn(user.id, text, result.reply, (result.runs || []).map((item) => item.id));
      return send(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/chat/history") {
      return send(res, 200, chatHistory(user.id, url.searchParams.get("q") || ""));
    }
    if (req.method === "GET" && url.pathname === "/api/memory") {
      return send(res, 200, db.prepare("SELECT id, kind, text, created_at FROM memories ORDER BY id DESC LIMIT 50").all());
    }
    const filePath = url.pathname === "/" ? join(publicDir, "index.html") : join(publicDir, url.pathname);
    if (!filePath.startsWith(publicDir) || !existsSync(filePath)) return send(res, 404, { error: "Yok" });
    res.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
    return res.end(readFileSync(filePath));
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

const worker = createWorker({ db, settings, reportsDir, casesDir, accounts: accountStore });
setInterval(() => worker.tick().catch((error) => audit(db, "worker", "tick", error.message)), 2000);
const port = Number(process.env.PORT || 8080);
server.listen(port, "0.0.0.0", () => {
  console.log(`Mercury Test Runner ${version} http://localhost:${port}`);
});
