// Local stand-ins for everything a real web run touches: the application under test, a test-user
// service, TestRail and an OpenAI-compatible vision model. The model does not guess: it decodes the
// screenshot Midscene sends and answers from what is actually on screen (colour-coded page regions),
// so assertions pass or fail because of what the real browser really did.
import { createServer } from "node:http";
import sharp from "sharp";

export const USERS = [
  { id: "u1", email: "ayse@demo.test", password: "Ayse-Pass-1", phone: "5550000001", plan: "premium", isLocked: false },
  { id: "u2", email: "mehmet@demo.test", password: "Mehmet-Pass-2", phone: "5550000002", plan: "premium", isLocked: false },
  { id: "u3", email: "zeynep@demo.test", password: "Zeynep-Pass-3", phone: "5550000003", plan: "premium", isLocked: false },
  { id: "u4", email: "can@demo.test", password: "Can-Pass-4", phone: "5550000004", plan: "basic", isLocked: false },
];
const SERVICE = { username: "runner@demo.test", password: "Service-Secret-9", token: "tok-demo-42" };

// Layout at 1280×800 CSS pixels. The model maps element descriptions to these boxes and reads state
// from the colour of fixed regions.
const BOX = {
  email: [440, 220, 840, 264],
  password: [440, 300, 840, 344],
  login: [440, 380, 840, 428],
  cookie: [1080, 736, 1240, 784],
};
const COLOR = { login: [29, 78, 216], member: [21, 128, 61], error: [185, 28, 28], cookie: [217, 119, 6] };

export const state = { logins: [], testrail: { runs: [], plans: [], results: [] }, model: { calls: 0, kinds: {} }, lockedIds: [], fail: { testrail: false } };

function listen(handler, port) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    }
    try {
      await handler(req, res, body);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: error.message }));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(data));
};

function page(title, bar, content) {
  const [x1, , x2] = BOX.email;
  return `<!doctype html><html lang="tr"><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; } body { font: 16px system-ui, sans-serif; background: #fff; width: 1280px; height: 800px; overflow: hidden; }
  header { position: absolute; left: 0; top: 0; width: 1280px; height: 64px; background: rgb(${bar}); color: #fff; font-size: 22px; padding: 18px 24px; }
  .error { position: absolute; left: 0; top: 64px; width: 1280px; height: 40px; background: rgb(${COLOR.error}); color: #fff; padding: 9px 24px; }
  label { position: absolute; left: ${x1}px; font-size: 14px; color: #333; }
  input { position: absolute; left: ${x1}px; width: ${x2 - x1}px; height: 44px; font-size: 16px; padding: 0 12px; border: 1px solid #999; }
  button.login { position: absolute; left: ${x1}px; top: ${BOX.login[1]}px; width: ${x2 - x1}px; height: 48px; font-size: 18px; background: #111; color: #fff; border: 0; }
  #cookie { position: absolute; left: 0; top: 720px; width: 1280px; height: 80px; background: rgb(${COLOR.cookie}); color: #fff; padding: 28px 24px; }
  #cookie button { position: absolute; left: ${BOX.cookie[0]}px; top: 16px; width: 160px; height: 48px; font-size: 16px; }
  .member { position: absolute; left: 440px; top: 200px; font-size: 28px; }
</style>${content}</html>`;
}

async function site(req, res, body) {
  const url = new URL(req.url, "http://site");
  const session = /sid=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  if (req.method === "POST" && url.pathname === "/login") {
    const user = USERS.find((item) => item.email === body.email && item.password === body.password);
    state.logins.push({ email: body.email, ok: Boolean(user) });
    res.writeHead(303, user
      ? { location: "/member", "set-cookie": `sid=${encodeURIComponent(user.email)}; Path=/; HttpOnly` }
      : { location: "/?error=1" });
    return res.end();
  }
  if (url.pathname === "/member") {
    if (!session) { res.writeHead(303, { location: "/" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page("Üye alanı", COLOR.member, `<header>Demo Mağaza · Üye alanı</header><p class="member">Hoş geldin, ${decodeURIComponent(session)}</p>`));
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page("Giriş", COLOR.login, `<header>Demo Mağaza · Giriş yap</header>
${url.searchParams.get("error") ? '<div class="error">E-posta veya şifre hatalı</div>' : ""}
<form method="post" action="/login">
  <label style="top:196px" for="email">E-posta</label><input id="email" name="email" type="email" style="top:${BOX.email[1]}px">
  <label style="top:276px" for="password">Şifre</label><input id="password" name="password" type="password" style="top:${BOX.password[1]}px">
  <button class="login" type="submit">Giriş yap</button>
</form>
<div id="cookie">Bu site çerez kullanır.<button type="button" onclick="document.getElementById('cookie').remove()">Kabul et</button></div>`));
  }
  res.writeHead(404);
  res.end();
}

async function users(req, res, body) {
  const url = new URL(req.url, "http://users");
  if (req.method === "POST" && url.pathname === "/auth/login") {
    if (body.email !== SERVICE.username || body.password !== SERVICE.password) return json(res, 401, { message: "Servis hesabı hatalı" });
    return json(res, 200, { data: { accessToken: SERVICE.token } });
  }
  if (req.headers.authorization !== `Bearer ${SERVICE.token}`) return json(res, 401, { message: "Token yok" });
  if (req.method === "GET" && url.pathname === "/test-users") {
    const plan = url.searchParams.get("plan");
    const free = USERS.filter((user) => !user.isLocked && (!plan || user.plan === plan));
    return json(res, 200, { items: free.map(({ isLocked, ...user }) => user) });
  }
  const lock = url.pathname.match(/^\/test-users\/(\w+)$/);
  if (req.method === "PATCH" && lock) {
    const user = USERS.find((item) => item.id === lock[1]);
    if (!user) return json(res, 404, { message: "Kullanıcı yok" });
    user.isLocked = Boolean(body.isLocked);
    state.lockedIds.push(user.id);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { message: "Yol yok" });
}

async function testrail(req, res, body) {
  const route = decodeURIComponent(req.url.split("?")[1] || "");
  if (req.headers.authorization !== `Basic ${Buffer.from("qa@demo.test:tr-key").toString("base64")}`) return json(res, 401, { error: "Authentication failed" });
  if (route === "/api/v2/get_projects") return json(res, 200, { projects: [{ id: 1, name: "Demo" }] });
  if (state.fail.testrail) {
    res.writeHead(503, { "content-type": "text/html" });
    return res.end("<html><body><h1>503 Service Unavailable</h1></body></html>");
  }
  const run = route.match(/^\/api\/v2\/add_run\/(\d+)$/);
  if (run) {
    const id = 500 + state.testrail.runs.length + 1;
    state.testrail.runs.push({ id, project: Number(run[1]), ...body });
    return json(res, 200, { id });
  }
  if (/^\/api\/v2\/add_plan\/\d+$/.test(route)) {
    const id = 600 + state.testrail.plans.length + 1;
    state.testrail.plans.push({ id, ...body });
    return json(res, 200, { id });
  }
  const results = route.match(/^\/api\/v2\/add_results_for_cases\/(\d+)$/);
  if (results) {
    state.testrail.results.push({ runId: Number(results[1]), results: body.results });
    return json(res, 200, []);
  }
  return json(res, 400, { error: `Bilinmeyen uç: ${route}` });
}

// ---- Fake vision model ---------------------------------------------------------------------------

async function readScreen(messages) {
  const images = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "image_url").map((part) => part.image_url.url);
  const last = images.at(-1);
  if (!last) throw new Error("İstekte ekran görüntüsü yok");
  const image = sharp(Buffer.from(last.split(",")[1], "base64"));
  const { width } = await image.metadata();
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = width / 1280;
  const pixel = (x, y) => {
    const offset = (Math.round(y * scale) * info.width + Math.round(x * scale)) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  const is = (rgb, target) => rgb.every((value, index) => Math.abs(value - target[index]) < 40);
  const header = pixel(1200, 12);
  return {
    scale,
    login: is(header, COLOR.login),
    member: is(header, COLOR.member),
    error: is(pixel(1200, 84), COLOR.error),
    cookie: is(pixel(60, 790), COLOR.cookie),
  };
}

const box = (name, screen) => BOX[name].map((value) => Math.round(value * screen.scale));

function targetOf(text, screen) {
  const t = text.toLocaleLowerCase("tr");
  if (/kabul|çerez|cookie/.test(t)) return screen.cookie ? "cookie" : null;
  if (!screen.login) return null;
  if (/e-?posta|email|mail/.test(t)) return "email";
  if (/şifre|parola|password/.test(t)) return "password";
  if (/giriş|login|gönder/.test(t) && /buton|button|düğme/.test(t)) return "login";
  return null;
}

// Truth rules for the statements the demo cases assert, evaluated against the decoded screen.
function judge(statement, screen) {
  const s = statement.toLocaleLowerCase("tr");
  if (/hatalı|hata|uyarı/.test(s)) return screen.error;
  if (/oturum|üye alanı|hoş geldin|giriş yapılmış/.test(s)) return screen.member;
  if (/giriş formu|giriş sayfası/.test(s)) return screen.login;
  if (/çerez/.test(s)) return screen.cookie;
  return false;
}

const reply = (content) => ({
  id: `fake-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "gpt-5-mini",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});

async function model(req, res, body) {
  const url = new URL(req.url, "http://model");
  if (req.headers.authorization !== "Bearer fake-model-key") return json(res, 401, { error: { message: "Invalid API key" } });
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, { object: "list", data: [{ id: "gpt-5-mini", object: "model" }, { id: "text-only-model", object: "model" }] });
  }
  if (url.pathname !== "/v1/chat/completions") return json(res, 404, { error: { message: "unknown" } });
  state.model.calls += 1;
  const system = String(body.messages.find((message) => message.role === "system")?.content || "");
  const text = body.messages.flatMap((message) => (typeof message.content === "string" ? [message.content] : message.content.map((part) => part.text || ""))).join("\n");
  const screen = await readScreen(body.messages);
  const count = (kind) => { state.model.kinds[kind] = (state.model.kinds[kind] || 0) + 1; };

  if (system.includes("helps identify UI elements")) {
    count("locate");
    const find = /Find:\s*([^\n]+)/.exec(text)?.[1] || "";
    const target = targetOf(find, screen);
    return json(res, 200, reply(JSON.stringify(target ? { bbox: box(target, screen) } : { bbox: [], error: `"${find}" is not visible on the screen` })));
  }
  if (system.includes("DATA_DEMAND")) {
    count("insight");
    const statement = /whether the following statement is true:\s*([^"\n]+)/.exec(text)?.[1] || "";
    const truth = judge(statement, screen);
    return json(res, 200, reply(`<observation>login=${screen.login} member=${screen.member} error=${screen.error} cookie=${screen.cookie}</observation><data-json>{"StatementIsTruthy": ${truth}}</data-json>`));
  }
  if (system.includes("manipulate the UI")) {
    count("plan");
    const instruction = /<user_instruction>([\s\S]*?)<\/user_instruction>/.exec(text)?.[1] || "";
    if (/çerez|cookie/i.test(instruction) && screen.cookie) {
      return json(res, 200, reply(`<planning>A cookie banner is visible at the bottom; accept it.</planning><log>Çerez bandını kabul et</log><action-type>Tap</action-type><action-param-json>{"locate": {"prompt": "Kabul et düğmesi", "bbox": ${JSON.stringify(box("cookie", screen))}}}</action-param-json>`));
    }
    return json(res, 200, reply(`<planning>Nothing left to do for this instruction.</planning><complete success="true"></complete>`));
  }
  count("unknown");
  return json(res, 400, { error: { message: "Beklenmeyen istek türü" } });
}

export async function startFakes({ base = 18910 } = {}) {
  const servers = await Promise.all([listen(site, base + 1), listen(users, base + 2), listen(testrail, base + 3), listen(model, base + 4)]);
  return {
    urls: {
      site: `http://127.0.0.1:${base + 1}/`,
      users: `http://127.0.0.1:${base + 2}`,
      testrail: `http://127.0.0.1:${base + 3}`,
      model: `http://127.0.0.1:${base + 4}/v1`,
    },
    service: SERVICE,
    close: () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}
