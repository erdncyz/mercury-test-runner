// Chat's QA agent: the connected model reads the tester's sentence together with the saved configurations
// (and their TestRail cases) and the conversation so far, then decides whether to run saved cases, design and run
// a new scenario, or answer/ask back. The model only plans; the server validates every id, address and step
// against what exists before anything is queued, and the steps themselves are executed by Midscene on the live screen.
import { READ_ACTIONS, midsceneModel, stepLabel } from "./midscene.mjs";
import { caseKey, selectCases } from "./planning.mjs";
import { skillPrompt } from "./skills.mjs";
import { agentLanguageNote } from "./i18n.mjs";

export const QA_AGENT_MARKER = "You are the Mercury QA agent";

const MAX_CASES = 5;
const MAX_STEPS = 25;
const MAX_TEXT = 500;

export const QA_AGENT_PROMPT = `${QA_AGENT_MARKER}: a senior QA engineer who drives a test runner from chat.
The user message is JSON: {"message": the tester's latest sentence, "conversation": earlier turns of this chat (oldest first, with the runs they started and how those ended), "catalog": the saved test configurations}.
Decide what to do and answer with ONE JSON object and nothing else (no prose, no code fence).

Intents
- "run_suite": the tester wants saved cases (TestRail cases) of a project/configuration to run ("X projesini koş", "X'in giriş testlerini koş", "X regresyonu"). Pick configuration ids from the catalog. If they name a subset, put the matching case keys from that configuration's "cases" in caseKeys; otherwise leave caseKeys empty so every case runs. "regresyon/regression" means every configuration of that project with regression=true. "Aynısını tekrar koş" repeats the previous run from the conversation.
- "scenario": the tester describes something to check that is not a saved case ("login ol", "sepete ürün ekle", "example.com'da arama yap", "şifremi unuttum akışını test et"). Design the test yourself and write executable steps.
- "reply": a question, greeting, a question about earlier runs (use the conversation), or you cannot act safely (target or credentials unknown). Answer briefly or ask ONE precise question.

Where a scenario runs
- An address (web) or an app package/bundle id (mobile) written in the message wins: set "url" or "packageId"; also set "configId" when a named project's configuration should lend its devices and test users.
- Never guess a package/bundle id from an app's name: use one only when it is written in the message, the conversation or the catalog, or it is one of the device's built-in apps below. For any other mobile app that is not in the catalog and has no written id, use "reply" and ask for the iOS bundle id / Android applicationId; do not say the test is starting.
- Built-in apps need no id from the tester. iOS: Ayarlar/Settings com.apple.Preferences, Safari com.apple.mobilesafari, App Store com.apple.AppStore, Fotoğraflar/Photos com.apple.mobileslideshow, Kamera/Camera com.apple.camera, Mesajlar/Messages com.apple.MobileSMS, Telefon/Phone com.apple.mobilephone, Mail com.apple.mobilemail, Takvim/Calendar com.apple.mobilecal, Saat/Clock com.apple.mobiletimer, Notlar/Notes com.apple.mobilenotes, Haritalar/Maps com.apple.Maps, Kişiler/Contacts com.apple.MobileAddressBook, Hesap Makinesi/Calculator com.apple.calculator, Dosyalar/Files com.apple.DocumentsApp, Hava Durumu/Weather com.apple.weather, Anımsatıcılar/Reminders com.apple.reminders. Android: Ayarlar/Settings com.android.settings, Chrome com.android.chrome, Play Store com.android.vending, YouTube com.google.android.youtube, Gmail com.google.android.gm, Google Maps com.google.android.apps.maps.
- Platform: a device UDID like 00008140-001E21220240801C (or 40 hex characters), an iPhone/iPad or a com.apple.* id means "ios"; otherwise a named Android device or package means "android". Without any of these, a built-in app runs on iOS only if the tester says iOS/iPhone/iPad; else ask which platform.
- Otherwise use a catalog configuration: the project/configuration the tester names; else the one used earlier in the conversation; else the only configuration if the catalog has exactly one. If it is still ambiguous, use "reply" and ask which project/configuration (list the options).

Writing steps (Midscene executes them: a vision agent that looks at the live screen and finds elements by itself)
- Never add a launch/open step; the runner opens the target before the first step.
- Write steps in the tester's language. Describe elements by what a person sees (text, label, role, position), never CSS selectors or ids.
- You have not seen the page, so make navigation steps goal-level and conditional, letting the vision agent find the way: e.g. {"action":"aiAct","text":"Giriş formu görünmüyorsa sayfadaki Giriş / Oturum aç / Login bağlantısını bul ve tıkla"}.
- Start every case with {"action":"aiAct","text":"Çerez, bildirim veya kampanya penceresi varsa kapat"} (or the same in the tester's language).
- Step shapes:
  {"action":"aiAct","text":"one user-level goal; may take several clicks or typing"}
  {"action":"aiInput","locate":"field as a person sees it","value":"text to type"}
  {"action":"aiTap","text":"element to tap/click"}
  {"action":"aiKeyboardPress","keyName":"Enter|Escape|Tab|Backspace|ArrowDown…","locate":"optional element to focus first"}
  {"action":"aiScroll","direction":"down|up|left|right","scrollType":"singleAction|scrollToBottom|scrollToTop|untilBottom|untilTop","locate":"optional scrollable area"}
  {"action":"aiClearInput","locate":"field to empty"}
  {"action":"aiDoubleClick","locate":"element"}   {"action":"aiRightClick","locate":"element"}   (web)
  {"action":"aiLongPress","locate":"element","duration":1000}   {"action":"aiPinch","direction":"in|out","locate":"optional area"}   (mobile)
  {"action":"aiAssert","text":"statement that must be true on screen"}
  {"action":"aiWaitFor","text":"condition to wait for","timeout":30000}
  {"action":"aiString|aiNumber|aiBoolean","prompt":"value to read off the screen","name":"saveAs","expect":"optional expected value or {{saved.otherName}}"}
  {"action":"sleep","ms":2000}
  {"action":"back"}   (Android only)
- Reading values: a read step with "name" keeps the value for later steps as {{saved.name}}; with "expect" it fails when the screen shows something else. Use them for comparisons across screens, e.g. read the product price with name "fiyat" on the detail page, then {"action":"aiNumber","prompt":"Sepetteki ürün satırının tutarı","expect":"{{saved.fiyat}}"}. Only reference names saved by an earlier step of the same case.
- Prefer aiKeyboardPress Enter to submit a search box, aiScroll to reach content below the fold or the end of a list, aiClearInput before editing a pre-filled field.
- Every case ends with at least one aiAssert that checks the outcome the tester cares about, phrased so that several UIs can satisfy it (e.g. "Kullanıcı giriş yapmış: hesabım/profil/çıkış bağlantısı veya hoş geldin mesajı görünüyor").
- Test users: to use the configuration's test user write exactly {{account.email}}, {{account.password}} or {{account.phone}}; only when that configuration has testAccount=true. Credentials the tester typed are used as written. If a login is needed, the configuration has no testAccount and the tester gave no credentials, use "reply" and ask for credentials or a test-account source.
- A concrete request ("login ol", "ürün ara") is 1 case. When the tester asks to test a feature ("login'i test et", "aramayı test et"), design up to ${MAX_CASES} cases: the happy path plus the most important negative/edge cases. Keep each case to 3–12 steps.

Output
{"intent":"run_suite|scenario|reply",
 "reply":"one or two sentences to the tester, in their language: what you will do and why, or your answer/question",
 "run":{"configIds":[1],"caseKeys":[]},
 "scenario":{"title":"short name of the whole scenario (what is being tested)","configId":1,"url":"","packageId":"","platform":"web|android|ios","cases":[{"title":"short test case title","steps":[]}]}}
Omit "run" unless intent is run_suite and "scenario" unless intent is scenario.`;

const clip = (value, max = MAX_TEXT) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// What the model may choose from: enabled configurations with their cases. No addresses of test-user services,
// no credentials — only whether a test user can be provided.
export function qaCatalog(configs, allCases) {
  return configs.filter((config) => config.enabled !== 0).map((config) => ({
    id: config.id,
    project: config.client_name,
    configuration: config.name,
    aliases: JSON.parse(config.aliases || "[]"),
    platform: config.platform,
    target: config.platform === "web" ? config.launch_url || "" : config.package_id || "",
    environment: config.environment || "",
    regression: Boolean(config.regression),
    testAccount: Boolean(config.account_source_id),
    testrail: Boolean(config.suite_id),
    ready: config.plan ? config.plan.ready : true,
    cases: selectCases(config, allCases).slice(0, 60).map((item) => ({ key: caseKey(item), title: clip(item.title, 120), tags: item.tags || [] })),
  }));
}

// The last turns of this conversation, with a short outcome of every run they started, so follow-ups
// ("aynısını iOS'ta koş", "neden düştü?") make sense. Steps are listed only for chat scenarios.
export function conversationContext(messages, limit = 8) {
  return messages.slice(-limit).map((message) => ({
    role: message.role,
    text: clip(message.text, 800),
    runs: (message.runs || []).map((run) => ({
      id: run.id,
      project: run.client_name,
      configuration: run.config_name,
      configId: run.config_id,
      platform: run.platform,
      status: run.status,
      message: clip(run.message, 300),
      scenario: Boolean(run.scenario),
      cases: (run.cases || []).slice(0, 10).map((item) => {
        const failed = (item.steps || []).find((step) => step.status === "failed");
        return {
          key: item.case_key,
          title: clip(item.title, 120),
          status: item.status,
          failedStep: failed ? clip(`${failed.action}: ${failed.text} → ${failed.detail}`, 300) : undefined,
          steps: run.scenario ? (item.steps || []).map((step) => clip(`${step.action}: ${step.text}`, 200)) : undefined,
        };
      }),
    })),
  }));
}

function completionText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return String(content || "");
}

// Models wrap JSON in fences or thinking blocks; take the outermost object.
export function parseDecision(text) {
  const cleaned = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)?.[1];
  const candidate = fenced || cleaned;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model JSON karar döndürmedi");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("modelin kararı okunamadı (geçersiz JSON)");
  }
}

// Calls the same model Midscene uses (its OpenAI-compatible endpoint) with the catalog and conversation.
// `language` is the tester's interface language ("tr" or "en"); without it the model answers in the message's language.
export async function askQaAgent({ settings, text, catalog, conversation = [], skills = [], language = "", fetchImpl = fetch, timeoutMs = 90_000 }) {
  const model = midsceneModel(settings);
  if (model.error) throw new Error(model.error);
  const config = model.config;
  const extra = config.MIDSCENE_MODEL_INIT_CONFIG_JSON ? JSON.parse(config.MIDSCENE_MODEL_INIT_CONFIG_JSON).defaultHeaders || {} : {};
  const headers = { "content-type": "application/json", ...extra };
  if (!headers["api-key"]) headers.authorization = `Bearer ${config.MIDSCENE_MODEL_API_KEY}`;
  let response;
  try {
    response = await fetchImpl(`${config.MIDSCENE_MODEL_BASE_URL}chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.MIDSCENE_MODEL_NAME,
        messages: [
          { role: "system", content: [QA_AGENT_PROMPT, language ? agentLanguageNote(language) : "", skillPrompt(skills)].filter(Boolean).join("\n\n") },
          { role: "user", content: JSON.stringify({ message: text, conversation, catalog }) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? `model ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi` : `modele ulaşılamadı (${error.message})`);
  }
  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(`model ${response.status} döndü${body?.error?.message ? `: ${clip(body.error.message, 200)}` : ""}`);
  return parseDecision(completionText(body));
}

const ACTION_ALIASES = {
  aiact: "aiAct", aiaction: "aiAct", ai: "aiAct", act: "aiAct",
  aitap: "aiTap", tap: "aiTap", click: "aiTap",
  aiinput: "aiInput", input: "aiInput", type: "aiInput",
  aiassert: "aiAssert", assert: "aiAssert", verify: "aiAssert",
  aiwaitfor: "aiWaitFor", waitfor: "aiWaitFor",
  aihover: "aiHover", hover: "aiHover",
  aikeyboardpress: "aiKeyboardPress", keyboardpress: "aiKeyboardPress", press: "aiKeyboardPress", key: "aiKeyboardPress", keypress: "aiKeyboardPress",
  aiscroll: "aiScroll", scroll: "aiScroll",
  aiclearinput: "aiClearInput", clearinput: "aiClearInput", clear: "aiClearInput",
  aidoubleclick: "aiDoubleClick", doubleclick: "aiDoubleClick", dblclick: "aiDoubleClick",
  airightclick: "aiRightClick", rightclick: "aiRightClick",
  ailongpress: "aiLongPress", longpress: "aiLongPress",
  aipinch: "aiPinch", pinch: "aiPinch", zoom: "aiPinch",
  aiboolean: "aiBoolean", boolean: "aiBoolean",
  ainumber: "aiNumber", number: "aiNumber",
  aistring: "aiString", string: "aiString", read: "aiString",
  aiquery: "aiQuery", query: "aiQuery",
  sleep: "sleep", wait: "sleep",
  back: "back", home: "home",
  launch: "launch", open: "launch",
};
const MOBILE_ONLY = new Set(["back", "home"]);
const WEB_ONLY = new Set(["aiHover", "aiRightClick", "aiDoubleClick"]);
const PINCH_PLATFORMS = new Set(["android", "ios"]);
const KEY_NAME = /^[A-Za-z0-9+_-]{1,30}$/;
const KNOWN_KEY = /\b(Enter|Escape|Esc|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)\b/i;
const KEY_CASE = { esc: "Escape", escape: "Escape", enter: "Enter", tab: "Tab", backspace: "Backspace", delete: "Delete", space: "Space" };

// "Enter", "enter'a bas", "ESC tuşu" → a key name Midscene understands; anything else is rejected.
function keyNameOf(value) {
  const text = String(value ?? "").trim();
  if (KEY_NAME.test(text)) return KEY_CASE[text.toLowerCase()] || text;
  const known = KNOWN_KEY.exec(text)?.[1];
  return known ? KEY_CASE[known.toLowerCase()] || known : "";
}
const SCROLL_TYPES = new Set(["singleAction", "scrollToBottom", "scrollToTop", "scrollToRight", "scrollToLeft", "untilBottom", "untilTop", "untilRight", "untilLeft", "once"]);
const SAVED_NAME = /^[A-Za-z_][\w]{0,39}$/;

// `saved` holds the names earlier steps of the same case read with `name`; nothing else can be referenced.
function checkPlaceholders(text, saved = new Set()) {
  for (const [, name] of String(text).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (name === "launchUrl" || /^account\.\w+$/.test(name)) continue;
    const savedName = /^saved\.(\w+)$/.exec(name)?.[1];
    if (savedName && saved.has(savedName)) continue;
    throw new Error(savedName ? `{{saved.${savedName}}} önceki bir adımda okunmadı` : `adımda bilinmeyen değişken: {{${name}}}`);
  }
}

const pick = (step, name) => step?.[name] ?? step?.args?.[name];
const optional = (value) => (value === undefined || value === null || value === "" ? undefined : value);

function number(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

// Turns the model's step into the runner's step shape (the same one `parseSteps` produces from YAML).
function normalizeStep(step, platform, saved) {
  const action = ACTION_ALIASES[String(step?.action || "").replace(/[^a-z]/gi, "").toLowerCase()];
  if (!action) throw new Error(`desteklenmeyen adım: ${clip(step?.action, 40) || "(boş)"}`);
  if (action === "launch") return null;
  if (MOBILE_ONLY.has(action)) return platform === "web" ? null : { action, text: "" };
  if (WEB_ONLY.has(action) && platform !== "web") throw new Error(`${action} yalnız web'de kullanılabilir`);
  if (action === "aiPinch" && !PINCH_PLATFORMS.has(platform)) throw new Error("aiPinch yalnız mobilde kullanılabilir");
  const checked = (value) => {
    const text = clip(value);
    checkPlaceholders(text, saved);
    return text;
  };
  const withLabel = (args) => {
    const clean = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
    return { action, text: stepLabel(action, clean) ?? clean.locate ?? "", args: clean };
  };
  if (action === "sleep") {
    return { action, text: String(number(step.ms ?? step.text, 100, 60_000, 1000)) };
  }
  if (action === "aiInput") {
    const locate = checked(pick(step, "locate") ?? step.text);
    const value = String(pick(step, "value") ?? "").slice(0, MAX_TEXT);
    if (!locate) throw new Error("aiInput adımında alan tarifi yok");
    checkPlaceholders(value, saved);
    return { action, text: `${locate} ← ${value}`, args: { locate, value } };
  }
  if (action === "aiKeyboardPress") {
    const keyName = keyNameOf(pick(step, "keyName") ?? pick(step, "key") ?? step.text);
    if (!keyName) throw new Error(`geçersiz tuş adı: ${clip(pick(step, "keyName") ?? step.text, 30) || "(boş)"}`);
    return withLabel({ keyName, locate: optional(pick(step, "locate")) && checked(pick(step, "locate")) });
  }
  if (action === "aiScroll" || action === "aiPinch") {
    const direction = String(pick(step, "direction") || (action === "aiPinch" ? "out" : "down")).toLowerCase();
    const allowed = action === "aiPinch" ? ["in", "out"] : ["down", "up", "left", "right"];
    if (!allowed.includes(direction)) throw new Error(`${action} yönü geçersiz: ${clip(direction, 20)}`);
    const scrollType = action === "aiScroll" ? String(pick(step, "scrollType") || "singleAction") : undefined;
    if (scrollType && !SCROLL_TYPES.has(scrollType)) throw new Error(`geçersiz kaydırma türü: ${clip(scrollType, 30)}`);
    // Only an explicit `locate` is a target; a free text like "sayfayı aşağı kaydır" is not an element.
    const locate = optional(pick(step, "locate"));
    const distance = optional(pick(step, "distance"));
    return withLabel({
      locate: locate && checked(locate),
      direction,
      scrollType,
      distance: distance === undefined ? undefined : String(number(distance, 1, 5000, 500)),
    });
  }
  if (["aiClearInput", "aiDoubleClick", "aiRightClick", "aiLongPress"].includes(action)) {
    const locate = checked(pick(step, "locate") ?? step.text);
    if (!locate) throw new Error(`${action} adımında öğe tarifi yok`);
    const duration = action === "aiLongPress" && optional(pick(step, "duration")) ? String(number(pick(step, "duration"), 200, 10_000, 1000)) : undefined;
    return withLabel({ locate, duration });
  }
  if (READ_ACTIONS.has(action)) {
    const prompt = checked(pick(step, "prompt") ?? step.text);
    if (!prompt) throw new Error(`${action} adımında ne okunacağı yok`);
    const name = optional(pick(step, "name"));
    if (name !== undefined && !SAVED_NAME.test(String(name))) throw new Error(`geçersiz değişken adı: ${clip(name, 40)}`);
    const expect = optional(pick(step, "expect"));
    const args = { prompt, name: name === undefined ? undefined : String(name), expect: expect === undefined ? undefined : checked(String(expect)) };
    if (name !== undefined) saved.add(String(name));
    return withLabel(args);
  }
  if (action === "aiWaitFor" && optional(pick(step, "timeout"))) {
    const text = checked(step.text ?? step.prompt);
    if (!text) throw new Error("aiWaitFor adımının metni boş");
    return { action, text, args: { timeout: String(number(pick(step, "timeout"), 1000, 120_000, 30_000)) } };
  }
  const text = checked(step.text ?? step.prompt ?? pick(step, "locate"));
  if (!text) throw new Error(`${action} adımının metni boş`);
  return { action, text };
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function usesAccount(cases) {
  return cases.some((item) => item.steps.some((step) => /\{\{\s*account\./.test(`${step.text} ${Object.values(step.args || {}).join(" ")}`)));
}

// Validates the model's decision against the catalog. Anything it invents (ids, case keys, actions,
// variables, non-http addresses) is rejected instead of being passed on to the runner.
export function normalizeDecision(raw, catalog) {
  const intent = String(raw?.intent || "").trim();
  const reply = clip(raw?.reply, 1200);
  const byId = new Map(catalog.map((item) => [Number(item.id), item]));
  if (intent === "reply") {
    if (!reply) throw new Error("model boş yanıt verdi");
    return { intent, reply };
  }
  if (intent === "run_suite") {
    const ids = [...new Set((raw.run?.configIds || []).map(Number))].filter((id) => byId.has(id));
    if (!ids.length) throw new Error("model katalogda olmayan bir konfigürasyon seçti");
    const requested = new Set((raw.run?.caseKeys || []).map(String).filter(Boolean));
    const runs = ids.map((id) => ({
      configId: id,
      caseKeys: requested.size ? byId.get(id).cases.map((item) => item.key).filter((key) => requested.has(key)) : [],
    })).filter((item) => !requested.size || item.caseKeys.length);
    if (!runs.length) throw new Error("model konfigürasyonda olmayan case'ler seçti");
    return { intent, reply, runs };
  }
  if (intent !== "scenario") throw new Error(`bilinmeyen karar: ${clip(intent, 40) || "(boş)"}`);
  const scenario = raw.scenario || {};
  const config = scenario.configId == null || scenario.configId === "" ? null : byId.get(Number(scenario.configId));
  if (scenario.configId != null && scenario.configId !== "" && !config) throw new Error("model katalogda olmayan bir konfigürasyon seçti");
  const url = normalizeUrl(scenario.url);
  const rawPackage = String(scenario.packageId || "").trim();
  const packageId = /^[A-Za-z][\w-]*(\.[A-Za-z0-9_-]+)+$/.test(rawPackage) ? rawPackage : "";
  if (scenario.url && !url) throw new Error(`geçersiz adres: ${clip(scenario.url, 80)}`);
  const hint = ["web", "android", "ios"].includes(scenario.platform) ? scenario.platform : "";
  const platform = url ? "web" : packageId ? (hint === "ios" || /^com\.apple\./i.test(packageId) ? "ios" : config?.platform === "ios" ? "ios" : "android") : config?.platform || "";
  if (!platform) {
    // The model's own reply would announce a test that is not going to start, so the tester gets the actual gap.
    if (hint === "ios" || hint === "android") {
      return { intent: "reply", reply: `Senaryo koşulmadı: ${hint === "ios" ? "iOS bundle id" : "Android applicationId"} bilinmiyor. Paket kimliğini yaz (örn. com.firma.app) ya da uygulamayı bu kimlikle bir proje konfigürasyonu olarak kaydet.` };
    }
    return { intent: "reply", reply: "Senaryoyu nerede koşayım? Bir adres, bir paket kimliği ya da kayıtlı bir proje adı yaz." };
  }
  // A borrowed configuration must match the platform; otherwise only the address or package is used.
  const lender = config && config.platform === platform ? config : null;
  const cases = (Array.isArray(scenario.cases) ? scenario.cases : []).slice(0, MAX_CASES).map((item, index) => {
    const saved = new Set();
    const steps = (Array.isArray(item?.steps) ? item.steps : []).map((step) => normalizeStep(step, platform, saved)).filter(Boolean).slice(0, MAX_STEPS);
    if (!steps.length) throw new Error(`${index + 1}. case'te adım yok`);
    return { title: clip(item.title, 120) || `Senaryo ${index + 1}`, steps: [{ action: "launch", text: "{{launchUrl}}" }, ...steps] };
  });
  if (!cases.length) throw new Error("model senaryo adımı üretmedi");
  const title = clip(scenario.title, 120) || cases[0].title;
  return { intent, reply, title, target: { platform, config: lender, launchUrl: url, packageId }, cases };
}
