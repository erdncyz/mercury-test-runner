import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

async function adb(args, timeout = 30_000) {
  const path = resolveAdb();
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

export async function adbConnect(target, { attempts = 30 } = {}) {
  const output = await adb(["connect", target]);
  if (!/connected to|already connected/i.test(output)) throw new Error(`adb connect ${target} başarısız: ${output}`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await adb(["-s", target, "get-state"], 10_000).catch((error) => error.output || error.message);
    if (/^device$/m.test(state)) return;
    if (/unauthorized/i.test(state)) {
      throw new Error("Cihaz bu sunucunun ADB anahtarını reddetti. Ayarlar → Mercury Farm → 'Bağlantıyı dene' anahtarı Farm'a kaydeder.");
    }
    await wait(500);
  }
  throw new Error(`${target} ADB üzerinden hazır olmadı`);
}

export async function adbDisconnect(target) {
  await adb(["disconnect", target], 10_000).catch(() => {});
}
