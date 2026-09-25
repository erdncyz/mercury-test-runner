const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  view: "chat",
  runFilter: "all",
  runTimer: null,
  configs: [],
  providers: [],
  model: null,
  drawerRun: null,
  configOptions: { clients: [], sources: [], cases: [], limits: {} },
};

const TITLES = { chat: "Chat", history: "Geçmiş", runs: "Koşumlar", configs: "Konfigürasyonlar", settings: "Ayarlar", people: "Üyeler" };
const STATUS_LABEL = { queued: "Kuyrukta", running: "Koşuyor", passed: "Geçti", failed: "Başarısız", blocked: "Engellendi" };
const PLATFORM = { web: ["Web", "globe"], android: ["Android", "phone"], ios: ["iOS", "phone"], tv: ["Smart TV", "tv"] };
const FINISHED = new Set(["passed", "failed", "blocked"]);
const STEP_ACTION = {
  launch: "aç", aiAct: "ai eylem", aiAction: "ai eylem", ai: "ai eylem", aiAssert: "doğrula", aiWaitFor: "bekle",
  aiQuery: "sorgu", aiTap: "dokun", aiInput: "yaz", aiHover: "üzerine gel", sleep: "uyu",
};
const STEP_STATE = { pending: "Bekliyor", running: "Koşuyor", passed: "Geçti", failed: "Başarısız", not_run: "Çalıştırılmadı", skipped: "Atlandı" };

/* ---------- Helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
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
  if (diff < 60) return "az önce";
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
  return date.toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.me && !path.startsWith("/api/auth/")) {
    state.me = null;
    showGate();
    throw new Error("Oturum sona erdi. Tekrar giriş yap.");
  }
  if (!response.ok) throw new Error(data.error || `İstek başarısız (${response.status})`);
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

/* ---------- Gate ---------- */

function showGate() {
  stopRunPolling();
  clearInterval(chatPoll);
  chatRuns.clear();
  closeDrawer();
  $("thread").replaceChildren();
  $("app").hidden = true;
  $("gate").hidden = false;
  document.title = "Giriş · Mercury Test Runner";
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
    error.textContent = "E-posta ve şifreyi doldur.";
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
    note.textContent = "Geçerli bir e-posta ve en az 8 karakter şifre gir.";
    note.hidden = false;
    return;
  }
  await busy(form.querySelector("button[type=submit]"), async () => {
    try {
      await api("/api/auth/register", { method: "POST", body: Object.fromEntries(new FormData(form)) });
      note.className = "notice ok";
      note.textContent = "İsteğin alındı. Admin onayladığında Giriş yap sekmesinden girebilirsin.";
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
  $("history-owner").textContent = `Yalnızca ${state.me.email} hesabına ait konuşmalar burada görünür.`;
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

function route() {
  if (!state.me) return;
  const view = currentView();
  state.view = view;
  for (const name of Object.keys(TITLES)) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll(".tabs-nav [data-view]").forEach((link) => {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.title = `${TITLES[view]} · Mercury Test Runner`;
  closeMenu();
  stopRunPolling();
  if (view === "chat") $("chat-input").focus();
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
  $("version").textContent = `Mercury Test Runner v${version.version}${version.midscene ? ` · Midscene ${version.midscene}` : ""}`;
  const button = $("update");
  if (!version.update) { button.hidden = true; return; }
  button.hidden = false;
  button.textContent = `Güncelleme var · ${version.update.version}`;
  button.title = version.update.notes || "";
  button.onclick = () => toast(state.me.role === "admin"
    ? `Yeni sürüm ${version.update.version}. Güncelleme imajı çekilerek uygulanır.`
    : "Güncellemeyi yalnız admin başlatabilir.");
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
  chip.querySelector(".pill-text").textContent = problem || modelName;
  chip.title = problem ? (midscene.error || "Web koşumları model olmadan engellenir") : `${providerLabel} · ${midscene.family || ""}`;
  chip.onclick = () => (isAdmin ? go("settings") : toast(problem ? `${problem}. Admin'in Ayarlar'dan bağlaması gerekir.` : `Model: ${modelName}`));

  const banner = $("model-banner");
  banner.hidden = !problem;
  if (problem) {
    banner.replaceChildren(
      icon("alert"),
      h("p", {}, h("strong", {}, `${problem}. `), !ready ? "Web koşumları model olmadan engellenir; chat komut çözümü de aynı modeli kullanır." : midscene.error),
      isAdmin ? h("button", { type: "button", class: "btn secondary sm", onclick: () => go("settings") }, "Ayarlar") : h("span", { class: "small" }, "Admin'e haber ver"),
    );
  }
}

/* ---------- Run card (chat + drawer) ---------- */

const openCases = new Set();

function stepItem(step, index) {
  const status = step.status || "pending";
  const marker = status === "passed" ? icon("check") : status === "failed" ? icon("x") : String(index + 1);
  return h("li", { class: `step ${status}` },
    h("span", { class: "marker", "aria-hidden": "true" }, marker),
    h("span", { class: "action" }, STEP_ACTION[step.action] || step.action),
    h("span", { class: "step-text" }, step.text || "—"),
    h("span", { class: "state" }, STEP_STATE[status] || status),
    step.detail && (status === "failed" || (status === "passed" && step.action === "aiQuery")) ? h("span", { class: "step-detail" }, step.detail) : null,
  );
}

// Case titles often already start with their TestRail id ("C101 …"); show the id once.
function caseLabel(key, title) {
  const text = String(title || "");
  if (!key) return [text];
  const rest = text.replace(new RegExp(`^C?${key}\\b[\\s:.\\-–—]*`, "i"), "");
  return [h("span", { class: "mono muted" }, `C${key}  `), rest || text];
}

function runCard(run, { expanded = false } = {}) {
  const cases = run.cases || [];
  const caseNodes = cases.map((item, index) => {
    const key = `${run.id}:${item.case_key || index}`;
    const steps = item.steps || [];
    const done = steps.filter((step) => ["passed", "failed", "skipped", "not_run"].includes(step.status)).length;
    const details = h("details", { class: "case", open: expanded || openCases.has(key) || cases.length === 1 ? true : undefined },
      h("summary", {},
        h("span", { class: "chev" }, icon("chevron")),
        h("span", { class: "grow truncate" }, ...caseLabel(item.case_key, item.title)),
        h("span", { class: "muted small" }, `${steps.length} adım`),
        badge(item.status, STATUS_LABEL[item.status] || STEP_STATE[item.status] || item.status),
      ),
      run.status === "running" && steps.length ? h("div", { class: "progress" }, h("span", { style: `width:${Math.round((done / steps.length) * 100)}%` })) : null,
      steps.length ? h("ol", { class: "steps" }, steps.map(stepItem)) : h("p", { class: "muted small", style: "padding:0 14px 14px" }, "Bu case için adım tanımı yok."),
    );
    details.addEventListener("toggle", () => (details.open ? openCases.add(key) : openCases.delete(key)));
    return details;
  });
  // A failed step already shows the error inline, so the run-level note would only repeat it.
  const stepFailed = cases.some((item) => (item.steps || []).some((step) => step.status === "failed"));
  return h("article", { class: "run-card" },
    h("div", { class: "run-card-head" },
      h("div", { class: "grow" },
        h("div", { class: "title truncate" }, `${run.client_name} · ${run.config_name}`),
        h("div", { class: "meta" },
          h("span", { class: "mono" }, `#${run.id}`),
          platform(run.platform),
          run.testrail_run_id
            ? h("span", {}, `TestRail R${run.testrail_run_id}`)
            : run.testrail_error ? h("span", { class: "meta-error", title: run.testrail_error }, "TestRail'e yazılmıyor") : h("span", {}, "Yerel koşum"),
          run.device_label ? h("span", {}, run.device_label) : null,
          run.account_email ? h("span", {}, run.account_email) : null,
        ),
      ),
      badge(run.status, STATUS_LABEL[run.status] || run.status),
      FINISHED.has(run.status) ? h("a", { class: "btn secondary sm", href: `/reports/${run.id}/`, target: "_blank", rel: "noopener" }, "Rapor", icon("external")) : null,
    ),
    run.message && !stepFailed ? h("div", { class: `note${run.status === "failed" ? " bad" : ""}` }, run.message) : null,
    cases.length ? caseNodes : h("p", { class: "muted small", style: "padding:12px 14px" }, "Bu client için case bulunamadı."),
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
}

function scrollThread() {
  $("thread").scrollTop = $("thread").scrollHeight;
}

function dayLabel(value) {
  return (value ? new Date(value) : new Date()).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
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
    h("p", {}, "Client ve platformu yaz; yeni bir koşum ve TestRail run açayım, adımları burada canlı göstereyim."),
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
  const time = new Date(createdAt || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
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
  const turns = [];
  const byTurn = new Map();
  for (const message of messages) {
    if (!byTurn.has(message.turn)) {
      const turn = { id: message.turn, messages: [] };
      byTurn.set(message.turn, turn);
      turns.push(turn);
    }
    byTurn.get(message.turn).messages.push(message);
  }
  info.textContent = turns.length ? `${turns.length} konuşma` : "";
  if (!turns.length) {
    $("history-list").replaceChildren(emptyState(
      query ? "Eşleşen konuşma yok" : "Henüz chat geçmişin yok",
      query ? "Başka bir kelimeyle aramayı dene." : "Chat üzerinden ilk koşumunu başlattığında konuşman burada görünecek.",
      query ? null : h("a", { class: "btn primary", href: "#/chat" }, "Chat'e git"),
    ));
    return;
  }
  $("history-list").replaceChildren(...turns.reverse().map(historyTurn));
}

function historyTurn(turn) {
  const userMessage = turn.messages.find((item) => item.role === "user");
  const assistantMessage = turn.messages.find((item) => item.role === "assistant");
  const createdAt = userMessage?.created_at || assistantMessage?.created_at;
  return h("article", { class: "history-turn" },
    h("header", { class: "history-turn-head" },
      h("span", { class: "history-icon", "aria-hidden": "true" }, icon("history")),
      h("div", { class: "grow" },
        h("h2", {}, userMessage?.text || "Konuşma"),
        h("p", { class: "muted small" }, new Date(createdAt).toLocaleString("tr-TR", {
          day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
        })),
      ),
    ),
    h("div", { class: "history-messages" },
      userMessage ? h("div", { class: "history-message user" },
        h("span", { class: "history-role" }, "Sen"),
        h("p", {}, userMessage.text),
      ) : null,
      assistantMessage ? h("div", { class: "history-message assistant" },
        h("span", { class: "history-role" }, "Mercury"),
        h("p", {}, assistantMessage.text),
        (assistantMessage.runs || []).map(mountRunCard),
      ) : null,
    ),
  );
}

async function sendChat(message) {
  addMessage("me", message);
  const typing = addMessage("bot typing", "Çözümleniyor");
  try {
    const result = await api("/api/chat", { method: "POST", body: { message } });
    typing.remove();
    addMessage("bot", result.reply, result.runs || []);
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
  return `${withClient} koş`;
}

function useCommand(command) {
  go("chat");
  chatInput.value = command;
  autosize();
  chatInput.focus();
}

async function loadConfigs() {
  state.configs = await api("/api/configs");
  $("suggestions").replaceChildren(...state.configs.slice(0, 6).map((config) => (
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

async function loadRuns(silent = false) {
  let runs;
  try {
    runs = await api("/api/runs");
  } catch (err) {
    if (!silent) toast(err.message, "error");
    return;
  }
  // The list is polled every few seconds; rebuilding identical rows would detach them mid-click and drop focus.
  const signature = JSON.stringify([state.runFilter, runs.map((run) => [run.id, run.status, run.message, run.testrail_run_id, relativeTime(run.created_at)])]);
  if (silent && signature === state.runsSignature && $("run-list").childElementCount) return;
  state.runsSignature = signature;
  const counts = runs.reduce((acc, run) => ({ ...acc, [run.status]: (acc[run.status] || 0) + 1 }), {});
  const stat = (label, value) => h("div", { class: "stat" }, h("span", {}, label), h("b", {}, value));
  $("run-stats").replaceChildren(
    stat("Toplam", runs.length),
    stat("Aktif", (counts.queued || 0) + (counts.running || 0)),
    stat("Geçti", counts.passed || 0),
    stat("Başarısız · Engellendi", (counts.failed || 0) + (counts.blocked || 0)),
  );
  const options = [["all", "Tümü", runs.length], ...Object.keys(STATUS_LABEL).map((key) => [key, STATUS_LABEL[key], counts[key] || 0])];
  $("run-filters").replaceChildren(...options.map(([key, label, count]) => (
    h("button", { type: "button", "aria-pressed": String(state.runFilter === key), onclick: () => { state.runFilter = key; loadRuns(true); } },
      label, h("span", { class: "n" }, count))
  )));

  const list = $("run-list");
  const visible = state.runFilter === "all" ? runs : runs.filter((run) => run.status === state.runFilter);
  if (!visible.length) {
    list.replaceChildren(emptyState(
      runs.length ? "Bu filtrede koşum yok" : "Henüz koşum yok",
      "Chat'e bir komut yaz; her komut yeni bir koşum ve TestRail run açar.",
      h("button", { type: "button", class: "btn primary", onclick: () => go("chat") }, "Chat'e git"),
    ));
    return;
  }
  const rows = visible.map((run) => {
    const row = h("tr", { class: "clickable", tabindex: "0", "aria-label": `Koşum #${run.id} ayrıntıları` },
      h("td", { class: "id hide-sm" }, `#${run.id}`),
      h("td", {},
        h("div", { class: "title" }, `${run.client_name} · ${run.config_name}`),
        run.message ? h("div", { class: "sub truncate", title: run.message }, run.message) : null,
      ),
      h("td", { class: "hide-sm" }, platform(run.platform)),
      h("td", {}, badge(run.status, STATUS_LABEL[run.status] || run.status)),
      h("td", { class: "hide-sm mono muted" }, run.testrail_run_id ? `R${run.testrail_run_id}` : "—"),
      h("td", { class: "hide-sm muted" }, relativeTime(run.created_at)),
      h("td", { class: "right hide-sm" }, FINISHED.has(run.status)
        ? h("a", { class: "btn ghost sm", href: `/reports/${run.id}/`, target: "_blank", rel: "noopener", onclick: (event) => event.stopPropagation() }, "Rapor", icon("external"))
        : null),
    );
    row.addEventListener("click", () => openDrawer(run.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDrawer(run.id); } });
    return row;
  });
  list.replaceChildren(h("div", { class: "table-card" }, h("table", { class: "table" },
    h("thead", {}, h("tr", {},
      h("th", { class: "hide-sm" }, "ID"), h("th", {}, "Koşum"), h("th", { class: "hide-sm" }, "Platform"), h("th", {}, "Durum"),
      h("th", { class: "hide-sm" }, "TestRail"), h("th", { class: "hide-sm" }, "Başladı"), h("th", { class: "hide-sm" }, h("span", { class: "sr-only" }, "Rapor")),
    )),
    h("tbody", {}, rows),
  )));
}

$("runs-refresh").addEventListener("click", (event) => busy(event.currentTarget, () => loadRuns()));

/* ---------- Drawer ---------- */

let drawerTimer = null;
let drawerReturnFocus = null;

async function paintDrawer() {
  if (!state.drawerRun) return;
  try {
    const run = await api(`/api/runs/${state.drawerRun}`);
    $("drawer-title").textContent = `Koşum #${run.id}`;
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

function configMeta(config) {
  const serials = parseConfigList(config.device_serials);
  const lanes = config.plan.lanes || 1;
  return [
    `${config.plan.caseCount} case`,
    lanes > 1 ? `${lanes} paralel` : "Tek hat",
    MOBILE_PLATFORMS.has(config.platform)
      ? (serials.length ? `${serials.length} UDID` : config.device_filter ? `Filtre: ${config.device_filter}` : "Farm'dan boş cihaz")
      : null,
    `Ortam: ${config.environment}`,
    parseConfigList(config.case_ids).length ? `ID: ${parseConfigList(config.case_ids).join(", ")}` : null,
    parseConfigList(config.case_tags).length ? `Etiket: ${parseConfigList(config.case_tags).join(", ")}` : null,
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
          h("button", { type: "button", class: "btn secondary sm", disabled: !config.plan.ready, title: config.plan.issues.join(" · "), onclick: () => useCommand(commandFor(config)) }, icon("play"), "Chat'e al"),
        )),
      ))),
    )),
  )));
}

function dialogClient() {
  const value = $("config-client").value;
  if (value === "__new") return { id: null, name: $("config-client-name").value.trim() };
  const client = state.configOptions.clients.find((item) => String(item.id) === value);
  return { id: client?.id ?? null, name: client?.name || "" };
}

function fillAccountSources(selected) {
  const { id } = dialogClient();
  const sources = state.configOptions.sources.filter((item) => item.client_id === null || item.client_id === id);
  $("config-account-source").replaceChildren(
    h("option", { value: "" }, sources.length ? "Kaynak seç" : "Kaynak yok — Ayarlar'dan ekle"),
    ...sources.map((item) => h("option", { value: item.id },
      `${item.name}${item.client_id === null ? " · ortak" : ""}${item.type === "manual" ? " · liste" : ""}${item.ready ? "" : " · eksik"}`)),
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
    h("p", { class: "field-help" }, `Kaynak varsayılanı: ${field.default || "yok"}`),
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
  const tags = splitList($("config-case-tags").value).map((tag) => tag.toLocaleLowerCase("tr"));
  const caseCount = ids.length
    ? cases.filter((item) => ids.includes(item.id)).length
    : tags.length ? cases.filter((item) => (item.tags || []).some((tag) => tags.includes(tag.toLocaleLowerCase("tr")))).length : cases.length;
  const parallel = Math.max(1, Math.min(20, Math.trunc(Number($("config-parallel").value)) || 1));
  const serials = mobile ? splitSerials($("config-serials").value) : [];
  const pool = serials.length ? Math.min(parallel, serials.length) : parallel;
  const lanes = Math.max(1, Math.min(pool, caseCount || 1));
  const limit = state.configOptions.limits?.[platformValue];
  const policy = $("config-account-policy").value;

  const problems = [];
  if (!caseCount) problems.push("Kapsamla eşleşen case yok");
  if (mobile && serials.length && parallel > serials.length) problems.push(`${parallel} paralel için ${parallel} UDID gerekir, ${serials.length} girildi`);
  const target = platformValue === "web" ? `${lanes} tarayıcı`
    : mobile ? (serials.length ? `${lanes} cihaz · ${serials.length} UDID havuzu` : `${lanes} cihaz · ${$("config-device-filter").value.trim() ? `filtre "${$("config-device-filter").value.trim()}"` : "Farm'dan boş"}`)
      : "yürütücü yok";
  const chips = [
    `${caseCount} case`,
    `${lanes} paralel hat`,
    caseCount ? `hat başına en fazla ${Math.ceil(caseCount / lanes)} case` : null,
    target,
    policy === "none" ? "test kullanıcısı yok" : `${lanes} test kullanıcısı (${POLICY_LABEL[policy].toLowerCase()})`,
  ].filter(Boolean);
  const notes = [];
  if (lanes < parallel && !(mobile && serials.length && parallel > serials.length) && caseCount) notes.push(`${caseCount} case olduğu için ${lanes} hat kullanılır`);
  if (limit && lanes > limit) notes.push(`Bu sunucuda en fazla ${limit} tarayıcı açılır (Ayarlar → Genel); ${lanes} hatlı koşum başka web koşumu yokken başlar`);
  $("config-summary").replaceChildren(...[
    h("div", { class: "chips" }, chips.map((chip) => h("span", { class: "chip" }, chip))),
    problems.length ? h("p", { class: "plan-issues" }, problems.join(" · ")) : null,
    notes.length ? h("p", { class: "plan-warnings" }, notes.join(" · ")) : null,
  ].filter(Boolean));
  $("config-serials-help").textContent = serials.length
    ? `${serials.length} UDID girildi. ${parallel} paralel hat için ${parallel} tanesi aynı anda kullanılır${serials.length > parallel ? `, ${serials.length - parallel} tanesi yedek` : ""}.`
    : "Girilirse yalnız bu cihazlar kullanılır. Boşsa filtreye uyan (veya herhangi) boş Farm cihazı alınır.";
  const credentials = $("config-account-credentials");
  const selectedSource = state.configOptions.sources.find((item) => String(item.id) === $("config-account-source").value);
  credentials.hidden = policy === "none" || !selectedSource || selectedSource.ready;
  if (!credentials.hidden) {
    credentials.className = policy === "required" ? "notice error" : "notice";
    credentials.replaceChildren(`"${selectedSource.name}" kaynağında ${selectedSource.issue}; kullanıcı alınamaz. `,
      h("a", { href: "#/settings", onclick: () => $("config-dialog").close() }, "Ayarlar → Test hesap kaynakları"));
  }
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
  $("config-dialog-title").textContent = { create: "Yeni konfigürasyon", clone: "Konfigürasyonu kopyala", edit: "Konfigürasyonu düzenle" }[mode];
  $("config-dialog-client").textContent = mode === "clone"
    ? `${config.name} satırından kopyalanıyor. Takma adlar boş bırakıldı; chat'in iki satırı karıştırmaması için yenilerini yaz.`
    : mode === "edit" ? `${config.client_name} · ${PLATFORM[config.platform]?.[0] || config.platform}` : "Platform, uygulama, cihazlar, paralellik ve test kullanıcısını tek yerde ayarla.";
  $("config-client").replaceChildren(
    ...state.configOptions.clients.map((item) => h("option", { value: item.id }, item.suite_id ? `${item.name} · Suite ${item.suite_id}` : item.name)),
    h("option", { value: "__new" }, "+ Yeni client…"),
  );
  $("config-client").value = base.client_id ? String(base.client_id) : String(state.configOptions.clients[0]?.id ?? "__new");
  $("config-client").disabled = mode === "edit";
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
  $("config-form-result").hidden = true;
  $("config-save").textContent = mode === "edit" ? "Kaydet" : "Oluştur";
  paintConfigDialog();
  $("config-dialog").showModal();
  $("config-name").focus();
  if (mode === "clone") $("config-name").select();
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
    suiteId: $("config-suite-id").value.trim(),
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
  };
  await busy($("config-save"), async () => {
    try {
      if (mode === "edit") await api(`/api/configs/${config.id}`, { method: "PUT", body });
      else await api("/api/configs", { method: "POST", body });
      closeConfigDialog();
      await renderConfigs();
      toast({ edit: "Konfigürasyon güncellendi.", create: "Konfigürasyon oluşturuldu.", clone: "Kopya oluşturuldu." }[mode], "ok");
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
    lead: "Her koş komutu bu projede yeni bir run açar. Eski run'a yazılmaz.",
    test: { path: "/api/settings/testrail-test", label: "Bağlantıyı dene" },
    fields: [
      ["testrail_host", "Host", "url", "https://firma.testrail.io"],
      ["testrail_user", "E-posta", "email"],
      ["testrail_api_key", "API anahtarı", "password"],
      ["testrail_project_id", "Proje id", "text"],
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
      ["web_concurrency", "Bu sunucuda aynı anda açık en fazla tarayıcı", "number", "2", "Tüm web koşumlarının toplam Chrome sayısı. Dolunca yeni koşum sırada bekler. Önerilen: 2 GB RAM başına 1; bilgisayar yavaşsa 1."],
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

function settingsCard(section, data) {
  const result = h("span", { class: "result", role: "status" });
  const form = h("form", { class: "card", id: `s-${section.id}`, novalidate: true },
    h("div", { class: "card-body" },
      sectionHeader(section.title, section.lead),
      section.note ? h("div", { class: "settings-note" }, icon("check"), h("p", {}, section.note)) : null,
      h("div", { class: "grid-2" }, section.fields.map(([name, label, type, placeholder, help]) => inputField(name, label, type, data[name], placeholder, help))),
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
        registered: " · ADB anahtarı Farm'a kaydedildi",
        exists: " · ADB anahtarı Farm'da kayıtlı",
        missing: " · Bu sunucuda ADB yok, Android koşamaz",
      }[response.adbKey] ?? (String(response.adbKey || "").startsWith("failed") ? ` · ADB anahtarı kaydedilemedi: ${response.adbKey.slice(8)}` : "");
      result.className = response.adbKey === "missing" || String(response.adbKey || "").startsWith("failed") ? "result error" : "result ok";
      result.textContent = `Bağlantı başarılı${adbNote}`;
    } catch (err) {
      result.className = "result error";
      result.textContent = err.message;
    }
  }));
  return form;
}

function modelCard(settings) {
  const card = h("section", { class: "card", id: "s-model" });
  const status = state.model || {};

  const renderSummary = () => {
    const ms = status.midscene || {};
    const familySelect = h("select", { id: "f-midscene-family", name: "midscene_model_family" },
      h("option", { value: "" }, ms.detectedFamily ? `Otomatik (${ms.detectedFamily})` : "Otomatik (algılanamadı)"),
      (ms.families || []).map((family) => h("option", { value: family }, family)),
    );
    familySelect.value = ms.familySetting || "";
    const saveFamily = h("button", { type: "button", class: "btn secondary" }, "Kaydet");
    saveFamily.addEventListener("click", () => busy(saveFamily, async () => {
      try {
        await api("/api/settings", { method: "PUT", body: { midscene_model_family: familySelect.value } });
        toast("Midscene model ailesi kaydedildi.", "ok");
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
        sectionHeader("Model", `Midscene ${ms.version || "kurulu değil"} ekran sürüşü ve chat agent'ı aynı model kaydını kullanır.`, stateBadge),
        status.ready
          ? h("dl", { class: "kv" },
            h("dt", {}, "Sağlayıcı"), h("dd", {}, status.providerLabel || status.provider),
            h("dt", {}, "Model"), h("dd", {}, status.modelName),
            h("dt", {}, "Adres"), h("dd", {}, status.baseUrl || "—"),
            status.keyMask ? [h("dt", {}, "Anahtar"), h("dd", {}, status.keyMask)] : null,
            h("dt", {}, "Midscene ailesi"), h("dd", {}, ms.family || "—"),
          )
          : h("p", { class: "muted" }, "Henüz model bağlanmadı. Web koşumları bu durumda engellenir."),
        status.ready && ms.error ? h("p", { class: "notice error", role: "alert" }, ms.error) : null,
        status.ready
          ? h("div", { class: "field" },
            h("label", { for: "f-midscene-family" }, "Midscene model ailesi"),
            h("div", { class: "inline-form" }, familySelect, saveFamily),
            h("p", { class: "hint" }, "Midscene ekranda öğe bulmak için modelin ailesini bilmelidir. Otomatik seçenek model adından algılar."))
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
    const models = h("div", { class: "model-list", role: "group", "aria-label": "Bulunan modeller" });
    const error = h("p", { class: "notice error", role: "alert", hidden: true });
    const manual = inputField("model", "Model adı", "text", settings.model_name || "", "listeden seç veya elle yaz");
    const listButton = h("button", { type: "button", class: "btn secondary" }, "Modelleri getir");
    const form = h("form", { class: "card", id: "s-model", novalidate: true },
      h("div", { class: "card-body" },
        sectionHeader(status.ready ? "Modeli değiştir" : "Model bağla", "Sağlayıcıyı seç, anahtarı yaz, modelleri getir ve birini kullan."),
        h("div", { class: "field" }, h("label", { for: "f-provider" }, "Sağlayıcı"), select),
        fields, hint, models, manual, error,
      ),
      h("div", { class: "card-foot" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { form.replaceWith(card); renderSummary(); } }, "Vazgeç"),
        listButton,
        h("button", { type: "submit", class: "btn primary" }, "Bu modeli kullan"),
      ),
    );

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
    select.addEventListener("change", () => { models.replaceChildren(); paint(); });
    paint();

    listButton.addEventListener("click", () => busy(listButton, async () => {
      error.hidden = true;
      try {
        const result = await api("/api/models/list", { method: "POST", body: payload() });
        models.replaceChildren(...result.models.map((item) => {
          const button = h("button", { type: "button", "aria-pressed": "false" }, item.label === item.id ? item.id : `${item.label} · ${item.id}`);
          button.addEventListener("click", () => {
            form.elements.model.value = item.id;
            models.querySelectorAll("button").forEach((node) => node.setAttribute("aria-pressed", String(node === button)));
          });
          return button;
        }));
        if (!result.models.length) {
          error.textContent = "Liste boş döndü. Model adını elle yazıp kullanabilirsin.";
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
        const body = { ...payload(), model: form.elements.model.value.trim() };
        if (!body.model) {
          error.textContent = "Bir model seç veya adını yaz.";
          error.hidden = false;
          return;
        }
        try {
          await api("/api/models/select", { method: "POST", body });
          toast(`${body.model} bağlandı.`, "ok");
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
    cards.splice(general, 0, sourcesCard());
    body.replaceChildren(modelCard(data), ...cards);
    const titles = SECTIONS.map((section) => [section.id, section.title]);
    titles.splice(general, 0, ["sources", "Test hesap kaynakları"]);
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
  try { value = JSON.parse(text); } catch { throw new Error(`${label}: geçerli JSON değil`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: bir JSON nesnesi olmalı ({ ... })`);
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
          ? `${source.accounts.total} hesap · ${source.accounts.available} kullanılabilir · ${source.use_mode === "once" ? "tek kullanımlık" : "tekrar kullanılabilir"}`
          : `${source.base_url || "adres yok"} · ${AUTH_LABEL[source.spec.auth.type]}`),
        source.used_by.length ? h("div", { class: "sub" }, `Kullanan: ${source.used_by.join(", ")}`) : null,
      ),
      h("td", { class: "hide-sm" }, SOURCE_TYPE_LABEL[source.type]),
      h("td", { class: "hide-sm" }, source.client_name || h("span", { class: "muted" }, "Tüm client'lar")),
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
            if (!confirm(`"${source.name}" kaynağı ve içindeki hesaplar silinsin mi? Bu geri alınamaz.`)) return;
            await busy(event.currentTarget, async () => {
              try {
                await api(`/api/sources/${source.id}`, { method: "DELETE" });
                toast("Kaynak silindi.", "ok");
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

function paintSourceDialog() {
  const type = $("src-type").value;
  const auth = $("src-auth-type").value;
  document.querySelectorAll("#source-form [data-type]").forEach((node) => { node.hidden = node.dataset.type !== type; });
  document.querySelectorAll("#source-form [data-auth]").forEach((node) => { node.hidden = !node.dataset.auth.split(" ").includes(auth); });
  $("src-template-field").hidden = type !== "http" || sourceDialog.mode !== "create";
  $("src-test").textContent = type === "manual" ? "Listeyi kontrol et" : "Bağlantıyı dene";
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
  $("source-dialog-title").textContent = { create: "Yeni hesap kaynağı", clone: "Kaynağı kopyala", edit: "Hesap kaynağını düzenle" }[mode];
  $("source-dialog-lead").textContent = mode === "clone"
    ? `"${source.name}" kopyalanıyor; giriş bilgileri ve hesaplar da kopyalanır.`
    : "Test kullanıcılarının nereden alınacağını tanımla. Her proje kendi servisini veya kendi listesini kullanabilir.";
  $("src-scope").replaceChildren(h("option", { value: "" }, "Tüm client'lar (ortak)"), ...sourceDialog.clients.map((client) => h("option", { value: client.id }, client.name)));
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
        h("span", { class: "muted small" }, `${used} hesap kullanıldı olarak işaretli.`),
        h("button", {
          type: "button",
          class: "btn secondary sm",
          onclick: (event) => busy(event.currentTarget, async () => {
            const { reset } = await api(`/api/sources/${source.id}/reset`, { method: "POST" });
            toast(`${reset} hesap tekrar kullanılabilir.`, "ok");
            $("src-accounts-state").replaceChildren();
            sourceDialog.onSaved?.();
          }),
        }, "Kullanılanları sıfırla"),
      );
    }
  }
  $("src-test-result").hidden = true;
  $("src-save").textContent = mode === "edit" ? "Kaydet" : "Oluştur";
  paintSourceDialog();
  $("source-dialog").showModal();
  $("src-name").focus();
  if (mode === "clone") $("src-name").select();
}

function sourceBody() {
  const type = $("src-type").value;
  const extras = Object.fromEntries($("src-extras").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`Ek alan satırı "ad=alan" biçiminde olmalı: ${line}`);
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
      toast({ edit: "Kaynak güncellendi.", create: "Kaynak oluşturuldu.", clone: "Kaynak kopyalandı." }[sourceDialog.mode], "ok");
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
      const role = h("select", { "aria-label": `${person.email} için rol` }, h("option", { value: "user" }, "user"), h("option", { value: "admin" }, "admin"));
      role.value = person.role === "admin" ? "admin" : "user";
      const act = (kind, button) => busy(button, async () => {
        try {
          await api(`/api/users/${person.id}/${kind}`, { method: "POST", body: kind === "approve" ? { role: role.value } : {} });
          toast(kind === "approve" ? `${person.email} ${role.value} olarak onaylandı.` : `${person.email} reddedildi.`, "ok");
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

api("/api/me").then(enter).catch(showGate);
