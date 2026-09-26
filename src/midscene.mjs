import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_FAMILY_VALUES } from "@midscene/shared/env";
import { setLogDirectoryResolver } from "@midscene/shared/logger";
import { providerById } from "./providers.mjs";
import { startScreenRecord, wakeScreen } from "./adb.mjs";
import { createBrowserPool } from "./browser-pool.mjs";

// Midscene appends every debug line — including values typed with aiInput, such as test-user
// passwords — to MIDSCENE_RUN_DIR/log, unrotated. Point it at a directory that never exists so the
// streams fail closed; MERCURY_MIDSCENE_LOGS=1 keeps them for troubleshooting.
if (process.env.MERCURY_MIDSCENE_LOGS !== "1") {
  const nowhere = join(tmpdir(), `mercury-midscene-logs-off-${process.pid}`, "disabled");
  setLogDirectoryResolver(() => nowhere);
}

const MASK = "••••••••";

// Removes secret values from report text in every form they can take: raw, JSON-escaped (also with
// the <, >, & escapes used inside <script>) and HTML-escaped.
export function redactSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 3) continue;
    const json = JSON.stringify(secret).slice(1, -1);
    const variants = new Set([
      secret,
      json,
      json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"),
      secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
      secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;"),
    ]);
    for (const variant of [...variants].sort((a, b) => b.length - a.length)) out = out.split(variant).join(MASK);
  }
  return out;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Read from the installed Midscene so the list follows `npm run midscene:upgrade`.
export const MIDSCENE_FAMILIES = [...MODEL_FAMILY_VALUES];

// Which models each family covers, shown next to the family in the settings UI.
const FAMILY_LABELS = {
  "doubao-vision": "Doubao Vision (ByteDance)",
  "doubao-seed": "Doubao Seed (ByteDance)",
  gemini: "Gemini (Google)",
  "qwen2.5-vl": "Qwen2.5-VL (Alibaba)",
  "qwen3-vl": "Qwen3-VL (Alibaba)",
  qwen3: "Qwen3 (Alibaba)",
  "qwen3.5": "Qwen3.5 (Alibaba)",
  "qwen3.6": "Qwen3.6 (Alibaba)",
  "vlm-ui-tars": "UI-TARS",
  "vlm-ui-tars-doubao": "UI-TARS · Doubao",
  "vlm-ui-tars-doubao-1.5": "UI-TARS 1.5 · Doubao",
  "glm-v": "GLM-V (Zhipu)",
  "auto-glm": "AutoGLM (Zhipu)",
  "auto-glm-multilingual": "AutoGLM çok dilli (Zhipu)",
  "gpt-5": "GPT-5 (OpenAI)",
  "gpt-6": "GPT-6 (OpenAI)",
  deepseek: "DeepSeek",
  kimi: "Kimi (Moonshot)",
  kimi3: "Kimi 3 (Moonshot)",
  "xiaomi-mimo": "MiMo (Xiaomi)",
};

export const MIDSCENE_FAMILY_OPTIONS = MIDSCENE_FAMILIES.map((id) => ({ id, label: FAMILY_LABELS[id] || id }));

// Ordered from most to least specific; the first match wins.
const FAMILY_RULES = [
  [/ui-?tars.*1[.-]5|1[.-]5.*ui-?tars/i, "vlm-ui-tars-doubao-1.5"],
  [/doubao.*ui-?tars/i, "vlm-ui-tars-doubao"],
  [/ui-?tars/i, "vlm-ui-tars"],
  [/doubao-seed|seed-\d/i, "doubao-seed"],
  [/doubao.*vision/i, "doubao-vision"],
  [/qwen2\.5-?vl/i, "qwen2.5-vl"],
  [/qwen3-?vl/i, "qwen3-vl"],
  [/qwen3\.6/i, "qwen3.6"],
  [/qwen3\.5/i, "qwen3.5"],
  [/qwen3/i, "qwen3"],
  [/auto-?glm.*multi/i, "auto-glm-multilingual"],
  [/auto-?glm/i, "auto-glm"],
  [/glm-?[\d.]*v/i, "glm-v"],
  [/gemini/i, "gemini"],
  [/gpt-6/i, "gpt-6"],
  [/gpt-5/i, "gpt-5"],
  [/deepseek/i, "deepseek"],
  [/kimi.*3/i, "kimi3"],
  [/kimi/i, "kimi"],
  [/mimo/i, "xiaomi-mimo"],
];

// Specialised or text-only variants that share a family name but can't locate elements in a screenshot.
const NOT_SCREEN_MODEL = /embed|rerank|(^|[-_/.])tts|whisper|audio|realtime|transcri|moderation|guard|distill|[-_/]coder|dall-?e|imagen|(^|[-_/])veo|lyria|-image(-|$)|search-preview/i;

export function detectFamily(modelName) {
  const name = String(modelName || "");
  if (NOT_SCREEN_MODEL.test(name)) return "";
  const family = FAMILY_RULES.find(([pattern]) => pattern.test(name))?.[1] || "";
  return MIDSCENE_FAMILIES.includes(family) ? family : "";
}

// Tags each provider model with the Midscene family its id (or label) belongs to; "" = Midscene can't drive the screen with it.
export function withMidsceneFamily(models) {
  return models.map((model) => ({ ...model, midsceneFamily: detectFamily(model.id) || detectFamily(model.label) }));
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// Translates the stored model settings into Midscene's per-agent modelConfig (isolated mode),
// so concurrent runs never share or mutate process.env.
export function midsceneModel(settings) {
  const name = String(settings.model_name || "").trim();
  const provider = providerById(settings.model_provider);
  if (!name || !provider) return { error: "Model bağlı değil. Ayarlar → Model'den bağla." };
  if (provider.auth === "bedrock-iam") {
    return { error: "Amazon Bedrock IAM, Midscene'ın OpenAI uyumlu istemcisiyle çalışmaz. Bedrock API anahtarı veya OpenAI uyumlu bir sağlayıcı seç." };
  }
  const family = String(settings.midscene_model_family || "").trim() || detectFamily(name);
  if (!family) {
    return { error: `"${name}" için Midscene model ailesi belirlenemedi. Ayarlar → Model'den aileyi seç ya da ekranda öğe bulabilen bir model kullan (Qwen3-VL, Gemini, GPT-5, Doubao Seed, UI-TARS).` };
  }
  if (!MIDSCENE_FAMILIES.includes(family)) return { error: `Geçersiz Midscene model ailesi: ${family}` };
  const apiKey = settings.model_api_key || "";
  if (!apiKey && !provider.keyOptional) return { error: "Model API anahtarı yok." };

  let baseUrl = trimSlash(settings.model_base_url || provider.base);
  const config = {};
  if (provider.auth === "gemini" && !/\/openai$/.test(baseUrl)) baseUrl = `${baseUrl}/openai`;
  if (provider.auth === "anthropic" && !/\/v1$/.test(baseUrl)) baseUrl = `${baseUrl}/v1`;
  if (provider.auth === "azure") {
    if (!/\/openai\/v1$/.test(baseUrl)) baseUrl = `${baseUrl}/openai/v1`;
    config.MIDSCENE_MODEL_INIT_CONFIG_JSON = JSON.stringify({ defaultHeaders: { "api-key": apiKey } });
  }
  Object.assign(config, {
    MIDSCENE_MODEL_NAME: name,
    MIDSCENE_MODEL_BASE_URL: `${baseUrl}/`,
    // The OpenAI client rejects an empty key even for local gateways that ignore it.
    MIDSCENE_MODEL_API_KEY: apiKey || "not-needed",
    MIDSCENE_MODEL_FAMILY: family,
  });
  return { config, family };
}

export function midsceneVersion() {
  try {
    return JSON.parse(readFileSync(join(root, "node_modules", "@midscene", "web", "package.json"), "utf8")).version;
  } catch {
    return "";
  }
}

export function resolveText(text, vars) {
  const resolved = String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path) => {
    const value = path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), vars);
    return value === undefined || value === null || value === "" ? match : String(value);
  });
  const missing = resolved.match(/\{\{\s*([\w.]+)\s*\}\}/);
  if (missing) throw new Error(`Değişken çözülemedi: ${missing[1]}`);
  return resolved;
}

function shortError(error) {
  return String(error?.message || error).split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 400);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What Midscene did for one step, from the executions it recorded meanwhile: AI calls (a call re-emitted while a
// task progresses is counted once), tokens, model time, cache hits, device actions and the model's last remark.
export function summarizeExecutions(executions, secrets = []) {
  const seen = new Set();
  const ai = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, timeMs: 0, cacheHits: 0 };
  const models = new Set();
  const actions = [];
  let note = "";
  for (const execution of executions || []) {
    for (const task of execution?.tasks || []) {
      const usage = task.usage;
      const id = usage && (usage.request_id || usage._midscene_call_id || task.taskId);
      if (usage && !seen.has(id)) {
        seen.add(id);
        ai.calls += 1;
        ai.promptTokens += Number(usage.prompt_tokens) || 0;
        ai.completionTokens += Number(usage.completion_tokens) || 0;
        ai.cachedTokens += Number(usage.cached_input) || 0;
        ai.totalTokens += Number(usage.total_tokens) || 0;
        ai.timeMs += Number(usage.time_cost) || 0;
        const model = usage.response_model_name || usage.model_name;
        if (model) models.add(String(model));
      }
      if (task.cache?.hit) ai.cacheHits += 1;
      if (task.type === "Action Space" && task.subType && !["Sleep", "Error"].includes(task.subType)) actions.push(task.subType);
      if ((task.type === "Planning" && task.subType === "Plan") || task.type === "Insight") {
        const remark = task.output?.output || task.output?.log || task.thought || task.output?.thought;
        if (typeof remark === "string" && remark.trim()) note = remark.trim();
      }
    }
  }
  const out = {};
  if (ai.calls || ai.cacheHits) out.ai = { ...ai, models: [...models] };
  if (actions.length) out.actions = actions;
  if (note) out.note = redactSecrets(note.length > 400 ? `${note.slice(0, 399)}…` : note, secrets);
  return out;
}

// Runs recorded before step metrics existed: rebuilds them from the case's saved Midscene report. Each step takes
// the next executions whose name mentions it ("Tap - Giriş butonu", "Input - E-posta alanı", retries included).
export function metricsFromReport(html, steps) {
  const match = /<script type="midscene_web_dump"[^>]*data-group-id[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let executions = [];
  try { executions = JSON.parse(match?.[1]?.trim() || "{}").executions || []; } catch { return null; }
  if (!executions.length) return null;
  const fold = (value) => String(value || "").toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
  let cursor = 0;
  return steps.map((step) => {
    if (step.action === "launch" || !["passed", "failed"].includes(step.status)) return null;
    const needle = fold(step.args?.locate || String(step.text || "").split(" ← ")[0]).slice(0, 40);
    const mine = [];
    while (cursor < executions.length && needle && fold(executions[cursor].name).includes(needle)) mine.push(executions[cursor++]);
    if (!mine.length) return null;
    const times = mine.flatMap((execution) => (execution.tasks || []).flatMap((task) => [task.timing?.start, task.timing?.end])).filter(Number.isFinite);
    return { ...(times.length ? { durationMs: Math.max(...times) - Math.min(...times) } : {}), ...summarizeExecutions(mine) };
  });
}

// Unlike a bare Promise.race, clears its timer so a finished step leaves nothing pending.
function withTimeout(promise, ms, message = "zaman aşımı") {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { timeout: true })), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Mistakes in the step itself (bad argument, unsupported on this platform): retrying cannot help.
function stepError(message) {
  return Object.assign(new Error(message), { fatal: true });
}

export const STEP_TIMEOUT_MS = Number(process.env.MERCURY_STEP_TIMEOUT_MS) || 180_000;
export const STEP_RETRIES = process.env.MERCURY_STEP_RETRIES === undefined ? 1 : Math.max(0, Math.trunc(Number(process.env.MERCURY_STEP_RETRIES)) || 0);

// How long one step may take before it fails: waits and sleeps get their own length on top.
export function stepTimeoutMs(step, base = STEP_TIMEOUT_MS) {
  const args = step.args || {};
  if (optionalNumber(args.stepTimeout)) return Number(args.stepTimeout);
  if (step.action === "aiWaitFor") return Math.max(base, (Number(args.timeout) || 30_000) + 30_000);
  if (step.action === "sleep") return (Number(args.ms ?? step.text) || 1000) + 5_000;
  return base;
}

const READ_ONLY = new Set(["aiAssert", "aiBoolean", "aiNumber", "aiString", "aiQuery"]);
const LOCATING = new Set(["aiTap", "aiInput", "aiHover", "aiDoubleClick", "aiRightClick", "aiLongPress", "aiClearInput", "aiScroll", "aiKeyboardPress", "aiPinch"]);
const NOT_FOUND = /element not found|cannot find|could not find|not (?:be )?(?:found|visible)|unable to locate|failed to locate|no element/i;
const MODEL_REFUSED = /\b40[13]\b|invalid api key|unauthori[sz]ed|forbidden|quota|insufficient_quota|Değişken çözülemedi/i;

// A retry is only safe when the first attempt changed nothing: reads and checks, or an action whose element
// was not found. `aiAct` (several actions), waits, launches and timed-out steps (may still be acting) never retry.
export function shouldRetry(step, error) {
  if (error?.timeout || error?.fatal) return false;
  const message = String(error?.message || error);
  if (MODEL_REFUSED.test(message)) return false;
  if (READ_ONLY.has(step.action)) return true;
  return LOCATING.has(step.action) && NOT_FOUND.test(message);
}

export const STEP_RECOVERY = process.env.MERCURY_STEP_RECOVERY !== "0";
const RECOVERY_TIMEOUT_MS = 120_000;

// Given to every aiAct plan: cookie banners, pop-ups and system prompts are not the test, so the AI clears them itself.
export const INTERRUPTION_HINT = "Unexpected interruptions are not part of the test. If a cookie consent banner, pop-up, modal dialog, "
  + "system permission prompt, advertisement, newsletter, app update or rating dialog, or onboarding overlay covers the screen, "
  + "first accept the cookies or close it (prefer Accept all, OK, Allow while using the app, Close, Not now, Skip), then continue with the task. "
  + "If the task itself is about that dialog, follow the task instead.";

const REDOABLE = new Set(["aiTap", "aiInput", "aiDoubleClick", "aiRightClick", "aiLongPress", "aiKeyboardPress", "aiAct", "aiAction", "ai"]);
const NOT_RECOVERABLE = new Set(["launch", "sleep", "back", "home"]);

function describeStep(step) {
  return `${step.action}: ${stepLabel(step.action, step.args) || step.text || ""}`.replace(/"/g, "'").slice(0, 300);
}

// Steps that failed for a reason on the screen (not a bad step, a refused model or a step still running) may be recoverable.
export function canRecover(step, error) {
  if (error?.timeout || error?.fatal || NOT_RECOVERABLE.has(step.action)) return false;
  const flag = step.args?.recover;
  if (flag === false || /^(false|0|no|hayır|hayir)$/i.test(String(flag ?? ""))) return false;
  return !MODEL_REFUSED.test(String(error?.message || error));
}

// When a step fails, the AI looks at the screen: an interruption that has nothing to do with the step (cookie consent,
// pop-up, permission prompt …) is accepted or closed, and a previous action it swallowed is done again. Returns what
// was done, or "" when the screen showed no interruption, so a genuine failure is never masked.
export async function recoverFromInterruption(session, step, previous, vars) {
  const { agent } = session;
  if (typeof agent.aiBoolean !== "function" || typeof agent.aiAct !== "function") return "";
  const blocked = await agent.aiBoolean(
    `The test step "${describeStep(step)}" just failed. Is the screen covered or blocked by an interruption that is not part of `
    + "that step, such as a cookie consent banner, pop-up, modal dialog, system permission prompt, advertisement, newsletter, "
    + "app update or rating dialog, or onboarding overlay, that has to be accepted or closed first? Error or validation messages "
    + "produced by the app itself, and anything the step is about, do not count. Answer false if unsure.",
  );
  if (blocked !== true) return "";
  await agent.aiAct(
    "Only clear the interruption that covers the screen: accept the cookie consent or close the pop-up, dialog or overlay "
    + "(prefer Accept all, OK, Allow while using the app, Close, Not now, Skip). Do nothing else, and do not perform the test step "
    + `"${describeStep(step)}" yourself.`,
    { cacheable: false },
  );
  const notes = ["Ekrandaki engel kapatıldı"];
  if (previous && previous.status === "passed" && REDOABLE.has(previous.action)) {
    const swallowed = await agent.aiBoolean(
      `An interruption covering the screen was just closed. It may have swallowed the earlier test step "${describeStep(previous)}". `
      + "Does the screen clearly show that this earlier step did not take effect (the same button, form or screen is still waiting "
      + "for it)? Answer false if unsure.",
    ).catch(() => false);
    if (swallowed === true) {
      await runStep(session, previous, vars);
      notes.push("önceki adım yeniden yapıldı");
    }
  }
  return notes.join(" · ");
}

// Mobile screenshots arrive as large PNG data URLs; a JPEG keeps step thumbnails light. Falls back to the original.
export async function screenshotFromDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/is.exec(String(dataUrl || ""));
  if (!match) return null;
  const data = Buffer.from(match[2], "base64");
  try {
    const { convertImgBufferToJpeg } = await import("@midscene/shared/img");
    return { data: await convertImgBufferToJpeg(data, 70), ext: "jpg" };
  } catch {
    return { data, ext: match[1].toLowerCase() === "png" ? "png" : "jpg" };
  }
}

const SCROLL_TYPES = new Set(["once", "singleAction", "scrollToBottom", "scrollToTop", "scrollToRight", "scrollToLeft", "untilBottom", "untilTop", "untilRight", "untilLeft"]);
const DIRECTIONS = new Set(["down", "up", "left", "right"]);
export const READ_ACTIONS = new Set(["aiBoolean", "aiNumber", "aiString", "aiQuery"]);

// The line shown for a step whose meaning lives in its arguments; null keeps the step's own text.
export function stepLabel(action, args = {}) {
  const filled = (value) => value !== undefined && value !== null && value !== "";
  if (action === "aiInput" && filled(args.locate)) return `${args.locate} ← ${args.value ?? ""}`;
  if (action === "aiScroll") {
    const kind = filled(args.scrollType) && args.scrollType !== "singleAction" ? ` · ${args.scrollType}` : "";
    return `${args.locate || "Ekran"} · ${args.direction || "down"}${kind}${filled(args.distance) ? ` · ${args.distance}px` : ""}`;
  }
  if (action === "aiKeyboardPress" && filled(args.keyName)) return `${args.keyName}${filled(args.locate) ? ` · ${args.locate}` : ""}`;
  if (action === "aiPinch") return `${args.locate || "Ekran"} · ${args.direction || "out"}`;
  if (READ_ACTIONS.has(action) && filled(args.prompt)) {
    return `${args.prompt}${filled(args.expect) ? ` = ${args.expect}` : ""}${filled(args.name) ? ` → ${args.name}` : ""}`;
  }
  return null;
}

function hasArgs(step) {
  return Boolean(step.args && Object.keys(step.args).length);
}

// Reads the step's own argument, or falls back to its text for the short YAML form (`- aiKeyboardPress: Enter`).
function argOrText(step, name, vars) {
  const value = hasArgs(step) ? step.args[name] : step.text;
  return value === undefined || value === null || value === "" ? undefined : resolveText(value, vars);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw stepError(`Sayı bekleniyordu: ${value}`);
  return number;
}

function sameValue(actual, expected, type) {
  if (type === "number") {
    const number = Number(String(expected).replace(",", "."));
    return Number.isFinite(number) && Math.abs(Number(actual) - number) < 1e-9;
  }
  if (type === "boolean") return String(actual) === String(/^(true|evet|yes|1|doğru|dogru)$/i.test(String(expected).trim()));
  return String(actual ?? "").trim().toLocaleLowerCase("tr") === String(expected ?? "").trim().toLocaleLowerCase("tr");
}

// aiBoolean/aiNumber/aiString/aiQuery read a value off the screen. `name` keeps it for later steps as {{saved.name}};
// `expect` turns the read into a check, so a step can compare two screens ("sepet tutarı = {{saved.fiyat}}").
async function readValue(session, step, vars, method, type) {
  const args = step.args || {};
  const prompt = resolveText(hasArgs(step) ? args.prompt ?? step.text : step.text, vars);
  if (typeof session.agent[method] !== "function") throw stepError(`${method} bu platformda desteklenmiyor`);
  const value = await session.agent[method](prompt);
  if (args.name) vars.saved[String(args.name)] = value;
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  if (args.expect !== undefined && args.expect !== "") {
    const expected = resolveText(args.expect, vars);
    if (!sameValue(value, expected, type)) {
      const error = new Error(`Beklenen "${expected}", ekranda okunan "${String(shown).slice(0, 200)}"`);
      error.readOnly = true;
      throw error;
    }
  }
  return `${args.name ? `${args.name} = ` : ""}${String(shown).slice(0, 500)}`;
}

function call(agent, method) {
  if (typeof agent[method] !== "function") throw stepError(`${method} bu platformda desteklenmiyor`);
  return agent[method].bind(agent);
}

// `session` hides the platform: web opens URLs with Playwright, mobile launches the app on the farm device.
async function runStep(session, step, vars) {
  const { agent } = session;
  const args = step.args || {};
  const text = () => resolveText(step.text, vars);
  switch (step.action) {
    case "launch": {
      const target = resolveText(args.uri || args.url || step.text || "{{launchUrl}}", vars);
      try {
        await session.launch(target);
      } catch (error) {
        const code = /net::(ERR_[A-Z_]+)/.exec(error.message)?.[1] || (/Timeout/i.test(error.message) ? "zaman aşımı" : "");
        if (!code) throw error;
        throw stepError(`Açılış adresine ulaşılamadı (${code}): ${target}`);
      }
      return "";
    }
    case "aiAct":
    case "aiAction":
    case "ai": {
      const prompt = text();
      const secret = vars?.account?.password;
      // The plan cache stores its prompt unmasked in MIDSCENE_RUN_DIR/cache, so a prompt carrying the password is never cached.
      return (await (secret && prompt.includes(secret) ? agent.aiAct(prompt, { cacheable: false }) : agent.aiAct(prompt))) || "";
    }
    case "aiAssert":
      await agent.aiAssert(text());
      return "";
    case "aiWaitFor":
      await agent.aiWaitFor(text(), { timeoutMs: Number(args.timeout) || 30_000 });
      return "";
    case "aiTap":
      await agent.aiTap(text());
      return "";
    case "aiHover":
      if (typeof agent.aiHover !== "function") throw stepError("aiHover bu platformda desteklenmiyor");
      await agent.aiHover(text());
      return "";
    case "aiInput":
      await agent.aiInput(resolveText(args.locate || step.text, vars), { value: resolveText(args.value ?? "", vars) });
      return "";
    case "aiQuery":
      if (hasArgs(step) && (args.name || args.expect !== undefined)) return readValue(session, step, vars, "aiQuery", "string");
      return JSON.stringify(await agent.aiQuery(text())).slice(0, 500);
    case "aiBoolean":
      return readValue(session, step, vars, "aiBoolean", "boolean");
    case "aiNumber":
      return readValue(session, step, vars, "aiNumber", "number");
    case "aiString":
      return readValue(session, step, vars, "aiString", "string");
    case "aiScroll": {
      // No target scrolls the whole screen; `scrollType: untilBottom` keeps going until the end of the page/list.
      const locate = hasArgs(step) ? (args.locate ? resolveText(args.locate, vars) : undefined) : step.text ? text() : undefined;
      const direction = String(args.direction || "down").toLowerCase();
      const scrollType = String(args.scrollType || "singleAction");
      if (!DIRECTIONS.has(direction)) throw stepError(`Geçersiz kaydırma yönü: ${direction}`);
      if (!SCROLL_TYPES.has(scrollType)) throw stepError(`Geçersiz kaydırma türü: ${scrollType}`);
      await call(agent, "aiScroll")(locate, { direction, scrollType, distance: optionalNumber(args.distance) ?? null });
      return "";
    }
    case "aiKeyboardPress": {
      const keyName = argOrText(step, "keyName", vars);
      if (!keyName) throw stepError("aiKeyboardPress için tuş adı (keyName) gerekli, örn. Enter");
      await call(agent, "aiKeyboardPress")(args.locate ? resolveText(args.locate, vars) : undefined, { keyName });
      return "";
    }
    case "aiDoubleClick":
    case "aiRightClick":
    case "aiClearInput":
      await call(agent, step.action)(resolveText(args.locate ?? step.text, vars));
      return "";
    case "aiLongPress":
      await call(agent, "aiLongPress")(resolveText(args.locate ?? step.text, vars), { duration: optionalNumber(args.duration) });
      return "";
    case "aiPinch": {
      const direction = String(args.direction || "out").toLowerCase();
      if (direction !== "in" && direction !== "out") throw stepError(`aiPinch yönü in veya out olmalı: ${direction}`);
      const locate = args.locate ? resolveText(args.locate, vars) : hasArgs(step) ? undefined : step.text ? text() : undefined;
      await call(agent, "aiPinch")(locate, { direction, distance: optionalNumber(args.distance), duration: optionalNumber(args.duration) });
      return "";
    }
    case "back":
    case "home":
      if (typeof agent[step.action] !== "function") throw stepError(`${step.action} bu platformda desteklenmiyor`);
      await agent[step.action]();
      return "";
    case "sleep":
      await wait(Number(args.ms ?? step.text) || 1000);
      return "";
    default:
      throw stepError(`Desteklenmeyen adım: ${step.action}`);
  }
}

// Runs the cases one after another; `openCase` returns { agent, launch, screenshot?, close? } for one case.
// `onProgress(caseIndex, steps, files)` fires on every step state change so the UI can follow along: each finished
// step carries its screenshot (`step.shot`) and `files.report` points at the Midscene report as it stands so far.
// Each step gets `stepTimeout` ms (see `stepTimeoutMs`) and up to `retries` safe retries (see `shouldRetry`).
// `item.context` (notes from the QA skills) becomes Midscene's agent-level AI context for that case.
// Midscene's cache: a case run again replays its earlier aiAct plans and (web only) XPath-checked element locations
// instead of asking the model; a stale entry falls back to the model. One file per case, platform and launch URL,
// under MIDSCENE_RUN_DIR/cache. MERCURY_MIDSCENE_CACHE=0 turns it off.
export function caseCacheId(platform, item, launchUrl) {
  if (!platform || process.env.MERCURY_MIDSCENE_CACHE === "0") return "";
  const identity = [platform, item.path || "", item.caseId || "", item.path ? "" : item.title || "", launchUrl || ""].join("\n");
  return `${platform}-${createHash("sha1").update(identity).digest("hex").slice(0, 16)}`;
}

export async function executeCases({
  runId, cases, vars, model, reportDir, onProgress, openCase, platform = "",
  stepTimeout = STEP_TIMEOUT_MS, retries = STEP_RETRIES, retryDelayMs = 1500, recovery = STEP_RECOVERY,
}) {
  mkdirSync(reportDir, { recursive: true });
  const secrets = [vars?.account?.password].filter(Boolean);
  const results = [];
  for (const [index, item] of cases.entries()) {
    // Cases without a TestRail id use the worker's unique `fileKey` so parallel lanes never share file names.
    const key = String(item.caseId || item.fileKey || index + 1).replace(/[^\w-]/g, "_");
    const steps = item.steps.map((step) => ({ ...step, status: "pending", detail: "" }));
    const files = {};
    const progress = () => onProgress?.(index, steps, { ...files });
    const cacheId = caseCacheId(platform, item, vars?.launchUrl);
    let session;
    try {
      session = await openCase({
        key,
        item,
        agentOptions: {
          modelConfig: model.config,
          reportFileName: `run-${runId}-case-${key}`,
          groupName: `Mercury #${runId}`,
          groupDescription: item.title,
          autoPrintReportMsg: false,
          aiContexts: {
            ...(item.context ? { default: item.context } : {}),
            aiAct: [INTERRUPTION_HINT, item.context].filter(Boolean).join("\n\n"),
          },
          ...(cacheId ? { cache: { id: cacheId } } : {}),
        },
      });
    } catch (error) {
      const detail = `Cihaz oturumu açılamadı: ${shortError(error)}`;
      for (const step of steps) Object.assign(step, { status: "not_run", detail });
      results.push({ status: "failed", message: detail, steps, files });
      progress();
      continue;
    }
    // Both helpers are best effort: a missing screenshot or report copy never changes a step's result.
    const shoot = async (step, position) => {
      if (!session.screenshot) return;
      try {
        const shot = await withTimeout(session.screenshot(), 15_000);
        if (!shot?.data?.length) return;
        const name = `shot-${key}-${position + 1}.${shot.ext}`;
        writeFileSync(join(reportDir, name), shot.data);
        step.shot = name;
      } catch { /* the step keeps its result without a picture */ }
    };
    // Midscene flushes its report after every action, so the file is a complete, viewable report at step boundaries.
    const publishReport = () => {
      const source = session.agent.reportFile;
      if (!source || !existsSync(source)) return;
      try {
        const name = `midscene-${key}.html`;
        const temporary = join(reportDir, `.${name}.tmp`);
        writeFileSync(temporary, redactSecrets(readFileSync(source, "utf8"), secrets));
        renameSync(temporary, join(reportDir, name));
        files.report = name;
      } catch { /* the final copy after the case still happens */ }
    };
    let failed = false;
    // Values read with `name` ({{saved.x}}) belong to this case only.
    const caseVars = { ...vars, saved: {} };
    for (const [position, step] of steps.entries()) {
      if (failed) {
        step.status = "skipped";
        step.detail = "Önceki adım başarısız olduğu için atlandı";
        continue;
      }
      step.status = "running";
      progress();
      if (session.beforeStep) {
        try { await withTimeout(session.beforeStep(), 10_000); } catch { /* the step itself reports what is wrong */ }
      }
      const startedAt = Date.now();
      const executionsBefore = session.agent.dump?.executions?.length ?? 0;
      const allowed = step.args?.retry !== undefined && step.args.retry !== "" ? Math.max(0, Math.trunc(Number(step.args.retry)) || 0) : retries;
      const limit = stepTimeoutMs(step, stepTimeout);
      let firstError = null;
      let checked = false;
      let recovered = "";
      for (let attempt = 1; ; attempt += 1) {
        try {
          const detail = await withTimeout(runStep(session, step, caseVars), limit, `Adım ${Math.round(limit / 1000)} sn içinde bitmedi (zaman aşımı)`);
          step.status = "passed";
          step.detail = firstError
            ? `${attempt}. denemede geçti${recovered ? ` · ${recovered}` : ""} · ilk deneme: ${shortError(firstError)}${detail ? ` · ${detail}` : ""}`
            : detail;
          break;
        } catch (error) {
          if (recovery && !checked && canRecover(step, error)) {
            checked = true;
            step.detail = `Ekran denetleniyor: ${shortError(error)}`;
            progress();
            recovered = await withTimeout(recoverFromInterruption(session, step, steps[position - 1], caseVars), RECOVERY_TIMEOUT_MS).catch(() => "");
            if (recovered) {
              firstError ||= error;
              step.attempts = attempt + 1;
              step.recovered = recovered;
              step.detail = `${recovered} · yeniden deneniyor`;
              progress();
              continue;
            }
          }
          // The attempt after a recovery does not use up the step's own safe retries.
          if (attempt <= allowed + (recovered ? 1 : 0) && shouldRetry(step, error)) {
            firstError ||= error;
            step.attempts = attempt + 1;
            step.detail = `Yeniden deneniyor: ${shortError(error)}`;
            progress();
            await wait(retryDelayMs);
            continue;
          }
          step.status = "failed";
          step.detail = firstError ? `${recovered ? `${recovered} · ` : ""}${attempt} denemede de başarısız: ${shortError(error)}` : shortError(error);
          failed = true;
          break;
        }
      }
      // Metrics are best effort as well: timing is ours, the rest comes from Midscene's dump and the page.
      step.metrics = { durationMs: Date.now() - startedAt };
      try { Object.assign(step.metrics, summarizeExecutions(session.agent.dump?.executions?.slice(executionsBefore), secrets)); } catch { /* no dump */ }
      if (session.pageInfo) {
        try { Object.assign(step.metrics, await withTimeout(session.pageInfo(step.action === "launch"), 5_000)); } catch { /* page busy or gone */ }
      }
      await shoot(step, position);
      publishReport();
      progress();
    }
    try { await session.agent.destroy(); } catch { /* report is still written on a best-effort basis */ }
    const reportFile = session.agent.reportFile;
    if (reportFile && existsSync(reportFile)) {
      files.report = `midscene-${key}.html`;
      writeFileSync(join(reportDir, files.report), redactSecrets(readFileSync(reportFile, "utf8"), secrets));
      // The original in MIDSCENE_RUN_DIR is unredacted and duplicates the copy above.
      rmSync(reportFile, { force: true });
    }
    try { Object.assign(files, (await session.close?.()) || {}); } catch { /* media is optional */ }
    const failedStep = steps.find((step) => step.status === "failed");
    results.push({
      status: failedStep ? "failed" : "passed",
      message: failedStep ? `${failedStep.action}: ${failedStep.detail}` : "Tüm adımlar geçti",
      steps,
      files,
    });
    progress();
  }
  return { results };
}

let sharedBrowsers = null;
const browserAgents = new WeakMap();

// Headless Chromium announces itself as "HeadlessChrome", which bot protection (WAF) answers with a "Request Rejected"
// page instead of the site. Each case gets the browser's own user agent without that word.
export async function realUserAgent(browser) {
  if (!browserAgents.has(browser)) {
    browserAgents.set(browser, (async () => {
      const probe = await browser.newContext();
      try {
        const page = await probe.newPage();
        return String(await page.evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, "Chrome");
      } finally {
        await probe.close().catch(() => {});
      }
    })().catch(() => ""));
  }
  return browserAgents.get(browser);
}

// All web lanes of all runs on this server draw from one pool (see src/browser-pool.mjs).
export function webBrowserPool(chromium) {
  sharedBrowsers ||= createBrowserPool({ launch: () => chromium.launch({ headless: process.env.MERCURY_HEADLESS !== "0" }) });
  return sharedBrowsers;
}

export async function runWebCases({ runId, cases, vars, model, reportDir, onProgress, pool }) {
  let chromium;
  let PlaywrightAgent;
  try {
    ({ chromium } = await import("playwright"));
    ({ PlaywrightAgent } = await import("@midscene/web/playwright/agent"));
  } catch (error) {
    return { setupError: `Midscene kurulu değil (${shortError(error)}). Sunucuda \`npm run setup\` çalıştır.` };
  }
  if (!existsSync(chromium.executablePath())) return { setupError: "Chromium kurulu değil. Sunucuda `npm run setup` çalıştır." };

  mkdirSync(reportDir, { recursive: true });
  // Parallel lanes share the report dir; each call records into its own scratch folder.
  const videoDir = mkdtempSync(join(reportDir, ".video-"));
  const browsers = pool || webBrowserPool(chromium);
  const contexts = new Set();
  let lease;
  try {
    lease = await browsers.acquire();
  } catch (error) {
    rmSync(videoDir, { recursive: true, force: true });
    throw error;
  }
  try {
    return await executeCases({
      runId, cases, vars, model, reportDir, onProgress, platform: "web",
      openCase: async ({ key, agentOptions }) => {
        // A crashed shared browser only fails the case that was on it; the lane's next case gets a fresh one.
        if (!lease.browser.isConnected()) {
          lease.release();
          lease = await browsers.acquire();
        }
        const { browser } = lease;
        const userAgent = await realUserAgent(browser);
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          recordVideo: { dir: videoDir },
          ...(userAgent ? { userAgent } : {}),
        });
        // The browser outlives this lane, so a context left open by an unexpected error must still be closed here.
        contexts.add(context);
        const page = await context.newPage();
        const agent = new PlaywrightAgent(page, agentOptions);
        // The agent injects a <select> rendering style without awaiting it; navigating right away destroys
        // that evaluation and logs a stack trace per case. Let it land on the blank page first (it re-applies on load).
        await page.waitForFunction(() => document.getElementById("midscene-force-select-rendering"), null, { timeout: 2000 }).catch(() => {});
        return {
          agent,
          launch: (url) => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }),
          // Address after every step; after opening, also how fast the page loaded (Navigation Timing) and the browser.
          pageInfo: async (opened) => {
            const info = { url: page.url() };
            if (!opened) return info;
            const load = await page.evaluate(() => {
              const nav = performance.getEntriesByType("navigation")[0];
              if (!nav) return null;
              const ms = (value) => (value > 0 ? Math.round(value) : null);
              const resources = performance.getEntriesByType("resource");
              return {
                status: nav.responseStatus || null,
                protocol: nav.nextHopProtocol || "",
                dnsMs: ms(nav.domainLookupEnd - nav.domainLookupStart),
                connectMs: ms(nav.connectEnd - nav.connectStart),
                ttfbMs: ms(nav.responseStart),
                fcpMs: ms(performance.getEntriesByName("first-contentful-paint")[0]?.startTime),
                domContentLoadedMs: ms(nav.domContentLoadedEventEnd),
                loadMs: ms(nav.loadEventEnd),
                requests: resources.length + 1,
                transferBytes: Math.round((nav.transferSize || 0) + resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0)),
              };
            }).catch(() => null);
            return { ...info, title: await page.title().catch(() => ""), ...(load ? { load } : {}), env: { browser: `Chromium ${browser.version()}`, viewport: "1280×800" } };
          },
          screenshot: async () => ({ data: await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 }), ext: "jpg" }),
          close: async () => {
            const video = page.video();
            await context.close();
            contexts.delete(context);
            const source = await video?.path();
            if (!source || !existsSync(source)) return {};
            renameSync(source, join(reportDir, `video-${key}.webm`));
            return { video: `video-${key}.webm` };
          },
        };
      },
    });
  } finally {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    lease.release();
    rmSync(videoDir, { recursive: true, force: true });
  }
}

export const BLACK_SCREEN_HINT = "If the screenshot is completely black or dark, the device screen is asleep or dimmed, not empty: "
  + "tap the center of the screen once, look again, and only then continue with the task. Never report failure just because the screen is black.";

// Drives a farm device. Android: `connection.serial` is the `adb connect` target that is already
// attached to this server's ADB. iOS: `connection.host/port` is the device's WebDriverAgent.
// Android cases are also screen-recorded through `recordScreen` (tests pass a fake); iOS has no recorder.
// Android screens are woken through `wake` when a case opens and before every step (see `wakeScreen`).
export async function runMobileCases({ platform, connection, appId, adbPath, runId, cases, vars, model, reportDir, onProgress, sdk, recordScreen = startScreenRecord, wake = wakeScreen }) {
  let midscene = sdk;
  try {
    midscene ||= platform === "android" ? await import("@midscene/android") : await import("@midscene/ios");
  } catch (error) {
    return { setupError: `Midscene ${platform} paketi kurulu değil (${shortError(error)}). Sunucuda \`npm run setup\` çalıştır.` };
  }
  return executeCases({
    runId, cases, vars, model, reportDir, onProgress, platform,
    openCase: async ({ key, item, agentOptions }) => {
      // A dark screenshot otherwise reads as "nothing to act on" and the AI gives up instead of waking the device.
      const withHint = (context) => [BLACK_SCREEN_HINT, context].filter(Boolean).join("\n\n");
      const aiContexts = { ...agentOptions.aiContexts, default: withHint(agentOptions.aiContexts?.default) };
      if (agentOptions.aiContexts?.aiAct) aiContexts.aiAct = withHint(agentOptions.aiContexts.aiAct);
      agentOptions = { ...agentOptions, aiContexts };
      let agent;
      if (platform === "android") {
        const device = new midscene.AndroidDevice(connection.serial, { androidAdbPath: adbPath || undefined, autoDismissKeyboard: true });
        await device.connect();
        agent = new midscene.AndroidAgent(device, agentOptions);
      } else {
        const device = new midscene.IOSDevice({ wdaHost: connection.host, wdaPort: connection.port, autoDismissKeyboard: true });
        await device.connect();
        agent = new midscene.IOSAgent(device, agentOptions);
      }
      let recorder = null;
      if (platform === "android" && adbPath && connection.serial && recordScreen) {
        try {
          recorder = recordScreen({ adbPath, serial: connection.serial, name: `${runId}-${key}` });
        } catch { recorder = null; }
      }
      const wakeDevice = platform === "android" && adbPath && connection.serial && wake
        ? () => wake({ adbPath, serial: connection.serial }).catch(() => {})
        : null;
      await wakeDevice?.();
      // Each case starts from a cold app so a previous case's screen cannot leak into it.
      if (appId) {
        await agent.terminate(appId).catch(() => {});
        if (!item.steps.some((step) => step.action === "launch")) await agent.launch(appId);
      }
      return {
        agent,
        launch: (target) => agent.launch(target),
        ...(wakeDevice ? { beforeStep: wakeDevice } : {}),
        screenshot: async () => screenshotFromDataUrl(await agent.page.screenshotBase64()),
        close: async () => {
          const videos = recorder ? await recorder.stop(reportDir, key) : [];
          return videos.length ? { video: videos[0], videos } : {};
        },
      };
    },
  });
}
