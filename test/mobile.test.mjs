import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NoFreeDeviceError, deviceLabel, devicesNamedIn, listDevices, matchesDeviceFilter, parseWdaUrl, registerAdbKey, releaseDevice,
  reportScenarios, reserveDevice, reserveDevices, useDevice,
} from "../src/farm.mjs";
import { runMobileCases } from "../src/midscene.mjs";
import { openDb, seed } from "../src/db.mjs";
import { createWorker } from "../src/worker.mjs";

const requests = [];
let busySerials = new Set();
let flakyFailures = 0;
let lateOwned = new Set();
const devices = [
  { serial: "HW-1", manufacturer: "HUAWEI", model: "ELE-L29", marketName: "P30", version: "10", present: true, ready: true, status: 3, owner: null },
  { serial: "HW-2", manufacturer: "HUAWEI", model: "VOG-L29", marketName: "P30 Pro", version: "10", present: true, ready: true, status: 3, owner: null },
  { serial: "PX-1", manufacturer: "Google", model: "Pixel 7", version: "14", present: true, ready: true, status: 3, owner: null },
  { serial: "IP-1", manufacturer: "Apple", platform: "iOS", model: "iPhone14,5", marketName: "iPhone 13", version: "17.4", present: true, ready: true, status: 3, owner: null },
];

const farm = createServer(async (req, res) => {
  const url = new URL(req.url, "http://farm");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
  const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (url.pathname === "/api/v1/devices") return reply(200, { devices });
  if (url.pathname === "/api/v1/autotests" && req.method === "GET") {
    const serial = url.searchParams.get("serials");
    if (serial) {
      const wanted = serial.split(",");
      if (wanted.some((item) => busySerials.has(item))) return reply(409, { description: "Conflicts Information" });
      return reply(200, { group: { id: `g-${serial}`, devices: wanted.map((item) => devices.find((entry) => entry.serial === item)) } });
    }
    if (url.searchParams.get("type") === "ios") return reply(409, { description: "Cant create group. Not enough free devices" });
    return reply(200, { group: { id: "g-any", devices: [devices[2]] } });
  }
  if (url.pathname === "/api/v1/autotests" && req.method === "DELETE") return reply(200, { success: true });
  if (url.pathname === "/api/v1/autotests/useDevice" && body.serial === "FLAKY" && flakyFailures-- > 0) {
    return reply(504, { description: "Device is not responding (failed to connect to device)" });
  }
  if (url.pathname === "/api/v1/autotests/useDevice" && body.serial === "GONE") return reply(404, { description: "Device not found" });
  // Farm's useDevice can time out after already giving the device to our group; its next useDevice then answers 403.
  if (url.pathname === "/api/v1/autotests/useDevice" && ["LATE", "NOTUNNEL"].includes(body.serial) && !lateOwned.has(body.serial)) {
    lateOwned.add(body.serial);
    return reply(504, { description: "Device is not responding (failed to join group)" });
  }
  if (url.pathname === "/api/v1/autotests/useDevice" && ["LATE", "NOTUNNEL", "TAKEN"].includes(body.serial)) {
    return reply(403, { description: "Device is currently in use or not available" });
  }
  const single = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)$/);
  if (single) {
    const serial = single[1];
    const owner = lateOwned.has(serial) ? { email: "mercury@test.com", group: "g-late" } : serial === "TAKEN" ? { email: "mercury@test.com", group: "g-other" } : null;
    const tunnel = serial === "LATE" ? { remoteConnect: true, remoteConnectUrl: "10.0.0.5:8102" } : { remoteConnect: false, remoteConnectUrl: null };
    return reply(200, { device: { serial, owner, using: !!owner, ...tunnel } });
  }
  if (url.pathname === "/api/v1/user/devices/NOTUNNEL/remoteConnect") return reply(200, { remoteConnectUrl: "10.0.0.5:8103" });
  if (url.pathname === "/api/v1/autotests/useDevice") return reply(200, { remoteConnectUrl: body.serial === "IP-1" ? "10.0.0.5:8101" : "10.0.0.5:7401" });
  if (url.pathname.startsWith("/api/v1/builds/")) return reply(200, { success: true });
  if (url.pathname === "/api/v1/user/adbPublicKeys") return reply(409, { description: "Key already exists" });
  return reply(404, { description: "unknown" });
});
await new Promise((resolve) => farm.listen(0, "127.0.0.1", resolve));
const settings = { farm_base_url: `http://127.0.0.1:${farm.address().port}`, farm_token: "secret-token" };
after(() => farm.close());

test("konfigürasyon penceresi için Farm cihazları platform ve doluluk durumuyla listelenir", async () => {
  devices.push(
    { serial: "SM-1", manufacturer: "samsung", model: "SM-S911B", version: "14", present: true, ready: true, status: 3, owner: { email: "qa@acme.io" } },
    { serial: "SM-2", manufacturer: "samsung", model: "SM-A546B", present: false, ready: false, status: 1, owner: null },
  );
  try {
    requests.length = 0;
    const listed = await listDevices(settings);
    assert.equal(requests[0].query.target, "bookable");
    assert.deepEqual(listed.find((item) => item.serial === "IP-1"), { serial: "IP-1", platform: "ios", name: "iPhone 13", manufacturer: "Apple", version: "17.4", state: "free" });
    assert.deepEqual(listed.filter((item) => item.platform === "android").map((item) => [item.serial, item.state]), [
      ["HW-1", "free"], ["HW-2", "free"], ["PX-1", "free"], ["SM-1", "busy"], ["SM-2", "offline"],
    ]);
    await assert.rejects(listDevices({}), /Farm ayarı eksik/);
  } finally {
    devices.splice(-2);
  }
});

test("filtresiz rezervasyon platform tipini Farm'a iletir", async () => {
  requests.length = 0;
  const reservation = await reserveDevice(settings, { platform: "android", run: "demo #1", project: "demo" });
  assert.equal(reservation.groupId, "g-any");
  assert.equal(reservation.device.serial, "PX-1");
  assert.deepEqual(requests[0].query, { run: "demo #1", project: "demo", timeout: "1800", amount: "1", need_amount: "true", type: "android" });
  assert.equal(requests[0].auth, "Bearer secret-token");
});

test("cihaz filtresi üretici/model üzerinden eşleşir, dolu cihazı atlayıp seriyle ayırır", async () => {
  busySerials = new Set(["HW-1"]);
  requests.length = 0;
  const reservation = await reserveDevice(settings, { platform: "android", filter: "huawei", run: "r" });
  assert.equal(reservation.device.serial, "HW-2");
  assert.deepEqual(requests.filter((item) => item.query.serials).map((item) => item.query.serials), ["HW-1", "HW-2"]);
  busySerials = new Set(["HW-1", "HW-2"]);
  await assert.rejects(reserveDevice(settings, { platform: "android", filter: "huawei", run: "r" }), NoFreeDeviceError);
  await assert.rejects(reserveDevice(settings, { platform: "android", filter: "samsung", run: "r" }), (error) => !(error instanceof NoFreeDeviceError) && /tanımlı değil/.test(error.message));
  await assert.rejects(reserveDevice(settings, { platform: "ios", run: "r" }), NoFreeDeviceError);
  busySerials = new Set();
  assert.equal((await reserveDevice(settings, { platform: "ios", filter: "iphone 13", run: "r" })).device.serial, "IP-1");
});

test("useDevice Farm'ın geçici 'Device is not responding' yanıtını yeniden dener", async () => {
  requests.length = 0;
  flakyFailures = 2;
  assert.equal(await useDevice(settings, "FLAKY", { delayMs: 1 }), "10.0.0.5:7401");
  assert.equal(requests.length, 3);
  flakyFailures = 5;
  await assert.rejects(useDevice(settings, "FLAKY", { attempts: 2, delayMs: 1 }), /Farm cihaz bağlantısını açamadı \(2 deneme\): Device is not responding/);
  requests.length = 0;
  await assert.rejects(useDevice(settings, "GONE", { delayMs: 1 }), /^Error: Device not found$/);
  assert.equal(requests.length, 1);
  flakyFailures = 0;
});

test("useDevice zaman aşımında cihaz koşumun grubuna geçtiyse 403'te adresi cihazdan alır; başka grubun cihazında 403'ü iletir", async () => {
  lateOwned = new Set();
  requests.length = 0;
  assert.equal(await useDevice(settings, "LATE", { groupId: "g-late", delayMs: 1 }), "10.0.0.5:8102");
  assert.deepEqual(requests.map((item) => [item.method, item.path]), [
    ["POST", "/api/v1/autotests/useDevice"],
    ["POST", "/api/v1/autotests/useDevice"],
    ["GET", "/api/v1/devices/LATE"],
  ]);
  requests.length = 0;
  assert.equal(await useDevice(settings, "NOTUNNEL", { groupId: "g-late", delayMs: 1 }), "10.0.0.5:8103");
  assert.deepEqual(requests.map((item) => item.path).slice(-2), ["/api/v1/devices/NOTUNNEL", "/api/v1/user/devices/NOTUNNEL/remoteConnect"]);
  requests.length = 0;
  await assert.rejects(useDevice(settings, "TAKEN", { groupId: "g-late", delayMs: 1 }), (error) => error.status === 403 && error.message === "Device is currently in use or not available");
  assert.deepEqual(requests.map((item) => item.path), ["/api/v1/autotests/useDevice", "/api/v1/devices/TAKEN"]);
});

test("mesajdaki cihaz adı Farm cihazlarıyla tam kelime eşleşir; en uzun ad kazanır, aynı modelin hepsi havuza girer", () => {
  const farmDevices = [
    { serial: "A1", platform: "ios", name: "iPhone 17" },
    { serial: "A2", platform: "ios", name: "iPhone 17 Pro" },
    { serial: "S1", platform: "android", name: "Galaxy S25 Ultra\n" },
    { serial: "S2", platform: "android", name: "Galaxy S25+\n" },
    { serial: "H1", platform: "android", name: "HBP-LX9" },
    { serial: "H2", platform: "android", name: "HBP-LX9" },
    { serial: "P1", platform: "android", name: "Pixel" },
  ];
  assert.deepEqual(devicesNamedIn("iPhone 17 Pro'da giriş yap", farmDevices, "ios"), ["A2"]);
  assert.deepEqual(devicesNamedIn("iPhone 17'de giriş yap", farmDevices, "ios"), ["A1"]);
  assert.deepEqual(devicesNamedIn("Galaxy S25 Ultra'da aç", farmDevices, "android"), ["S1"]);
  assert.deepEqual(devicesNamedIn("Galaxy S25+ ile aç", farmDevices, "android"), ["S2"]);
  assert.deepEqual(devicesNamedIn("hbp-lx9 cihazında koş", farmDevices, "android"), ["H1", "H2"]);
  assert.deepEqual(devicesNamedIn("pixel'de aç", farmDevices, "android"), [], "tek kelimelik genel ad sabitlemez");
  assert.deepEqual(devicesNamedIn("iPhone 17 Pro'da aç", farmDevices, "android"), [], "başka platformun cihazı alınmaz");
});

test("useDevice, bırakma, senaryo ve ADB anahtarı Farm sözleşmesine uyar", async () => {
  requests.length = 0;
  assert.equal(await useDevice(settings, "HW-2"), "10.0.0.5:7401");
  await releaseDevice(settings, "g-1", "passed");
  await releaseDevice(settings, "g-2", "blocked");
  await reportScenarios(settings, "g-1", [{ name: "C1", status: "passed" }]);
  assert.equal(await registerAdbKey(settings, "QAAAA key@host"), "exists");
  assert.deepEqual(requests[0].body, { serial: "HW-2" });
  assert.deepEqual(requests[1].query, { group: "g-1", result: "passed" });
  assert.deepEqual(requests[2].query, { group: "g-2" });
  assert.deepEqual(requests[3].body, { scenarios: [{ name: "C1", status: "passed" }] });
  assert.equal(requests[4].body.title, "Mercury Test Runner");
  assert.deepEqual(parseWdaUrl("10.0.0.5:8101"), { host: "10.0.0.5", port: 8101 });
  assert.deepEqual(parseWdaUrl("http://wda.local"), { host: "wda.local", port: 8100 });
  assert.equal(deviceLabel(devices[3]), "iPhone 13 · iOS 17.4 · IP-1");
  assert.equal(matchesDeviceFilter(devices[0], "Huawei P30"), true);
});

function fakeSdk(calls, { failOn, options: seen = [] } = {}) {
  class Agent {
    constructor(device, options) { this.device = device; seen.push(options); calls.push(["agent", device.target, options.reportFileName]); }
    page = { screenshotBase64: async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
    async launch(uri) { calls.push(["launch", uri]); }
    async terminate(uri) { calls.push(["terminate", uri]); }
    async aiAct(text) { calls.push(["aiAct", text]); if (failOn === text) throw new Error("ekranda bulunamadı"); }
    async aiInput(locate, { value }) { calls.push(["aiInput", locate, value]); }
    async aiAssert(text) { calls.push(["aiAssert", text]); }
    async back() { calls.push(["back"]); }
    async destroy() { calls.push(["destroy"]); }
  }
  return {
    AndroidDevice: class { constructor(serial, options) { this.target = serial; calls.push(["device", serial, options.androidAdbPath]); } async connect() {} },
    AndroidAgent: Agent,
    IOSDevice: class { constructor(options) { this.target = `${options.wdaHost}:${options.wdaPort}`; } async connect() {} },
    IOSAgent: Agent,
  };
}

const mobileCase = {
  caseId: "7",
  title: "Giriş",
  steps: [
    { action: "launch", text: "{{launchUrl}}", args: { uri: "{{launchUrl}}" } },
    { action: "aiAct", text: "Giriş'e bas" },
    { action: "aiInput", text: "E-posta", args: { locate: "E-posta", value: "{{account.email}}" } },
    { action: "back", text: "" },
    { action: "aiAssert", text: "Üye alanı görünür" },
  ],
};

test("Midscene Android ajanı Farm cihazında adımları yürütür; her adımın ekranı ve ekran kaydı case'e bağlanır", async () => {
  const calls = [];
  const agentOptions = [];
  const reportDir = mkdtempSync(join(tmpdir(), "mtr-m-"));
  const outcome = await runMobileCases({
    platform: "android", connection: { serial: "10.0.0.5:7401" }, adbPath: "/x/adb", appId: "com.demo",
    runId: 5, cases: [mobileCase], vars: { launchUrl: "com.demo", account: { email: "qa@demo.com" } },
    model: { config: {} }, reportDir, sdk: fakeSdk(calls, { options: agentOptions }),
    recordScreen: (options) => {
      calls.push(["record", options.adbPath, options.serial, options.name]);
      return { stop: async (dir, key) => { calls.push(["record-stop", dir === reportDir, key]); return ["video-7-1.mp4", "video-7-2.mp4"]; } };
    },
    wake: async (options) => { calls.push(["wake", options.adbPath, options.serial]); },
  });
  assert.equal(outcome.results[0].status, "passed");
  assert.deepEqual(calls.slice(0, 7), [["device", "10.0.0.5:7401", "/x/adb"], ["agent", "10.0.0.5:7401", "run-5-case-7"], ["record", "/x/adb", "10.0.0.5:7401", "5-7"], ["wake", "/x/adb", "10.0.0.5:7401"], ["terminate", "com.demo"], ["wake", "/x/adb", "10.0.0.5:7401"], ["launch", "com.demo"]]);
  assert.equal(calls.filter((call) => call[0] === "wake").length, 1 + mobileCase.steps.length, "ekran case başında ve her adımdan önce uyandırılır");
  assert.match(agentOptions[0].aiContexts.default, /completely black/, "AI siyah ekranı uyku olarak bilir");
  assert.deepEqual(calls.find((call) => call[0] === "aiInput"), ["aiInput", "E-posta", "qa@demo.com"]);
  assert.ok(calls.some((call) => call[0] === "back"));
  assert.deepEqual(calls.find((call) => call[0] === "record-stop"), ["record-stop", true, "7"]);
  assert.deepEqual(outcome.results[0].files, { video: "video-7-1.mp4", videos: ["video-7-1.mp4", "video-7-2.mp4"] });
  assert.deepEqual(outcome.results[0].steps.map((step) => step.shot), ["shot-7-1.jpg", "shot-7-2.jpg", "shot-7-3.jpg", "shot-7-4.jpg", "shot-7-5.jpg"]);
  assert.deepEqual([...readFileSync(join(reportDir, "shot-7-1.jpg")).subarray(0, 2)], [0xff, 0xd8], "PNG ekran JPEG olarak saklanır");
});

test("iOS ajanı WDA adresine bağlanır, hata sonrası adımlar atlanır", async () => {
  const calls = [];
  const outcome = await runMobileCases({
    platform: "ios", connection: { host: "10.0.0.5", port: 8101 }, appId: "com.demo.ios",
    runId: 6, cases: [mobileCase], vars: { launchUrl: "com.demo.ios", account: { email: "a@b.c" } },
    model: { config: {} }, reportDir: mkdtempSync(join(tmpdir(), "mtr-m-")), sdk: fakeSdk(calls, { failOn: "Giriş'e bas" }),
    recordScreen: () => { throw new Error("iOS'ta ekran kaydı başlatılmamalı"); },
    wake: () => { throw new Error("iOS'ta ADB ile uyandırılmamalı"); },
  });
  const [result] = outcome.results;
  assert.equal(result.status, "failed");
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "failed", "skipped", "skipped", "skipped"]);
  assert.deepEqual(result.steps.map((step) => step.shot || ""), ["shot-7-1.jpg", "shot-7-2.jpg", "", "", ""], "başarısız adımın ekranı da alınır");
  assert.equal(calls[0][1], "10.0.0.5:8101");
});

function writeCases(count) {
  const dir = mkdtempSync(join(tmpdir(), "mtr-cases-"));
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(join(dir, `C${index}.yaml`), `testrailCaseId: ${index}
client: Örnek Proje
tags: [regression]
cases:
  - name: "Case ${index}"
    steps:
      - launch:
          uri: "{{launchUrl}}"
      - aiInput:
          locate: "E-posta"
          value: "{{account.email}}"
`);
  }
  return dir;
}

function workerFixture({ reserve, update = {}, caseCount = 0, settingsOverride = {}, accounts, runs = 1, platform = "android", runWebCases }) {
  const dir = mkdtempSync(join(tmpdir(), "mtr-w-"));
  const db = openDb(dir);
  seed(db);
  const changes = { account_policy: "none", package_id: "com.demo", app_url: "https://files/app.apk", device_filter: "Huawei", ...update };
  db.prepare(`UPDATE configs SET ${Object.keys(changes).map((key) => `${key} = ?`).join(", ")} WHERE platform = ?`).run(...Object.values(changes), platform);
  const config = db.prepare("SELECT * FROM configs WHERE platform = ?").get(platform);
  const runIds = Array.from({ length: runs }, () => Number(db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, message, created_at, device_hint)
     VALUES ('queued', 'Örnek Proje', ?, ?, ?, '', ?, 'P30')`,
  ).run(config.id, config.name, platform, new Date().toISOString()).lastInsertRowid));
  const calls = [];
  let remote = 7400;
  const worker = createWorker({
    db,
    settings: () => ({
      model_provider: "openai", model_name: "gpt-5", model_api_key: "k", web_concurrency: "2",
      ...settingsOverride,
    }),
    reportsDir: join(dir, "reports"),
    casesDir: caseCount ? writeCases(caseCount) : fileURLToPath(new URL("../cases", import.meta.url)),
    drivers: {
      farm: {
        reserveDevices: async (_, options) => { calls.push(["reserve", options.platform, options.filter, options.amount, options.serials]); return reserve(options); },
        installApp: async (_, serial, url) => calls.push(["install", serial, url]),
        useDevice: async (_, serial) => { calls.push(["use", serial]); remote += 1; return `10.0.0.5:${remote}`; },
        reportScenarios: async (_, group, scenarios) => calls.push(["scenarios", group, scenarios]),
        releaseDevice: async (_, group, result) => calls.push(["release", group, result]),
      },
      adb: {
        resolveAdb: () => "/x/adb",
        adbConnect: async (target) => calls.push(["adb-connect", target]),
        adbDisconnect: async (target) => calls.push(["adb-disconnect", target]),
      },
      accounts,
      runWebCases,
      runMobileCases: async (options) => {
        calls.push(["midscene", options.platform, options.connection.serial, options.appId, options.vars.launchUrl, options.cases.map((item) => item.caseId), options.vars.account.email, options.vars.account.pin]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { results: options.cases.map((item) => ({ status: "passed", message: "ok", steps: item.steps.map((step) => ({ ...step, status: "passed" })), files: {} })) };
      },
    },
  });
  return { db, worker, runId: runIds[0], runIds, calls };
}

test("worker Android koşumunu Farm cihazında baştan sona yürütür ve cihazı bırakır", async () => {
  const { db, worker, runId, calls } = workerFixture({ reserve: async () => ({ groupId: "g-9", devices: [devices[0]] }) });
  await worker.tick();
  await worker.idle();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  assert.equal(run.status, "passed");
  assert.equal(run.device_label, "P30 · Android 10 · HW-1");
  assert.deepEqual(calls.map((call) => call[0]), ["reserve", "install", "use", "adb-connect", "midscene", "adb-disconnect", "scenarios", "release"]);
  assert.equal(calls[0][2], "Huawei P30");
  assert.equal(calls[0][3], 1);
  assert.deepEqual(calls[4].slice(0, 5), ["midscene", "android", "10.0.0.5:7401", "com.demo", "com.demo"]);
  assert.deepEqual(calls.at(-1), ["release", "g-9", "passed"]);
  assert.equal(calls[6][2][0].status, "passed");
});

test("boş cihaz yoksa koşum hesap/satır tüketmeden kuyrukta bekler", async () => {
  const { db, worker, runId, calls } = workerFixture({ reserve: async () => { throw new NoFreeDeviceError("hepsi dolu"); } });
  await worker.tick();
  await worker.idle();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  assert.equal(run.status, "queued");
  assert.match(run.message, /Boş cihaz bekleniyor/);
  assert.ok(new Date(run.retry_at) > new Date());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_cases WHERE run_id = ?").get(runId).n, 0);
  assert.ok(!calls.some((call) => call[0] === "release"));
  await worker.tick();
  assert.equal(calls.filter((call) => call[0] === "reserve").length, 1);
});

test("UDID havuzuyla paralel koşum case'leri cihazlara böler, her hat ayrı kilitli kullanıcı alır", async () => {
  const handed = [];
  const accounts = {
    sourceById: (id) => ({ id, name: "Havuz" }),
    status: () => ({ ready: true, issue: "" }),
    acquire: async (source, options) => {
      const pool = [{ id: "u1", email: "u1@t" }, { id: "u2", email: "u2@t" }, { id: "u3", email: "u3@t" }];
      const account = pool.find((item) => !options.exclude.has(`${source.id}:${item.id}`));
      handed.push([account.id, options.filters, options.environment]);
      handed.push(["locked", account.id]);
      return { ...account, password: "x", phone: "", extras: { pin: "1234" }, lockKey: `${source.id}:${account.id}` };
    },
  };
  const { db, worker, runId, calls } = workerFixture({
    caseCount: 5,
    update: { parallel: 2, device_serials: JSON.stringify(["HW-1", "HW-2", "PX-1"]), account_policy: "required", account_source_id: 99, account_filters: JSON.stringify({ userPackage: "SPORT" }) },
    accounts,
    reserve: async (options) => ({ groupId: "g-p", devices: options.serials.slice(0, options.amount).map((serial) => devices.find((item) => item.serial === serial)) }),
  });
  await worker.tick();
  await worker.idle();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  assert.equal(run.status, "passed", run.message);
  assert.equal(run.lanes, 2);
  assert.deepEqual(calls[0].slice(3), [2, ["HW-1", "HW-2", "PX-1"]]);
  const lanes = calls.filter((call) => call[0] === "midscene");
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes.map((call) => call[5]).sort(), [["1", "3", "5"], ["2", "4"]]);
  assert.notEqual(lanes[0][6], lanes[1][6], "iki hat aynı kullanıcıyı almamalı");
  assert.deepEqual(handed.filter((item) => item[0] === "locked").length, 2, "kullanıcı alındığı anda kilitlenir");
  assert.deepEqual(handed[0].slice(1), [{ userPackage: "SPORT" }, "test"]);
  assert.equal(lanes[0][7], "1234", "kaynağın ek alanları {{account.*}} olarak iletilir");
  assert.equal(calls.filter((call) => call[0] === "release").length, 1);
  assert.equal(calls.find((call) => call[0] === "scenarios")[2].length, 5);
  assert.match(run.device_label, /HW-1.*\|.*HW-2/);
  assert.equal(run.account_email.split(", ").length, 2);
});

test("chat'te verilen UDID koşumu o cihaza sabitler; konfigürasyonun UDID listesi ve filtresi yerine geçer", async () => {
  const { db, worker, runId, calls } = workerFixture({
    caseCount: 3,
    update: { parallel: 2, device_serials: JSON.stringify(["HW-1", "HW-2"]) },
    reserve: async (options) => ({ groupId: "g-pin", devices: options.serials.slice(0, options.amount).map((serial) => devices.find((item) => item.serial === serial)) }),
  });
  db.prepare("UPDATE runs SET device_serials = ? WHERE id = ?").run(JSON.stringify(["PX-1"]), runId);
  await worker.tick();
  await worker.idle();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  assert.equal(run.status, "passed", run.message);
  assert.equal(run.lanes, 1, "tek UDID tek hat demektir");
  assert.deepEqual(calls[0].slice(3), [1, ["PX-1"]]);
  assert.deepEqual(calls.filter((call) => call[0] === "use"), [["use", "PX-1"]]);
});

test("web koşumları sunucunun tarayıcı sınırına uyar; hat sayısıyla hesaplanır", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const { db, worker, runIds } = workerFixture({
    platform: "web",
    caseCount: 2,
    runs: 2,
    update: { parallel: 2, launch_url: "https://example.com" },
    runWebCases: async (options) => {
      started.push(options.runId);
      await gate;
      return { results: options.cases.map((item) => ({ status: "passed", message: "ok", steps: item.steps.map((step) => ({ ...step, status: "passed" })), files: {} })) };
    },
  });
  await worker.tick();
  const status = (id) => db.prepare("SELECT status FROM runs WHERE id = ?").get(id).status;
  assert.equal(status(runIds[0]), "running");
  assert.equal(status(runIds[1]), "queued", "2 hatlık koşum 2 tarayıcılık sunucu sınırını doldurur");
  release();
  await worker.idle();
  await worker.tick();
  await worker.idle();
  assert.equal(status(runIds[1]), "passed");
  assert.equal(started.length, 4, "her koşum 2 hatla, sırayla");
});

test("geniş web koşumu tarayıcıları tek başına kapmaz; bekleyen diğer kullanıcı da hat alır", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const lanes = [];
  const { db, worker } = workerFixture({
    platform: "web",
    caseCount: 4,
    runs: 0,
    update: { parallel: 4, launch_url: "https://example.com" },
    settingsOverride: { web_concurrency: "3" },
    runWebCases: async (options) => {
      lanes.push([options.runId, options.cases.length]);
      await gate;
      return { results: options.cases.map((item) => ({ status: "passed", message: "ok", steps: item.steps.map((step) => ({ ...step, status: "passed" })), files: {} })) };
    },
  });
  const config = db.prepare("SELECT * FROM configs WHERE platform = 'web'").get();
  const wide = Number(db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, message, created_at, started_by)
     VALUES ('queued', 'Örnek Proje', ?, ?, 'web', '', ?, 1)`,
  ).run(config.id, config.name, new Date().toISOString()).lastInsertRowid);
  const small = Number(db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, message, created_at, scenario_json, started_by)
     VALUES ('queued', 'Anlık senaryo', NULL, 'Senaryo · Web', 'web', '', ?, ?, 2)`,
  ).run(new Date().toISOString(), JSON.stringify({ title: "aç", steps: [{ action: "launch", text: "{{launchUrl}}" }], launchUrl: "https://shop.test", packageId: "" })).lastInsertRowid);
  await worker.tick();
  const run = (id) => db.prepare("SELECT status, lanes FROM runs WHERE id = ?").get(id);
  assert.deepEqual({ ...run(wide) }, { status: "running", lanes: 2 }, "4 hat isteyen koşum 3 tarayıcının 2'sini alır");
  assert.deepEqual({ ...run(small) }, { status: "running", lanes: 1 }, "diğer kullanıcı beklemeden başlar");
  release();
  await worker.idle();
  assert.equal(run(wide).status, "passed");
  assert.deepEqual(lanes.filter(([id]) => id === wide).map(([, count]) => count), [2, 2], "4 case 2 hatta bölünür");
});

test("mobil koşumları Mercury sınırlamaz; sınırı Farm'daki boş cihazlar belirler", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { db, worker, runIds, calls } = workerFixture({
    caseCount: 2,
    runs: 3,
    update: { parallel: 2 },
    reserve: async (options) => { await gate; return { groupId: `g-${options.run}`, devices: [devices[0], devices[1]].slice(0, options.amount) }; },
  });
  await worker.tick();
  assert.deepEqual(runIds.map((id) => db.prepare("SELECT status FROM runs WHERE id = ?").get(id).status), ["running", "running", "running"]);
  release();
  await worker.idle();
  assert.equal(calls.filter((call) => call[0] === "reserve").length, 3);
});

test("boş cihaz bekleme süresi konfigürasyondan gelir", async () => {
  const { db, worker, runId } = workerFixture({
    update: { device_wait_minutes: 5 },
    reserve: async () => { throw new NoFreeDeviceError("hepsi dolu"); },
  });
  db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60_000).toISOString(), runId);
  await worker.tick();
  await worker.idle();
  const run = db.prepare("SELECT status, message FROM runs WHERE id = ?").get(runId);
  assert.equal(run.status, "failed");
  assert.match(run.message, /5 dk içinde boş cihaz bulunamadı/);
});

test("UDID havuzundan istenen sayıda boş cihaz tek grupta ayrılır, tanımsız UDID açık hata verir", async () => {
  busySerials = new Set();
  requests.length = 0;
  const reservation = await reserveDevices(settings, { platform: "android", amount: 2, serials: ["HW-2", "PX-1", "HW-1"], run: "r" });
  assert.deepEqual(reservation.devices.map((item) => item.serial), ["HW-2", "PX-1"]);
  assert.equal(requests.find((item) => item.query.serials).query.serials, "HW-2,PX-1");
  await assert.rejects(reserveDevices(settings, { platform: "android", amount: 1, serials: ["NOPE-1"], run: "r" }), /UDID bulunamadı: NOPE-1/);
  await assert.rejects(reserveDevices(settings, { platform: "android", amount: 4, serials: ["HW-1", "HW-2", "PX-1"], run: "r" }), NoFreeDeviceError);
});

test("chat senaryosu web'de tek case olarak koşar; adres senaryodan gelir, TestRail'e yazılmaz", async () => {
  const seen = [];
  const { db, worker } = workerFixture({
    platform: "web",
    runs: 0,
    update: { parallel: 3, launch_url: "https://example.com" },
    runWebCases: async (options) => {
      seen.push({ launchUrl: options.vars.launchUrl, cases: options.cases.map((item) => [item.caseId, item.title, item.steps.map((step) => step.action)]) });
      return { results: options.cases.map((item) => ({ status: "passed", message: "ok", steps: item.steps.map((step) => ({ ...step, status: "passed" })), files: {} })) };
    },
  });
  const steps = [{ action: "launch", text: "{{launchUrl}}" }, { action: "aiAct", text: "girişe tıkla" }, { action: "aiAssert", text: "form göründü" }];
  const runId = Number(db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, message, created_at, scenario_json)
     VALUES ('queued', 'Anlık senaryo', NULL, 'Senaryo · Web', 'web', '', ?, ?)`,
  ).run(new Date().toISOString(), JSON.stringify({ title: "shop.test'i aç", steps, launchUrl: "https://shop.test", packageId: "" })).lastInsertRowid);
  await worker.tick();
  await worker.idle();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  assert.equal(run.status, "passed");
  assert.equal(run.lanes, 1);
  assert.equal(run.testrail_run_id, "");
  assert.deepEqual(seen, [{ launchUrl: "https://shop.test", cases: [["", "shop.test'i aç", ["launch", "aiAct", "aiAssert"]]] }]);
  assert.deepEqual(JSON.parse(db.prepare("SELECT steps_json FROM run_cases WHERE run_id = ?").get(runId).steps_json).map((step) => step.status), ["passed", "passed", "passed"]);
});

test("chat senaryosu mobil konfigürasyonun cihaz ayarını kullanır, uygulamayı senaryodan açar ve tek cihaz ayırır", async () => {
  const { db, worker, calls } = workerFixture({ runs: 0, update: { parallel: 3 }, reserve: async () => ({ groupId: "g-s", devices: [devices[0]] }) });
  const config = db.prepare("SELECT * FROM configs WHERE platform = 'android'").get();
  const runId = Number(db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, message, created_at, device_hint, scenario_json)
     VALUES ('queued', 'Örnek Proje', ?, 'Senaryo · Android', 'android', '', ?, '', ?)`,
  ).run(config.id, new Date().toISOString(), JSON.stringify({ title: "oynat", steps: [{ action: "launch", text: "{{launchUrl}}" }, { action: "aiAct", text: "oynat" }], launchUrl: "", packageId: "com.other.app" })).lastInsertRowid);
  await worker.tick();
  await worker.idle();
  assert.equal(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId).status, "passed");
  const reserve = calls.find((call) => call[0] === "reserve");
  assert.deepEqual([reserve[2], reserve[3]], ["Huawei", 1], "konfigürasyonun filtresi, tek cihaz");
  assert.deepEqual(calls.find((call) => call[0] === "midscene").slice(3, 5), ["com.other.app", "com.other.app"]);
});

test("koşum sürerken gelen rapor bilgisi hemen kaydedilir; TestRail id'si olmayan case benzersiz dosya anahtarı alır", async () => {
  let midRun = null;
  const { db, worker } = workerFixture({
    platform: "web",
    runs: 0,
    update: { launch_url: "https://example.com" },
    runWebCases: async (options) => {
      const [item] = options.cases;
      const row = db.prepare("SELECT id FROM run_cases WHERE run_id = ?").get(options.runId);
      const steps = item.steps.map((step) => ({ ...step, status: "passed", shot: `shot-${item.fileKey}-1.jpg` }));
      options.onProgress(0, steps, { report: `midscene-${item.fileKey}.html` });
      midRun = { fileKey: item.fileKey, rowId: String(row.id), saved: db.prepare("SELECT files_json, steps_json FROM run_cases WHERE id = ?").get(row.id) };
      return { results: [{ status: "passed", message: "ok", steps, files: { report: `midscene-${item.fileKey}.html`, video: `video-${item.fileKey}.webm` } }] };
    },
  });
  const runId = Number(db.prepare(
    `INSERT INTO runs (status, client_name, config_id, config_name, platform, message, created_at, scenario_json)
     VALUES ('queued', 'Anlık senaryo', NULL, 'Senaryo · Web', 'web', '', ?, ?)`,
  ).run(new Date().toISOString(), JSON.stringify({ title: "aç", steps: [{ action: "launch", text: "{{launchUrl}}" }], launchUrl: "https://shop.test", packageId: "" })).lastInsertRowid);
  await worker.tick();
  await worker.idle();
  assert.equal(midRun.fileKey, midRun.rowId, "dosya anahtarı run_cases kaydının kimliği");
  assert.deepEqual(JSON.parse(midRun.saved.files_json), { report: `midscene-${midRun.fileKey}.html` }, "rapor bağlantısı koşum bitmeden kaydedilir");
  assert.equal(JSON.parse(midRun.saved.steps_json)[0].shot, `shot-${midRun.fileKey}-1.jpg`);
  const final = db.prepare("SELECT files_json FROM run_cases WHERE run_id = ?").get(runId);
  assert.deepEqual(JSON.parse(final.files_json), { report: `midscene-${midRun.fileKey}.html`, video: `video-${midRun.fileKey}.webm` });
});
