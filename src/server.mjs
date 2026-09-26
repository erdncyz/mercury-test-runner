import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, seed, audit, SECRET_KEYS, accountTemplates } from "./db.mjs";
import { decrypt, encrypt, hashPassword, loadAppKey, maskSecret, verifyPassword } from "./security.mjs";
import {
  buildScenarioSteps, deviceHint, fold, hasScenarioAction, isIosUdid, isPlainRunCommand, isSettingsUtterance, parseMemory, parseScenario, parseSetting,
  resolveConfigs, resolveScenarioTarget, serialCandidates, wantsRun,
} from "./agent.mjs";
import { addPlan, addRun, ensureScenarioCases, farmRequest, listProjectSuites, listProjects, testrailConfigured } from "./integrations.mjs";
import { gatherReferences, testAtlassian } from "./atlassian.mjs";
import { createAccountStore, normalizeSourceInput, normalizeSpec } from "./accounts.mjs";
import { createWorker, listCases, scenarioCases } from "./worker.mjs";
import { askQaAgent, conversationContext, normalizeDecision, qaCatalog, usesAccount } from "./qa-agent.mjs";
import { loadSkills, midsceneContext, parseSkill, selectSkills } from "./skills.mjs";
import { MIDSCENE_FAMILIES, MIDSCENE_FAMILY_OPTIONS, detectFamily, metricsFromReport, midsceneModel, midsceneVersion, withMidsceneFamily } from "./midscene.mjs";
import { assertCredentials, listModels, providerById, publicProviders } from "./providers.mjs";
import { DEFAULT_LANG, localize, localizeBody, requestLang } from "./i18n.mjs";
import { autoWebLimit, configurationPlan, normalizeConfigInput, scopeCases, selectCases, webLimit, webLimitSetting } from "./planning.mjs";
import { adbPublicKey, ensureAdbServer, resolveAdb } from "./adb.mjs";
import { devicesNamedIn, listDevices, registerAdbKey } from "./farm.mjs";
import { dueSlot, nextRunAt, parseSchedule, sameTiming } from "./schedule.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || join(root, "data");
const reportsDir = process.env.REPORTS_DIR || join(root, "reports");
const casesDir = process.env.CASES_DIR || join(root, "cases");
// Built-in QA skills ship with the code; an installation adds or overrides them (Ayarlar → QA becerileri) in the data dir.
const builtinSkillsDir = join(root, "skills");
const customSkillsDir = join(dataDir, "skills");
const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,59}$/;
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
  if (name === "web_concurrency") value = webLimitSetting(value);
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
  // What an empty browser limit resolves to on this machine, shown next to the field.
  current.web_concurrency_auto = String(autoWebLimit());
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
      families: MIDSCENE_FAMILY_OPTIONS,
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

// Server messages are written in Turkish and translated here for clients that asked for another language.
function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(localizeBody(body, res.lang)));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length, ...headers });
  res.end(payload);
}

function setSession(userId) {
  const token = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, Date.now() + 1000 * 60 * 60 * 24 * 7);
  return `mtr=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
}

function planOptions(current) {
  return {
    modelReady: Boolean(current.model_name && (current.model_api_key || current.model_aws_secret)),
    farmReady: Boolean(current.farm_base_url && current.farm_token),
    adbReady: Boolean(resolveAdb()),
    limits: platformLimits(current),
  };
}

function loadConfigs() {
  const current = settings();
  const cases = listCases(casesDir);
  const options = planOptions(current);
  return db.prepare(
    `SELECT configs.*, clients.name AS client_name, clients.suite_id, clients.project_id AS testrail_project_id,
            sources.name AS account_source_name
     FROM configs
     JOIN clients ON clients.id = configs.client_id
     LEFT JOIN sources ON sources.id = configs.account_source_id
     ORDER BY configs.id`,
  ).all().map((row) => {
    const source = row.account_source_id ? accountStore.sourceById(row.account_source_id) : null;
    const sourceState = source ? accountStore.status(source) : null;
    const config = { ...row, account_source_ready: sourceState?.ready ?? null, account_source_issue: sourceState?.issue ?? "" };
    const schedule = parseSchedule(row.schedule_json);
    return {
    ...config,
    plan: configurationPlan(config, cases, options),
    schedule_next_at: schedule && row.enabled ? nextRunAt(schedule, Date.parse(row.schedule_last_at || "") || 0) : null,
    };
  });
}

function platformLimits(current) {
  return { web: webLimit(current) };
}

function resolveProject(body) {
  const selected = body.clientId ? db.prepare("SELECT * FROM clients WHERE id = ?").get(Number(body.clientId)) : null;
  if (selected) return selected;

  const name = String(body.client || "").trim();
  if (!name) throw new Error("Proje seç veya yeni proje adı yaz");

  const suiteId = String(body.suiteId || "").trim();
  const projectId = String(body.projectId || "").trim();
  const existing = db.prepare("SELECT * FROM clients WHERE name = ?").get(name);
  if (existing) {
    // Suite ids are unique across TestRail; a same-named project on another suite must not absorb this one.
    if (suiteId && existing.suite_id && existing.suite_id !== suiteId) {
      throw new Error(`"${name}" adlı proje başka bir TestRail suite'ine (${existing.suite_id}) bağlı; farklı bir ad seç`);
    }
    if (suiteId && !existing.suite_id) db.prepare("UPDATE clients SET suite_id = ? WHERE id = ?").run(suiteId, existing.id);
    if (projectId && !existing.project_id) db.prepare("UPDATE clients SET project_id = ? WHERE id = ?").run(projectId, existing.id);
    return existing;
  }

  const inserted = db.prepare("INSERT INTO clients (name, suite_id, project_id) VALUES (?, ?, ?)").run(name, suiteId, projectId);
  return { id: Number(inserted.lastInsertRowid), name };
}

// A schedule keeps its start point while its timing is unchanged; a new or changed one starts counting from now,
// so saving never fires slots that already passed. Scheduled runs are started as the admin who set the timing.
function storedSchedule(schedule, previous, actor) {
  if (!schedule.enabled) return JSON.stringify(schedule);
  const old = parseSchedule(previous);
  const keep = old && sameTiming(old, schedule);
  return JSON.stringify({ ...schedule, since: keep ? old.since : new Date().toISOString(), userId: keep ? old.userId : actor?.id ?? null });
}

// Shared by create, clone and edit: validates ownership and chat alias uniqueness, then writes the row.
function saveConfig(input, clientId, id = null, actor = null) {
  if (input.accountSourceId && !db.prepare("SELECT id FROM sources WHERE id = ? AND (client_id = ? OR client_id IS NULL)").get(input.accountSourceId, clientId)) {
    throw new Error("Hesap kaynağı bu projeye ait değil ve ortak değil");
  }
  const siblings = db.prepare("SELECT id, name, aliases FROM configs WHERE client_id = ? AND id IS NOT ?").all(clientId, id);
  if (siblings.some((item) => fold(item.name) === fold(input.name))) throw new Error(`Bu projede "${input.name}" adlı konfigürasyon zaten var`);
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
    storedSchedule(input.schedule, id ? db.prepare("SELECT schedule_json FROM configs WHERE id = ?").get(id)?.schedule_json : "", actor),
  ];
  if (id) {
    db.prepare(
      `UPDATE configs SET name = ?, aliases = ?, platform = ?, farm_type = ?, device_filter = ?,
       app_url = ?, package_id = ?, launch_url = ?, regression = ?, environment = ?,
       account_source_id = ?, account_policy = ?, case_ids = ?, case_tags = ?, enabled = ?,
       device_serials = ?, parallel = ?, account_filters = ?, device_wait_minutes = ?, schedule_json = ?, client_id = ? WHERE id = ?`,
    ).run(...values, clientId, id);
    return id;
  }
  return Number(db.prepare(
    `INSERT INTO configs
      (name, aliases, platform, farm_type, device_filter, app_url, package_id, launch_url, regression, environment,
       account_source_id, account_policy, case_ids, case_tags, enabled, device_serials, parallel, account_filters, device_wait_minutes, schedule_json, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...values, clientId).lastInsertRowid);
}

function caseIds(config) {
  return scopeCases(selectCases(config, listCases(casesDir)), config.case_keys).filter((item) => item.caseId).map((item) => Number(item.caseId));
}

function fillStepText(text, accountEmail, launchUrl) {
  return String(text || "")
    .replaceAll("{{launchUrl}}", launchUrl || "{{launchUrl}}")
    .replaceAll("{{account.email}}", accountEmail || "{{account.email}}");
}

const FINISHED_RUN = new Set(["passed", "failed", "blocked"]);

// Cases finished before step metrics were recorded get them once from their Midscene report, then keep them.
function backfillMetrics(runId, row) {
  const steps = JSON.parse(row.steps_json || "[]");
  const report = JSON.parse(row.files_json || "{}").report;
  if (!report || !steps.length || steps.some((step) => step.metrics)) return;
  let html = "";
  try { html = readFileSync(join(reportsDir, String(runId), report), "utf8"); } catch { return; }
  const metrics = metricsFromReport(html, steps);
  steps.forEach((step, index) => { step.metrics = metrics?.[index] || {}; });
  row.steps_json = JSON.stringify(steps);
  db.prepare("UPDATE run_cases SET steps_json = ? WHERE id = ?").run(row.steps_json, row.id);
}

function runDetail(id) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!run) return null;
  delete run.report_dir;
  const scenario = run.scenario_json ? JSON.parse(run.scenario_json) : null;
  delete run.scenario_json;
  run.scenario = Boolean(scenario);
  const config = run.config_id ? db.prepare("SELECT * FROM configs WHERE id = ?").get(run.config_id) : {};
  const scopedConfig = { ...config, client_name: run.client_name };
  const launchUrl = scenario ? scenario.launchUrl || scenario.packageId || config?.launch_url || config?.package_id || "" : config?.launch_url || "";
  const recorded = db.prepare("SELECT id, case_key, title, status, detail, steps_json, files_json, account_email FROM run_cases WHERE run_id = ? ORDER BY id").all(id);
  if (FINISHED_RUN.has(run.status)) for (const row of recorded) backfillMetrics(id, row);
  const pending = (item) => ({ case_key: item.caseId || "", title: item.title, status: "pending", detail: "", files: {}, steps: item.steps.map((step) => ({ ...step, status: "pending", detail: "" })) });
  const cases = recorded.length
    ? recorded.map(({ id: rowId, steps_json: stepsJson, files_json: filesJson, ...item }) => ({ ...item, files: JSON.parse(filesJson || "{}"), steps: JSON.parse(stepsJson || "[]") }))
    : scenario ? scenarioCases(scenario).map(pending) : scopeCases(selectCases(scopedConfig, listCases(casesDir)), run.case_keys).map(pending);
  // Older runs have no per-case user; fall back to the run's only if it used a single one.
  const runEmail = run.account_email && !run.account_email.includes(",") ? run.account_email : "";
  for (const item of cases) for (const step of item.steps) step.text = fillStepText(step.text, item.account_email || runEmail, launchUrl);
  return { ...run, cases };
}

// A turn joins `conversationId` only if that conversation is the user's own; otherwise it starts a new one.
function saveChatTurn(userId, text, reply, runIds, conversationId = null) {
  const now = new Date().toISOString();
  const owned = conversationId
    && db.prepare("SELECT 1 FROM chat_messages WHERE user_id = ? AND conversation_id = ? LIMIT 1").get(userId, Number(conversationId));
  const asked = db.prepare("INSERT INTO chat_messages (user_id, role, text, created_at) VALUES (?, 'user', ?, ?)").run(userId, text, now);
  const turn = Number(asked.lastInsertRowid);
  const conversation = owned ? Number(conversationId) : turn;
  db.prepare("UPDATE chat_messages SET turn = ?, conversation_id = ? WHERE id = ?").run(turn, conversation, turn);
  db.prepare("INSERT INTO chat_messages (user_id, turn, conversation_id, role, text, run_ids, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)").run(
    userId, turn, conversation, reply, JSON.stringify(runIds), now,
  );
  return conversation;
}

function withRuns({ run_ids: runIds, ...row }) {
  return { ...row, runs: JSON.parse(runIds || "[]").map(runDetail).filter(Boolean) };
}

// The 50 most recently active conversations (those with a matching message when searching), oldest first.
function chatHistory(userId, query) {
  const rows = db.prepare("SELECT id, turn, conversation_id, role, text, run_ids, created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 5000").all(userId).reverse();
  const needle = fold(query).trim();
  const byConversation = new Map();
  for (const row of rows) {
    if (!byConversation.has(row.conversation_id)) byConversation.set(row.conversation_id, []);
    byConversation.get(row.conversation_id).push(row);
  }
  return [...byConversation.values()]
    .filter((messages) => !needle || messages.some((row) => fold(row.text).includes(needle)))
    .sort((a, b) => a.at(-1).id - b.at(-1).id)
    .slice(-50)
    .flat()
    .map(withRuns);
}

function chatConversation(userId, conversationId) {
  return db.prepare("SELECT id, turn, conversation_id, role, text, run_ids, created_at FROM chat_messages WHERE user_id = ? AND conversation_id = ? ORDER BY id")
    .all(userId, conversationId).map(withRuns);
}

async function createExecution({ user, configs, deviceHint, serials = [], note = "", trigger = "" }) {
  const current = settings();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const projectOf = (config) => String(config.testrail_project_id || current.testrail_project_id || "").trim();
  // A TestRail plan lives in one project, so a multi-configuration run only gets a plan when they share it.
  const planProjects = new Set(configs.map(projectOf));
  const planProject = planProjects.size === 1 ? [...planProjects][0] : "";
  let planId = "";
  if (configs.length > 1 && planProject) {
    try {
      const plan = await addPlan(current, {
        projectId: planProject,
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
    const projectId = projectOf(config);
    let testrailRunId = "";
    let testrailError = "";
    if (config.plan.ready && projectId) {
      try {
        const run = await addRun(current, { projectId, suiteId: config.suite_id, name, caseIds: caseIds(config) });
        if (run.skipped) testrailError = run.reason;
        else testrailRunId = String(run.id || "");
      } catch (error) {
        testrailError = error.message;
        audit(db, user.email, "testrail_run_failed", error.message);
      }
    } else if (config.plan.ready && testrailConfigured(current)) {
      testrailError = `"${config.client_name}" projesinin TestRail projesi yok; konfigürasyonda TestRail suite'i seç`;
    }
    // The run still executes locally; the tester must know its results will not reach TestRail.
    const testrailNote = testrailError ? `TestRail run açılamadı (${testrailError}); sonuçlar yalnız yerel raporda` : "";
    const status = config.plan.ready ? "queued" : "blocked";
    const pinned = ["android", "ios"].includes(config.platform) ? serials : [];
    const hint = pinned.length ? "" : deviceHint || "";
    const message = config.plan.ready
      ? [note, deviceNote(pinned, hint), testrailNote].filter(Boolean).join(" · ")
      : [note, `Konfigürasyon hazır değil: ${config.plan.issues.join("; ")}`].filter(Boolean).join(" · ");
    const row = db.prepare(
      `INSERT INTO runs (status, client_name, config_id, config_name, platform, testrail_run_id, testrail_plan_id, started_by, message, created_at, device_hint, device_serials, testrail_error, case_keys, trigger_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(status, config.client_name, config.id, config.name, config.platform, testrailRunId, planId, user.id, message, new Date().toISOString(), hint, JSON.stringify(pinned), testrailNote, JSON.stringify(config.case_keys || []), trigger);
    created.push(db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(row.lastInsertRowid)));
  }
  return created;
}

const PLATFORM_LABEL = { web: "Web", android: "Android", ios: "iOS", tv: "Smart TV" };

// Devices the tester names by serial, UDID or model ("00008140-… cihazında", "Galaxy S25 Ultra'da") pin a mobile
// run to exactly those devices, ahead of the configuration's UDID list and filter. iOS UDIDs count by their shape;
// any other serial and every model name only when the Farm has such a device. The Farm's spelling is kept.
// `texts` are checked newest first; the first message that names a device decides.
async function pinnedSerials(texts, platform) {
  if (!["android", "ios"].includes(platform)) return [];
  const messages = texts.filter(Boolean);
  const current = settings();
  if (!current.farm_base_url || !current.farm_token) {
    return messages.map((text) => serialCandidates(text).filter(isIosUdid)).find((found) => found.length) || [];
  }
  let known = [];
  try { known = await listDevices(current, { timeoutMs: 10_000 }); } catch { /* Farm unreachable: the shape alone decides */ }
  for (const text of messages) {
    const bySerial = serialCandidates(text)
      .map((word) => known.find((device) => device.serial.toLowerCase() === word.toLowerCase())?.serial || (isIosUdid(word) ? word : ""))
      .filter(Boolean);
    const found = [...new Set(bySerial.length ? bySerial : devicesNamedIn(text, known, platform))];
    if (found.length) return found;
  }
  return [];
}

function deviceNote(serials, hint) {
  if (serials.length) return `Cihaz: ${serials.join(", ")}`;
  return hint ? `Cihaz daraltıldı: ${hint}` : "";
}

// Every QA skill for the admin screen, with its file text so a built-in one can be copied and overridden.
function skillList() {
  const read = (dir, id) => {
    try { return readFileSync(join(dir, `${id}.md`), "utf8"); } catch { return ""; }
  };
  const builtin = new Set(loadSkills([builtinSkillsDir]).map((skill) => skill.id));
  return loadSkills([builtinSkillsDir, customSkillsDir]).sort((a, b) => Number(b.always) - Number(a.always)).map(({ body, ...skill }) => ({
    ...skill,
    overrides: skill.source === "custom" && builtin.has(skill.id),
    size: body.length,
    text: read(skill.source === "custom" ? customSkillsDir : builtinSkillsDir, skill.id),
  }));
}

// Rule-based ad-hoc scenario (no model to plan with, or the QA agent could not): one case whose steps come from the sentence.
async function runScenario(user, parsed) {
  const configs = loadConfigs();
  const target = resolveScenarioTarget(parsed, configs, db.prepare("SELECT * FROM clients").all());
  if (target.error) return { reply: target.error };
  const title = parsed.text.length > 90 ? `${parsed.text.slice(0, 87)}…` : parsed.text;
  return createScenarioRun(user, { target, cases: [{ title, steps: buildScenarioSteps(parsed, target.ignore) }], text: parsed.text });
}

const TESTRAIL_STEP = {
  launch: "Aç", aiAct: "Yap", aiAction: "Yap", ai: "Yap", aiAssert: "Doğrula", aiWaitFor: "Bekle", aiQuery: "Sorgula",
  aiTap: "Dokun", aiInput: "Yaz", aiHover: "Üzerine gel", sleep: "Bekle (ms)", back: "Geri",
};
const SENSITIVE_FIELD = /şifre|sifre|parola|password|passcode|\bpin\b|otp|cvv|cvc/i;

// A scenario's steps as the TestRail case's steps text. Typed secrets never leave Mercury.
function scenarioStepsText(steps, launchUrl) {
  return steps.map((step, index) => {
    let text = step.text || "";
    if (step.action === "launch") text = launchUrl || text;
    if (step.action === "aiInput" && step.args) {
      const { locate, value } = step.args;
      const literal = !String(value).includes("{{");
      text = `${locate} ← ${literal && SENSITIVE_FIELD.test(locate) ? "••••••••" : value}`;
    }
    return `${index + 1}. ${TESTRAIL_STEP[step.action] || step.action}${text ? `: ${text}` : ""}`;
  }).join("\n");
}

// Files the scenario's cases in TestRail and opens a run named like the Mercury run. Without TestRail settings the
// scenario stays local; any other problem is reported but never stops the run.
async function openScenarioTestrail(user, config, cases, name, launchUrl) {
  const current = settings();
  if (!testrailConfigured(current)) return { runId: "", error: "", cases };
  const projectId = String(config.testrail_project_id || current.testrail_project_id || "").trim();
  if (!projectId) return { runId: "", error: "TestRail projesi seçili değil; Ayarlar'da varsayılan TestRail projesini seç", cases };
  try {
    const filed = await ensureScenarioCases(current, {
      projectId, suiteId: config.suite_id, cases: cases.map((item) => ({ title: item.title, stepsText: scenarioStepsText(item.steps, launchUrl) })),
    });
    if (filed.skipped) return { runId: "", error: filed.reason, cases };
    const run = await addRun(current, { projectId, suiteId: filed.suiteId, name, caseIds: [...new Set(filed.caseIds.map(Number))] });
    if (run.skipped) return { runId: "", error: run.reason, cases };
    return { runId: String(run.id || ""), error: "", cases: cases.map((item, index) => ({ ...item, caseId: filed.caseIds[index] })) };
  } catch (error) {
    audit(db, user.email, "testrail_run_failed", error.message);
    return { runId: "", error: error.message, cases };
  }
}

// A chat scenario run: its cases run one after another in one browser or device. It borrows devices, test users and
// the app from `target.config` when there is one and passes the same preflight. It is named after the scenario
// ("Kullanıcı girişi · Web") and, with TestRail set up, files its cases there and opens a run of the same name.
// `lead` is the QA agent's own explanation, shown before the run summary.
// `skills` are the QA skills the plan was made with; their "## Midscene" notes go to Midscene as AI context.
async function createScenarioRun(user, { target, cases: drafted, text, earlier = [], lead = "", skills = null, title = "" }) {
  // Each case becomes its own TestRail case (found again by title), so titles within one scenario must differ.
  const seen = new Map();
  const cases = drafted.map((item) => {
    const count = (seen.get(item.title) || 0) + 1;
    seen.set(item.title, count);
    return count > 1 ? { ...item, title: `${item.title} (${count})` } : item;
  });
  const base = target.config || {};
  const needsAccount = usesAccount(cases);
  if (needsAccount && !base.account_source_id) {
    const where = target.config ? `"${base.client_name} · ${base.name}" konfigürasyonunun` : "Bu hedefin";
    return { reply: [lead, `${where} test hesabı kaynağı yok, giriş için kullanıcı alamıyorum. Kullanıcı adı ve şifreyi mesajda yaz ya da konfigürasyona bir hesap kaynağı bağla.`].filter(Boolean).join("\n") };
  }
  const serials = await pinnedSerials([text, ...earlier], target.platform);
  const config = {
    ...base,
    platform: target.platform,
    client_name: base.client_name || "Anlık senaryo",
    enabled: 1,
    case_ids: "[]",
    case_tags: "[]",
    parallel: 1,
    ...(serials.length ? { device_serials: JSON.stringify(serials), device_filter: "" } : {}),
    launch_url: target.launchUrl || base.launch_url || "",
    package_id: target.packageId || base.package_id || "",
    // Steps that type the test user's e-mail or password cannot run without one.
    account_policy: needsAccount ? "required" : base.account_policy || "none",
  };
  const planned = cases.map((item) => ({ caseId: "", title: item.title, client: "", tags: [], steps: item.steps }));
  const plan = configurationPlan(config, planned, planOptions(settings()));
  const hint = target.config && !serials.length ? deviceHint(fold(text), target.config) : "";
  const where = target.platform === "web" ? config.launch_url || "başlangıç adresi yok" : `${PLATFORM_LABEL[target.platform]} · ${config.package_id || "paket kimliği yok"}`;
  const scenarioTitle = String(title || cases[0].title).trim();
  const runName = `${scenarioTitle} · ${target.config ? target.config.name : PLATFORM_LABEL[target.platform]}`;
  const testrail = plan.ready
    ? await openScenarioTestrail(user, base, cases, runName, config.launch_url || config.package_id)
    : { runId: "", error: "", cases };
  const testrailNote = testrail.error ? `TestRail run açılamadı (${testrail.error}); sonuçlar yalnız yerel raporda` : "";
  const message = plan.ready
    ? ["Anlık senaryo", testrail.runId ? "" : testrailNote || "TestRail'e yazılmaz, sonuç yerel raporda", deviceNote(serials, hint)].filter(Boolean).join(" · ")
    : `Senaryo koşulamıyor: ${plan.issues.join("; ")}`;
  const row = db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, started_by, message, created_at, device_hint, device_serials, scenario_json, testrail_run_id, testrail_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.ready ? "queued" : "blocked", config.client_name, target.config?.id ?? null, runName,
    target.platform, user.id, message, new Date().toISOString(), hint, JSON.stringify(serials),
    JSON.stringify({
      title: scenarioTitle, steps: cases[0].steps, cases: testrail.cases, launchUrl: config.launch_url, packageId: config.package_id, accountPolicy: config.account_policy,
      context: midsceneContext(skills || selectSkills(loadSkills([builtinSkillsDir, customSkillsDir]), [text])),
    }),
    testrail.runId, testrailNote,
  );
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(row.lastInsertRowid));
  audit(db, user.email, "scenario", `${run.id} ${where}`);
  const stepCount = cases.reduce((sum, item) => sum + item.steps.length, 0);
  let heading = "Senaryo ön kontrolü geçemedi. Eksikleri tamamladıktan sonra yeniden yaz.";
  if (plan.ready) {
    heading = cases.length === 1 && !lead
      ? `Senaryoyu ${stepCount} adıma böldüm ve koşumu başlattım (${where}). Adımları aşağıda canlı izleyebilirsin.`
      : `${cases.length} test case (${stepCount} adım) hazırladım ve koşumu başlattım (${where}). Adımları aşağıda canlı izleyebilirsin.`;
  }
  const list = cases.length > 1 ? cases.map((item, index) => `${index + 1}. ${item.title} (${item.steps.length} adım)`) : [];
  return { reply: [lead, heading, ...list, `#${run.id} ${run.config_name}${run.testrail_run_id ? ` · TestRail R${run.testrail_run_id}` : ""} — ${message}`].filter(Boolean).join("\n"), runs: [run] };
}

async function handleChat(user, message, conversationId = null, lang = DEFAULT_LANG) {
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
  const clients = db.prepare("SELECT * FROM clients").all();
  const configs = loadConfigs();
  const memories = db.prepare("SELECT * FROM memories ORDER BY id DESC").all();
  // "örnek proje web chrome koş" names nothing but a saved configuration: it runs as is, without asking the model.
  if (isPlainRunCommand(text, configs, clients, memories)) return runConfigs(user, text, clients);
  // Everything else goes to the QA agent when a model is connected; if it cannot plan, the rules below still answer.
  const current = settings();
  const history = conversationId ? chatConversation(user.id, Number(conversationId)) : [];
  const recent = history.filter((item) => item.role === "user").slice(-3).reverse().map((item) => item.text);
  // Jira issues / Confluence pages named in the sentence (or, for "bu task", earlier in the chat) are read first.
  const { references, errors: referenceErrors } = await gatherReferences(current, text, recent);
  if (references.length || referenceErrors.length) {
    audit(db, user.email, "atlassian_read", [...references.map((item) => `${item.kind}:${item.key}`), ...referenceErrors.map((item) => `hata:${item.split(":")[0]}`)].join(", "));
  }
  if (referenceErrors.length && !references.length) {
    return { reply: `Jira/Confluence kaydı okunamadı:\n${referenceErrors.join("\n")}` };
  }
  const referenceNote = referenceErrors.length ? `Okunamayan kayıtlar: ${referenceErrors.join("; ")}` : "";
  let note = "";
  if (!midsceneModel(current).error) {
    let decision = null;
    let skills = [];
    try {
      const catalog = qaCatalog(configs, listCases(casesDir));
      skills = selectSkills(loadSkills([builtinSkillsDir, customSkillsDir]), [text, ...recent]);
      decision = normalizeDecision(await askQaAgent({ settings: current, text, catalog, conversation: conversationContext(history), references, skills, language: lang }), catalog);
    } catch (error) {
      audit(db, user.email, "qa_agent_failed", error.message);
      note = `QA ajanı bu cümleyi planlayamadı (${error.message}); cümleyi kurallarla yorumladım.`;
    }
    if (decision) {
      audit(db, user.email, "qa_agent", `${decision.intent} · beceriler: ${skills.map((skill) => skill.id).join(", ")}`);
      const issueKey = references.find((item) => item.kind === "jira")?.key;
      // Cases designed from an issue carry its key, so the run, the report and TestRail trace back to it.
      if (decision.intent === "scenario" && issueKey) {
        const tag = (title) => (title.includes(issueKey) ? title : `${issueKey} · ${title}`);
        decision.title = tag(decision.title);
        decision.cases = decision.cases.map((item) => ({ ...item, title: tag(item.title) }));
      }
      const result = await actOnDecision(user, text, decision, configs, skills, recent);
      return {
        ...result,
        reply: [referenceNote, result.reply].filter(Boolean).join("\n"),
        skills: skills.map((skill) => (skill.source === "custom" ? skill.name : localize(skill.name, lang))),
        ...(references.length ? { references: references.map(({ kind, key, url, title }) => ({ kind, key, url, title })) } : {}),
      };
    }
  }
  // Test cases can only be designed from a Jira issue or Confluence page by the model.
  if (references.length) {
    const named = references.map((item) => item.key).join(", ");
    return { reply: [note, `${named} okundu, ama test case çıkarmak için bir model bağlı olmalı (Ayarlar → Model).`].filter(Boolean).join("\n") };
  }
  const result = await ruleBasedChat(user, text, clients);
  return note ? { ...result, reply: `${note}\n${result.reply}` } : result;
}

// `earlier` are the tester's previous messages in this chat (newest first): a device named there ("… cihazında",
// then "com.firma.app ile devam et") still applies when the latest message names none.
async function actOnDecision(user, text, decision, configs, skills, earlier = []) {
  if (decision.intent === "reply") return { reply: decision.reply };
  const byId = new Map(configs.map((item) => [item.id, item]));
  if (decision.intent === "run_suite") {
    const chosen = decision.runs.map((item) => ({ ...byId.get(item.configId), case_keys: item.caseKeys }));
    return startConfigs(user, chosen, chosen.length === 1 ? deviceHint(fold(text), chosen[0]) : "", decision.reply, [text, ...earlier]);
  }
  const target = { ...decision.target, config: decision.target.config ? byId.get(decision.target.config.id) || null : null };
  return createScenarioRun(user, { target, cases: decision.cases, text, earlier, lead: decision.reply, skills, title: decision.title });
}

// Saved configurations keep precedence ("tod android koş", "tod regresyon koş"): a sentence is a scenario only
// when it names a site/app, or asks for actions beyond the project and configuration names.
async function ruleBasedChat(user, text, clients) {
  const scenario = parseScenario(text);
  if (scenario && (scenario.url || scenario.packageId)) return runScenario(user, scenario);
  if (scenario && !/regresyon|regression/.test(fold(text))) {
    if (!wantsRun(text)) return runScenario(user, scenario);
    const named = resolveConfigs(text, loadConfigs(), clients, []);
    let rest = fold(text);
    for (const name of [...clients.map((item) => item.name), ...named.configs.flatMap((item) => [item.name, ...JSON.parse(item.aliases || "[]")])]) {
      if (fold(name)) rest = rest.replace(fold(name), " ");
    }
    if (!named.configs.length || hasScenarioAction(rest)) return runScenario(user, scenario);
  }
  if (!wantsRun(text)) {
    return { reply: "Koşum için proje ve konfigürasyonu söyle (örn. <proje adı> web koş) ya da bir senaryo yaz (örn. https://example.com'u aç, More information'a tıkla, IANA yazdığını doğrula)." };
  }
  return runConfigs(user, text, clients);
}

async function runConfigs(user, text, clients) {
  const resolved = resolveConfigs(text, loadConfigs(), clients, db.prepare("SELECT * FROM memories ORDER BY id DESC").all());
  if (!resolved.configs.length) return { reply: "Bu cümle kayıtlı bir proje veya konfigürasyonla eşleşmedi." };
  return startConfigs(user, resolved.configs, resolved.deviceHint, "", [text]);
}

// `config.case_keys` (from the QA agent) narrows a configuration to the cases the tester named.
// A serial, UDID or device name in `texts` pins a single mobile configuration to that device (see `pinnedSerials`).
async function startConfigs(user, configs, hint, lead = "", texts = []) {
  const serials = configs.length === 1 ? await pinnedSerials(texts, configs[0].platform) : [];
  const runs = await createExecution({ user, configs, deviceHint: hint, serials });
  audit(db, user.email, "run", runs.map((item) => item.id).join(","));
  const blocked = runs.filter((item) => item.status === "blocked");
  const heading = blocked.length
    ? `${blocked.length} koşum, konfigürasyon ön kontrolü geçemedi. Eksikleri tamamladıktan sonra yeniden başlat.`
    : "Yürütme planı hazırlandı ve yeni koşum açıldı. Adımları aşağıda canlı izleyebilirsin.";
  const scope = (run) => {
    const keys = JSON.parse(run.case_keys || "[]");
    return keys.length ? ` · ${keys.length} case` : "";
  };
  return {
    reply: [lead, heading, ...runs.map((item) => `#${item.id} ${item.client_name} · ${item.config_name}${scope(item)}${item.message ? ` — ${item.message}` : ""}`)].filter(Boolean).join("\n"),
    runs,
  };
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.lang = requestLang(req);
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
    if ((url.pathname.startsWith("/api/settings") || url.pathname.startsWith("/api/users") || url.pathname.startsWith("/api/sources") || url.pathname.startsWith("/api/skills")) && user.role !== "admin") {
      return send(res, 403, { error: "Bu alan yalnız admin içindir" });
    }
    if (req.method === "GET" && url.pathname === "/api/skills") {
      // Built-in skills show a translated name and description; custom ones are the admin's own text.
      return send(res, 200, skillList().map((skill) => (skill.source === "custom" ? skill
        : { ...skill, name: localize(skill.name, res.lang), description: localize(skill.description, res.lang) })));
    }
    const skillRoute = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (skillRoute && (req.method === "PUT" || req.method === "DELETE")) {
      const id = decodeURIComponent(skillRoute[1]);
      if (!SKILL_ID.test(id)) return send(res, 400, { error: "Beceri kimliği küçük harf, rakam ve tire olmalı (2–60 karakter)" });
      const file = join(customSkillsDir, `${id}.md`);
      if (req.method === "DELETE") {
        if (!existsSync(file)) return send(res, 404, { error: "Bu kimlikte özel beceri yok; yerleşik beceriler silinmez" });
        rmSync(file);
        audit(db, user.email, "skill_delete", id);
        return send(res, 200, skillList());
      }
      const body = await readBody(req);
      const text = String(body.text || "");
      if (text.length > 20_000) return send(res, 400, { error: "Beceri en fazla 20.000 karakter olabilir" });
      const parsed = parseSkill(text, id);
      if (!parsed.body) return send(res, 400, { error: "Beceri metni boş" });
      if (!parsed.always && !parsed.triggers.length) return send(res, 400, { error: "Ön bilgiye tetikleyici sözcükler (triggers: …) veya always: true yaz; yoksa beceri hiç seçilmez" });
      mkdirSync(customSkillsDir, { recursive: true });
      writeFileSync(file, text);
      audit(db, user.email, "skill_save", id);
      return send(res, 200, skillList());
    }
    if (req.method === "GET" && url.pathname === "/api/settings") return send(res, 200, publicSettings());
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      const family = body.midscene_model_family;
      if (typeof family === "string" && family && !MIDSCENE_FAMILIES.includes(family)) return send(res, 400, { error: `Geçersiz Midscene model ailesi: ${family}` });
      for (const [name, value] of Object.entries(body)) {
        if (typeof value !== "string" || name === "web_concurrency_auto" || (SECRET_KEYS.has(name) && value.includes("•"))) continue;
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
        return send(res, 200, { models: withMidsceneFamily(listed.models), baseUrl: listed.base || input.baseUrl });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/models/select") {
      try {
        const body = await readBody(req);
        const name = String(body.model || "").trim();
        if (!name) return send(res, 400, { error: "Model seç" });
        // "" = detect from the model name. Always rewritten so a family chosen for the previous model doesn't stick.
        const family = String(body.midsceneFamily || "").trim();
        if (family && !MIDSCENE_FAMILIES.includes(family)) return send(res, 400, { error: `Geçersiz Midscene model ailesi: ${family}` });
        const input = modelInput(body);
        assertCredentials(input);
        saveModel(input, name);
        saveSetting("midscene_model_family", family);
        audit(db, user.email, "model_select", `${input.provider}:${name}`);
        return send(res, 200, modelStatus());
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if ((req.method === "POST" && url.pathname === "/api/settings/testrail-test") || (req.method === "GET" && url.pathname === "/api/settings/testrail-projects")) {
      try {
        const projects = await listProjects(settings());
        if (projects.skipped) return send(res, 400, { error: projects.reason });
        return send(res, 200, { ok: true, projects });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    // Optional helper for the configuration dialog: failures come back as `reason` so the dialog still works offline.
    if (req.method === "GET" && url.pathname === "/api/settings/farm-devices") {
      try {
        return send(res, 200, { devices: await listDevices(settings()) });
      } catch (error) {
        return send(res, 200, { devices: [], reason: error.message });
      }
    }
    // Optional helper for the configuration dialog: failures come back as `reason` so the dialog still works offline.
    if (req.method === "GET" && url.pathname === "/api/settings/testrail-suites") {
      try {
        const suites = await listProjectSuites(settings());
        if (suites.skipped) return send(res, 200, { suites: [], reason: suites.reason });
        const projects = db.prepare("SELECT id, suite_id FROM clients").all();
        return send(res, 200, { suites: suites.map((suite) => ({ ...suite, client_id: projects.find((item) => item.suite_id === suite.id)?.id ?? null })) });
      } catch (error) {
        return send(res, 200, { suites: [], reason: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/settings/atlassian-test") {
      try {
        const checked = await testAtlassian(settings());
        if (checked.skipped) return send(res, 400, { error: checked.reason });
        audit(db, user.email, "atlassian_test", checked.confluence);
        return send(res, 200, checked);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
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
        clients: db.prepare("SELECT id, name, suite_id, project_id FROM clients ORDER BY name").all(),
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
        const project = resolveProject(body);
        const id = saveConfig(input, project.id, null, user);
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
        const body = await readBody(req);
        const projectInput = body.clientId === undefined && body.client === undefined ? { ...body, clientId: current.client_id } : body;
        saveConfig(normalizeConfigInput(body, current), resolveProject(projectInput).id, current.id, user);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      audit(db, user.email, "config_update", String(current.id));
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && configUpdate) {
      if (user.role !== "admin") return send(res, 403, { error: "Bu alan yalnız admin içindir" });
      const current = db.prepare("SELECT * FROM configs WHERE id = ?").get(Number(configUpdate[1]));
      if (!current) return send(res, 404, { error: "Konfigürasyon bulunamadı" });
      const activeRun = db.prepare("SELECT id FROM runs WHERE config_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1").get(current.id);
      if (activeRun) return send(res, 409, { error: `Konfigürasyon #${activeRun.id} numaralı koşum tamamlanmadan silinemez` });
      db.prepare("DELETE FROM configs WHERE id = ?").run(current.id);
      audit(db, user.email, "config_delete", String(current.id));
      return send(res, 200, { ok: true });
    }
    // /api/sources* is admin-only (checked above with the settings routes).
    if (req.method === "GET" && url.pathname === "/api/sources") return send(res, 200, accountStore.list());
    if (req.method === "GET" && url.pathname === "/api/sources/templates") {
      return send(res, 200, accountTemplates().map((item) => ({ template: item.template, name: localize(item.name, res.lang), base_url: item.base_url, spec: normalizeSpec(item.spec) })));
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
      const rows = db.prepare("SELECT id, status, client_name, config_name, platform, testrail_run_id, testrail_plan_id, device_label, account_email, message, created_at, finished_at, started_by, scenario_json != '' AS scenario, trigger_kind = 'schedule' AS scheduled FROM runs ORDER BY id DESC").all();
      const reports = new Map();
      for (const { run_id: runId, report } of db.prepare("SELECT run_id, json_extract(files_json, '$.report') AS report FROM run_cases WHERE report IS NOT NULL ORDER BY id").all()) {
        reports.set(runId, [...(reports.get(runId) || []), report]);
      }
      // Per-run case tallies so a 400-case regression reads "380 passed · 15 failed" without opening it.
      const counts = new Map();
      for (const { run_id: runId, status, n } of db.prepare("SELECT run_id, status, COUNT(*) AS n FROM run_cases GROUP BY run_id, status").all()) {
        const tally = counts.get(runId) || { total: 0, passed: 0, failed: 0, blocked: 0, running: 0 };
        tally.total += n;
        tally[Object.hasOwn(tally, status) ? status : "running"] += n;
        counts.set(runId, tally);
      }
      return send(res, 200, rows.map(({ started_by: startedBy, ...run }) => ({
        ...run, scenario: Boolean(run.scenario), scheduled: Boolean(run.scheduled), midscene_reports: reports.get(run.id) || [], can_delete: user.role === "admin" || startedBy === user.id,
        case_counts: counts.get(run.id) || { total: 0, passed: 0, failed: 0, blocked: 0, running: 0 },
      })));
    }
    // Every scheduled configuration with its next slot and its latest scheduled run; read-only, so every member sees it.
    if (req.method === "GET" && url.pathname === "/api/schedules") {
      const latest = db.prepare("SELECT id, status, created_at FROM runs WHERE config_id = ? AND trigger_kind = 'schedule' ORDER BY id DESC LIMIT 1");
      const rows = db.prepare(
        `SELECT configs.id, configs.name, configs.platform, configs.enabled, configs.schedule_json, configs.schedule_last_at, clients.name AS client_name
         FROM configs JOIN clients ON clients.id = configs.client_id ORDER BY clients.name, configs.name`,
      ).all();
      return send(res, 200, rows.flatMap((row) => {
        const schedule = parseSchedule(row.schedule_json);
        if (!schedule) return [];
        const { since, userId, ...timing } = schedule;
        return [{
          config_id: row.id, config_name: row.name, client_name: row.client_name, platform: row.platform, enabled: Boolean(row.enabled),
          schedule: timing, next_at: row.enabled ? nextRunAt(schedule, Date.parse(row.schedule_last_at || "") || 0) : null,
          last_run: latest.get(row.id) || null,
        }];
      }));
    }
    const runDelete = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (req.method === "DELETE" && runDelete) {
      const run = db.prepare("SELECT id, status, started_by FROM runs WHERE id = ?").get(Number(runDelete[1]));
      if (!run) return send(res, 404, { error: "Koşum yok" });
      if (user.role !== "admin" && run.started_by !== user.id) return send(res, 403, { error: "Yalnız kendi başlattığın koşumları silebilirsin" });
      if (run.status === "queued" || run.status === "running") return send(res, 409, { error: `Koşum #${run.id} tamamlanmadan silinemez` });
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM run_cases WHERE run_id = ?").run(run.id);
        db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
        // Run ids can be reused after the newest run is deleted; drop the reference so old chat turns never show a newer run.
        const linked = db.prepare("SELECT id, run_ids FROM chat_messages WHERE run_ids LIKE ?").all(`%${run.id}%`);
        const unlink = db.prepare("UPDATE chat_messages SET run_ids = ? WHERE id = ?");
        for (const row of linked) {
          const ids = JSON.parse(row.run_ids || "[]");
          if (ids.includes(run.id)) unlink.run(JSON.stringify(ids.filter((item) => item !== run.id)), row.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      rmSync(join(reportsDir, String(run.id)), { recursive: true, force: true });
      audit(db, user.email, "run_delete", String(run.id));
      return send(res, 200, { ok: true });
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
      if (!/^\d+$/.test(id) || !/^[\w-]+\.(html|webm|mp4|png|jpg|json)$/.test(fileName)) return send(res, 404, { error: "Rapor yok" });
      const file = join(reportsDir, id, fileName);
      if (!existsSync(file)) return send(res, 404, { error: "Rapor yok" });
      const reportTypes = { ".html": "text/html; charset=utf-8", ".webm": "video/webm", ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json" };
      const body = readFileSync(file);
      // A step screenshot is written once and never changes; everything else (live report, index) may still grow.
      const cache = fileName.startsWith("shot-") ? "private, max-age=31536000, immutable" : "private, no-store";
      const headers = { "content-type": reportTypes[extname(file)], "accept-ranges": "bytes", "cache-control": cache };
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
      const result = await handleChat(user, text, body.conversationId, res.lang);
      if (result.runs) result.runs = result.runs.map((item) => runDetail(item.id) || item);
      if (text) result.conversationId = saveChatTurn(user.id, text, result.reply, (result.runs || []).map((item) => item.id), body.conversationId);
      return send(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/chat/history") {
      return send(res, 200, chatHistory(user.id, url.searchParams.get("q") || ""));
    }
    // History is private: a user only ever reads or deletes their own conversations. Runs stay in Koşumlar.
    const historyRoute = url.pathname.match(/^\/api\/chat\/history(?:\/(\d+))?$/);
    if (req.method === "GET" && historyRoute?.[1]) {
      const messages = chatConversation(user.id, Number(historyRoute[1]));
      if (!messages.length) return send(res, 404, { error: "Konuşma bulunamadı" });
      return send(res, 200, messages);
    }
    if (req.method === "DELETE" && historyRoute) {
      const removed = historyRoute[1]
        ? db.prepare("DELETE FROM chat_messages WHERE user_id = ? AND conversation_id = ?").run(user.id, Number(historyRoute[1])).changes
        : db.prepare("DELETE FROM chat_messages WHERE user_id = ?").run(user.id).changes;
      if (historyRoute[1] && !removed) return send(res, 404, { error: "Konuşma bulunamadı" });
      audit(db, user.email, historyRoute[1] ? "chat_conversation_delete" : "chat_history_clear", historyRoute[1] || String(removed));
      return send(res, 200, { ok: true, removed });
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

// Starts configurations whose schedule slot has come. The slot is recorded before the run is created,
// so a slow TestRail call or a crash cannot start the same slot twice.
let scheduling = false;
async function runSchedules(now = Date.now()) {
  if (scheduling) return;
  scheduling = true;
  try {
    const rows = db.prepare("SELECT id, name, enabled, schedule_json, schedule_last_at FROM configs WHERE enabled = 1 AND schedule_json LIKE '%\"enabled\":true%'").all();
    for (const row of rows) {
      const schedule = parseSchedule(row.schedule_json);
      const due = dueSlot(schedule, Date.parse(row.schedule_last_at || "") || 0, now);
      if (!due) continue;
      const slot = new Date(due.slot).toISOString();
      db.prepare("UPDATE configs SET schedule_last_at = ? WHERE id = ?").run(slot, row.id);
      if (due.action === "skip") {
        audit(db, "scheduler", "schedule_missed", `${row.id} ${slot}`);
        continue;
      }
      const active = db.prepare("SELECT id FROM runs WHERE config_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1").get(row.id);
      if (active) {
        audit(db, "scheduler", "schedule_skipped", `${row.id} ${slot}: #${active.id} sürüyor`);
        continue;
      }
      const owner = (schedule.userId && db.prepare("SELECT id, email FROM users WHERE id = ? AND status = 'active' AND role = 'admin'").get(schedule.userId))
        || db.prepare("SELECT id, email FROM users WHERE builtin = 1").get();
      const config = loadConfigs().find((item) => item.id === row.id);
      if (!config || !owner) continue;
      const runs = await createExecution({ user: owner, configs: [config], note: "Zamanlanmış koşum", trigger: "schedule" });
      audit(db, "scheduler", "schedule_run", `${row.id} ${slot} -> ${runs.map((item) => item.id).join(",")}`);
    }
  } finally {
    scheduling = false;
  }
}

const worker = createWorker({ db, settings, reportsDir, casesDir, skillsDirs: [builtinSkillsDir, customSkillsDir], accounts: accountStore });
setInterval(() => worker.tick().catch((error) => audit(db, "worker", "tick", error.message)), 2000);
const scheduleEvery = Math.max(1000, Number(process.env.MERCURY_SCHEDULE_INTERVAL_MS) || 30_000);
setInterval(() => runSchedules().catch((error) => audit(db, "scheduler", "tick", error.message)), scheduleEvery);
const port = Number(process.env.PORT || 8080);
server.listen(port, "0.0.0.0", () => {
  console.log(`Mercury Test Runner ${version} http://localhost:${port}`);
});
