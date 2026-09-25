import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setLogDirectoryResolver } from "@midscene/shared/logger";
import { providerById } from "./providers.mjs";

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

// Values accepted by MIDSCENE_MODEL_FAMILY in @midscene/shared (TModelFamily).
export const MIDSCENE_FAMILIES = [
  "doubao-vision", "doubao-seed", "gemini", "qwen2.5-vl", "qwen3-vl", "qwen3", "qwen3.5", "qwen3.6",
  "vlm-ui-tars", "vlm-ui-tars-doubao", "vlm-ui-tars-doubao-1.5", "glm-v", "auto-glm", "auto-glm-multilingual",
  "gpt-5", "gpt-6", "deepseek", "kimi", "kimi3", "xiaomi-mimo",
];

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

export function detectFamily(modelName) {
  const name = String(modelName || "");
  return FAMILY_RULES.find(([pattern]) => pattern.test(name))?.[1] || "";
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
        throw new Error(`Açılış adresine ulaşılamadı (${code}): ${target}`);
      }
      return "";
    }
    case "aiAct":
    case "aiAction":
    case "ai":
      return (await agent.aiAct(text())) || "";
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
      if (typeof agent.aiHover !== "function") throw new Error("aiHover bu platformda desteklenmiyor");
      await agent.aiHover(text());
      return "";
    case "aiInput":
      await agent.aiInput(resolveText(args.locate || step.text, vars), { value: resolveText(args.value ?? "", vars) });
      return "";
    case "aiQuery":
      return JSON.stringify(await agent.aiQuery(text())).slice(0, 500);
    case "back":
    case "home":
      if (typeof agent[step.action] !== "function") throw new Error(`${step.action} bu platformda desteklenmiyor`);
      await agent[step.action]();
      return "";
    case "sleep":
      await wait(Number(args.ms ?? step.text) || 1000);
      return "";
    default:
      throw new Error(`Desteklenmeyen adım: ${step.action}`);
  }
}

// Runs the cases one after another; `openCase` returns { agent, launch, close } for one case.
// `onProgress(caseIndex, steps)` fires on every step state change so the UI can follow along.
export async function executeCases({ runId, cases, vars, model, reportDir, onProgress, openCase }) {
  mkdirSync(reportDir, { recursive: true });
  const secrets = [vars?.account?.password].filter(Boolean);
  const results = [];
  for (const [index, item] of cases.entries()) {
    const key = String(item.caseId || index + 1).replace(/[^\w-]/g, "_");
    const steps = item.steps.map((step) => ({ ...step, status: "pending", detail: "" }));
    const files = {};
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
        },
      });
    } catch (error) {
      const detail = `Cihaz oturumu açılamadı: ${shortError(error)}`;
      for (const step of steps) Object.assign(step, { status: "not_run", detail });
      results.push({ status: "failed", message: detail, steps, files });
      onProgress?.(index, steps);
      continue;
    }
    let failed = false;
    for (const step of steps) {
      if (failed) {
        step.status = "skipped";
        step.detail = "Önceki adım başarısız olduğu için atlandı";
        continue;
      }
      step.status = "running";
      onProgress?.(index, steps);
      try {
        step.detail = await runStep(session, step, vars);
        step.status = "passed";
      } catch (error) {
        step.status = "failed";
        step.detail = shortError(error);
        failed = true;
      }
      onProgress?.(index, steps);
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
    onProgress?.(index, steps);
  }
  return { results };
}

export async function runWebCases({ runId, cases, vars, model, reportDir, onProgress }) {
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
  const browser = await chromium.launch({ headless: process.env.MERCURY_HEADLESS !== "0" });
  try {
    return await executeCases({
      runId, cases, vars, model, reportDir, onProgress,
      openCase: async ({ key, agentOptions }) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir } });
        const page = await context.newPage();
        const agent = new PlaywrightAgent(page, agentOptions);
        // The agent injects a <select> rendering style without awaiting it; navigating right away destroys
        // that evaluation and logs a stack trace per case. Let it land on the blank page first (it re-applies on load).
        await page.waitForFunction(() => document.getElementById("midscene-force-select-rendering"), null, { timeout: 2000 }).catch(() => {});
        return {
          agent,
          launch: (url) => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }),
          close: async () => {
            const video = page.video();
            await context.close();
            const source = await video?.path();
            if (!source || !existsSync(source)) return {};
            renameSync(source, join(reportDir, `video-${key}.webm`));
            return { video: `video-${key}.webm` };
          },
        };
      },
    });
  } finally {
    await browser.close().catch(() => {});
    rmSync(videoDir, { recursive: true, force: true });
  }
}

// Drives a farm device. Android: `connection.serial` is the `adb connect` target that is already
// attached to this server's ADB. iOS: `connection.host/port` is the device's WebDriverAgent.
export async function runMobileCases({ platform, connection, appId, adbPath, runId, cases, vars, model, reportDir, onProgress, sdk }) {
  let midscene = sdk;
  try {
    midscene ||= platform === "android" ? await import("@midscene/android") : await import("@midscene/ios");
  } catch (error) {
    return { setupError: `Midscene ${platform} paketi kurulu değil (${shortError(error)}). Sunucuda \`npm run setup\` çalıştır.` };
  }
  return executeCases({
    runId, cases, vars, model, reportDir, onProgress,
    openCase: async ({ item, agentOptions }) => {
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
      // Each case starts from a cold app so a previous case's screen cannot leak into it.
      if (appId) {
        await agent.terminate(appId).catch(() => {});
        if (!item.steps.some((step) => step.action === "launch")) await agent.launch(appId);
      }
      return { agent, launch: (target) => agent.launch(target) };
    },
  });
}
