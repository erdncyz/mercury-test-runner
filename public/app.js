const $ = (id) => document.getElementById(id);
const translatedAttrs = new Set(["placeholder", "aria-label", "title", "alt"]);
const ui = (key, params) => t(key, params);
const lowerLocale = () => (i18n.getLang() === "en" ? "en" : "tr");

const state = {
  me: null,
  view: "chat",
  runFilter: "all",
  runScheduledOnly: false,
  runProject: "all",
  runTimer: null,
  configs: [],
  providers: [],
  model: null,
  drawerRun: null,
  conversationId: null,
  configOptions: { clients: [], sources: [], cases: [], limits: {}, suites: [] },
};

const TITLES = { chat: "Chat", history: "Geçmiş", runs: "Koşumlar", configs: "Konfigürasyonlar", settings: "Ayarlar", people: "Üyeler" };
const STATUS_LABEL = { queued: "Kuyrukta", running: "Koşuyor", passed: "Geçti", failed: "Başarısız", blocked: "Engellendi" };
const PLATFORM = { web: ["Web", "globe"], android: ["Android", "phone"], ios: ["iOS", "phone"], tv: ["Smart TV", "tv"] };
const FINISHED = new Set(["passed", "failed", "blocked"]);
const STEP_ACTION = {
  launch: "aç", aiAct: "ai eylem", aiAction: "ai eylem", ai: "ai eylem", aiAssert: "doğrula", aiWaitFor: "bekle",
  aiQuery: "sorgu", aiTap: "dokun", aiInput: "yaz", aiHover: "üzerine gel", sleep: "uyu",
  aiKeyboardPress: "tuş", aiScroll: "kaydır", aiClearInput: "temizle", aiDoubleClick: "çift tık", aiRightClick: "sağ tık",
  aiLongPress: "uzun bas", aiPinch: "yakınlaştır", aiString: "oku", aiNumber: "sayı oku", aiBoolean: "evet/hayır", back: "geri", home: "ana ekran",
};
const STEP_STATE = { pending: "Bekliyor", running: "Koşuyor", passed: "Geçti", failed: "Başarısız", not_run: "Çalıştırılmadı", skipped: "Atlandı" };

/* ---------- Helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : (translatedAttrs.has(key) && typeof value === "string" ? t(value) : value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(typeof child === "string" ? t(child) : String(child)));
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const badge = (value, label) => h("span", { class: `badge dot ${value}` }, label || value);

function platform(value) {
  const [label, glyph] = PLATFORM[value] || [value, "globe"];
  return h("span", { class: "platform" }, icon(glyph), label);
}

function relativeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return t("az önce");
  if (diff < 3600) return t("{n} dk önce", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n} sa önce", { n: Math.floor(diff / 3600) });
  return date.toLocaleString(i18n.locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-mercury-lang": i18n.getLang(), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.me && !path.startsWith("/api/auth/")) {
    state.me = null;
    showGate();
    throw new Error(t("Oturum sona erdi. Tekrar giriş yap."));
  }
  if (!response.ok) throw new Error(data.error || t("İstek başarısız ({status})", { status: response.status }));
  return data;
}

function toast(message, kind = "") {
  const node = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" },
    icon(kind === "error" ? "alert" : "check"), h("span", {}, message));
  $("toasts").append(node);
  setTimeout(() => node.remove(), kind === "error" ? 6000 : 3500);
}

async function busy(button, task) {
  if (!button || button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
}

function emptyState(title, text, action) {
  return h("div", { class: "empty" }, h("h3", {}, title), h("p", {}, text), action || null);
}

// In-app replacement for window.confirm, which embedded browsers may dismiss without ever showing it.
// Esc or "Vazgeç" resolves false; focus starts on "Vazgeç" so Enter never deletes by accident.
function confirmAction({ title, message, confirmLabel = "Sil" }) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = t(confirmLabel);
  dialog.returnValue = "";
  dialog.showModal();
  $("confirm-cancel").focus();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}
// Closing explicitly keeps the dialog working even where form submission is restricted (embedded browsers).
for (const [id, value] of [["confirm-ok", "ok"], ["confirm-cancel", "cancel"]]) {
  $(id).addEventListener("click", (event) => {
    event.preventDefault();
    $("confirm-dialog").close(value);
  });
}

/* ---------- Gate ---------- */

function showGate() {
  stopRunPolling();
  clearInterval(chatPoll);
  chatRuns.clear();
  closeDrawer();
  $("thread").replaceChildren();
  $("app").hidden = true;
  $("gate").hidden = false;
  document.title = `${t("Giriş")} · Mercury Test Runner`;
  selectTab("login");
}

function selectTab(name) {
  const login = name === "login";
  $("tab-login").setAttribute("aria-selected", String(login));
  $("tab-register").setAttribute("aria-selected", String(!login));
  $("login-form").hidden = !login;
  $("register-form").hidden = login;
  (login ? $("login-email") : $("register-email")).focus();
}

$("tab-login").addEventListener("click", () => selectTab("login"));
$("tab-register").addEventListener("click", () => selectTab("register"));

function validate(form) {
  let ok = true;
  for (const input of form.querySelectorAll("input")) {
    const valid = input.checkValidity();
    input.setAttribute("aria-invalid", String(!valid));
    if (!valid && ok) input.focus();
    ok = ok && valid;
  }
  return ok;
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $("login-error");
  error.hidden = true;
  if (!validate(form)) {
    error.textContent = t("E-posta ve şifreyi doldur.");
    error.hidden = false;
    return;
  }
  await busy(form.querySelector("button[type=submit]"), async () => {
    try {
      await api("/api/auth/login", { method: "POST", body: Object.fromEntries(new FormData(form)) });
      form.password.value = "";
      await enter();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
});

$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = $("register-note");
  note.hidden = true;
  if (!validate(form)) {
    note.className = "notice error";
    note.textContent = t("Geçerli bir e-posta ve en az 8 karakter şifre gir.");
    note.hidden = false;
    return;
  }
  await busy(form.querySelector("button[type=submit]"), async () => {
    try {
      await api("/api/auth/register", { method: "POST", body: Object.fromEntries(new FormData(form)) });
      note.className = "notice ok";
      note.textContent = t("İsteğin alındı. Admin onayladığında Giriş yap sekmesinden girebilirsin.");
      form.reset();
    } catch (err) {
      note.className = "notice error";
      note.textContent = err.message;
    }
    note.hidden = false;
  });
});

/* ---------- Shell & routing ---------- */

async function enter() {
  state.me = await api("/api/me");
  const isAdmin = state.me.role === "admin";
  $("gate").hidden = true;
  $("app").hidden = false;
  $("who-email").textContent = state.me.email;
  $("who-role").textContent = state.me.role;
  $("who-role").className = `badge ${state.me.role}`;
  $("avatar").textContent = state.me.email.slice(0, 1);
  $("history-owner").textContent = t("Yalnızca {email} hesabına ait konuşmalar burada görünür.", { email: state.me.email });
  $("version").textContent = `Mercury Test Runner v${state.me.version || ""}`;
  document.querySelectorAll("[data-admin]").forEach((node) => { node.hidden = !isAdmin; });
  $("history-search").value = "";
  await Promise.all([refreshModel(), loadConfigs(), checkUpdate(), isAdmin ? refreshPendingCount() : null].map((task) => task?.catch?.(() => {})));
  resetThread();
  threadInner.append(hero());
  route();
  startChatPoll();
}

function currentView() {
  const view = location.hash.replace(/^#\/?/, "") || "chat";
  const link = document.querySelector(`.tabs-nav [data-view="${view}"]`);
  return TITLES[view] && link && !link.hidden ? view : "chat";
}

function route({ preserveFocus = false } = {}) {
  if (!state.me) return;
  const view = currentView();
  state.view = view;
  for (const name of Object.keys(TITLES)) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll(".tabs-nav [data-view]").forEach((link) => {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.title = `${t(TITLES[view])} · Mercury Test Runner`;
  closeMenu();
  stopRunPolling();
  if (view === "chat" && !preserveFocus) $("chat-input").focus();
  if (view === "history") loadHistory($("history-search").value.trim());
  if (view === "runs") { loadRuns(); state.runTimer = setInterval(() => loadRuns(true), 4000); }
  if (view === "configs") renderConfigs();
  if (view === "settings") loadSettings();
  if (view === "people") loadPeople();
}

function go(view) {
  if (location.hash === `#/${view}`) route();
  else location.hash = `#/${view}`;
}

window.addEventListener("hashchange", route);

function stopRunPolling() {
  clearInterval(state.runTimer);
  state.runTimer = null;
}

function closeMenu() {
  $("user-menu").hidden = true;
  $("user-button").setAttribute("aria-expanded", "false");
}

$("user-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const open = $("user-menu").hidden;
  $("user-menu").hidden = !open;
  $("user-button").setAttribute("aria-expanded", String(open));
  if (open) $("logout").focus();
});
document.addEventListener("click", (event) => { if (!event.target.closest(".menu-wrap")) closeMenu(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("drawer").hidden) closeDrawer();
  else if (!$("user-menu").hidden) { closeMenu(); $("user-button").focus(); }
});

$("logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* session may already be gone */ }
  state.me = null;
  showGate();
});

async function checkUpdate() {
  const version = await api("/api/version");
  state.midscene = version.midscene || "";
  $("version").textContent = `Mercury Test Runner v${version.version}${version.midscene ? ` · Midscene ${version.midscene}` : ""}`;
  const button = $("update");
  if (!version.update) { button.hidden = true; return; }
  button.hidden = false;
  button.textContent = t("Güncelleme var · {version}", { version: version.update.version });
  button.title = version.update.notes || "";
  button.onclick = () => toast(state.me.role === "admin"
    ? t("Yeni sürüm {version}. Güncelleme imajı çekilerek uygulanır.", { version: version.update.version })
    : t("Güncellemeyi yalnız admin başlatabilir."));
}

async function refreshPendingCount() {
  const users = await api("/api/users");
  setPendingCount(users.filter((user) => user.status === "pending").length);
}

function setPendingCount(count) {
  $("pending-count").hidden = !count;
  $("pending-count").textContent = count;
}

/* ---------- Model status ---------- */

async function refreshModel() {
  state.model = await api("/api/models/status");
  const { ready, modelName, providerLabel, midscene = {} } = state.model;
  const isAdmin = state.me.role === "admin";
  const problem = !ready ? "Model bağlı değil" : midscene.error ? "Midscene hazır değil" : "";
  const chip = $("model-chip");
  chip.className = `pill ${problem ? "warn" : "ok"}`;
  chip.querySelector(".pill-text").textContent = problem ? t(problem) : modelName;
  chip.title = problem ? (midscene.error || t("Web koşumları model olmadan engellenir")) : `${providerLabel} · ${midscene.family || ""}`;
  chip.onclick = () => (isAdmin ? go("settings") : toast(problem ? t("{problem}. Admin'in Ayarlar'dan bağlaması gerekir.", { problem: t(problem) }) : t("Model: {model}", { model: modelName })));

  const banner = $("model-banner");
  banner.hidden = !problem;
  if (problem) {
    banner.replaceChildren(
      icon("alert"),
      h("p", {}, h("strong", {}, t("{problem}. ", { problem: t(problem) })), !ready ? "Web koşumları model olmadan engellenir; chat komut çözümü de aynı modeli kullanır." : midscene.error),
      isAdmin ? h("button", { type: "button", class: "btn secondary sm", onclick: () => go("settings") }, "Ayarlar") : h("span", { class: "small" }, "Admin'e haber ver"),
    );
  }
}

/* ---------- Run card (chat + drawer) ---------- */

const openCases = new Set();

/* ---------- Run metrics (timing, page load and Midscene's AI usage) ---------- */

const num = (value, digits = 0) => Number(value).toLocaleString(i18n.locale(), { maximumFractionDigits: digits });
function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return t("{n} ms", { n: num(ms) });
  if (ms < 60_000) return t("{n} sn", { n: num(ms / 1000, 1) });
  return t("{m} dk {s} sn", { m: Math.floor(ms / 60_000), s: Math.round((ms % 60_000) / 1000) });
}
const fmtTokens = (value) => (value >= 1000 ? `${num(value / 1000, 1)}K` : num(value));
const fmtBytes = (value) => (value >= 1_048_576 ? `${num(value / 1_048_576, 1)} MB` : `${num(value / 1024)} KB`);
const MIDSCENE_ACTION = { Tap: "tıklama", Input: "yazma", KeyboardPress: "tuş", Scroll: "kaydırma", Hover: "üzerine gelme", DoubleClick: "çift tıklama", RightClick: "sağ tıklama", DragAndDrop: "sürükleme", LongPress: "uzun basma", Swipe: "kaydırma" };

function sumAi(stepsWithAi) {
  const total = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, timeMs: 0, cacheHits: 0, models: new Set() };
  for (const { ai } of stepsWithAi) {
    for (const key of ["calls", "promptTokens", "completionTokens", "cachedTokens", "totalTokens", "timeMs", "cacheHits"]) total[key] += ai[key] || 0;
    for (const model of ai.models || []) total.models.add(model);
  }
  return total;
}

// One line under a step: its duration, what Midscene spent on it, what it did and where the page went.
function stepMeta(step, previousUrl) {
  const metrics = step.metrics || {};
  const parts = [];
  if (metrics.durationMs) parts.push(fmtMs(metrics.durationMs));
  const ai = metrics.ai;
  if (ai?.calls) parts.push(t("AI {n} çağrı · {time}", { n: ai.calls, time: fmtMs(ai.timeMs) }));
  if (ai?.totalTokens) parts.push(t("{n} token", { n: fmtTokens(ai.totalTokens) }));
  if (ai?.cacheHits) parts.push(t("{n} önbellek isabeti", { n: ai.cacheHits }));
  if (metrics.actions?.length) parts.push(metrics.actions.map((action) => t(MIDSCENE_ACTION[action] || action)).join(" → "));
  if (metrics.load?.domContentLoadedMs) parts.push(t("açılış {time}", { time: fmtMs(metrics.load.domContentLoadedMs) }));
  if (metrics.url && previousUrl && metrics.url !== previousUrl) {
    try { const url = new URL(metrics.url); parts.push(`→ ${url.pathname}${url.search}`); } catch { parts.push(`→ ${metrics.url}`); }
  }
  // A failed step already shows the same text as its error.
  const note = metrics.note && step.status === "passed" && step.action !== "aiQuery" ? metrics.note : "";
  const title = ai?.calls
    ? t("Giriş {input} · çıkış {output} · önbellekten {cached} token · {models}", {
      input: num(ai.promptTokens), output: num(ai.completionTokens), cached: num(ai.cachedTokens), models: (ai.models || []).join(", "),
    })
    : undefined;
  return [
    parts.length ? h("span", { class: "step-meta", title }, parts.join(" · ")) : null,
    note ? h("span", { class: "step-note" }, h("b", {}, "Midscene: "), note) : null,
  ];
}

// Summary tiles for the whole run, plus the page-load breakdown of its first page.
function runMetrics(run) {
  const steps = (run.cases || []).flatMap((item) => item.steps || []);
  if (!steps.length) return null;
  const measured = steps.map((step) => step.metrics).filter(Boolean);
  const started = Date.parse(run.started_at || "");
  const ended = run.finished_at ? Date.parse(run.finished_at) : run.status === "running" ? Date.now() : NaN;
  const duration = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : measured.reduce((sum, item) => sum + (item.durationMs || 0), 0);
  const count = (status) => steps.filter((step) => step.status === status).length;
  const ai = sumAi(measured.filter((item) => item.ai));
  const load = measured.find((item) => item.load)?.load;
  const env = measured.find((item) => item.env)?.env;
  const slowest = steps.reduce((top, step, index) => ((step.metrics?.durationMs || 0) > (top?.ms || 0) ? { ms: step.metrics.durationMs, index } : top), null);
  const tile = (label, value, sub, extra) => h("div", { class: "run-metric" }, h("span", {}, label), h("b", {}, value), extra || null, sub ? h("small", {}, sub) : null);
  const passed = count("passed");
  const failed = count("failed");
  const notRun = count("skipped") + count("not_run");
  const segment = (kind, n) => (n ? h("i", { class: kind, style: `flex:${n}` }) : null);
  const stepBar = h("span", { class: "run-metric-bar", "aria-hidden": "true" },
    segment("ok", passed), segment("bad", failed), segment("rest", steps.length - passed - failed));
  const group = (label, aside, tiles) => {
    const items = tiles.filter(Boolean);
    return items.length ? h("div", { class: "metric-group" },
      h("div", { class: "metric-group-head" }, h("span", {}, label), aside ? h("span", { class: "truncate", title: aside }, aside) : null),
      h("div", { class: "metric-row", style: `--cols:${items.length}` }, items),
    ) : null;
  };
  const runGroup = group("Koşum", env ? [env.browser, env.viewport].filter(Boolean).join(" · ") : "", [
    duration > 0 ? tile("Süre", fmtMs(duration), run.status === "running" ? t("sürüyor") : null) : null,
    tile("Adım", t("{passed}/{total} geçti", { passed, total: steps.length }),
      [failed ? t("{n} başarısız", { n: failed }) : "", notRun ? t("{n} koşmadı", { n: notRun }) : ""].filter(Boolean).join(" · ") || null, stepBar),
    slowest?.ms ? tile("En yavaş adım", fmtMs(slowest.ms), t("{n}. adım", { n: slowest.index + 1 })) : null,
    load ? tile("Sayfa açılışı", fmtMs(load.domContentLoadedMs), load.ttfbMs ? t("ilk bayt {time}", { time: fmtMs(load.ttfbMs) }) : null) : null,
  ]);
  const aiGroup = ai.calls || ai.totalTokens ? group("Midscene AI",
    [[...ai.models].join(", "), state.midscene ? `Midscene ${state.midscene}` : ""].filter(Boolean).join(" · "), [
      ai.calls ? tile("AI çağrısı", num(ai.calls), t("model süresi {time}", { time: fmtMs(ai.timeMs) })) : null,
      ai.totalTokens ? tile("Token", fmtTokens(ai.totalTokens), t("giriş {input} · çıkış {output}", { input: fmtTokens(ai.promptTokens), output: fmtTokens(ai.completionTokens) })) : null,
      ai.cachedTokens ? tile("Önbellekten", fmtTokens(ai.cachedTokens), t("giriş tokenlarında %{n}", { n: num((ai.cachedTokens / Math.max(1, ai.promptTokens)) * 100) })) : null,
    ]) : null;
  const item = (label, value) => (value ? h("span", {}, t(label), " ", h("b", {}, value)) : null);
  const loadLine = load ? h("div", { class: "run-load", "aria-label": t("Sayfa açılış ayrıntısı") },
    item("HTTP", [load.status, load.protocol].filter(Boolean).join(" · ")),
    item("DNS", load.dnsMs ? fmtMs(load.dnsMs) : ""),
    item("Bağlantı", load.connectMs ? fmtMs(load.connectMs) : ""),
    item("İlk bayt", load.ttfbMs ? fmtMs(load.ttfbMs) : ""),
    item("İlk boyama", load.fcpMs ? fmtMs(load.fcpMs) : ""),
    item("DOM hazır", load.domContentLoadedMs ? fmtMs(load.domContentLoadedMs) : ""),
    item("Tam yükleme", load.loadMs ? fmtMs(load.loadMs) : ""),
    item("İstek sayısı", load.requests ? num(load.requests) : ""),
    item("Aktarım", load.transferBytes ? fmtBytes(load.transferBytes) : ""),
  ) : null;
  return [h("div", { class: "run-metrics" }, runGroup, aiGroup), loadLine];
}

// Known failure sources, matched against Midscene's (usually English) error text. Order matters: a CAPTCHA
// also surfaces as a waitFor timeout, so the more specific causes come first.
const FAILURE_CAUSES = [
  [/captcha|recaptcha|hcaptcha|turnstile|robot olmadığ|kareleri seçin|not a robot|unusual traffic|olağandışı trafik|bot (?:koruma|detection|protection)|verify you are human/i,
    "Bot koruması / CAPTCHA", "Site otomasyonu doğrulama ekranıyla durdurdu. Test ortamında CAPTCHA'yı kapatın ya da test hesabını/IP'yi beyaz listeye alın."],
  [/adb (?:connect|devices|shell)|failed to authenticate to|device (?:offline|unauthori[sz]ed|not found)|WebDriverAgent|farm cihaz|cihaz(?:a)? bağlanılamadı/i,
    "Cihaz bağlantısı", "Cihaza bağlanılamadı; cihazın açık, kilidi açık ve USB/ağ hata ayıklamasına izin verilmiş olduğunu kontrol edin."],
  [/api[ _-]?key|unauthori[sz]ed|\b40[13]\b|\b429\b|quota|rate.?limit|model (?:error|hatası)/i,
    "Model / API hatası", "Model sağlayıcısı isteği reddetti; anahtarı, kotayı ve model adını Ayarlar'dan kontrol edin."],
  [/net::|ERR_[A-Z_]{3,}|ECONN|ENOTFOUND|getaddrinfo|navigation (?:failed|timeout)|sayfa açılamadı/i,
    "Ağ / sayfa açılamadı", "Adres erişilebilir mi, VPN ya da ağ bağlantısı açık mı kontrol edin."],
  [/not found|cannot find|could not (?:find|locate)|unable to locate|failed to locate|bulunamadı/i,
    "Öğe bulunamadı", "Midscene hedef öğeyi ekranda bulamadı; adım metnini ekrandaki etikete göre netleştirin."],
  [/assert|doğrulama/i, "Doğrulama tutmadı", "Beklenen durum ekranda görülmedi; adımın ekran görüntüsüne bakın."],
  [/timeout|timed out|zaman aşımı/i, "Zaman aşımı", "Beklenen durum süre içinde oluşmadı; ekran görüntüsüne bakın."],
];

// The first failed step of a failed run, reduced to a short "what broke and why" summary.
function failureCause(run) {
  if (run.status !== "failed") return null;
  let hit = null;
  for (const item of run.cases || []) {
    const steps = item.steps || [];
    const index = steps.findIndex((step) => step.status === "failed");
    if (index >= 0) { hit = { step: steps[index], index, text: steps[index].detail || item.detail || "" }; break; }
  }
  const text = String(hit?.text || run.message || "").trim();
  if (!text) return null;
  const [, label, hint] = FAILURE_CAUSES.find(([pattern]) => pattern.test(text)) || [null, hit ? "Adım başarısız" : "Koşum başarısız", ""];
  // Midscene prefixes its own error kind ("waitFor timeout: …"); the summary only needs the first sentence.
  const reason = text.replace(/^(?:[a-z]+ )?(?:timeout|failed|error)\s*:\s*/i, "").replace(/^Task failed:\s*/i, "");
  const firstSentence = reason.match(/^.{20,}?[.!?](?=\s|$)/s)?.[0] || reason;
  const short = firstSentence.length > 180 ? `${firstSentence.slice(0, 177).trimEnd()}…` : firstSentence;
  // Without a failed step the run message is the only explanation (preflight, device, report errors); keep it whole.
  return { label, hint, short: hit ? short : text, full: text, step: hit?.step, index: hit?.index };
}

function causeCallout(cause) {
  const focusStep = (event) => {
    const step = event.currentTarget.closest(".run-card")?.querySelector(".step.failed");
    if (!step) return;
    const details = step.closest("details");
    if (details) details.open = true;
    step.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return h("section", { class: "run-cause", role: "status", "aria-label": t("Hata kaynağı") },
    h("span", { class: "run-cause-icon" }, icon("alert")),
    h("div", { class: "run-cause-body" },
      h("div", { class: "run-cause-head" },
        h("span", { class: "run-cause-kicker" }, "Hata kaynağı"),
        h("strong", {}, cause.label),
      ),
      cause.step ? h("div", { class: "run-cause-where" },
        h("span", { class: "mono" }, t("{n}. adım", { n: cause.index + 1 })),
        h("span", { class: "run-cause-action" }, STEP_ACTION[cause.step.action] || cause.step.action),
        h("span", { class: "truncate" }, cause.step.text || ""),
      ) : null,
      h("p", { class: "run-cause-text", title: cause.full }, cause.short),
      cause.hint ? h("p", { class: "run-cause-hint" }, cause.hint) : null,
    ),
    cause.step ? h("button", { type: "button", class: "btn secondary sm", onclick: focusStep }, "Adıma git") : null,
  );
}

function stepItem(step, index, runId, previousUrl) {
  const status = step.status || "pending";
  const marker = status === "passed" ? icon("check") : status === "failed" ? icon("x") : String(index + 1);
  const shot = step.shot ? `/reports/${runId}/${encodeURIComponent(step.shot)}` : "";
  return h("li", { class: `step ${status}` },
    h("span", { class: "marker", "aria-hidden": "true" }, marker),
    h("span", { class: "action" }, STEP_ACTION[step.action] || step.action),
    h("span", { class: "step-text" }, step.text || "—"),
    h("span", { class: "state" }, STEP_STATE[status] || status),
    ...stepMeta(step, previousUrl),
    step.detail && (status === "failed" || (status === "passed" && step.action === "aiQuery")) ? h("span", { class: "step-detail" }, step.detail) : null,
    shot ? h("a", { class: "step-shot", href: shot, target: "_blank", rel: "noopener", title: "Ekran görüntüsünü büyüt" },
      h("img", { src: shot, alt: t("{n}. adımdan sonra ekran", { n: index + 1 }), loading: "lazy" })) : null,
  );
}

// Midscene report of one case, shown next to the run's status (or each case's when the run has several). It is
// published after every step, so it is usable mid-run. A link inside <summary> opens the report without toggling the case.
function caseReport(run, item, caseCount = 0) {
  const files = item.files || {};
  if (!files.report || caseCount === 1) return null;
  const live = run.status === "running" && item.status === "running";
  return h("a", { class: "case-report", href: `/reports/${run.id}/${encodeURIComponent(files.report)}`, target: "_blank", rel: "noopener" },
    live ? "Midscene raporu (canlı)" : "Midscene raporu", icon("external"));
}

// Chat scenarios are named after the scenario ("Kullanıcı girişi · Web"); saved runs after project and configuration.
function runTitle(run) {
  return run.scenario ? run.config_name : `${run.client_name} · ${run.config_name}`;
}

// Case titles often already start with their TestRail id ("C101 …"); show the id once.
function caseLabel(key, title) {
  const text = String(title || "");
  if (!key) return [text];
  const rest = text.replace(new RegExp(`^C?${key}\\b[\\s:.\\-–—]*`, "i"), "");
  return [h("span", { class: "mono muted" }, `C${key}  `), rest || text];
}

function runCard(run, { expanded = false } = {}) {
  // In the drawer failures are listed first and every case starts collapsed, so 400 cases stay readable.
  const CASE_ORDER = { failed: 0, blocked: 1, running: 2 };
  const entries = (run.cases || []).map((item, index) => ({ item, key: `${run.id}:${item.case_key || index}` }));
  if (expanded && entries.length > 1) entries.sort((a, b) => (CASE_ORDER[a.item.status] ?? 3) - (CASE_ORDER[b.item.status] ?? 3));
  const cases = entries.map(({ item }) => item);
  const caseNodes = entries.map(({ item, key }) => {
    const steps = item.steps || [];
    const done = steps.filter((step) => ["passed", "failed", "skipped", "not_run"].includes(step.status)).length;
    const autoOpen = !expanded && cases.length === 1;
    const details = h("details", { class: "case", open: autoOpen || openCases.has(key) ? true : undefined },
      h("summary", {},
        h("span", { class: "chev" }, icon("chevron")),
        h("span", { class: "grow truncate" }, ...caseLabel(item.case_key, item.title)),
        h("span", { class: "muted small" }, t("{n} adım", { n: steps.length })),
        caseReport(run, item, cases.length),
        badge(item.status, STATUS_LABEL[item.status] || STEP_STATE[item.status] || item.status),
      ),
      run.status === "running" && steps.length ? h("div", { class: "progress" }, h("span", { style: `width:${Math.round((done / steps.length) * 100)}%` })) : null,
      steps.length ? h("ol", { class: "steps" }, steps.map((step, position) => stepItem(step, position, run.id, steps[position - 1]?.metrics?.url))) : h("p", { class: "muted small", style: "padding:0 14px 14px" }, "Bu case için adım tanımı yok."),
    );
    details.addEventListener("toggle", () => (details.open ? openCases.add(key) : openCases.delete(key)));
    return details;
  });
  // A failed step already shows the error inline, so the run-level note would only repeat it.
  const stepFailed = cases.some((item) => (item.steps || []).some((step) => step.status === "failed"));
  const cause = failureCause(run);
  return h("article", { class: "run-card" },
    h("div", { class: "run-card-head" },
      h("div", { class: "grow" },
        h("div", { class: "title truncate" }, runTitle(run)),
        h("div", { class: "meta" },
          h("span", { class: "mono" }, `#${run.id}`),
          platform(run.platform),
          run.scenario ? h("span", {}, run.client_name) : null,
          run.testrail_run_id
            ? h("span", {}, `TestRail R${run.testrail_run_id}`)
            : run.testrail_error ? h("span", { class: "meta-error", title: run.testrail_error }, "TestRail'e yazılmıyor") : h("span", {}, "Yerel koşum"),
          run.device_label ? h("span", {}, run.device_label) : null,
          run.account_email ? h("span", {}, run.account_email) : null,
        ),
      ),
      cases.length === 1 ? caseReport(run, cases[0]) : null,
      badge(run.status, STATUS_LABEL[run.status] || run.status),
    ),
    cause ? causeCallout(cause) : null,
    cases.length > 1 ? h("div", { class: "run-card-tally" }, caseTally(countCases(cases), run.status)) : null,
    expanded ? runMetrics(run) : null,
    run.message && !stepFailed && !cause ? h("div", { class: `note${run.status === "failed" ? " bad" : ""}` }, run.message) : null,
    cases.length ? caseNodes : h("p", { class: "muted small", style: "padding:12px 14px" }, "Bu proje için case bulunamadı."),
  );
}

/* ---------- Chat ---------- */

const chatRuns = new Map();
let chatPoll = null;
let lastDay = "";
let threadInner = null;

function resetThread() {
  threadInner = h("div", { class: "thread-inner" });
  $("thread").replaceChildren(threadInner);
  chatRuns.clear();
  lastDay = "";
  state.conversationId = null;
}

function scrollThread() {
  $("thread").scrollTop = $("thread").scrollHeight;
}

function dayLabel(value) {
  return (value ? new Date(value) : new Date()).toLocaleDateString(i18n.locale(), { day: "numeric", month: "long", year: "numeric" });
}

function hero() {
  const cards = state.configs.slice(0, 4).map((config) => h("button", {
    type: "button",
    class: "hero-card",
    disabled: !config.plan?.ready,
    title: config.plan?.issues?.join(" · ") || "",
    onclick: () => useCommand(commandFor(config)),
  },
    h("strong", {}, icon(PLATFORM[config.platform]?.[1] || "globe"), config.name),
    h("span", {}, config.plan?.ready ? commandFor(config) : config.plan?.issues?.[0] || "Plan hazır değil"),
  ));
  return h("div", { class: "hero", id: "hero" },
    h("span", { class: "brand-mark", "aria-hidden": "true" }, h("span", {}, "M")),
    h("h1", {}, "Ne koşalım?"),
    h("p", {}, "Kayıtlı case'leri koştur (\"proje adı web koş\", \"proje adının giriş testlerini koş\") ya da ne test edeceğimi anlat: \"proje adında login ol\", \"example.com'da arama yap ve sonuç geldiğini doğrula\". Senaryoyu ben yazar, sayfada yolunu bulur, adımları burada canlı gösteririm."),
    cards.length ? h("div", { class: "hero-grid" }, cards) : null,
  );
}

function addMessage(role, text, runs = [], createdAt = "") {
  $("hero")?.remove();
  const typing = role.includes("typing");
  const day = dayLabel(createdAt);
  if (!typing && day !== lastDay) {
    threadInner.append(h("div", { class: "day-sep" }, day));
    lastDay = day;
  }
  const mine = role === "me";
  const time = new Date(createdAt || Date.now()).toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit" });
  const node = h("div", { class: `msg ${role}` },
    mine ? null : h("div", { class: "avatar", "aria-hidden": "true" }, "M"),
    h("div", { class: "body" },
      h("div", { class: "text" }, text),
      runs.map(mountRunCard),
      typing ? null : h("span", { class: "time" }, time),
    ),
  );
  threadInner.append(node);
  scrollThread();
  return node;
}

function mountRunCard(run) {
  const holder = h("div", {});
  if (!chatRuns.has(run.id)) chatRuns.set(run.id, new Set());
  chatRuns.get(run.id).add(holder);
  if (FINISHED.has(run.status)) holder.dataset.done = "1";
  holder.append(runCard(run));
  return holder;
}

async function pollChatRuns() {
  for (const [id, holders] of chatRuns) {
    const live = [...holders].filter((holder) => holder.isConnected && !holder.dataset.done);
    if (!live.length) continue;
    try {
      const run = await api(`/api/runs/${id}`);
      for (const holder of live) {
        holder.replaceChildren(runCard(run));
        if (FINISHED.has(run.status)) holder.dataset.done = "1";
      }
    } catch { /* keep the last known state */ }
  }
}

function startChatPoll() {
  clearInterval(chatPoll);
  chatPoll = setInterval(pollChatRuns, 3000);
}

let historySeq = 0;
async function loadHistory(query = "") {
  const seq = ++historySeq;
  let messages;
  try {
    messages = await api(`/api/chat/history${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  if (seq !== historySeq) return;
  const info = $("history-info");
  const conversations = [];
  const byId = new Map();
  for (const message of messages) {
    const id = message.conversation_id || message.turn;
    if (!byId.has(id)) {
      const conversation = { id, messages: [] };
      byId.set(id, conversation);
      conversations.push(conversation);
    }
    byId.get(id).messages.push(message);
  }
  info.textContent = conversations.length ? t("{n} konuşma", { n: conversations.length }) : "";
  $("history-clear").hidden = !conversations.length || Boolean(query);
  if (!conversations.length) {
    $("history-list").replaceChildren(emptyState(
      query ? "Eşleşen konuşma yok" : "Henüz chat geçmişin yok",
      query ? "Başka bir kelimeyle aramayı dene." : "Chat üzerinden ilk koşumunu başlattığında konuşman burada görünecek.",
      query ? null : h("a", { class: "btn primary", href: "#/chat" }, "Chat'e git"),
    ));
    return;
  }
  $("history-list").replaceChildren(...conversations.reverse().map((conversation) => historyConversation(conversation, Boolean(query))));
}

// Conversations start collapsed; search results start expanded so matches are visible.
function historyConversation(conversation, expanded = false) {
  const title = conversation.messages.find((item) => item.role === "user")?.text || "Konuşma";
  const lastAt = conversation.messages.at(-1)?.created_at;
  const turns = conversation.messages.filter((item) => item.role === "user").length;
  const open = () => openConversation(conversation.id);
  const bodyId = `history-messages-${conversation.id}`;
  const setExpanded = (article, value) => {
    article.classList.toggle("collapsed", !value);
    article.querySelector(".history-messages").hidden = !value;
    const toggle = article.querySelector(".history-toggle");
    toggle.setAttribute("aria-expanded", String(value));
    toggle.setAttribute("aria-label", t(value ? "Mesajları gizle" : "Mesajları göster"));
    toggle.title = toggle.getAttribute("aria-label");
  };
  const article = h("article", { class: "history-turn" },
    h("header", { class: "history-turn-head" },
      h("span", { class: "history-icon", "aria-hidden": "true" }, icon("history")),
      h("div", { class: "grow" },
        h("h2", {}, h("button", { type: "button", class: "history-open", title: "Chat'te aç ve devam et", onclick: open }, title)),
        h("p", { class: "muted small" }, [
          new Date(lastAt).toLocaleString(i18n.locale(), { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }),
          turns > 1 ? t("{n} mesaj", { n: turns }) : "",
        ].filter(Boolean).join(" · ")),
      ),
      h("button", { type: "button", class: "btn secondary sm", onclick: open }, "Devam et"),
      h("button", {
        type: "button",
        class: "btn ghost sm",
        "aria-label": t('"{title}" konuşmasını sil', { title }),
        onclick: async (event) => {
          const button = event.currentTarget;
          if (!(await confirmAction({ title: t("Konuşma silinsin mi?"), message: t('"{title}" geçmişten kalıcı olarak silinir. Koşumlar Koşumlar sayfasında kalır.', { title }) }))) return;
          await busy(button, async () => {
            try {
              await api(`/api/chat/history/${conversation.id}`, { method: "DELETE" });
              if (state.conversationId === conversation.id) state.conversationId = null;
              toast(t("Konuşma silindi."), "ok");
              await loadHistory($("history-search").value.trim());
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }, "Sil"),
      h("button", {
        type: "button",
        class: "icon-btn history-toggle",
        "aria-controls": bodyId,
        onclick: () => setExpanded(article, article.classList.contains("collapsed")),
      }, icon("chevron-down")),
    ),
    h("div", { class: "history-messages", id: bodyId }, conversation.messages.map((message) => (message.role === "user"
      ? h("div", { class: "history-message user" }, h("span", { class: "history-role" }, "Sen"), h("p", {}, message.text))
      : h("div", { class: "history-message assistant" },
        h("span", { class: "history-role" }, "Mercury"),
        h("p", {}, message.text),
        (message.runs || []).map(mountRunCard),
      )))),
  );
  setExpanded(article, expanded);
  return article;
}

// Loads a saved conversation into Chat; the next message is added to the same conversation.
async function renderConversation(id) {
  let messages;
  try {
    messages = await api(`/api/chat/history/${id}`);
  } catch (err) {
    toast(err.message, "error");
    return false;
  }
  resetThread();
  for (const message of messages) {
    addMessage(message.role === "user" ? "me" : "bot", message.text, message.runs || [], message.created_at);
  }
  state.conversationId = id;
  scrollThread();
  return true;
}

async function openConversation(id) {
  if (!(await renderConversation(id))) return;
  go("chat");
  scrollThread();
}

async function sendChat(message) {
  addMessage("me", message);
  const typing = addMessage("bot typing", t("Düşünüyor"));
  try {
    const result = await api("/api/chat", { method: "POST", body: { message, conversationId: state.conversationId } });
    if (result.conversationId) state.conversationId = result.conversationId;
    typing.remove();
    const node = addMessage("bot", result.reply, result.runs || []);
    // Which QA skills the agent planned with; shown only on the live answer.
    if (result.skills?.length) node.querySelector(".time")?.before(h("div", { class: "msg-skills" }, t("QA becerileri: {skills}", { skills: result.skills.join(" · ") })));
  } catch (err) {
    typing.remove();
    addMessage("bot error", err.message);
  }
}

let searchTimer = null;
$("history-search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadHistory(event.target.value.trim()), 300);
});
$("history-clear").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!(await confirmAction({ title: t("Tüm chat geçmişi silinsin mi?"), message: t("Bütün konuşmaların kalıcı olarak silinir, geri alınamaz. Koşumlar Koşumlar sayfasında kalır."), confirmLabel: "Tümünü sil" }))) return;
  busy(button, async () => {
    try {
      await api("/api/chat/history", { method: "DELETE" });
      toast(t("Chat geçmişi silindi."), "ok");
      state.conversationId = null;
      await loadHistory();
    } catch (err) {
      toast(err.message, "error");
    }
  });
});

// Clears the on-screen conversation only; saved history stays in Geçmiş.
function newChat() {
  resetThread();
  threadInner.append(hero());
  chatInput.value = "";
  autosize();
  go("chat");
  chatInput.focus();
}
$("chat-new").addEventListener("click", newChat);
$("history-new").addEventListener("click", newChat);

const chatInput = $("chat-input");
const sendButton = document.querySelector("#chat-form .send");
function autosize() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 180)}px`;
  sendButton.disabled = !chatInput.value.trim();
}
chatInput.addEventListener("input", autosize);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  autosize();
  await busy(sendButton, () => sendChat(message));
  autosize();
  chatInput.focus();
});
autosize();

function parseAliases(config) {
  try { return JSON.parse(config.aliases || "[]"); } catch { return []; }
}

function parseConfigList(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

function commandFor(config) {
  const alias = parseAliases(config)[0] || config.name;
  const withClient = alias.toLowerCase().includes(config.client_name.toLowerCase()) ? alias : `${config.client_name} ${alias}`;
  return `${withClient} ${t("koş")}`;
}

function useCommand(command) {
  go("chat");
  chatInput.value = command;
  autosize();
  chatInput.focus();
}

async function loadConfigs() {
  state.configs = await api("/api/configs");
  const suggestions = $("suggestions");
  suggestions.hidden = state.configs.length === 0;
  suggestions.replaceChildren(...state.configs.slice(0, 6).map((config) => (
    h("button", {
      type: "button",
      disabled: !config.plan?.ready,
      title: config.plan?.ready ? `${config.client_name} · ${config.name}` : config.plan?.issues?.join(" · "),
      onclick: () => useCommand(commandFor(config)),
    }, commandFor(config))
  )));
  const current = $("hero");
  if (current) current.replaceWith(hero());
}

/* ---------- Runs ---------- */

const collapsedProjects = new Set();

function dayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayHeading(value) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const relative = dayKey(value) === dayKey(today) ? t("Bugün") : dayKey(value) === dayKey(yesterday) ? t("Dün") : "";
  return relative ? `${relative} · ${dayLabel(value)}` : dayLabel(value);
}

function clockTime(value) {
  return new Date(value).toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit" });
}

function countCases(cases = []) {
  const tally = { total: cases.length, passed: 0, failed: 0, blocked: 0, running: 0 };
  for (const item of cases) tally[Object.hasOwn(tally, item.status) && item.status !== "total" ? item.status : "running"] += 1;
  return tally;
}

// "✓ 380  ✗ 15  ⊘ 5 · 400 case" with a proportional bar; a running run shows how many cases are done.
function caseTally(tally, runStatus) {
  if (!tally?.total) return h("span", { class: "muted small" }, "—");
  const done = tally.passed + tally.failed + tally.blocked;
  const parts = [["passed", "✓", "{n} geçti"], ["failed", "✗", "{n} başarısız"], ["blocked", "⊘", "{n} engellendi"], ["running", "◷", "{n} bekliyor"]]
    .filter(([key]) => tally[key]);
  return h("div", { class: "tally" },
    h("div", { class: "tally-line" },
      ...parts.map(([key, mark, label]) => h("span", { class: `tally-n ${key}`, title: t(label, { n: tally[key] }) }, `${mark} ${tally[key]}`)),
      h("span", { class: "muted small" }, runStatus === "running" ? `${done}/${tally.total}` : t("{n} case", { n: tally.total })),
    ),
    h("div", { class: "tally-bar", "aria-hidden": "true" },
      ...parts.map(([key]) => h("span", { class: key, style: `width:${(tally[key] / tally.total) * 100}%` }))),
  );
}

async function loadRuns(silent = false) {
  let runs;
  let schedules;
  try {
    // The schedule table is secondary; its failure must not blank the run list.
    [runs, schedules] = await Promise.all([api("/api/runs"), api("/api/schedules").catch(() => [])]);
  } catch (err) {
    if (silent && state.runsSignature) return;
    state.runsSignature = null;
    $("run-stats").hidden = true;
    $("run-toolbar").hidden = true;
    $("run-schedules").hidden = true;
    $("run-list").replaceChildren(emptyState(
      "Koşumlar yüklenemedi",
      err.message,
      h("button", { type: "button", class: "btn secondary", onclick: (event) => busy(event.currentTarget, () => loadRuns()) }, icon("refresh"), "Tekrar dene"),
    ));
    return;
  }
  // The list is polled every few seconds; rebuilding identical rows would detach them mid-click and drop focus.
  const signature = JSON.stringify([state.runFilter, state.runProject, state.runScheduledOnly, dayKey(new Date()), schedules, runs.map((run) => [run.id, run.status, run.message, run.testrail_run_id, run.midscene_reports, run.case_counts, run.created_at])]);
  if (silent && signature === state.runsSignature && $("run-list").childElementCount) return;
  state.runsSignature = signature;
  // With no runs at all, zeroed stats and filters are just noise above the empty state.
  $("run-stats").hidden = !runs.length;
  $("run-toolbar").hidden = !runs.length;

  const projectNames = [...new Set(runs.map((run) => run.client_name))].sort((a, b) => a.localeCompare(b, i18n.locale()));
  if (state.runProject !== "all" && !projectNames.includes(state.runProject)) state.runProject = "all";
  $("run-project").replaceChildren(
    h("option", { value: "all" }, t("Tüm projeler ({n})", { n: runs.length })),
    ...projectNames.map((name) => h("option", { value: name }, `${name} (${runs.filter((run) => run.client_name === name).length})`)),
  );
  $("run-project").value = state.runProject;

  renderSchedules(state.runProject === "all" ? schedules : schedules.filter((item) => item.client_name === state.runProject));
  $("run-scheduled-only").setAttribute("aria-pressed", String(state.runScheduledOnly));
  const scoped = (state.runProject === "all" ? runs : runs.filter((run) => run.client_name === state.runProject))
    .filter((run) => !state.runScheduledOnly || run.scheduled);
  const counts = scoped.reduce((acc, run) => ({ ...acc, [run.status]: (acc[run.status] || 0) + 1 }), {});
  const stat = (label, value) => h("div", { class: "stat" }, h("span", {}, label), h("b", {}, value));
  $("run-stats").replaceChildren(
    stat("Toplam", scoped.length),
    stat("Aktif", (counts.queued || 0) + (counts.running || 0)),
    stat("Geçti", counts.passed || 0),
    stat("Başarısız · Engellendi", (counts.failed || 0) + (counts.blocked || 0)),
  );
  const options = [["all", "Tümü", scoped.length], ...Object.keys(STATUS_LABEL).map((key) => [key, STATUS_LABEL[key], counts[key] || 0])];
  $("run-filters").replaceChildren(...options.map(([key, label, count]) => (
    h("button", { type: "button", "aria-pressed": String(state.runFilter === key), onclick: () => { state.runFilter = key; loadRuns(true); } },
      label, h("span", { class: "n" }, count))
  )));

  const list = $("run-list");
  const visible = state.runFilter === "all" ? scoped : scoped.filter((run) => run.status === state.runFilter);
  if (!visible.length) {
    list.replaceChildren(emptyState(
      state.runScheduledOnly && !scoped.length ? "Henüz zamanlanmış koşum yok" : runs.length ? "Bu filtrede koşum yok" : "Henüz koşum yok",
      "Chat'e bir komut yaz; her komut yeni bir koşum ve TestRail run açar.",
      h("button", { type: "button", class: "btn primary", onclick: () => go("chat") }, "Chat'e git"),
    ));
    return;
  }
  // One case opens its Midscene report directly; with several, the drawer lists them per case.
  const midsceneReportButton = (run) => {
    const reports = run.midscene_reports || [];
    if (!reports.length) return null;
    const stop = { onclick: (event) => event.stopPropagation(), onkeydown: (event) => event.stopPropagation() };
    return reports.length === 1
      ? h("a", { class: "btn ghost sm hide-sm", href: `/reports/${run.id}/${encodeURIComponent(reports[0])}`, target: "_blank", rel: "noopener", ...stop }, "Midscene raporu", icon("external"))
      :       h("button", { type: "button", class: "btn ghost sm hide-sm", ...stop, onclick: (event) => { event.stopPropagation(); openDrawer(run.id); } }, t("Midscene raporları ({n})", { n: reports.length }));
  };
  const runRow = (run) => {
    const row = h("tr", { class: "clickable", tabindex: "0", "aria-label": t("Koşum #{id} ayrıntıları", { id: run.id }) },
      h("td", { class: "id hide-sm" }, `#${run.id}`),
      h("td", {},
        run.scheduled
          ? h("div", { class: "title with-tag" }, h("span", { class: "truncate" }, run.config_name),
            h("span", { class: "schedule-tag", title: t("Konfigürasyon zamanlamasıyla başladı") }, icon("clock"), h("span", { class: "sr-only" }, "Zamanlanmış")))
          : h("div", { class: "title" }, run.config_name),
        run.message ? h("div", { class: "sub truncate", title: run.message }, run.message) : null,
      ),
      h("td", { class: "hide-sm" }, platform(run.platform)),
      h("td", { class: "cases-cell" }, caseTally(run.case_counts, run.status)),
      h("td", {}, badge(run.status, STATUS_LABEL[run.status] || run.status)),
      h("td", { class: "hide-sm mono muted" }, run.testrail_run_id ? `R${run.testrail_run_id}` : "—"),
      h("td", { class: "hide-sm mono muted", title: new Date(run.created_at).toLocaleString(i18n.locale()) }, clockTime(run.created_at)),
      h("td", { class: "right" }, h("div", { class: "actions" },
        midsceneReportButton(run),
        run.can_delete && FINISHED.has(run.status)
          ? h("button", {
            type: "button",
            class: "btn ghost sm",
            "aria-label": t("Koşum #{id} sil", { id: run.id }),
            onclick: (event) => { event.stopPropagation(); deleteRun(run, event.currentTarget); },
            onkeydown: (event) => event.stopPropagation(),
          }, "Sil")
          : null,
      )),
    );
    row.addEventListener("click", () => openDrawer(run.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDrawer(run.id); } });
    return row;
  };
  // Fixed column widths keep the day tables of a project aligned under each other.
  const table = (dayRuns) => h("div", { class: "table-card" }, h("table", { class: "table run-table" },
    h("thead", {}, h("tr", {},
      h("th", { class: "hide-sm col-id" }, "ID"), h("th", {}, "Koşum"), h("th", { class: "hide-sm col-platform" }, "Platform"), h("th", { class: "col-cases" }, "Case'ler"),
      h("th", { class: "col-status" }, "Durum"), h("th", { class: "hide-sm col-testrail" }, "TestRail"), h("th", { class: "hide-sm col-time" }, "Saat"),
      h("th", { class: "col-actions" }, h("span", { class: "sr-only" }, "İşlemler")),
    )),
    h("tbody", {}, dayRuns.map(runRow)),
  ));

  // Project → day → runs. Runs arrive newest first, so projects and days keep "most recent on top".
  const projects = new Map();
  for (const run of visible) {
    if (!projects.has(run.client_name)) projects.set(run.client_name, new Map());
    const days = projects.get(run.client_name);
    const key = dayKey(run.created_at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(run);
  }
  const caseTotal = (items) => items.reduce((sum, run) => sum + (run.case_counts?.total || 0), 0);
  list.replaceChildren(...[...projects].map(([name, days]) => {
    const projectRuns = [...days.values()].flat();
    const group = h("details", { class: "run-group", open: !collapsedProjects.has(name) },
      h("summary", {},
        h("span", { class: "chev" }, icon("chevron")),
        h("span", { class: "run-group-name truncate" }, name),
        h("span", { class: "muted small" }, t("{n} koşum", { n: projectRuns.length }), " · ", t("{n} gün", { n: days.size })),
      ),
      ...[...days].map(([, dayRuns]) => h("section", { class: "run-day" },
        h("div", { class: "run-day-head" },
          h("span", {}, dayHeading(dayRuns[0].created_at)),
          h("span", { class: "muted small" }, t("{n} koşum", { n: dayRuns.length }), " · ", t("{n} case", { n: caseTotal(dayRuns) })),
        ),
        table(dayRuns),
      )),
    );
    group.addEventListener("toggle", () => (group.open ? collapsedProjects.delete(name) : collapsedProjects.add(name)));
    return group;
  }));
}

async function deleteRun(run, button) {
  if (!(await confirmAction({
    title: t("Koşum #{id} silinsin mi?", { id: run.id }),
    message: t('"{title}" koşumu ve yerel raporu kalıcı olarak silinir, geri alınamaz. TestRail\'deki run değişmez.', { title: runTitle(run) }),
  }))) return;
  await busy(button, async () => {
    try {
      await api(`/api/runs/${run.id}`, { method: "DELETE" });
      if (state.drawerRun === run.id) closeDrawer();
      toast(t("Koşum #{id} silindi.", { id: run.id }), "ok");
      await loadRuns();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

$("runs-refresh").addEventListener("click", (event) => busy(event.currentTarget, () => loadRuns()));
$("run-project").addEventListener("change", (event) => { state.runProject = event.target.value; loadRuns(true); });
$("run-scheduled-only").addEventListener("click", () => { state.runScheduledOnly = !state.runScheduledOnly; loadRuns(true); });

// Upcoming scheduled configurations on the runs screen, with the outcome of each one's latest scheduled run.
function renderSchedules(schedules) {
  $("run-schedules").hidden = !schedules.length;
  if (!schedules.length) return $("run-schedule-list").replaceChildren();
  const isAdmin = state.me.role === "admin";
  const upcoming = [...schedules].sort((a, b) => (Date.parse(a.next_at || "") || Infinity) - (Date.parse(b.next_at || "") || Infinity));
  $("run-schedule-list").replaceChildren(h("table", { class: "table schedule-table" },
    h("thead", {}, h("tr", {},
      h("th", {}, "Konfigürasyon"), h("th", { class: "hide-sm" }, "Platform"), h("th", {}, "Sıklık"),
      h("th", {}, "Sonraki koşum"), h("th", {}, "Son zamanlanmış koşum"), h("th", {}, h("span", { class: "sr-only" }, "İşlem")),
    )),
    h("tbody", {}, upcoming.map((item) => h("tr", {},
      h("td", {}, h("div", { class: "title" }, item.config_name), h("div", { class: "sub" }, item.client_name)),
      h("td", { class: "hide-sm" }, platform(item.platform)),
      h("td", {}, scheduleLabel(item.schedule)),
      h("td", {}, item.next_at
        ? h("div", {}, h("div", { class: "title" }, scheduleDate(item.next_at)), h("div", { class: "sub" }, untilText(item.next_at)))
        : h("span", { class: "muted" }, "Konfigürasyon pasif")),
      h("td", {}, item.last_run
        ? h("button", { type: "button", class: "btn ghost sm", title: t("Koşum #{id} ayrıntıları", { id: item.last_run.id }), onclick: () => openDrawer(item.last_run.id) },
          `#${item.last_run.id}`, badge(item.last_run.status, STATUS_LABEL[item.last_run.status] || item.last_run.status))
        : h("span", { class: "muted" }, "Henüz koşmadı")),
      h("td", { class: "right" }, isAdmin
        ? h("button", { type: "button", class: "btn ghost sm", onclick: () => editScheduledConfig(item.config_id) }, "Düzenle")
        : null),
    ))),
  ));
}

function untilText(value) {
  const minutes = Math.max(0, Math.round((Date.parse(value) - Date.now()) / 60000));
  if (minutes < 60) return t("{n} dk sonra", { n: minutes });
  if (Math.round(minutes / 60) < 24) return t("{n} sa sonra", { n: Math.round(minutes / 60) });
  return t("{n} gün sonra", { n: Math.round(minutes / 1440) });
}

async function editScheduledConfig(id) {
  try {
    await loadConfigs();
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  const config = state.configs.find((item) => item.id === id);
  if (config) openConfigDialog("edit", config);
}

/* ---------- Drawer ---------- */

let drawerTimer = null;
let drawerReturnFocus = null;

async function paintDrawer() {
  if (!state.drawerRun) return;
  try {
    const run = await api(`/api/runs/${state.drawerRun}`);
    $("drawer-title").textContent = t("Koşum #{id}", { id: run.id });
    $("drawer-body").replaceChildren(runCard(run, { expanded: true }));
    if (FINISHED.has(run.status)) { clearInterval(drawerTimer); drawerTimer = null; }
  } catch (err) {
    $("drawer-body").replaceChildren(h("p", { class: "notice error" }, err.message));
  }
}

function openDrawer(id) {
  drawerReturnFocus = document.activeElement;
  state.drawerRun = id;
  $("drawer-body").replaceChildren(h("p", { class: "muted" }, "Yükleniyor…"));
  $("drawer").hidden = false;
  $("drawer-scrim").hidden = false;
  $("drawer-close").focus();
  paintDrawer();
  clearInterval(drawerTimer);
  drawerTimer = setInterval(paintDrawer, 3000);
}

function closeDrawer() {
  clearInterval(drawerTimer);
  drawerTimer = null;
  state.drawerRun = null;
  $("drawer").hidden = true;
  $("drawer-scrim").hidden = true;
  drawerReturnFocus?.focus?.();
}

$("drawer-close").addEventListener("click", closeDrawer);
$("drawer-scrim").addEventListener("click", closeDrawer);

/* ---------- Configs ---------- */

const MOBILE_PLATFORMS = new Set(["android", "ios"]);
const POLICY_LABEL = { required: "Zorunlu", optional: "Opsiyonel", none: "Kapalı" };
const FILTER_LABEL = { userPackage: "Kullanıcı paketi", countryCode: "Ülke kodu", userType: "Kullanıcı tipi", frekans: "Frekans" };
const configDialog = { mode: "edit", config: null };

function splitList(text) {
  return String(text || "").split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function splitSerials(text) {
  return [...new Set(String(text || "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function storedSchedule(config) {
  try {
    const value = typeof config?.schedule_json === "string" ? JSON.parse(config.schedule_json || "{}") : config?.schedule_json || {};
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function scheduleLabel(schedule) {
  const every = Number(schedule.everyDays) || 1;
  const zone = schedule.timeZone && schedule.timeZone !== browserTimeZone() ? ` (${schedule.timeZone})` : "";
  const text = every === 1 ? t("Her gün {time}", { time: schedule.time })
    : every === 7 ? t("Haftada bir {time}", { time: schedule.time })
      : every === 14 ? t("2 haftada bir {time}", { time: schedule.time })
        : t("{n} günde bir {time}", { n: every, time: schedule.time });
  return text + zone;
}

function scheduleDate(value) {
  return new Date(value).toLocaleString(i18n.locale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Dialog preview in the browser's clock; the server computes the same slots in the schedule's time zone.
function previewNextRun(everyDays, time, startDate) {
  const [year, month, day] = String(startDate || "").split("-").map(Number);
  const [hour, minute] = String(time || "").split(":").map(Number);
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const now = Date.now();
  for (let index = 0; index < 5000; index += 1) {
    const slot = new Date(year, month - 1, day + index * everyDays, hour, minute);
    if (slot.getTime() > now) return slot;
  }
  return null;
}

function configMeta(config) {
  const serials = parseConfigList(config.device_serials);
  const lanes = config.plan.lanes || 1;
  return [
    t("{n} case", { n: config.plan.caseCount }),
    lanes > 1 ? t("{n} paralel", { n: lanes }) : t("Tek hat"),
    MOBILE_PLATFORMS.has(config.platform)
      ? (serials.length ? t("{n} UDID", { n: serials.length }) : config.device_filter ? t("Filtre: {filter}", { filter: config.device_filter }) : t("Farm'dan boş cihaz"))
      : null,
    t("Ortam: {environment}", { environment: config.environment }),
    parseConfigList(config.case_ids).length ? t("ID: {ids}", { ids: parseConfigList(config.case_ids).join(", ") }) : null,
    parseConfigList(config.case_tags).length ? t("Etiket: {tags}", { tags: parseConfigList(config.case_tags).join(", ") }) : null,
    storedSchedule(config).enabled
      ? (config.schedule_next_at
        ? t("Zamanlandı: {schedule} · sonraki {next}", { schedule: scheduleLabel(storedSchedule(config)), next: scheduleDate(config.schedule_next_at) })
        : t("Zamanlandı: {schedule} · konfigürasyon pasif", { schedule: scheduleLabel(storedSchedule(config)) }))
      : null,
  ].filter(Boolean);
}

async function renderConfigs() {
  const box = $("config-list");
  try {
    await loadConfigs();
  } catch (err) {
    box.replaceChildren(h("p", { class: "notice error" }, err.message));
    return;
  }
  const isAdmin = state.me.role === "admin";
  if (!state.configs.length) {
    box.replaceChildren(emptyState("Kayıtlı konfigürasyon yok", "İlk koşum planını ekle: platform, uygulama, cihazlar ve test kullanıcısı.",
      isAdmin ? h("button", { type: "button", class: "btn primary", onclick: () => openConfigDialog("create") }, "Yeni konfigürasyon") : null));
    return;
  }
  const groups = new Map();
  for (const config of state.configs) {
    if (!groups.has(config.client_name)) groups.set(config.client_name, []);
    groups.get(config.client_name).push(config);
  }
  box.replaceChildren(...[...groups].map(([client, configs]) => h("section", { class: "stack" },
    h("h2", {}, client, configs[0].suite_id ? h("span", { class: "muted small", style: "font-weight:400;margin-left:8px" }, `Suite ${configs[0].suite_id}`) : null),
    h("div", { class: "table-card" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Konfigürasyon ve plan"), h("th", {}, "Platform"), h("th", { class: "hide-sm" }, "Test kullanıcısı"), h("th", {}, "Durum"), h("th", {}, h("span", { class: "sr-only" }, "İşlem")))),
      h("tbody", {}, configs.map((config) => h("tr", {},
        h("td", {},
          h("div", { class: "title" }, config.name),
          h("div", { class: "plan-meta" }, configMeta(config).map((item) => h("span", {}, item))),
          config.plan.issues.length ? h("div", { class: "plan-issues" }, config.plan.issues.join(" · ")) : null,
          config.plan.warnings.length ? h("div", { class: "plan-warnings" }, config.plan.warnings.join(" · ")) : null,
        ),
        h("td", {}, platform(config.platform)),
        h("td", { class: "hide-sm" },
          h("div", { class: "title" }, config.account_policy === "none" ? "Kullanılmıyor" : config.account_source_name || "Seçilmedi"),
          h("div", { class: "sub" }, POLICY_LABEL[config.account_policy]),
        ),
        h("td", {}, badge(config.plan.ready ? "passed" : "blocked", config.plan.ready ? "Hazır" : "Eksik")),
        h("td", { class: "right" }, h("div", { class: "actions" },
          isAdmin ? h("button", { type: "button", class: "btn ghost sm", onclick: () => openConfigDialog("edit", config) }, "Düzenle") : null,
          isAdmin ? h("button", { type: "button", class: "btn ghost sm", title: "Bu satırı kopyalayıp yeni konfigürasyon aç", onclick: () => openConfigDialog("clone", config) }, icon("copy"), "Kopyala") : null,
          isAdmin ? h("button", {
            type: "button",
            class: "btn ghost sm",
            title: "Konfigürasyonu sil",
            onclick: async (event) => {
              const button = event.currentTarget;
              if (!(await confirmAction({ title: t("Konfigürasyon silinsin mi?"), message: t('"{name}" kalıcı olarak silinir, geri alınamaz. Geçmiş koşumlar korunur.', { name: config.name }) }))) return;
              await busy(button, async () => {
                try {
                  await api(`/api/configs/${config.id}`, { method: "DELETE" });
                  await renderConfigs();
                  toast(t("Konfigürasyon silindi."), "ok");
                } catch (err) {
                  toast(err.message, "error");
                }
              });
            },
          }, "Sil") : null,
          h("button", { type: "button", class: "btn secondary sm", disabled: !config.plan.ready, title: config.plan.issues.join(" · "), onclick: () => useCommand(commandFor(config)) }, icon("play"), "Chat'e al"),
        )),
      ))),
    )),
  )));
}

function dialogClient() {
  const value = $("config-client").value;
  if (value === "__new") return { id: null, name: $("config-client-name").value.trim(), suiteId: $("config-suite-id").value.trim(), projectId: "" };
  if (value.startsWith("tr:")) {
    const suite = (state.configOptions.suites || []).find((item) => `tr:${item.id}` === value);
    return { id: null, name: suite ? suiteProjectName(suite) : "", suiteId: suite?.id || "", projectId: suite?.project_id || "" };
  }
  const client = state.configOptions.clients.find((item) => String(item.id) === value);
  return { id: client?.id ?? null, name: client?.name || "", suiteId: "", projectId: "" };
}

// Single-suite TestRail projects call their only suite "Master", so the project name reads better; a name that
// would clash with another suite or an existing Mercury project gets the TestRail project as a prefix.
function suiteProjectName(suite) {
  const base = suite.suite_mode === 1 ? suite.project_name : suite.name;
  const others = (state.configOptions.suites || []).filter((item) => item.id !== suite.id)
    .map((item) => (item.suite_mode === 1 ? item.project_name : item.name));
  const taken = others.includes(base) || state.configOptions.clients.some((client) => client.name === base);
  return taken && base !== suite.project_name ? `${suite.project_name} · ${suite.name}` : base;
}

// TestRail suites that are not a Mercury project yet appear grouped by TestRail project; picking one creates the project on save.
function fillProjectOptions(selected) {
  const suites = (state.configOptions.suites || []).filter((item) => !item.client_id);
  const groups = new Map();
  for (const suite of suites) {
    if (!groups.has(suite.project_id)) groups.set(suite.project_id, { name: suite.project_name, suites: [] });
    groups.get(suite.project_id).suites.push(suite);
  }
  $("config-client").replaceChildren(...[
    state.configOptions.clients.length ? h("optgroup", { label: "Mercury projeleri" },
      state.configOptions.clients.map((item) => h("option", { value: item.id }, item.suite_id ? `${item.name} · Suite ${item.suite_id}` : item.name))) : null,
    ...[...groups.values()].map((group) => h("optgroup", { label: `TestRail'den ekle · ${group.name}` },
      group.suites.map((item) => h("option", { value: `tr:${item.id}` }, `${suiteProjectName(item)} · Suite ${item.id}`)))),
    h("option", { value: "__new" }, "+ Yeni proje…"),
  ].filter(Boolean));
  $("config-client").value = selected;
}

let suiteRequest = 0;
async function loadTestrailSuites(mode) {
  const ticket = ++suiteRequest;
  const help = $("config-client-help");
  help.textContent = t("TestRail suite'leri yükleniyor…");
  let response;
  try {
    response = await api("/api/settings/testrail-suites");
  } catch {
    response = { suites: [], reason: "" };
  }
  if (ticket !== suiteRequest || !$("config-dialog").open) return;
  state.configOptions.suites = response.suites;
  const fresh = response.suites.filter((item) => !item.client_id);
  let selected = $("config-client").value;
  if (mode !== "edit" && selected === "__new" && !$("config-client-name").value.trim() && fresh.length) selected = `tr:${fresh[0].id}`;
  fillProjectOptions(selected);
  const projectCount = new Set(fresh.map((item) => item.project_id)).size;
  help.textContent = response.reason
    ? (/eksik/.test(response.reason) ? t("TestRail bağlanırsa suite'leri burada listelenir (Ayarlar → TestRail).") : t("TestRail suite'leri alınamadı: {reason}", { reason: response.reason }))
    : fresh.length ? t('{projects} TestRail projesinden {suites} suite "TestRail\'den ekle" altında; seçip kaydedince proje olarak eklenir.', { projects: projectCount, suites: fresh.length }) : t("TestRail'deki tüm suite'ler proje olarak ekli.");
  fillAccountSources($("config-account-source").value);
  paintConfigDialog();
}

const DEVICE_STATE = { free: "Boş", busy: "Kullanımda", offline: "Çevrimdışı" };
let farmDevices = { list: null, reason: "", platform: null };
let deviceRequest = 0;

async function loadFarmDevices() {
  const ticket = ++deviceRequest;
  let response;
  try {
    response = await api("/api/settings/farm-devices");
  } catch (err) {
    response = { devices: [], reason: err.message };
  }
  if (ticket !== deviceRequest || !$("config-dialog").open) return;
  farmDevices = { list: response.devices, reason: response.reason || "", platform: null };
  syncFarmDevices();
}

// `click` runs before the form's input/change listeners re-sync the boxes from the textarea.
function toggleSerial(serial, on) {
  const serials = splitSerials($("config-serials").value).filter((item) => item !== serial);
  if (on) serials.push(serial);
  $("config-serials").value = serials.join("\n");
}

function farmDeviceHelp(devices, selected) {
  if (farmDevices.list === null) return t("Farm cihazları yükleniyor…");
  if (farmDevices.reason) {
    return /eksik/.test(farmDevices.reason)
      ? t("Mercury Farm bağlanırsa cihazlar burada listelenir (Ayarlar → Mercury Farm).")
      : t("Farm cihazları alınamadı: {reason}", { reason: farmDevices.reason });
  }
  const label = PLATFORM[$("config-platform").value]?.[0] || "";
  if (!devices.length) return t("Farm'da bu hesabın kullanabileceği {platform} cihaz yok.", { platform: label });
  const free = devices.filter((device) => device.state === "free").length;
  const unknown = [...selected].filter((serial) => !devices.some((device) => device.serial === serial));
  return [
    t("{count} {platform} cihaz, {free} boş. İşaretlediğin cihazın UDID'si listeye eklenir, kaldırınca çıkar.", { count: devices.length, platform: label, free }),
    unknown.length ? t("Farm'da bulunamayan UDID: {serials}", { serials: unknown.join(", ") }) : "",
  ].filter(Boolean).join(" ");
}

// Rebuilds the picker only when the platform or device list changes, so a click never loses focus.
function syncFarmDevices() {
  const platformValue = $("config-platform").value;
  if (!MOBILE_PLATFORMS.has(platformValue)) return;
  const selected = new Set(splitSerials($("config-serials").value));
  const devices = (farmDevices.list || []).filter((device) => device.platform === platformValue);
  if (farmDevices.platform !== platformValue) {
    farmDevices.platform = farmDevices.list === null ? null : platformValue;
    $("config-farm-devices").replaceChildren(...devices.map((device) => h("label", { class: "device-option", title: `${device.name} · ${device.serial}` },
      h("input", { type: "checkbox", value: device.serial, onclick: (event) => toggleSerial(device.serial, event.currentTarget.checked) }),
      h("span", { class: "meta" },
        h("strong", {}, device.name),
        h("span", {}, [device.version ? `${PLATFORM[device.platform][0]} ${device.version}` : "", device.serial].filter(Boolean).join(" · ")),
      ),
      h("span", { class: `device-state ${device.state}` }, DEVICE_STATE[device.state]),
    )));
  }
  for (const input of $("config-farm-devices").querySelectorAll("input")) input.checked = selected.has(input.value);
  $("config-farm-help").textContent = farmDeviceHelp(devices, selected);
}

function fillAccountSources(selected) {
  const { id } = dialogClient();
  const sources = state.configOptions.sources.filter((item) => item.client_id === null || item.client_id === id);
  $("config-account-source").replaceChildren(
    h("option", { value: "" }, sources.length ? "Kaynak seç" : "Kaynak yok — Ayarlar'dan ekle"),
    ...sources.map((item) => h("option", { value: item.id },
      `${item.name}${item.client_id === null ? t(" · ortak") : ""}${item.type === "manual" ? t(" · liste") : ""}${item.ready ? "" : t(" · eksik")}`)),
  );
  $("config-account-source").value = sources.some((item) => String(item.id) === String(selected)) ? String(selected) : "";
}

// Blank filter inputs keep the source default; only typed values override it for this configuration.
function renderAccountFilters(values = {}) {
  const source = state.configOptions.sources.find((item) => String(item.id) === $("config-account-source").value);
  const fields = source?.filters || [];
  const box = $("config-account-filters");
  box.replaceChildren(...fields.map((field) => h("div", { class: "field" },
    h("label", { for: `af-${field.key}` }, FILTER_LABEL[field.key] || field.key),
    h("input", { id: `af-${field.key}`, "data-filter": field.key, value: values[field.key] ?? "", placeholder: field.default || "boş = tümü", autocomplete: "off" }),
    h("p", { class: "field-help" }, t("Kaynak varsayılanı: {value}", { value: field.default || t("yok") })),
  )));
  box.hidden = !fields.length || $("config-account-policy").value === "none";
}

function accountFilterValues() {
  return Object.fromEntries([...$("config-account-filters").querySelectorAll("[data-filter]")]
    .map((input) => [input.dataset.filter, input.value.trim()])
    .filter(([, value]) => value));
}

function paintConfigDialog() {
  const platformValue = $("config-platform").value;
  const mobile = MOBILE_PLATFORMS.has(platformValue);
  document.querySelectorAll("#config-form [data-for]").forEach((node) => {
    node.hidden = !(node.dataset.for === platformValue || (node.dataset.for === "mobile" && mobile));
  });
  $("config-new-client").hidden = $("config-client").value !== "__new";
  $("config-account-filters").hidden = !$("config-account-filters").children.length || $("config-account-policy").value === "none";

  const client = dialogClient();
  const cases = state.configOptions.cases.filter((item) => !item.client || item.client === client.name);
  const ids = splitList($("config-case-ids").value);
  const tags = splitList($("config-case-tags").value).map((tag) => tag.toLocaleLowerCase(lowerLocale()));
  const caseCount = ids.length
    ? cases.filter((item) => ids.includes(item.id)).length
    : tags.length ? cases.filter((item) => (item.tags || []).some((tag) => tags.includes(tag.toLocaleLowerCase(lowerLocale())))).length : cases.length;
  const parallel = Math.max(1, Math.min(20, Math.trunc(Number($("config-parallel").value)) || 1));
  const serials = mobile ? splitSerials($("config-serials").value) : [];
  const pool = serials.length ? Math.min(parallel, serials.length) : parallel;
  const lanes = Math.max(1, Math.min(pool, caseCount || 1));
  const limit = state.configOptions.limits?.[platformValue];
  const policy = $("config-account-policy").value;

  const problems = [];
  if (!caseCount) problems.push(t("Kapsamla eşleşen case yok"));
  if (mobile && serials.length && parallel > serials.length) problems.push(t("{parallel} paralel için {parallel} UDID gerekir, {count} girildi", { parallel, count: serials.length }));
  const target = platformValue === "web" ? t("{n} tarayıcı", { n: lanes })
    : mobile ? (serials.length ? t("{lanes} cihaz · {count} UDID havuzu", { lanes, count: serials.length }) : t("{lanes} cihaz · {target}", { lanes, target: $("config-device-filter").value.trim() ? t('filtre "{filter}"', { filter: $("config-device-filter").value.trim() }) : t("Farm'dan boş") }))
      : "yürütücü yok";
  const chips = [
    t("{n} case", { n: caseCount }),
    t("{n} paralel hat", { n: lanes }),
    caseCount ? t("hat başına en fazla {n} case", { n: Math.ceil(caseCount / lanes) }) : null,
    target,
    policy === "none" ? "test kullanıcısı yok" : t("{n} test kullanıcısı ({policy})", { n: lanes, policy: t(POLICY_LABEL[policy]).toLocaleLowerCase(lowerLocale()) }),
  ].filter(Boolean);
  const notes = [];
  if (lanes < parallel && !(mobile && serials.length && parallel > serials.length) && caseCount) notes.push(t("{cases} case olduğu için {lanes} hat kullanılır", { cases: caseCount, lanes }));
  if (limit && lanes > limit) notes.push(t("Bu sunucuda aynı anda en fazla {limit} tarayıcı açılır (Ayarlar → Genel); bu koşum en fazla {lanes} hatla koşar", { limit, lanes: limit }));
  $("config-summary").replaceChildren(...[
    h("div", { class: "chips" }, chips.map((chip) => h("span", { class: "chip" }, chip))),
    problems.length ? h("p", { class: "plan-issues" }, problems.join(" · ")) : null,
    notes.length ? h("p", { class: "plan-warnings" }, notes.join(" · ")) : null,
  ].filter(Boolean));
  $("config-serials-help").textContent = serials.length
    ? t("{count} UDID girildi. {parallel} paralel hat için {parallel} tanesi aynı anda kullanılır{spare}.", { count: serials.length, parallel, spare: serials.length > parallel ? t(", {n} tanesi yedek", { n: serials.length - parallel }) : "" })
    : t("Girilirse yalnız bu cihazlar kullanılır. Boşsa filtreye uyan (veya herhangi) boş Farm cihazı alınır.");
  const scheduled = $("config-schedule-enabled").checked;
  $("config-schedule-fields").hidden = !scheduled;
  const next = scheduled ? previewNextRun(Number($("config-schedule-every").value) || 1, $("config-schedule-time").value, $("config-schedule-start").value) : null;
  $("config-schedule-help").textContent = !scheduled
    ? t("Kapalı. Açarsan bu konfigürasyon seçtiğin saatte kendiliğinden koşar; sonuçlar Koşumlar ekranında görünür.")
    : !next ? t("Saat ve ilk günü seç.")
      : !$("config-enabled").checked ? t("Konfigürasyon pasif olduğu için zamanlanmış koşum başlamaz.")
        : t("Sonraki koşum: {next}. Önceki zamanlanmış koşum hâlâ sürüyorsa o sıra atlanır.", { next: scheduleDate(next) });
  const credentials = $("config-account-credentials");
  const selectedSource = state.configOptions.sources.find((item) => String(item.id) === $("config-account-source").value);
  credentials.hidden = policy === "none" || !selectedSource || selectedSource.ready;
  if (!credentials.hidden) {
    credentials.className = policy === "required" ? "notice error" : "notice";
    credentials.replaceChildren(t('"{name}" kaynağında {issue}; kullanıcı alınamaz. ', { name: selectedSource.name, issue: selectedSource.issue }),
      h("a", { href: "#/settings", onclick: () => $("config-dialog").close() }, "Ayarlar → Test hesap kaynakları"));
  }
  syncFarmDevices();
}

async function openConfigDialog(mode, config = null) {
  try {
    state.configOptions = await api("/api/config-options");
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  Object.assign(configDialog, { mode, config });
  const base = config || { platform: "web", environment: "test", parallel: 1, enabled: 1, regression: 0, account_policy: "none" };
  $("config-dialog-title").textContent = t({ create: "Yeni konfigürasyon", clone: "Konfigürasyonu kopyala", edit: "Konfigürasyonu düzenle" }[mode]);
  $("config-dialog-client").textContent = mode === "clone"
    ? t("{name} satırından kopyalanıyor. Takma adlar boş bırakıldı; chat'in iki satırı karıştırmaması için yenilerini yaz.", { name: config.name })
    : mode === "edit" ? `${config.client_name} · ${PLATFORM[config.platform]?.[0] || config.platform}` : t("Platform, uygulama, cihazlar, paralellik ve test kullanıcısını tek yerde ayarla.");
  state.configOptions.suites = [];
  fillProjectOptions(base.client_id ? String(base.client_id) : String(state.configOptions.clients[0]?.id ?? "__new"));
  $("config-client").disabled = false;
  $("config-client-name").value = "";
  $("config-suite-id").value = "";
  $("config-platform").value = base.platform;
  $("config-name").value = mode === "clone" ? `${base.name} (kopya)` : base.name || "";
  $("config-environment").value = base.environment || "test";
  $("config-aliases").value = mode === "clone" ? "" : parseAliases(base).join(", ");
  $("config-enabled").checked = base.enabled !== 0;
  $("config-regression").checked = Boolean(base.regression);
  $("config-launch-url").value = base.launch_url || "";
  $("config-package-id").value = base.package_id || "";
  $("config-app-url").value = base.app_url || "";
  $("config-parallel").value = base.parallel || 1;
  $("config-device-filter").value = base.device_filter || "";
  $("config-device-wait").value = base.device_wait_minutes || 30;
  $("config-serials").value = parseConfigList(base.device_serials).join("\n");
  $("config-account-policy").value = base.account_policy || "none";
  fillAccountSources(base.account_source_id);
  let filters = {};
  try { filters = typeof base.account_filters === "string" ? JSON.parse(base.account_filters || "{}") : base.account_filters || {}; } catch { filters = {}; }
  renderAccountFilters(filters);
  $("config-case-ids").value = parseConfigList(base.case_ids).join(", ");
  $("config-case-tags").value = parseConfigList(base.case_tags).join(", ");
  // A copy starts unscheduled so the same plan is not started twice at the same time by accident.
  const schedule = mode === "clone" ? {} : storedSchedule(base);
  const today = new Date();
  $("config-schedule-enabled").checked = Boolean(schedule.enabled);
  $("config-schedule-every").value = String(schedule.everyDays || 1);
  if (!$("config-schedule-every").value) $("config-schedule-every").value = "1";
  $("config-schedule-time").value = schedule.time || "09:00";
  $("config-schedule-start").value = schedule.startDate
    || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  configDialog.timeZone = schedule.enabled && schedule.timeZone ? schedule.timeZone : browserTimeZone();
  $("config-form-result").hidden = true;
  $("config-save").textContent = t(mode === "edit" ? "Kaydet" : "Oluştur");
  farmDevices = { list: null, reason: "", platform: null };
  $("config-farm-devices").replaceChildren();
  paintConfigDialog();
  $("config-dialog").showModal();
  $("config-name").focus();
  if (mode === "clone") $("config-name").select();
  loadTestrailSuites(mode);
  loadFarmDevices();
}

function closeConfigDialog() {
  $("config-dialog").close();
}

$("config-new").addEventListener("click", () => openConfigDialog("create"));
$("config-dialog-close").addEventListener("click", closeConfigDialog);
$("config-cancel").addEventListener("click", closeConfigDialog);
$("config-client").addEventListener("change", () => {
  fillAccountSources("");
  renderAccountFilters();
  paintConfigDialog();
  if ($("config-client").value === "__new") $("config-client-name").focus();
});
$("config-account-source").addEventListener("change", () => { renderAccountFilters(); paintConfigDialog(); });
$("config-form").addEventListener("input", paintConfigDialog);
$("config-form").addEventListener("change", paintConfigDialog);
$("config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = $("config-form-result");
  result.hidden = true;
  if (!$("config-name").value.trim()) {
    $("config-name").setAttribute("aria-invalid", "true");
    $("config-name").focus();
    return;
  }
  $("config-name").removeAttribute("aria-invalid");
  const client = dialogClient();
  const { mode, config } = configDialog;
  const body = {
    clientId: client.id,
    client: client.name,
    suiteId: client.suiteId,
    projectId: client.projectId,
    cloneOf: mode === "clone" ? config.id : undefined,
    name: $("config-name").value,
    platform: $("config-platform").value,
    environment: $("config-environment").value,
    aliases: splitList($("config-aliases").value),
    enabled: $("config-enabled").checked,
    regression: $("config-regression").checked,
    launchUrl: $("config-launch-url").value,
    packageId: $("config-package-id").value,
    appUrl: $("config-app-url").value,
    parallel: Number($("config-parallel").value) || 1,
    deviceFilter: $("config-device-filter").value,
    deviceWaitMinutes: Number($("config-device-wait").value) || 30,
    deviceSerials: splitSerials($("config-serials").value),
    accountSourceId: $("config-account-source").value || null,
    accountPolicy: $("config-account-policy").value,
    accountFilters: accountFilterValues(),
    caseIds: splitList($("config-case-ids").value),
    caseTags: splitList($("config-case-tags").value),
    schedule: {
      enabled: $("config-schedule-enabled").checked,
      everyDays: Number($("config-schedule-every").value) || 1,
      time: $("config-schedule-time").value,
      startDate: $("config-schedule-start").value,
      timeZone: configDialog.timeZone || browserTimeZone(),
    },
  };
  await busy($("config-save"), async () => {
    try {
      if (mode === "edit") await api(`/api/configs/${config.id}`, { method: "PUT", body });
      else await api("/api/configs", { method: "POST", body });
      closeConfigDialog();
      await renderConfigs();
      toast(t({ edit: "Konfigürasyon güncellendi.", create: "Konfigürasyon oluşturuldu.", clone: "Kopya oluşturuldu." }[mode]), "ok");
    } catch (err) {
      result.className = "notice error";
      result.textContent = err.message;
      result.hidden = false;
      result.scrollIntoView({ block: "nearest" });
    }
  });
});

/* ---------- Settings ---------- */

const SECTIONS = [
  {
    id: "testrail",
    title: "TestRail",
    lead: "Her koş komutu, Mercury projesinin bağlı olduğu TestRail projesinde yeni bir run açar. Eski run'a yazılmaz.",
    test: { path: "/api/settings/testrail-test", label: "Bağlantıyı dene" },
    fields: [
      ["testrail_host", "Host", "url", "https://firma.testrail.io"],
      ["testrail_user", "E-posta", "email"],
      ["testrail_api_key", "API anahtarı", "password"],
      ["testrail_project_id", "TestRail projesi", "text", "", "Bağlantıyı deneyince TestRail'deki projeler burada listelenir."],
    ],
  },
  {
    id: "farm",
    title: "Mercury Farm",
    lead: "Android ve iOS testleri yalnız Farm'daki cihazlarda koşar. Midscene cihazı Farm üzerinden sürer; bu sunucuda telefon gerekmez.",
    note: "'Bağlantıyı dene' Farm erişimini doğrular ve bu sunucunun ADB anahtarını Farm'a kaydeder. Android cihazlar bu anahtar olmadan bağlantıyı reddeder.",
    test: { path: "/api/settings/farm-test", label: "Bağlantıyı dene" },
    fields: [
      ["farm_base_url", "Mercury Farm adresi", "url", "https://farm.firma.local", "Farm arayüzünün kök adresi (/#/ olmadan)."],
      ["farm_token", "Mercury Farm erişim anahtarı", "password", "", "Farm → Settings → Keys → Access Tokens altında oluşturulur."],
    ],
  },
  {
    id: "general",
    title: "Genel",
    lead: "Bu sunucunun kapasitesi ve adresleri. Projeye göre paralellik ve cihaz bekleme süresi her konfigürasyonda ayrıca ayarlanır.",
    note: "Kaç hatta koşulacağı konfigürasyondan gelir (bir projede 1, diğerinde 4 olabilir). Buradaki sınır, tüm projeler ve kullanıcılar birlikte koşarken bu makinenin kaldırabileceği toplam tarayıcı sayısıdır. Android/iOS için sınır yoktur: Farm'daki boş cihazlar ve konfigürasyondaki UDID havuzu belirler.",
    fields: [
      ["web_concurrency", "Bu sunucuda aynı anda açık en fazla tarayıcı", "number", "Otomatik", "Boş bırakılırsa bu makinenin RAM ve işlemcisine göre otomatik hesaplanır (hat başına ~1 GB). Tüm web koşumlarının toplamıdır; dolunca yeni koşumlar sırada bekler ve boşalan hatlar bekleyen kullanıcılar arasında sırayla paylaştırılır. Makine yavaşlarsa daha küçük bir sayı yaz."],
      ["public_base_url", "Raporların açılacağı dış adres (opsiyonel)", "url", "http://mercury.ofis.local:8080", "TestRail'e yazılan rapor bağlantılarının açılacağı Mercury adresi. Yalnız bu bilgisayarda kullanıyorsan boş bırak."],
      ["update_manifest_url", "Yeni sürüm kontrol adresi (opsiyonel)", "url", "https://sunucu/mercury-version.json", "Kurumsal güncelleme sunucunuz varsa sürüm JSON adresini yaz. Yoksa boş bırak; testler çalışmaya devam eder."],
    ],
  },
];

function inputField(name, label, type, value, placeholder, help) {
  const id = `f-${name}`;
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    h("input", {
      id, name, type: type === "url" ? "text" : type, value: value ?? "", placeholder,
      autocomplete: type === "password" ? "new-password" : "off",
      inputmode: type === "url" ? "url" : type === "number" ? "numeric" : undefined,
      min: type === "number" ? "1" : undefined,
      "aria-describedby": help ? `${id}-help` : undefined,
    }),
    help ? h("p", { class: "field-help", id: `${id}-help` }, help) : null,
  );
}

function sectionHeader(title, lead, extra) {
  return h("header", { style: "display:flex;gap:12px;justify-content:space-between;align-items:flex-start" },
    h("div", {}, h("h2", {}, title), h("p", {}, lead)), extra || null);
}

// Swaps the free-text project id for a list of the account's TestRail projects; an id not in the list is kept.
// "Tüm projeler" (empty) lists every project's suites in the configuration dialog.
function testrailProjectPicker(form, projects) {
  const field = form.elements.testrail_project_id;
  if (!field || !projects?.length) return;
  const current = field.value;
  const select = h("select", { id: field.id, name: field.name, "aria-describedby": field.getAttribute("aria-describedby") },
    h("option", { value: "" }, t("Tüm projeler ({n})", { n: projects.length })),
    projects.map((project) => h("option", { value: project.id }, `${project.name} · #${project.id}`)),
    current && !projects.some((project) => project.id === current) ? h("option", { value: current }, `#${current} (listede yok)`) : null,
  );
  select.value = current;
  field.replaceWith(select);
  const help = form.querySelector(`#${field.id}-help`);
  const paintHelp = () => {
    if (help) help.textContent = select.value
      ? t("Konfigürasyonda yalnız bu projenin suite'leri listelenir; TestRail projesi olmayan Mercury projeleri de burada run açar.")
      : t("Konfigürasyonda tüm TestRail projelerinin suite'leri listelenir; her Mercury projesi seçtiği suite'in projesinde run açar.");
  };
  select.addEventListener("change", paintHelp);
  paintHelp();
}

function settingsCard(section, data) {
  const result = h("span", { class: "result", role: "status" });
  const form = h("form", { class: "card", id: `s-${section.id}`, novalidate: true },
    h("div", { class: "card-body" },
      sectionHeader(section.title, section.lead),
      section.note ? h("div", { class: "settings-note" }, icon("check"), h("p", {}, section.note)) : null,
      h("div", { class: "grid-2" }, section.fields.map(([name, label, type, placeholder, help]) => inputField(name, label, type, data[name], name === "web_concurrency" && data.web_concurrency_auto ? t("Otomatik ({n})", { n: data.web_concurrency_auto }) : placeholder, help))),
    ),
    h("div", { class: "card-foot" },
      result,
      section.test ? h("button", { type: "button", class: "btn secondary", "data-test": "" }, section.test.label) : null,
      h("button", { type: "submit", class: "btn primary" }, "Kaydet"),
    ),
  );
  const save = async () => {
    const fresh = await api("/api/settings", { method: "PUT", body: Object.fromEntries(new FormData(form)) });
    for (const [name] of section.fields) if (form.elements[name]) form.elements[name].value = fresh[name] ?? "";
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(form.querySelector("button[type=submit]"), async () => {
      try {
        await save();
        result.className = "result";
        result.textContent = "";
        toast(`${section.title} kaydedildi.`, "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
  form.querySelector("[data-test]")?.addEventListener("click", (event) => busy(event.currentTarget, async () => {
    result.textContent = "";
    try {
      await save();
      const response = await api(section.test.path, { method: "POST" });
      const adbNote = {
        registered: t(" · ADB anahtarı Farm'a kaydedildi"),
        exists: t(" · ADB anahtarı Farm'da kayıtlı"),
        missing: t(" · Bu sunucuda ADB yok, Android koşamaz"),
      }[response.adbKey] ?? (String(response.adbKey || "").startsWith("failed") ? t(" · ADB anahtarı kaydedilemedi: {message}", { message: response.adbKey.slice(8) }) : "");
      let projectNote = "";
      if (response.projects) {
        testrailProjectPicker(form, response.projects);
        projectNote = t(" · {n} TestRail projesi bulundu", { n: response.projects.length });
      }
      result.className = response.adbKey === "missing" || String(response.adbKey || "").startsWith("failed") ? "result error" : "result ok";
      result.textContent = t("Bağlantı başarılı") + adbNote + projectNote;
    } catch (err) {
      result.className = "result error";
      result.textContent = err.message;
    }
  }));
  if (section.id === "testrail" && data.testrail_host && data.testrail_user && data.testrail_api_key) {
    api("/api/settings/testrail-projects").then((response) => testrailProjectPicker(form, response.projects)).catch(() => {});
  }
  return form;
}

const FAMILY_SOURCE_HINT = "Bu liste sağlayıcının modelleri değil; kurulu Midscene sürümünün tanıdığı model aileleridir. Midscene ekrandaki öğenin yerini modelin cevabından aileye göre okur, bu yüzden seçtiğin model gerçekten bu ailelerden birinden olmalı.";

function familyName(families, id) {
  const found = (families || []).find((family) => family.id === id);
  return found && found.label !== id ? `${found.label} · ${id}` : id;
}

function familySelectFor(id, families, detected) {
  return h("select", { id, name: "midscene_model_family" },
    h("option", { value: "" }, detected ? t("Otomatik: {family}", { family: familyName(families, detected) }) : "Otomatik: model adından algılanamadı"),
    (families || []).map((family) => h("option", { value: family.id }, familyName(families, family.id))),
  );
}

function modelCard(settings) {
  const card = h("section", { class: "card", id: "s-model" });
  const status = state.model || {};

  const renderSummary = () => {
    const ms = status.midscene || {};
    const familySelect = familySelectFor("f-midscene-family", ms.families, ms.detectedFamily);
    familySelect.value = ms.familySetting || "";
    let familyWarning = "";
    if (ms.familySetting && !ms.detectedFamily) {
      familyWarning = t('"{model}" adından aile anlaşılmıyor; elle seçilen {family} kullanılıyor. Yönlendirici takma adları (ör. auto/…) her istekte başka modele gidebilir ve Midscene yanlış okur. Aşağıdan "Modeli değiştir" ile Midscene uyumlu listeden sabit bir model seçmen önerilir.', { model: status.modelName, family: ms.familySetting });
    } else if (ms.familySetting && ms.familySetting !== ms.detectedFamily) {
      familyWarning = t("Elle seçilen aile ({selected}) model adından algılanandan ({detected}) farklı. Emin değilsen Otomatik bırak.", { selected: ms.familySetting, detected: ms.detectedFamily });
    }
    const saveFamily = h("button", { type: "button", class: "btn secondary" }, "Kaydet");
    saveFamily.addEventListener("click", () => busy(saveFamily, async () => {
      try {
        await api("/api/settings", { method: "PUT", body: { midscene_model_family: familySelect.value } });
        toast(t("Midscene model ailesi kaydedildi."), "ok");
        await refreshModel();
        Object.assign(status, state.model);
        renderSummary();
      } catch (err) {
        toast(err.message, "error");
      }
    }));
    const stateBadge = !status.ready ? badge("pending", "Bağlı değil") : ms.error ? badge("blocked", "Midscene hazır değil") : badge("active", "Bağlı");
    card.replaceChildren(
      h("div", { class: "card-body" },
        sectionHeader("Model", t("Midscene {version} ekran sürüşü ve chat agent'ı aynı model kaydını kullanır.", { version: ms.version || t("kurulu değil") }), stateBadge),
        status.ready
          ? h("dl", { class: "kv" },
            h("dt", {}, "Sağlayıcı"), h("dd", {}, status.providerLabel || status.provider),
            h("dt", {}, "Model"), h("dd", {}, status.modelName),
            h("dt", {}, "Adres"), h("dd", {}, status.baseUrl || "—"),
            status.keyMask ? [h("dt", {}, "Anahtar"), h("dd", {}, status.keyMask)] : null,
            h("dt", {}, "Midscene ailesi"), h("dd", {}, ms.family ? `${familyName(ms.families, ms.family)}${ms.familySetting ? t(" (elle)") : t(" (otomatik)")}` : "—"),
          )
          : h("p", { class: "muted" }, "Henüz model bağlanmadı. Web koşumları bu durumda engellenir."),
        status.ready && ms.error ? h("p", { class: "notice error", role: "alert" }, ms.error) : null,
        status.ready && !ms.error && familyWarning ? h("p", { class: "notice warn", role: "status" }, familyWarning) : null,
        status.ready
          ? h("div", { class: "field" },
            h("label", { for: "f-midscene-family" }, "Midscene model ailesi"),
            h("div", { class: "inline-form" }, familySelect, saveFamily),
            h("p", { class: "hint" }, t("{hint} Otomatik, bağlı modelin adından algılar.", { hint: t(FAMILY_SOURCE_HINT) })))
          : null,
      ),
      h("div", { class: "card-foot" }, h("button", { type: "button", class: "btn primary", onclick: renderConnect }, status.ready ? "Modeli değiştir" : "Model bağla")),
    );
  };

  const renderConnect = async () => {
    try {
      if (!state.providers.length) state.providers = await api("/api/providers");
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const list = state.providers;
    const select = h("select", { id: "f-provider", name: "provider" });
    for (const group of [...new Set(list.map((item) => item.group))]) {
      select.append(h("optgroup", { label: group }, list.filter((row) => row.group === group).map((item) => h("option", { value: item.id }, item.label))));
    }
    select.value = settings.model_provider || list[0]?.id || "";
    const fields = h("div", { class: "grid-2" });
    const hint = h("p", { class: "hint" });
    const models = h("div", { class: "model-picker", hidden: true });
    const error = h("p", { class: "notice error", role: "alert", hidden: true });
    const listButton = h("button", { type: "button", class: "btn secondary" }, "Modelleri getir");
    const manual = h("div", { class: "field" },
      h("label", { for: "f-model" }, "Model adı"),
      h("div", { class: "inline-form" },
        h("input", { id: "f-model", name: "model", type: "text", value: settings.model_name || "", placeholder: "listeden seç veya elle yaz", autocomplete: "off" }),
        listButton,
      ),
    );
    const ms = status.midscene || {};
    const knownFamily = new Map(settings.model_name ? [[settings.model_name, ms.detectedFamily || ""]] : []);
    const familySelect = familySelectFor("f-connect-family", ms.families, "");
    const familyWarn = h("p", { class: "notice warn", role: "status", hidden: true });
    const familyField = h("div", { class: "field" },
      h("label", { for: "f-connect-family" }, "Midscene model ailesi"),
      familySelect,
      h("p", { class: "hint" }, FAMILY_SOURCE_HINT),
      familyWarn,
    );
    const paintFamily = () => {
      const name = form.elements.model.value.trim();
      const detected = knownFamily.has(name) ? knownFamily.get(name) : undefined;
      familySelect.options[0].textContent = detected
        ? t("Otomatik: {family}", { family: familyName(ms.families, detected) })
        : detected === "" ? t("Otomatik: model adından algılanamadı") : t("Otomatik: kaydedince model adından algılanır");
      familyWarn.hidden = !(name && detected === "" && !familySelect.value);
      familyWarn.textContent = t('"{name}" Midscene\'ın tanıdığı bir aileye ait görünmüyor; bu modelle web ve mobil koşumlar engellenir. Listeden Midscene uyumlu bir model seç ya da modelin gerçek ailesini biliyorsan yukarıdan seç.', { name });
    };
    const form = h("form", { class: "card", id: "s-model", novalidate: true },
      h("div", { class: "card-body" },
        sectionHeader(status.ready ? "Modeli değiştir" : "Model bağla", "Sağlayıcıyı seç, anahtarı yaz, modelleri getir ve Midscene uyumlu birini kullan. Ekran sürüşü ve chat agent'ı bu tek modeli paylaşır."),
        h("div", { class: "field" }, h("label", { for: "f-provider" }, "Sağlayıcı"), select),
        fields, hint, manual, models, familyField, error,
      ),
      h("div", { class: "card-foot" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { form.replaceWith(card); renderSummary(); } }, "Vazgeç"),
        h("button", { type: "submit", class: "btn primary" }, "Bu modeli kullan"),
      ),
    );
    familySelect.value = ms.familySetting || "";
    familySelect.addEventListener("change", paintFamily);
    form.elements.model.addEventListener("input", paintFamily);
    paintFamily();

    const paint = () => {
      const provider = list.find((item) => item.id === select.value) || list[0];
      if (!provider) return;
      hint.textContent = provider.hint || "";
      const same = settings.model_provider === provider.id;
      if (provider.auth === "bedrock-iam") {
        fields.replaceChildren(
          inputField("region", "Bölge", "text", settings.model_region || "us-east-1"),
          inputField("awsAccessKey", "Access key", "password", same ? settings.model_aws_access_key : ""),
          inputField("awsSecret", "Secret", "password", same ? settings.model_aws_secret : ""),
          inputField("awsSession", "Session token", "password", same ? settings.model_aws_session : ""),
        );
        return;
      }
      fields.replaceChildren(
        inputField("baseUrl", "Adres", "url", same && settings.model_base_url ? settings.model_base_url : provider.base),
        inputField("apiKey", provider.keyOptional ? "API anahtarı (isteğe bağlı)" : "API anahtarı", "password", same ? settings.model_api_key : ""),
      );
      if (provider.auth === "azure") fields.append(inputField("azureApiVersion", "API sürümü", "text", settings.model_azure_api_version || "2024-10-21"));
      if (provider.auth === "bedrock-key") fields.append(inputField("region", "Bölge", "text", settings.model_region || "us-east-1"));
    };
    const payload = () => {
      const data = Object.fromEntries(new FormData(form));
      return {
        provider: data.provider,
        apiKey: data.apiKey || "",
        baseUrl: data.baseUrl || "",
        region: data.region || "",
        awsAccessKey: data.awsAccessKey || "",
        awsSecret: data.awsSecret || "",
        awsSession: data.awsSession || "",
        azureApiVersion: data.azureApiVersion || "",
      };
    };
    select.addEventListener("change", () => { models.replaceChildren(); models.hidden = true; paint(); });
    paint();

    const pick = (item) => {
      form.elements.model.value = item.id;
      familySelect.value = "";
      models.querySelectorAll(".model-list button").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.id === item.id)));
      paintFamily();
    };
    const modelButton = (item) => {
      const button = h("button", { type: "button", "data-id": item.id, "aria-pressed": String(item.id === form.elements.model.value.trim()) },
        item.label === item.id ? item.id : `${item.label} · ${item.id}`,
        item.midsceneFamily ? h("span", { class: "family-tag" }, item.midsceneFamily) : null,
      );
      button.addEventListener("click", () => pick(item));
      return button;
    };
    const renderModels = (items) => {
      const compatible = items.filter((item) => item.midsceneFamily);
      const other = items.filter((item) => !item.midsceneFamily);
      const onlyCompatible = h("input", { type: "checkbox", id: "f-only-midscene", checked: compatible.length > 0 });
      const otherGroup = h("div", { class: "model-group" },
        h("p", { class: "label" }, t("Diğer modeller ({n})", { n: other.length })),
        h("p", { class: "hint" }, "Adından Midscene ailesi anlaşılmıyor: metin modeli, yönlendirici takma adı (auto/…) ya da Midscene'ın desteklemediği bir model olabilir. Seçersen aileyi elle belirlemen gerekir."),
        h("div", { class: "model-list", role: "group", "aria-label": "Diğer modeller" }, other.map(modelButton)),
      );
      const paintGroups = () => {
        otherGroup.hidden = onlyCompatible.checked && compatible.length > 0;
        const query = search.value.trim().toLowerCase();
        models.querySelectorAll(".model-list button").forEach((node) => { node.hidden = Boolean(query) && !node.textContent.toLowerCase().includes(query); });
      };
      const search = h("input", { type: "search", id: "f-model-search", placeholder: "Modellerde ara (ör. qwen3-vl, gemini, gpt-5)", autocomplete: "off", "aria-label": "Modellerde ara" });
      search.addEventListener("input", paintGroups);
      onlyCompatible.addEventListener("change", paintGroups);
      models.replaceChildren(
        search,
        h("div", { class: "check-row" }, h("label", { for: "f-only-midscene" }, onlyCompatible, t("Yalnız Midscene uyumlu modelleri göster ({compatible}/{total})", { compatible: compatible.length, total: items.length }))),
        h("div", { class: "model-group" },
          h("p", { class: "label" }, t("Midscene uyumlu ({n})", { n: compatible.length })),
          h("p", { class: "hint" }, "Etiket, model adından algılanan Midscene ailesidir. Midscene ekran görüntüsü gönderir; seçtiğin modelin görsel girdi kabul ettiğinden emin ol."),
          compatible.length
            ? h("div", { class: "model-list", role: "group", "aria-label": "Midscene uyumlu modeller" }, compatible.map(modelButton))
            : h("p", { class: "notice warn" }, "Bu sağlayıcının listesinde Midscene'ın tanıdığı bir model bulunamadı. Görsel bir model (Qwen3-VL, Gemini, GPT-5, Doubao Seed, UI-TARS…) sunan bir sağlayıcı seç ya da model adını elle yaz."),
        ),
        other.length ? otherGroup : null,
      );
      models.hidden = false;
      paintGroups();
    };

    listButton.addEventListener("click", () => busy(listButton, async () => {
      error.hidden = true;
      try {
        const result = await api("/api/models/list", { method: "POST", body: payload() });
        for (const item of result.models) knownFamily.set(item.id, item.midsceneFamily || "");
        renderModels(result.models);
        paintFamily();
        if (!result.models.length) {
          models.hidden = true;
          error.textContent = t("Liste boş döndü. Model adını elle yazıp kullanabilirsin.");
          error.hidden = false;
        }
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    }));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      busy(form.querySelector("button[type=submit]"), async () => {
        error.hidden = true;
        const body = { ...payload(), model: form.elements.model.value.trim(), midsceneFamily: familySelect.value };
        if (!body.model) {
          error.textContent = t("Bir model seç veya adını yaz.");
          error.hidden = false;
          return;
        }
        try {
          await api("/api/models/select", { method: "POST", body });
          toast(t("{model} bağlandı.", { model: body.model }), "ok");
          await refreshModel();
          loadSettings();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      });
    });
    card.replaceWith(form);
    select.focus();
  };

  renderSummary();
  return card;
}

async function loadSettings() {
  const body = $("settings-body");
  try {
    const [data] = await Promise.all([api("/api/settings"), refreshModel()]);
    body.className = "stack-lg settings-body";
    const cards = SECTIONS.map((section) => settingsCard(section, data));
    const general = SECTIONS.findIndex((section) => section.id === "general");
    cards.splice(general, 0, sourcesCard(), skillsCard());
    body.replaceChildren(modelCard(data), ...cards);
    const titles = SECTIONS.map((section) => [section.id, section.title]);
    titles.splice(general, 0, ["sources", "Test hesap kaynakları"], ["skills", "QA becerileri"]);
    const links = [["model", "Model"], ...titles].map(([id, title]) => {
      const link = h("a", { href: `#/settings`, "data-target": id }, title);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        document.getElementById(`s-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        $("settings-nav").querySelectorAll("a").forEach((node) => node.removeAttribute("aria-current"));
        link.setAttribute("aria-current", "true");
      });
      return link;
    });
    links[0].setAttribute("aria-current", "true");
    $("settings-nav").replaceChildren(...links);
  } catch (err) {
    body.replaceChildren(h("p", { class: "notice error" }, err.message));
  }
}

/* ---------- Account sources ---------- */

const SOURCE_TYPE_LABEL = { http: "HTTP servis", manual: "Elle girilen liste" };
const AUTH_LABEL = { none: "Kimlik doğrulama yok", login: "Giriş → token", header: "API anahtarı", basic: "Basic auth" };
const sourceDialog = { mode: "create", source: null, templates: [], clients: [] };

function prettyJson(value) {
  return value && Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
}

function jsonField(id, label) {
  const text = $(id).value.trim();
  if (!text) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(t("{label}: geçerli JSON değil", { label: t(label) })); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("{label}: bir JSON nesnesi olmalı ({ ... })", { label: t(label) }));
  return value;
}

function sourcesCard() {
  const card = h("section", { class: "card", id: "s-sources" });
  const render = async () => {
    let sources;
    try {
      sources = await api("/api/sources");
    } catch (err) {
      card.replaceChildren(h("div", { class: "card-body" }, h("p", { class: "notice error" }, err.message)));
      return;
    }
    const rows = sources.map((source) => h("tr", {},
      h("td", {},
        h("div", { class: "title" }, source.name),
        h("div", { class: "sub" }, source.type === "manual"
          ? t("{total} hesap · {available} kullanılabilir · {mode}", { total: source.accounts.total, available: source.accounts.available, mode: t(source.use_mode === "once" ? "tek kullanımlık" : "tekrar kullanılabilir") })
          : t("{address} · {auth}", { address: source.base_url || t("adres yok"), auth: t(AUTH_LABEL[source.spec.auth.type]) })),
        source.used_by.length ? h("div", { class: "sub" }, t("Kullanan: {items}", { items: source.used_by.join(", ") })) : null,
      ),
      h("td", { class: "hide-sm" }, SOURCE_TYPE_LABEL[source.type]),
      h("td", { class: "hide-sm" }, source.client_name || h("span", { class: "muted" }, "Tüm projeler")),
      h("td", {}, badge(source.ready ? "passed" : "blocked", source.ready ? "Hazır" : "Eksik"), source.ready ? null : h("div", { class: "sub" }, source.issue)),
      h("td", { class: "right" }, h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost sm", onclick: () => openSourceDialog("edit", source, render) }, "Düzenle"),
        h("button", { type: "button", class: "btn ghost sm", onclick: () => openSourceDialog("clone", source, render) }, icon("copy"), "Kopyala"),
        h("button", {
          type: "button",
          class: "btn ghost sm",
          title: source.used_by.length ? "Kullanan konfigürasyonlar varken silinemez" : "Kaynağı sil",
          disabled: source.used_by.length > 0,
          onclick: async (event) => {
            const button = event.currentTarget;
            if (!(await confirmAction({ title: t("Hesap kaynağı silinsin mi?"), message: t('"{name}" ve içindeki hesaplar kalıcı olarak silinir, geri alınamaz.', { name: source.name }) }))) return;
            await busy(button, async () => {
              try {
                await api(`/api/sources/${source.id}`, { method: "DELETE" });
                toast(t("Kaynak silindi."), "ok");
                render();
              } catch (err) {
                toast(err.message, "error");
              }
            });
          },
        }, "Sil"),
      )),
    ));
    card.replaceChildren(
      h("div", { class: "card-body" },
        sectionHeader("Test hesap kaynakları", "Koşumların giriş yapacağı test kullanıcıları buradan gelir. Her proje kendi servisini veya kendi hesap listesini kullanabilir; konfigürasyonlar kaynak seçer.",
          h("button", { type: "button", class: "btn primary sm", onclick: () => openSourceDialog("create", null, render) }, icon("plus"), "Yeni kaynak")),
        sources.length
          ? h("div", { class: "table-card" }, h("table", { class: "table" },
            h("thead", {}, h("tr", {}, h("th", {}, "Kaynak"), h("th", { class: "hide-sm" }, "Tür"), h("th", { class: "hide-sm" }, "Kapsam"), h("th", {}, "Durum"), h("th", {}, h("span", { class: "sr-only" }, "İşlem")))),
            h("tbody", {}, rows),
          ))
          : emptyState("Henüz hesap kaynağı yok", "Test kullanıcılarını bir HTTP servisten almak veya elle listelemek için kaynak ekle."),
      ),
    );
  };
  card.replaceChildren(h("div", { class: "card-body" }, h("p", { class: "muted" }, "Yükleniyor…")));
  render();
  return card;
}

/* ---------- QA skills ---------- */

const SKILL_TEMPLATE = `---
name: Projeye özel bilgiler
description: Chat QA ajanının bu projede bilmesi gerekenler.
triggers: proje adı, giriş, ödeme
---
# Projeye özel bilgiler

- Giriş bağlantısı sağ üstteki "Hesabım" menüsünün içindedir.
- Ödeme adımında 3D Secure ekranı açılır; test ortamında bu ekranda dur.

## Midscene
- Giriş bağlantısı sağ üstteki "Hesabım" menüsünün içindedir.
`;

function skillsCard() {
  const card = h("section", { class: "card", id: "s-skills" });
  const editor = (skill, render) => {
    const creating = !skill || skill.source === "builtin";
    const idField = h("input", { id: "skill-id", value: skill?.id || "", placeholder: "proje-giris", autocomplete: "off", required: true, disabled: !creating || Boolean(skill) });
    const textField = h("textarea", { id: "skill-text", spellcheck: "false" }, skill?.text || SKILL_TEMPLATE);
    const result = h("span", { class: "result", role: "status" });
    const form = h("form", { class: "skill-editor", novalidate: true },
      h("div", { class: "field" }, h("label", { for: "skill-id" }, "Kimlik (dosya adı)"), idField,
        h("p", { class: "field-help" }, skill?.source === "builtin"
          ? "Yerleşik beceriyi aynı kimlikle kaydetmek onu bu kurulumda ezer; özel kopyayı silince yerleşik geri gelir."
          : "Küçük harf, rakam ve tire. Ön bilgide triggers: ile tetikleyici sözcükleri ya da always: true yaz. \"## Midscene\" bölümü ekranı süren Midscene'a da not olarak gider.")),
      h("div", { class: "field" }, h("label", { for: "skill-text" }, "Beceri (Markdown)"), textField),
      h("div", { class: "actions" }, result,
        h("button", { type: "button", class: "btn ghost", onclick: () => render() }, "Vazgeç"),
        h("button", { type: "submit", class: "btn primary" }, "Kaydet")),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      busy(form.querySelector("button[type=submit]"), async () => {
        try {
          await api(`/api/skills/${encodeURIComponent(idField.value.trim())}`, { method: "PUT", body: { text: textField.value } });
          toast(t("Beceri kaydedildi."), "ok");
          render();
        } catch (err) {
          result.textContent = err.message;
          result.className = "result error";
        }
      });
    });
    return form;
  };
  const render = async (editing) => {
    let skills;
    try {
      skills = await api("/api/skills");
    } catch (err) {
      card.replaceChildren(h("div", { class: "card-body" }, h("p", { class: "notice error" }, err.message)));
      return;
    }
    const sourceBadge = (skill) => skill.source === "builtin"
      ? badge("pending", "Yerleşik")
      : badge("active", skill.overrides ? "Özel · yerleşiği ezer" : "Özel");
    const rows = skills.map((skill) => h("tr", {},
      h("td", {},
        h("div", { class: "title" }, skill.name),
        h("div", { class: "sub" }, skill.description),
        h("div", { class: "sub" }, skill.always ? "Her istekte kullanılır" : t("Tetikleyiciler: {triggers}{more}", { triggers: skill.triggers.slice(0, 10).join(", "), more: skill.triggers.length > 10 ? "…" : "" })),
      ),
      h("td", {}, sourceBadge(skill)),
      h("td", { class: "right" }, h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost sm", onclick: () => render(skill) }, skill.source === "builtin" ? "Özelleştir" : "Düzenle"),
        skill.source === "custom" ? h("button", {
          type: "button",
          class: "btn ghost sm",
          onclick: async (event) => {
            const button = event.currentTarget;
            const message = skill.overrides ? t('"{name}" özel kopyası silinir, yerleşik sürüm geri gelir.', { name: skill.name }) : t('"{name}" kalıcı olarak silinir.', { name: skill.name });
            if (!(await confirmAction({ title: t("Beceri silinsin mi?"), message }))) return;
            await busy(button, async () => {
              try {
                await api(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
                toast(t("Beceri silindi."), "ok");
                render();
              } catch (err) {
                toast(err.message, "error");
              }
            });
          },
        }, "Sil") : null,
      )),
    ));
    card.replaceChildren(
      h("div", { class: "card-body" },
        sectionHeader("QA becerileri", "Chat QA ajanının uzmanlığı. Ajan her mesajda QA çekirdeğini ve mesaja uyan becerileri (giriş, arama, sepet, hata analizi…) okur; senaryoyu ve adımları bunlara göre yazar. Projene özel bilgileri (menü yerleri, test verisi kuralları, ortam kısıtları) özel beceri olarak ekle.",
          h("button", { type: "button", class: "btn primary sm", onclick: () => render(null) }, icon("plus"), "Yeni beceri")),
        h("div", { class: "table-card" }, h("table", { class: "table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Beceri"), h("th", {}, "Kaynak"), h("th", {}, h("span", { class: "sr-only" }, "İşlem")))),
          h("tbody", {}, rows),
        )),
        editing !== undefined ? editor(editing, render) : null,
      ),
    );
    if (editing !== undefined) card.querySelector("#skill-text")?.focus();
  };
  card.replaceChildren(h("div", { class: "card-body" }, h("p", { class: "muted" }, "Yükleniyor…")));
  render();
  return card;
}

function paintSourceDialog() {
  const type = $("src-type").value;
  const auth = $("src-auth-type").value;
  document.querySelectorAll("#source-form [data-type]").forEach((node) => { node.hidden = node.dataset.type !== type; });
  document.querySelectorAll("#source-form [data-auth]").forEach((node) => { node.hidden = !node.dataset.auth.split(" ").includes(auth); });
  $("src-template-field").hidden = type !== "http" || sourceDialog.mode !== "create";
  $("src-test").textContent = t(type === "manual" ? "Listeyi kontrol et" : "Bağlantıyı dene");
}

function fillSourceForm(source) {
  const spec = source.spec;
  $("src-base-url").value = source.base_url || "";
  $("src-auth-type").value = spec.auth.type;
  $("src-auth-method").value = spec.auth.method;
  $("src-auth-path").value = spec.auth.path;
  $("src-auth-body").value = prettyJson(spec.auth.body);
  $("src-token-path").value = spec.auth.tokenPath;
  $("src-token-header").value = spec.auth.tokenHeader;
  $("src-token-prefix").value = spec.auth.tokenPrefix;
  $("src-list-method").value = spec.list.method;
  $("src-list-path").value = spec.list.path;
  $("src-items-path").value = spec.list.itemsPath;
  $("src-list-params").value = prettyJson(spec.list.params);
  $("src-f-email").value = spec.fields.email;
  $("src-f-password").value = spec.fields.password;
  $("src-f-phone").value = spec.fields.phone;
  $("src-f-id").value = spec.fields.id;
  $("src-extras").value = Object.entries(spec.extras || {}).map(([name, path]) => `${name}=${path}`).join("\n");
  $("src-mark-method").value = spec.markUsed?.method || "PUT";
  $("src-mark-path").value = spec.markUsed?.path || "";
  $("src-mark-body").value = prettyJson(spec.markUsed?.body);
}

async function openSourceDialog(mode, source, onSaved) {
  try {
    const [templates, options] = await Promise.all([
      sourceDialog.templates.length ? sourceDialog.templates : api("/api/sources/templates"),
      api("/api/config-options"),
    ]);
    sourceDialog.templates = templates;
    sourceDialog.clients = options.clients;
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  Object.assign(sourceDialog, { mode, source, onSaved });
  const blank = { type: "http", base_url: "", use_mode: "reuse", client_id: null, credentials: {}, spec: { auth: { type: "none", method: "POST", path: "", body: {}, tokenPath: "token", tokenHeader: "Authorization", tokenPrefix: "" }, list: { method: "GET", path: "", params: {}, itemsPath: "" }, fields: { email: "email", password: "password", phone: "phoneNumber", id: "_id" }, extras: {}, markUsed: null } };
  const base = source || blank;
  $("source-dialog-title").textContent = t({ create: "Yeni hesap kaynağı", clone: "Kaynağı kopyala", edit: "Hesap kaynağını düzenle" }[mode]);
  $("source-dialog-lead").textContent = mode === "clone"
    ? t('"{name}" kopyalanıyor; giriş bilgileri ve hesaplar da kopyalanır.', { name: source.name })
    : t("Test kullanıcılarının nereden alınacağını tanımla. Her proje kendi servisini veya kendi listesini kullanabilir.");
  $("src-scope").replaceChildren(h("option", { value: "" }, "Tüm projeler (ortak)"), ...sourceDialog.clients.map((client) => h("option", { value: client.id }, client.name)));
  $("src-scope").value = base.client_id ? String(base.client_id) : "";
  $("src-template").replaceChildren(h("option", { value: "" }, "Boş başla"), ...sourceDialog.templates.map((item) => h("option", { value: item.template }, item.name)));
  $("src-template").value = "";
  $("src-name").value = mode === "clone" ? `${source.name} (kopya)` : base.name || "";
  $("src-type").value = base.type;
  $("src-type").disabled = mode === "edit" && source.accounts?.total > 0;
  $("src-cred-user").value = base.credentials.username || "";
  $("src-cred-pass").value = base.credentials.password || "";
  $("src-cred-secret").value = base.credentials.secret || "";
  $("src-use-mode").value = base.use_mode || "reuse";
  fillSourceForm(base);
  $("src-accounts").value = "";
  $("src-accounts-state").replaceChildren();
  if (source?.type === "manual") {
    const lines = await api(`/api/sources/${source.id}/accounts`).catch(() => []);
    $("src-accounts").value = lines.map((line) => [line.email, line.password, line.phone].filter((part, index) => index < 2 || part).join(", ")).join("\n");
    const used = lines.filter((line) => line.used).length;
    if (mode === "edit" && used) {
      $("src-accounts-state").replaceChildren(
          h("span", { class: "muted small" }, t("{n} hesap kullanıldı olarak işaretli.", { n: used })),
        h("button", {
          type: "button",
          class: "btn secondary sm",
          onclick: (event) => busy(event.currentTarget, async () => {
            const { reset } = await api(`/api/sources/${source.id}/reset`, { method: "POST" });
            toast(t("{n} hesap tekrar kullanılabilir.", { n: reset }), "ok");
            $("src-accounts-state").replaceChildren();
            sourceDialog.onSaved?.();
          }),
        }, "Kullanılanları sıfırla"),
      );
    }
  }
  $("src-test-result").hidden = true;
  $("src-save").textContent = t(mode === "edit" ? "Kaydet" : "Oluştur");
  paintSourceDialog();
  $("source-dialog").showModal();
  $("src-name").focus();
  if (mode === "clone") $("src-name").select();
}

function sourceBody() {
  const type = $("src-type").value;
  const extras = Object.fromEntries($("src-extras").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    if (at < 1) throw new Error(t('Ek alan satırı "ad=alan" biçiminde olmalı: {line}', { line }));
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  const markPath = $("src-mark-path").value.trim();
  const { mode, source } = sourceDialog;
  return {
    id: mode === "edit" ? source.id : undefined,
    cloneOf: mode === "clone" ? source.id : undefined,
    name: $("src-name").value,
    clientId: $("src-scope").value || null,
    type,
    template: mode === "edit" ? source.template : $("src-template").value,
    baseUrl: $("src-base-url").value,
    useMode: $("src-use-mode").value,
    credentials: { username: $("src-cred-user").value, password: $("src-cred-pass").value, secret: $("src-cred-secret").value },
    accounts: type === "manual" ? $("src-accounts").value : undefined,
    spec: {
      auth: {
        type: $("src-auth-type").value,
        method: $("src-auth-method").value,
        path: $("src-auth-path").value,
        body: jsonField("src-auth-body", "Giriş isteği gövdesi"),
        tokenPath: $("src-token-path").value,
        tokenHeader: $("src-token-header").value,
        tokenPrefix: $("src-token-prefix").value,
      },
      list: { method: $("src-list-method").value, path: $("src-list-path").value, itemsPath: $("src-items-path").value, params: jsonField("src-list-params", "Filtre parametreleri") },
      fields: { email: $("src-f-email").value, password: $("src-f-password").value, phone: $("src-f-phone").value, id: $("src-f-id").value },
      extras,
      markUsed: markPath ? { method: $("src-mark-method").value, path: markPath, body: jsonField("src-mark-body", "Kullanıldı isteği gövdesi") } : null,
    },
  };
}

function sourceNotice(kind, content) {
  const box = $("src-test-result");
  box.className = `notice ${kind}`;
  box.replaceChildren(...[content].flat().filter((node) => node !== null && node !== undefined));
  box.hidden = false;
  box.scrollIntoView({ block: "nearest" });
}

$("src-type").addEventListener("change", paintSourceDialog);
$("src-auth-type").addEventListener("change", () => {
  const auth = $("src-auth-type").value;
  const header = $("src-token-header");
  if (auth === "header" && (!header.value || header.value === "Authorization")) header.value = "x-api-key";
  if (auth === "login" && header.value === "x-api-key") header.value = "Authorization";
  paintSourceDialog();
});
$("src-template").addEventListener("change", () => {
  const template = sourceDialog.templates.find((item) => item.template === $("src-template").value);
  if (!template) return;
  fillSourceForm(template);
  if (!$("src-name").value.trim()) $("src-name").value = template.name;
  paintSourceDialog();
});
$("source-dialog-close").addEventListener("click", () => $("source-dialog").close());
$("src-cancel").addEventListener("click", () => $("source-dialog").close());
$("src-test").addEventListener("click", (event) => busy(event.currentTarget, async () => {
  try {
    const result = await api("/api/sources/test", { method: "POST", body: sourceBody() });
    const preview = result.preview;
    sourceNotice("ok", [
      h("strong", {}, result.message),
      preview ? h("dl", { class: "kv", style: "margin-top:8px" },
        h("dt", {}, "Kullanıcı"), h("dd", {}, preview.email || "—"),
        h("dt", {}, "Şifre"), h("dd", {}, preview.password),
        h("dt", {}, "Telefon"), h("dd", {}, preview.phone || "—"),
        h("dt", {}, "Kimlik"), h("dd", {}, preview.id || "—"),
        Object.entries(preview.extras || {}).map(([name, value]) => [h("dt", {}, `account.${name}`), h("dd", {}, value || "—")]),
      ) : null,
    ]);
  } catch (err) {
    sourceNotice("error", err.message);
  }
}));
$("source-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("src-name").value.trim()) {
    $("src-name").setAttribute("aria-invalid", "true");
    $("src-name").focus();
    return;
  }
  $("src-name").removeAttribute("aria-invalid");
  await busy($("src-save"), async () => {
    try {
      const body = sourceBody();
      if (sourceDialog.mode === "edit") await api(`/api/sources/${sourceDialog.source.id}`, { method: "PUT", body });
      else await api("/api/sources", { method: "POST", body });
      $("source-dialog").close();
      toast(t({ edit: "Kaynak güncellendi.", create: "Kaynak oluşturuldu.", clone: "Kaynak kopyalandı." }[sourceDialog.mode]), "ok");
      sourceDialog.onSaved?.();
    } catch (err) {
      sourceNotice("error", err.message);
    }
  });
});

/* ---------- People ---------- */

const USER_STATUS = { active: "Aktif", pending: "Beklemede", rejected: "Reddedildi" };

async function loadPeople() {
  const box = $("people-list");
  let users;
  try {
    users = await api("/api/users");
  } catch (err) {
    box.replaceChildren(h("p", { class: "notice error" }, err.message));
    return;
  }
  const order = { pending: 0, active: 1, rejected: 2 };
  users.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.id - b.id);
  setPendingCount(users.filter((user) => user.status === "pending").length);

  const rows = users.map((person) => {
    let actions = null;
    if (person.builtin) actions = h("span", { class: "muted small" }, "Yerleşik hesap");
    else if (person.status === "pending" || person.status === "rejected") {
      const role = h("select", { "aria-label": t("{email} için rol", { email: person.email }) }, h("option", { value: "user" }, "user"), h("option", { value: "admin" }, "admin"));
      role.value = person.role === "admin" ? "admin" : "user";
      const act = (kind, button) => busy(button, async () => {
        try {
          await api(`/api/users/${person.id}/${kind}`, { method: "POST", body: kind === "approve" ? { role: role.value } : {} });
          toast(kind === "approve" ? t("{email} {role} olarak onaylandı.", { email: person.email, role: role.value }) : t("{email} reddedildi.", { email: person.email }), "ok");
          loadPeople();
        } catch (err) {
          toast(err.message, "error");
        }
      });
      actions = h("div", { class: "actions" },
        role,
        h("button", { type: "button", class: "btn primary sm", onclick: (event) => act("approve", event.currentTarget) }, "Onayla"),
        person.status === "pending" ? h("button", { type: "button", class: "btn danger sm", onclick: (event) => act("reject", event.currentTarget) }, "Reddet") : null,
      );
    }
    return h("tr", {},
      h("td", {}, h("div", { class: "title" }, person.email)),
      h("td", {}, h("span", { class: `badge ${person.role}` }, person.role)),
      h("td", {}, badge(person.status, USER_STATUS[person.status] || person.status)),
      h("td", { class: "right" }, h("div", { class: "actions" }, actions)),
    );
  });

  box.replaceChildren(h("div", { class: "table-card" }, h("table", { class: "table" },
    h("thead", {}, h("tr", {}, h("th", {}, "E-posta"), h("th", {}, "Rol"), h("th", {}, "Durum"), h("th", {}, h("span", { class: "sr-only" }, "İşlemler")))),
    h("tbody", {}, rows),
  )));
}

/* ---------- Boot ---------- */

window.addEventListener("langchange", async () => {
  const active = document.activeElement;
  if (!state.me) {
    document.title = `${t("Giriş")} · Mercury Test Runner`;
    $("login-error").hidden = true;
    $("register-note").hidden = true;
    return;
  }
  $("history-owner").textContent = t("Yalnızca {email} hesabına ait konuşmalar burada görünür.", { email: state.me.email });
  await Promise.all([checkUpdate(), refreshModel(), loadConfigs()].map((task) => task.catch?.(() => {})));
  if (state.conversationId) await renderConversation(state.conversationId);
  else if (state.view === "chat") {
    resetThread();
    threadInner.append(hero());
  }
  route({ preserveFocus: true });
  if (!$("drawer").hidden) paintDrawer();
  if ($("config-dialog").open) {
    $("config-dialog-title").textContent = t({ create: "Yeni konfigürasyon", clone: "Konfigürasyonu kopyala", edit: "Konfigürasyonu düzenle" }[configDialog.mode]);
    $("config-save").textContent = t(configDialog.mode === "edit" ? "Kaydet" : "Oluştur");
    paintConfigDialog();
  }
  if ($("source-dialog").open) {
    $("source-dialog-title").textContent = t({ create: "Yeni hesap kaynağı", clone: "Kaynağı kopyala", edit: "Hesap kaynağını düzenle" }[sourceDialog.mode]);
    $("src-save").textContent = t(sourceDialog.mode === "edit" ? "Kaydet" : "Oluştur");
    paintSourceDialog();
  }
  if (active?.matches?.("[data-lang]")) active.focus();
});

api("/api/me").then(enter).catch(showGate);
