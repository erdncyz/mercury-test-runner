import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adbConnect, adbDisconnect, resolveAdb } from "./adb.mjs";
import { NoFreeDeviceError, deviceLabel, installApp, parseWdaUrl, releaseDevice, reportScenarios, reserveDevices, useDevice } from "./farm.mjs";
import { addResults } from "./integrations.mjs";
import { midsceneModel, midsceneVersion, runMobileCases, runWebCases, stepLabel } from "./midscene.mjs";
import { fairLaneGrants, laneCount, objectValue, scopeCases, selectCases, serialList, shardCases, webLimit } from "./planning.mjs";
import { caseSkillText, loadSkills, midsceneContext, selectSkills } from "./skills.mjs";

// A chat scenario holds one or more cases; rows written before multi-case scenarios have only title/steps.
export function scenarioCases(scenario) {
  return scenario?.cases?.length ? scenario.cases : [{ title: scenario?.title || "", steps: scenario?.steps || [] }];
}

function unquote(value) {
  const text = String(value || "").trim();
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
}

// The inline value of a step that also has nested arguments (`- aiNumber: "Sepet tutarı"` + `name: tutar`) is the
// argument that step would otherwise lack, so the shown label never becomes the text sent to Midscene.
const INLINE_ARG = { aiBoolean: "prompt", aiNumber: "prompt", aiString: "prompt", aiQuery: "prompt", aiKeyboardPress: "keyName", aiScroll: "locate", aiPinch: "locate" };

// Minimal reader for the `steps:` lists in case YAML (no YAML dependency in this project).
export function parseSteps(text) {
  const steps = [];
  let stepsIndent = -1;
  let current = null;
  let inline = "";
  const finish = () => {
    if (!current?.args || !INLINE_ARG[current.action]) return;
    const name = INLINE_ARG[current.action];
    if (inline && current.args[name] === undefined) current.args = { [name]: inline, ...current.args };
    current.text = stepLabel(current.action, current.args) ?? current.text;
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (trimmed === "steps:") {
      finish();
      stepsIndent = indent;
      current = null;
      continue;
    }
    if (stepsIndent < 0) continue;
    if (indent <= stepsIndent) {
      finish();
      stepsIndent = -1;
      current = null;
      continue;
    }
    const item = trimmed.match(/^-\s*([A-Za-z]\w*):\s*(.*)$/);
    if (item) {
      finish();
      current = { action: item[1], text: unquote(item[2]) };
      inline = current.text;
      steps.push(current);
      continue;
    }
    const nested = trimmed.match(/^([A-Za-z]\w*):\s*(.+)$/);
    if (nested && current) {
      current.args = { ...current.args, [nested[1]]: unquote(nested[2]) };
      const { locate, value } = current.args;
      if (current.action === "aiInput" && locate !== undefined) current.text = `${locate} ← ${value ?? ""}`;
      else if (!current.text) current.text = unquote(nested[2]);
    }
  }
  finish();
  return steps;
}

export function listCases(root) {
  const found = [];
  function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.name.endsWith(".yaml") || name.name.endsWith(".yml")) {
        const text = readFileSync(path, "utf8");
        const caseId = text.match(/testrailCaseId:\s*(\d+)/)?.[1] || "";
        const title = text.match(/name:\s*"([^"]+)"/)?.[1] || name.name;
        const client = text.match(/^client:\s*(.+)$/m)?.[1]?.trim() || "";
        const tags = [...text.matchAll(/tags:\s*\[([^\]]*)\]/g)]
          .flatMap((match) => match[1].split(","))
          .map((tag) => unquote(tag))
          .filter(Boolean);
        found.push({ path, caseId, title, client, tags: [...new Set(tags)], text, steps: parseSteps(text) });
      }
    }
  }
  try {
    walk(root);
  } catch {
    return [];
  }
  return found;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

const STEP_LABEL = { passed: "geçti", failed: "başarısız", skipped: "atlandı", not_run: "çalıştırılmadı", pending: "bekliyor" };

function reportHtml({ run, cases, note, midscene }) {
  const blocks = cases.map((item) => {
    const steps = (item.steps || []).map((step) => `<li class="${escapeHtml(step.status)}"><code>${escapeHtml(step.action)}</code> ${escapeHtml(step.text)} <em>${escapeHtml(STEP_LABEL[step.status] || step.status)}</em>${step.shot ? ` <a href="${escapeHtml(`${step.shot}?v=${encodeURIComponent(run.created_at || "")}`)}">ekran</a>` : ""}${step.detail && step.status === "failed" ? `<div class="err">${escapeHtml(step.detail)}</div>` : ""}</li>`).join("");
    const links = item.files?.report ? `<a href="${escapeHtml(item.files.report)}">Midscene raporu</a>` : "";
    const title = item.caseId ? String(item.title).replace(new RegExp(`^C?${item.caseId}\\b[\\s:.\\-–—]*`, "i"), "") || item.title : item.title;
    return `<section><h2><code>${escapeHtml(item.caseId ? `C${item.caseId}` : "—")}</code> ${escapeHtml(title)} <em>${escapeHtml(item.status)}</em></h2>${links ? `<p>${links}</p>` : ""}<ol>${steps}</ol></section>`;
  }).join("");
  return `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Run ${run.id}</title>
  <style>body{font-family:sans-serif;background:#0b1120;color:#f8fafc;padding:32px;max-width:960px;margin:auto}a{color:#22c55e}code{color:#94a3b8}
  section{border:1px solid #334155;border-radius:12px;padding:8px 20px;margin:16px 0}li{margin:6px 0}.passed em{color:#22c55e}.failed em,.err{color:#f87171}.skipped em,.not_run em{color:#94a3b8}.err{font-size:13px;margin-top:4px}</style>
  <body><h1>Mercury Test Runner · #${run.id}</h1>
  <p>${run.scenario_json ? `${escapeHtml(run.config_name)} · ${escapeHtml(run.client_name)}` : `${escapeHtml(run.client_name)} · ${escapeHtml(run.config_name)}`}${midscene ? ` · Midscene ${escapeHtml(midscene)}` : ""}</p>
  <p>${escapeHtml(note)}</p>${blocks}</body></html>`;
}

// Only browsers are capped by this machine; phones are limited by the farm's free devices and each UDID pool.
const LIMITS = { web: webLimit };
const DEVICE_RETRY_MS = 30_000;
const MOBILE = new Set(["android", "ios"]);

function scenarioStatus(status) {
  return status === "passed" ? "passed" : status === "failed" ? "failed" : "skipped";
}

// `accounts` is the account store (src/accounts.mjs); `drivers` lets tests replace the farm, ADB,
// account and Midscene runners with fakes.
// `skillsDirs` (built-in, then custom) give each case the "## Midscene" notes of the QA skills that fit it.
export function createWorker({ db, settings, reportsDir, casesDir, skillsDirs = [], accounts: accountStore = {}, drivers = {} }) {
  const farm = { reserveDevices, useDevice, installApp, releaseDevice, reportScenarios, ...drivers.farm };
  const adb = { resolveAdb, adbConnect, adbDisconnect, ...drivers.adb };
  const accounts = { ...accountStore, ...drivers.accounts };
  const runWeb = drivers.runWebCases || runWebCases;
  const runMobile = drivers.runMobileCases || runMobileCases;
  const configById = db.prepare(
    `SELECT configs.*, sources.name AS account_source_name
     FROM configs LEFT JOIN sources ON sources.id = configs.account_source_id WHERE configs.id = ?`,
  );
  let ticking = false;
  const active = new Set();
  // Account acquisition is serialized and locked immediately, so parallel lanes and runs never get the same user.
  const accountsInUse = new Set();
  let accountQueue = Promise.resolve();

  db.prepare("UPDATE runs SET status = 'failed', message = 'Sunucu yeniden başladı; koşum yarıda kaldı', finished_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const current = settings();
      const running = {};
      const usage = {};
      for (const row of db.prepare("SELECT platform, started_by, SUM(lanes) AS n FROM runs WHERE status = 'running' GROUP BY platform, started_by").all()) {
        running[row.platform] = (running[row.platform] || 0) + (row.n || 0);
        (usage[row.platform] ||= new Map()).set(row.started_by ?? 0, row.n || 0);
      }
      const due = db.prepare("SELECT * FROM runs WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= ?) ORDER BY id ASC")
        .all(new Date().toISOString());
      // A chat scenario runs its cases one after another, so it always takes one browser or device.
      const wanted = (run) => (run.scenario_json ? 1 : laneCount(configById.get(run.config_id) || {}));
      const grants = new Map();
      for (const run of due) if (!LIMITS[run.platform]) grants.set(run.id, wanted(run));
      // Capped platforms share their free lanes fairly between the users waiting for them.
      for (const [platform, limitOf] of Object.entries(LIMITS)) {
        const waiting = due.filter((run) => run.platform === platform).map((run) => ({ id: run.id, user: run.started_by ?? 0, lanes: wanted(run) }));
        if (!waiting.length) continue;
        const free = limitOf(current) - (running[platform] || 0);
        for (const [id, lanes] of fairLaneGrants(waiting, free, usage[platform])) grants.set(id, lanes);
      }
      for (const run of due) {
        const lanes = grants.get(run.id);
        if (!lanes) continue;
        db.prepare("UPDATE runs SET status = 'running', retry_at = NULL, lanes = ?, started_at = ? WHERE id = ?")
          .run(lanes, new Date().toISOString(), run.id);
        const job = execute(run, lanes)
          .catch((error) => {
            db.prepare("UPDATE runs SET status = 'failed', message = ?, finished_at = ? WHERE id = ? AND status = 'running'")
              .run(`Beklenmeyen hata: ${error.message}`, new Date().toISOString(), run.id);
          })
          .finally(() => active.delete(job));
        active.add(job);
      }
    } finally {
      ticking = false;
    }
  }

  async function lockAccount(config, warnings) {
    if (config.account_policy === "none") return null;
    const required = config.account_policy === "required";
    const skip = (reason) => {
      if (required) throw new Error(reason);
      warnings.push(`Opsiyonel test hesabı alınamadı: ${reason}`);
      return null;
    };
    const source = config.account_source_id ? accounts.sourceById(config.account_source_id) : null;
    if (!source) return skip("Konfigürasyonun hesap kaynağı bulunamadı");
    const state = accounts.status(source);
    if (!state.ready) return skip(`"${source.name}" hesap kaynağında ${state.issue}`);
    let account;
    try {
      account = await accounts.acquire(source, {
        environment: config.environment,
        filters: objectValue(config.account_filters),
        exclude: accountsInUse,
      });
    } catch (error) {
      return skip(`"${source.name}": ${error.message}`);
    }
    accountsInUse.add(account.lockKey);
    if (account.warning) {
      warnings.push(account.warning);
      db.prepare("INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)")
        .run("worker", "account_mark_failed", account.warning, new Date().toISOString());
    }
    return account;
  }

  function acquireAccount(config, warnings) {
    const task = accountQueue.then(() => lockAccount(config, warnings));
    accountQueue = task.catch(() => {});
    return task;
  }

  // `maxLanes` is what the scheduler granted: a run may get fewer lanes than configured while others wait.
  async function execute(run, maxLanes = Infinity) {
    const current = settings();
    const config = configById.get(run.config_id) || {};
    config.client_name = run.client_name;
    const pinned = serialList(run.device_serials);
    if (pinned.length) Object.assign(config, { device_serials: JSON.stringify(pinned), device_filter: "" });
    const scenario = run.scenario_json ? JSON.parse(run.scenario_json) : null;
    if (scenario) {
      // The scenario's own site or app overrides the configuration it borrowed devices and test users from.
      config.launch_url = scenario.launchUrl || config.launch_url || "";
      config.package_id = scenario.packageId || config.package_id || "";
      config.parallel = 1;
      config.account_policy = scenario.accountPolicy || config.account_policy || "none";
    }
    const skills = skillsDirs.length && !scenario ? loadSkills(skillsDirs) : [];
    const cases = scenario
      ? scenarioCases(scenario).map((item) => ({ caseId: item.caseId || "", title: item.title, client: "", tags: [], steps: item.steps, context: scenario.context || "" }))
      : scopeCases(selectCases(config, listCases(casesDir)), run.case_keys)
        .map((item) => ({ ...item, context: skills.length ? midsceneContext(selectSkills(skills, [caseSkillText(item)])) : "" }));
    const model = midsceneModel(current);
    const shards = shardCases(cases.length, Math.min(laneCount(config, cases.length), maxLanes));
    db.prepare("UPDATE runs SET lanes = ? WHERE id = ?").run(shards.length, run.id);

    // Devices are reserved before anything else so a run waiting for free phones holds no account or rows.
    let reservation = null;
    let reservationError = null;
    if (MOBILE.has(run.platform) && cases.length && !model.error) {
      try {
        reservation = await farm.reserveDevices(current, {
          platform: run.platform,
          amount: shards.length,
          serials: serialList(config.device_serials),
          filter: [config.device_filter, run.device_hint].filter(Boolean).join(" "),
          run: `${run.client_name} ${run.config_name} #${run.id}`,
          project: run.client_name,
        });
      } catch (error) {
        const waitLimit = Math.max(1, Number(config.device_wait_minutes) || 30);
        const waited = (Date.now() - new Date(run.created_at).getTime()) / 60_000;
        if (error instanceof NoFreeDeviceError && waited < waitLimit) {
          db.prepare("UPDATE runs SET status = 'queued', started_at = NULL, retry_at = ?, message = ? WHERE id = ?")
            .run(new Date(Date.now() + DEVICE_RETRY_MS).toISOString(), `Boş cihaz bekleniyor · ${error.message}`, run.id);
          return;
        }
        reservationError = error instanceof NoFreeDeviceError
          ? new Error(`${waitLimit} dk içinde boş cihaz bulunamadı: ${error.message}`)
          : error;
      }
    }

    const dir = join(reportsDir, String(run.id));
    mkdirSync(dir, { recursive: true });
    const rows = cases.map((item) => ({
      item,
      steps: item.steps.map((step) => ({ ...step, status: "pending", detail: "" })),
      status: "running",
      detail: "",
      files: {},
      lane: 0,
      id: Number(db.prepare("INSERT INTO run_cases (run_id, case_key, title, status, detail, steps_json) VALUES (?, ?, ?, 'running', '', ?)")
        .run(run.id, item.caseId, item.title, JSON.stringify(item.steps.map((step) => ({ ...step, status: "pending", detail: "" })))).lastInsertRowid),
    }));
    shards.forEach((indices, lane) => indices.forEach((index) => { rows[index].lane = lane; }));
    const saveRow = (row) => db.prepare("UPDATE run_cases SET status = ?, detail = ?, steps_json = ?, files_json = ? WHERE id = ?")
      .run(row.status, row.detail, JSON.stringify(row.steps), JSON.stringify(row.files || {}), row.id);
    const note = (text) => db.prepare("UPDATE runs SET message = ? WHERE id = ?").run(text, run.id);

    let status = "blocked";
    let message = "";
    const devices = reservation?.devices || [];
    const labels = devices.map(deviceLabel);
    const emails = [];
    const warnings = [];
    if (labels.length) db.prepare("UPDATE runs SET device_label = ? WHERE id = ?").run(labels.join(" | "), run.id);

    // One lane = one browser or one farm device, its own test user and its share of the cases.
    async function runLane(lane, indices) {
      // `fileKey` (the run_cases id) names screenshots, reports and videos of cases that have no TestRail id.
      const laneCases = indices.map((index) => ({ ...cases[index], fileKey: String(rows[index].id) }));
      const onProgress = (local, steps, files) => {
        rows[indices[local]].steps = steps;
        if (files) rows[indices[local]].files = files;
        saveRow(rows[indices[local]]);
      };
      const prefix = shards.length > 1 ? `Hat ${lane + 1}: ` : "";
      let account = null;
      let adbTarget = "";
      try {
        account = await acquireAccount(config, warnings);
        if (config.account_policy === "required" && !account) throw new Error("Zorunlu test hesabı alınamadı");
        if (account) {
          emails.push(account.email);
          const tag = db.prepare("UPDATE run_cases SET account_email = ? WHERE id = ?");
          for (const index of indices) tag.run(account.email, rows[index].id);
        }
        const vars = { account: account ? { ...account.extras, email: account.email, password: account.password, phone: account.phone } : {} };
        let outcome;
        if (run.platform === "web") {
          outcome = await runWeb({ runId: run.id, cases: laneCases, vars: { ...vars, launchUrl: config.launch_url || "" }, model, reportDir: dir, onProgress });
        } else {
          const device = devices[lane];
          if (config.app_url) await farm.installApp(current, device.serial, config.app_url);
          const remote = await farm.useDevice(current, device.serial, { groupId: reservation.groupId });
          let connection;
          let adbPath = "";
          if (run.platform === "android") {
            adbPath = adb.resolveAdb();
            if (!adbPath) throw new Error("ADB kurulu değil. Sunucuda `npm run setup` çalıştır.");
            await adb.adbConnect(remote);
            adbTarget = remote;
            connection = { serial: remote };
          } else {
            connection = parseWdaUrl(remote);
          }
          outcome = await runMobile({
            platform: run.platform,
            connection,
            adbPath,
            appId: config.package_id || "",
            runId: run.id,
            cases: laneCases,
            vars: { ...vars, launchUrl: config.launch_url || config.package_id || "" },
            model,
            reportDir: dir,
            onProgress,
          });
        }
        if (outcome.setupError) {
          for (const index of indices) Object.assign(rows[index], { status: "blocked", detail: outcome.setupError });
        } else {
          outcome.results.forEach((result, local) => Object.assign(rows[indices[local]], {
            status: result.status, detail: `${prefix}${result.message}`, steps: result.steps, files: result.files,
          }));
        }
      } catch (error) {
        const label = labels[lane] ? ` (${labels[lane]})` : "";
        for (const index of indices) {
          if (rows[index].status === "running") Object.assign(rows[index], { status: "failed", detail: `${prefix}${error.message}${label}` });
        }
      } finally {
        if (adbTarget) await adb.adbDisconnect(adbTarget);
        if (account) accountsInUse.delete(account.lockKey);
      }
    }

    try {
      if (run.platform === "tv") {
        message = "Smart TV için yürütücü yok";
      } else if (!cases.length) {
        message = "Bu konfigürasyonun case kapsamında YAML case yok";
      } else if (model.error) {
        message = `${model.error} Midscene çalıştırılmadı.`;
      } else {
        if (reservationError) throw reservationError;
        const where = run.platform === "web" ? `${shards.length} tarayıcı` : `${devices.length} cihaz`;
        note(`Midscene koşuyor (${model.family}) · ${where}, ${cases.length} case`);
        await Promise.all(shards.map((indices, lane) => runLane(lane, indices)));
        const failedRows = rows.filter((row) => row.status === "failed");
        const blockedRow = rows.find((row) => row.status === "blocked");
        status = failedRows.length ? "failed" : blockedRow ? "blocked" : "passed";
        message = failedRows.length
          ? `${failedRows.length}/${rows.length} case başarısız. ${failedRows[0].detail}`
          : blockedRow ? blockedRow.detail : `${rows.length} case geçti${shards.length > 1 ? ` · ${shards.length} paralel hat` : ""}`;
      }
    } catch (error) {
      status = "failed";
      message = error.message;
    } finally {
      if (reservation) {
        const scenarios = rows.map((row) => ({
          name: row.item.caseId && !new RegExp(`^C?${row.item.caseId}\\b`, "i").test(row.item.title) ? `C${row.item.caseId} ${row.item.title}` : row.item.title,
          status: scenarioStatus(row.status === "running" ? status : row.status),
          ...(row.status === "failed" && row.detail ? { error: row.detail.slice(0, 500) } : {}),
        }));
        await farm.reportScenarios(current, reservation.groupId, scenarios)
          .catch((error) => warnings.push(`Farm senaryo sonucu yazılamadı: ${error.message}`));
        await farm.releaseDevice(current, reservation.groupId, status)
          .catch((error) => warnings.push(`Farm cihazı bırakılamadı: ${error.message}`));
      }
    }

    if (run.testrail_error) warnings.push(run.testrail_error);
    if (warnings.length) message = [message, ...new Set(warnings)].filter(Boolean).join(" · ");
    for (const row of rows) {
      if (row.status === "running") Object.assign(row, { status, detail: message });
      for (const step of row.steps) {
        if (step.status === "pending" || step.status === "running") Object.assign(step, { status: "not_run", detail: row.detail || message });
      }
      saveRow(row);
    }
    writeFileSync(join(dir, "index.html"), reportHtml({
      run,
      cases: rows.map((row) => ({ ...row.item, status: row.status, steps: row.steps, files: row.files })),
      note: message,
      midscene: midsceneVersion(),
    }));
    db.prepare(
      "UPDATE runs SET status = ?, message = ?, report_dir = ?, finished_at = ?, device_label = ?, account_email = ? WHERE id = ?",
    ).run(status, message, dir, new Date().toISOString(), labels.join(" | "), emails.join(", "), run.id);
    if (run.testrail_run_id && rows.length) {
      try {
        await addResults(
          current,
          run.testrail_run_id,
          rows.filter((row) => row.item.caseId).map((row) => ({
            case_id: Number(row.item.caseId),
            status_id: row.status === "passed" ? 1 : row.status === "failed" ? 5 : 2,
            comment: row.detail || message,
          })),
        );
      } catch (error) {
        db.prepare("UPDATE runs SET message = ? WHERE id = ?").run(`${message} TestRail sonucu yazılamadı: ${error.message}`, run.id);
      }
    }
  }

  return { tick, idle: () => Promise.all([...active]) };
}
