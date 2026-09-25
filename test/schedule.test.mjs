import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dueSlot, lastSlot, nextRunAt, nextSlot, normalizeSchedule, parseSchedule, sameTiming } from "../src/schedule.mjs";

const at = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();

test("zamanlama girdisi doğrulanır; kapalı zamanlama eksik alanla da kaydedilir", () => {
  const input = normalizeSchedule({ enabled: true, everyDays: "2", time: "09:30", startDate: "2026-09-25", timeZone: "Europe/Istanbul" });
  assert.deepEqual(input, { enabled: true, everyDays: 2, time: "09:30", startDate: "2026-09-25", timeZone: "Europe/Istanbul" });
  assert.equal(normalizeSchedule(undefined).enabled, false);
  assert.equal(normalizeSchedule({ enabled: false, time: "saat" }).enabled, false);
  assert.throws(() => normalizeSchedule({ enabled: true, everyDays: 0, time: "09:00" }), /1–30 gün/);
  assert.throws(() => normalizeSchedule({ enabled: true, everyDays: 31, time: "09:00" }), /1–30 gün/);
  assert.throws(() => normalizeSchedule({ enabled: true, time: "25:00" }), /SS:DD/);
  assert.throws(() => normalizeSchedule({ enabled: true, time: "09:00", startDate: "2026-02-30" }), /YYYY-AA-GG/);
  assert.throws(() => normalizeSchedule({ enabled: true, time: "09:00", timeZone: "Mars/Olympus" }), /saat dilimi/);
  assert.equal(parseSchedule('{"enabled":false}'), null);
  assert.equal(parseSchedule("bozuk"), null);
  assert.ok(sameTiming(input, { ...input, since: "x", userId: 3 }), "başlangıç anı ve sahip zamanlamayı değiştirmez");
  assert.ok(!sameTiming(input, { ...input, time: "10:00" }));
});

test("her gün, 2 günde bir ve 3 günde bir koşum saatleri ilk günden sayılır ve saat dilimine göre hesaplanır", () => {
  const daily = normalizeSchedule({ enabled: true, everyDays: 1, time: "09:00", startDate: "2026-09-25", timeZone: "Europe/Istanbul" });
  assert.equal(iso(nextSlot(daily, at("2026-09-25T05:00:00Z"))), "2026-09-25T06:00:00.000Z", "İstanbul 09:00 = UTC 06:00");
  assert.equal(iso(nextSlot(daily, at("2026-09-25T06:00:00Z"))), "2026-09-26T06:00:00.000Z", "tam saat geçmiş sayılır");
  assert.equal(nextSlot(daily, at("2020-01-01T00:00:00Z")), at("2026-09-25T06:00:00Z"), "ilk günden önce ilk günün saati");

  const everyTwo = normalizeSchedule({ enabled: true, everyDays: 2, time: "23:30", startDate: "2026-09-25", timeZone: "UTC" });
  assert.equal(iso(nextSlot(everyTwo, at("2026-09-25T23:31:00Z"))), "2026-09-27T23:30:00.000Z");
  assert.equal(iso(nextSlot(everyTwo, at("2026-09-26T12:00:00Z"))), "2026-09-27T23:30:00.000Z", "aradaki gün atlanır");

  const everyThree = normalizeSchedule({ enabled: true, everyDays: 3, time: "02:00", startDate: "2026-09-25", timeZone: "UTC" });
  assert.equal(iso(nextSlot(everyThree, at("2026-09-25T02:00:00Z"))), "2026-09-28T02:00:00.000Z");
  assert.equal(iso(lastSlot(everyThree, at("2026-09-30T10:00:00Z"))), "2026-09-28T02:00:00.000Z");
  assert.equal(lastSlot(everyThree, at("2026-09-25T01:59:00Z")), null, "ilk saatten önce koşum yok");

  const newYork = normalizeSchedule({ enabled: true, everyDays: 1, time: "09:00", startDate: "2026-11-01", timeZone: "America/New_York" });
  assert.equal(iso(nextSlot(newYork, at("2026-10-31T00:00:00Z"))), "2026-11-01T14:00:00.000Z", "yaz saati bitince duvar saati korunur");
  assert.equal(iso(nextSlot(newYork, at("2026-11-01T15:00:00Z"))), "2026-11-02T14:00:00.000Z");
});

test("kaydedildikten sonra gelen ilk saat koşar, geçmiş saatler koşmaz; çok geç kalınan saat atlanır", () => {
  const schedule = { ...normalizeSchedule({ enabled: true, everyDays: 1, time: "09:00", startDate: "2026-09-20", timeZone: "UTC" }), since: "2026-09-25T10:00:00.000Z" };
  assert.equal(dueSlot(schedule, 0, at("2026-09-25T10:05:00Z")), null, "kayıttan önceki 09:00 koşmaz");
  assert.deepEqual(dueSlot(schedule, 0, at("2026-09-26T09:00:20Z")), { slot: at("2026-09-26T09:00:00Z"), action: "run" });
  assert.equal(dueSlot(schedule, at("2026-09-26T09:00:00Z"), at("2026-09-26T09:30:00Z")), null, "aynı saat iki kez koşmaz");
  assert.deepEqual(dueSlot(schedule, at("2026-09-26T09:00:00Z"), at("2026-09-27T11:00:00Z")), { slot: at("2026-09-27T09:00:00Z"), action: "skip" }, "sunucu saatlerce kapalıysa atlanır");
  assert.equal(nextRunAt(schedule, at("2026-09-26T09:00:00Z"), at("2026-09-26T12:00:00Z")), "2026-09-27T09:00:00.000Z");
  assert.equal(dueSlot(null, 0, Date.now()), null);
});

const dir = mkdtempSync(join(tmpdir(), "mtr-schedule-"));
const port = 20080 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(port), DATA_DIR: dir, REPORTS_DIR: join(dir, "reports"), MERCURY_SCHEDULE_INTERVAL_MS: "300" },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${port}`;
after(() => child.kill());

async function ready() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

test("konfigürasyon zamanlaması API ile kaydedilir, saati gelince zamanlanmış koşum açılır ve aynı saat tekrar koşmaz", async () => {
  await ready();
  const auth = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mercury@test.com", password: "Mercury" }),
  });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const call = (path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { "content-type": "application/json", cookie }, body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const web = (await call("/api/configs")).body.find((item) => item.name === "Web (Chrome)");

  const bad = await call(`/api/configs/${web.id}`, { method: "PUT", body: { schedule: { enabled: true, everyDays: 2, time: "9", timeZone: "UTC" } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /SS:DD/);

  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const startDate = now.toISOString().slice(0, 10);
  const saved = await call(`/api/configs/${web.id}`, { method: "PUT", body: { schedule: { enabled: true, everyDays: 2, time, startDate, timeZone: "UTC" } } });
  assert.equal(saved.status, 200);
  const listed = (await call("/api/configs")).body.find((item) => item.id === web.id);
  const stored = JSON.parse(listed.schedule_json);
  assert.deepEqual([stored.enabled, stored.everyDays, stored.time, stored.startDate, stored.timeZone], [true, 2, time, startDate, "UTC"]);
  assert.ok(stored.since && stored.userId, "kaydeden admin ve başlangıç anı saklanır");
  assert.ok(Date.parse(listed.schedule_next_at) > now.getTime(), "kayıttan önceki saat koşmaz; sonraki saat ileride");

  await call(`/api/configs/${web.id}`, { method: "PUT", body: { name: "Web (Chrome)" } });
  assert.equal(JSON.parse((await call("/api/configs")).body.find((item) => item.id === web.id).schedule_json).since, stored.since, "zamanlamaya dokunmayan kayıt başlangıcı değiştirmez");

  // Pretend the schedule was saved a minute before this slot so the scheduler sees it as due.
  const db = new DatabaseSync(join(dir, "mercury.sqlite"));
  db.prepare("UPDATE configs SET schedule_json = ? WHERE id = ?").run(JSON.stringify({ ...stored, since: new Date(now.getTime() - 120_000).toISOString() }), web.id);
  let runs = [];
  for (let i = 0; i < 40 && !runs.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    runs = (await call("/api/runs")).body.filter((item) => item.config_name === "Web (Chrome)");
  }
  assert.equal(runs.length, 1, "saati gelen zamanlama bir koşum açar");
  assert.match(runs[0].message, /^Zamanlanmış koşum/);
  assert.equal(runs[0].scheduled, true, "koşum listesinde zamanlanmış olarak işaretlenir");
  assert.equal(runs[0].status, "blocked", "ön kontrol aynı kurallarla işler (model yok)");
  const [listedSchedule] = (await call("/api/schedules")).body;
  assert.deepEqual([listedSchedule.config_id, listedSchedule.schedule.everyDays, listedSchedule.schedule.time, listedSchedule.last_run.id], [web.id, 2, time, runs[0].id]);
  assert.ok(Date.parse(listedSchedule.next_at) > Date.now(), "sonraki sıra ileride");
  assert.equal(listedSchedule.schedule.userId, undefined, "iç alanlar dönmez");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await call("/api/runs")).body.filter((item) => item.config_name === "Web (Chrome)").length, 1, "aynı saat ikinci kez koşmaz");
  const audits = db.prepare("SELECT action FROM audit WHERE actor = 'scheduler'").all().map((row) => row.action);
  assert.deepEqual(audits, ["schedule_run"]);

  const off = await call(`/api/configs/${web.id}`, { method: "PUT", body: { schedule: { enabled: false } } });
  assert.equal(off.status, 200);
  assert.equal((await call("/api/configs")).body.find((item) => item.id === web.id).schedule_next_at, null);
  assert.deepEqual((await call("/api/schedules")).body, [], "kapatılan zamanlama listeden çıkar");
  db.close();
});
