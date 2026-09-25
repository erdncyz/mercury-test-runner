import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.platform === "win32" ? "adb.exe" : "adb";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The copy that `npm run setup` downloads comes first so every installation uses a known ADB.
export function adbCandidates(env = process.env) {
  const list = [];
  if (env.MERCURY_ADB_PATH) list.push(env.MERCURY_ADB_PATH);
  list.push(join(root, "tools", "platform-tools", binary));
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) if (sdk) list.push(join(sdk, "platform-tools", binary));
  if (process.platform === "darwin") list.push(join(homedir(), "Library", "Android", "sdk", "platform-tools", binary));
  for (const dir of String(env.PATH || "").split(delimiter)) if (dir) list.push(join(dir, binary));
  return list;
}

export function resolveAdb(env = process.env) {
  return adbCandidates(env).find((path) => existsSync(path)) || "";
}

export function adbPublicKey() {
  try {
    return readFileSync(join(homedir(), ".android", "adbkey.pub"), "utf8").trim();
  } catch {
    return "";
  }
}

async function adb(args, timeout = 30_000, path = resolveAdb()) {
  if (!path) throw new Error("ADB kurulu değil. Sunucuda `npm run setup` çalıştır.");
  try {
    const { stdout, stderr } = await execFileAsync(path, args, { timeout });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`.trim();
    const wrapped = new Error(output || error.message);
    wrapped.output = output;
    throw wrapped;
  }
}

// Starting the server also creates ~/.android/adbkey(.pub) on first use.
export async function ensureAdbServer() {
  await adb(["start-server"]);
  return adbPublicKey();
}

// Farm's ADB proxy rejects adb's first (signature) auth round and accepts the public key that follows, so
// `adb connect` prints "failed to authenticate" and the transport is briefly "unauthorized" before it turns
// "device" (~0.5 s). Both are only final if the device never becomes ready.
export async function adbConnect(target, { attempts = 30, intervalMs = 500, path = resolveAdb() } = {}) {
  const output = await adb(["connect", target], 30_000, path).catch((error) => error.output || error.message);
  const authPending = /failed to authenticate/i.test(output);
  if (!authPending && !/connected to|already connected/i.test(output)) {
    await adbDisconnect(target, path);
    throw new Error(`adb connect ${target} başarısız: ${output}`);
  }
  let state = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await adb(["-s", target, "get-state"], 10_000, path).catch((error) => error.output || error.message);
    if (/^device$/m.test(state)) return;
    await wait(intervalMs);
  }
  // Leaving the transport behind keeps an "offline"/"unauthorized" entry in `adb devices` that adb retries forever.
  await adbDisconnect(target, path);
  if (authPending || /unauthorized/i.test(state)) {
    throw new Error("Cihaz bu sunucunun ADB anahtarını reddetti. Ayarlar → Mercury Farm → 'Bağlantıyı dene' anahtarı Farm'a kaydeder.");
  }
  throw new Error(`${target} ADB üzerinden hazır olmadı`);
}

export async function adbDisconnect(target, path = resolveAdb()) {
  await adb(["disconnect", target], 10_000, path).catch(() => {});
}

// Farm devices may sit with the display off, dozing or on a swipe lock screen; screenshots are then black and the
// AI has nothing to act on. KEYCODE_WAKEUP is a no-op on an awake screen (unlike POWER, it never turns it off) and
// `wm dismiss-keyguard` only lifts a non-secure lock screen, so both are safe to send before every step.
export async function wakeScreen({ adbPath, serial }) {
  await adb(["-s", serial, "shell", "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"], 10_000, adbPath);
}

// Records the device screen for one case. Android's `screenrecord` stops by itself after 3 minutes, so a
// segment that ends on its own is followed by a new one. Recording is best effort: any failure means no video.
// Stopping sends SIGINT on the device, which lets screenrecord finish the MP4 properly before it is pulled.
export function startScreenRecord({ adbPath, serial, name, spawnImpl = spawn, minSegmentMs = 5_000 }) {
  const segments = [];
  let stopping = false;
  let current = null;
  const begin = () => {
    const remote = `/sdcard/mercury-${name}-${segments.length + 1}.mp4`;
    segments.push(remote);
    const startedAt = Date.now();
    const child = spawnImpl(adbPath, ["-s", serial, "shell", "screenrecord", "--bit-rate", "4000000", remote], { stdio: "ignore" });
    const exited = new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(-1));
    });
    current = { child, exited };
    // Only a clean exit after a real recording is the time limit; a quick or failed exit is not retried.
    exited.then((code) => { if (!stopping && code === 0 && Date.now() - startedAt > minSegmentMs) begin(); });
  };
  begin();
  return {
    async stop(outDir, key) {
      stopping = true;
      await adb(["-s", serial, "shell", "pkill -INT screenrecord || kill -2 $(pidof screenrecord)"], 10_000, adbPath).catch(() => {});
      const finished = await Promise.race([current.exited.then(() => true), wait(10_000).then(() => false)]);
      if (!finished) {
        current.child.kill("SIGINT");
        await Promise.race([current.exited, wait(3_000)]);
      }
      const files = [];
      for (const [index, remote] of segments.entries()) {
        const file = `video-${key}${segments.length > 1 ? `-${index + 1}` : ""}.mp4`;
        const local = join(outDir, file);
        try {
          await adb(["-s", serial, "pull", remote, local], 180_000, adbPath);
          if (existsSync(local) && statSync(local).size > 0) files.push(file);
        } catch { /* a missing or unreadable segment only means less video */ }
        await adb(["-s", serial, "shell", "rm", "-f", remote], 10_000, adbPath).catch(() => {});
      }
      return files;
    },
  };
}
