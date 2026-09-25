import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adbConnect, startScreenRecord, wakeScreen } from "../src/adb.mjs";

// Behaves like `adb` for the calls the recorder makes. A recording writes its file on the "device" (the state
// folder) and runs until `pkill -INT` creates the stop marker; FAKE_FIRST_SEGMENT_MS makes the first segment end
// by itself like Android's 3-minute limit, FAKE_UNSUPPORTED makes screenrecord fail immediately.
const FAKE_ADB = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_ADB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(args) + "\\n");
const cmd = args.slice(2);
const stop = path.join(dir, "stop");
if (cmd[0] === "shell" && cmd[1] === "screenrecord") {
  if (process.env.FAKE_UNSUPPORTED) process.exit(1);
  const remote = cmd[cmd.length - 1];
  const count = fs.readdirSync(dir).filter((name) => name.startsWith("dev-")).length;
  fs.writeFileSync(path.join(dir, "dev-" + path.basename(remote)), "mp4:" + path.basename(remote));
  if (count === 0 && process.env.FAKE_FIRST_SEGMENT_MS) setTimeout(() => process.exit(0), Number(process.env.FAKE_FIRST_SEGMENT_MS));
  else setInterval(() => { if (fs.existsSync(stop)) process.exit(0); }, 20);
} else if (cmd[0] === "shell" && /pkill -INT screenrecord/.test(cmd[1])) {
  fs.writeFileSync(stop, "");
} else if (cmd[0] === "pull") {
  const source = path.join(dir, "dev-" + path.basename(cmd[1]));
  if (!fs.existsSync(source)) { console.error("remote object does not exist"); process.exit(1); }
  fs.copyFileSync(source, cmd[2]);
} else if (cmd[0] === "shell" && cmd[1] === "rm") {
  fs.rmSync(path.join(dir, "dev-" + path.basename(cmd[3])), { force: true });
}
`;

function fakeAdb(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mtr-adb-"));
  const adbPath = join(dir, "fake-adb.cjs");
  writeFileSync(adbPath, FAKE_ADB);
  chmodSync(adbPath, 0o755);
  const state = mkdtempSync(join(tmpdir(), "mtr-dev-"));
  Object.assign(process.env, { FAKE_ADB_DIR: state, FAKE_FIRST_SEGMENT_MS: "", FAKE_UNSUPPORTED: "", ...env });
  const log = () => readFileSync(join(state, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { adbPath, state, log };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 10_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("beklenen durum oluşmadı");
    await wait(25);
  }
}

test("Android ekran kaydı 3 dk sınırında yeni parçayla sürer; durdurunca parçalar çekilip cihazdan silinir", async () => {
  const { adbPath, state, log } = fakeAdb({ FAKE_FIRST_SEGMENT_MS: "150" });
  const out = mkdtempSync(join(tmpdir(), "mtr-out-"));
  const recorder = startScreenRecord({ adbPath, serial: "10.0.0.5:7401", name: "9-41", minSegmentMs: 50 });
  // Wait for the second segment to be recording on the "device" instead of a fixed delay (slow machines).
  await until(() => readdirSync(state).includes("dev-mercury-9-41-2.mp4"));
  const files = await recorder.stop(out, "41");
  assert.deepEqual(files, ["video-41-1.mp4", "video-41-2.mp4"]);
  assert.equal(readFileSync(join(out, "video-41-2.mp4"), "utf8"), "mp4:mercury-9-41-2.mp4");
  const calls = log();
  assert.ok(calls.every((call) => call[0] === "-s" && call[1] === "10.0.0.5:7401"), "her komut yalnız o cihaza gider");
  assert.deepEqual(calls.filter((call) => call[3] === "screenrecord").map((call) => call.at(-1)), ["/sdcard/mercury-9-41-1.mp4", "/sdcard/mercury-9-41-2.mp4"]);
  assert.ok(calls.some((call) => /pkill -INT screenrecord/.test(call[3] || "")), "kayıt öldürülmez, INT ile kapatılır (MP4 bozulmaz)");
  assert.deepEqual(readdirSync(state).filter((name) => name.startsWith("dev-")), [], "cihazda kayıt dosyası kalmaz");
});

test("ekran kaydı desteklenmiyorsa yeniden denenmez ve video olmadan devam edilir", async () => {
  const { adbPath, log } = fakeAdb({ FAKE_UNSUPPORTED: "1" });
  const recorder = startScreenRecord({ adbPath, serial: "10.0.0.5:7402", name: "9-7", minSegmentMs: 0 });
  await until(() => { try { return log().some((call) => call[3] === "screenrecord"); } catch { return false; } });
  await wait(300);
  assert.deepEqual(await recorder.stop(mkdtempSync(join(tmpdir(), "mtr-out-")), "7"), []);
  assert.equal(log().filter((call) => call[3] === "screenrecord").length, 1, "hemen başarısız olan kayıt tekrar başlatılmaz");
});

// `adb connect` / `get-state` as the Farm proxy answers them: FAKE_CONNECT_OUT is what connect prints and
// get-state reports "unauthorized" for the first FAKE_UNAUTHORIZED_CALLS calls (FAKE_NEVER_READY: always).
const FAKE_CONNECT_ADB = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_ADB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "connect") { console.log(process.env.FAKE_CONNECT_OUT); process.exit(0); }
if (args[2] === "get-state") {
  const count = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").split("get-state").length - 1;
  if (process.env.FAKE_NEVER_READY || count <= Number(process.env.FAKE_UNAUTHORIZED_CALLS || 0)) {
    console.error("error: device unauthorized."); process.exit(1);
  }
  console.log("device");
}
`;

function fakeConnectAdb(env) {
  const dir = mkdtempSync(join(tmpdir(), "mtr-adbc-"));
  const adbPath = join(dir, "fake-adb.cjs");
  writeFileSync(adbPath, FAKE_CONNECT_ADB);
  chmodSync(adbPath, 0o755);
  const state = mkdtempSync(join(tmpdir(), "mtr-devc-"));
  Object.assign(process.env, { FAKE_ADB_DIR: state, FAKE_UNAUTHORIZED_CALLS: "", FAKE_NEVER_READY: "", ...env });
  const log = () => readFileSync(join(state, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { adbPath, log };
}

test("Farm'ın ilk kimlik turunu reddetmesi (failed to authenticate) cihaz hazır olunca hata sayılmaz", async () => {
  const { adbPath, log } = fakeConnectAdb({ FAKE_CONNECT_OUT: "failed to authenticate to 10.0.0.5:7401", FAKE_UNAUTHORIZED_CALLS: "2" });
  await adbConnect("10.0.0.5:7401", { path: adbPath, intervalMs: 10 });
  assert.deepEqual(log().map((args) => args.filter((arg) => arg !== "-s" && arg !== "10.0.0.5:7401")[0]), ["connect", "get-state", "get-state", "get-state"]);
});

test("cihaz hiç yetkilendirmezse anahtar hatası verilir ve bağlantı artığı temizlenir", async () => {
  const { adbPath, log } = fakeConnectAdb({ FAKE_CONNECT_OUT: "failed to authenticate to 10.0.0.5:7401", FAKE_NEVER_READY: "1" });
  await assert.rejects(adbConnect("10.0.0.5:7401", { path: adbPath, attempts: 3, intervalMs: 10 }), /ADB anahtarını reddetti/);
  assert.deepEqual(log().at(-1), ["disconnect", "10.0.0.5:7401"]);
});

test("adb connect bağlanamazsa çıktısıyla hemen başarısız olur", async () => {
  const { adbPath, log } = fakeConnectAdb({ FAKE_CONNECT_OUT: "failed to connect to 10.0.0.5:7401" });
  await assert.rejects(adbConnect("10.0.0.5:7401", { path: adbPath, intervalMs: 10 }), /adb connect 10\.0\.0\.5:7401 başarısız: failed to connect/);
  assert.deepEqual(log().map((args) => args[0]), ["connect", "disconnect"]);
});

test("uyuyan ekran KEYCODE_WAKEUP ile açılır ve basit kilit ekranı kaldırılır (POWER gibi kapatmaz)", async () => {
  const { adbPath, log } = fakeConnectAdb({});
  await wakeScreen({ adbPath, serial: "10.0.0.5:7401" });
  assert.deepEqual(log(), [["-s", "10.0.0.5:7401", "shell", "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"]]);
});
