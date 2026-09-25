#!/usr/bin/env node
// Makes the runtime match package.json: pinned npm packages (Midscene, Playwright) and the
// Chromium build that the installed Playwright expects. Runs before `npm start`, so pulling a
// new Mercury Test Runner version that bumps Midscene updates it on the next start.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const log = (message) => console.log(`[setup] ${message}`);

if (process.env.MERCURY_SKIP_SETUP === "1") {
  log("MERCURY_SKIP_SETUP=1, atlandı");
  process.exit(0);
}

function installedVersion(name) {
  try {
    return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function run(command, args) {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

const stale = Object.entries(pkg.dependencies || {}).filter(([name, wanted]) => installedVersion(name) !== wanted);
if (stale.length) {
  for (const [name, wanted] of stale) log(`${name}: kurulu ${installedVersion(name) || "yok"}, beklenen ${wanted}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const ok = (existsSync(join(root, "package-lock.json")) && run(npm, ["ci", "--no-audit", "--no-fund"]))
    || run(npm, ["install", "--no-audit", "--no-fund"]);
  if (!ok) {
    console.error("[setup] Paketler kurulamadı. İnternet bağlantısını kontrol edip `npm run setup` çalıştır.");
    process.exit(1);
  }
}

const require = createRequire(join(root, "package.json"));
let executable = "";
try {
  executable = require("playwright").chromium.executablePath();
} catch (error) {
  console.error(`[setup] Playwright yüklenemedi: ${error.message}`);
  process.exit(1);
}
if (!existsSync(executable)) {
  log(`Playwright ${installedVersion("playwright")} için Chromium kuruluyor`);
  if (!run(process.execPath, [join(root, "node_modules", "playwright", "cli.js"), "install", "chromium"])) {
    console.error("[setup] Chromium kurulamadı. Linux'ta sistem kütüphaneleri için: npx playwright install --with-deps chromium");
    process.exit(1);
  }
}

log(`hazır: Midscene ${installedVersion("@midscene/web")}, Playwright ${installedVersion("playwright")}`);

// npm may skip dependency install scripts; @midscene/android ships ffmpeg without the execute bit.
for (const dir of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
  const ffmpeg = join(root, "node_modules", "@ffmpeg-installer", dir, "ffmpeg");
  if (existsSync(ffmpeg)) chmodSync(ffmpeg, 0o755);
}

// Android farm devices are driven through `adb connect`, so every installation needs an ADB client.
const { resolveAdb } = await import("../src/adb.mjs");
if (!resolveAdb()) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const tools = join(root, "tools");
  const archive = join(tools, "platform-tools.zip");
  try {
    if (!os) throw new Error(`${process.platform} desteklenmiyor`);
    mkdirSync(tools, { recursive: true });
    log("Android platform-tools (ADB) indiriliyor");
    const response = await fetch(`https://dl.google.com/android/repository/platform-tools-latest-${os}.zip`);
    if (!response.ok) throw new Error(`indirme ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const extracted = (process.platform !== "win32" && run("unzip", ["-q", "-o", archive, "-d", tools])) || run("tar", ["-xf", archive, "-C", tools]);
    rmSync(archive, { force: true });
    if (!extracted || !resolveAdb()) throw new Error("arşiv açılamadı");
    if (process.platform !== "win32") chmodSync(join(tools, "platform-tools", "adb"), 0o755);
  } catch (error) {
    console.warn(`[setup] ADB kurulamadı (${error.message}). Android koşumları için ANDROID_HOME veya MERCURY_ADB_PATH ayarla.`);
  }
}
const adbPath = resolveAdb();
if (adbPath) {
  // The first start creates ~/.android/adbkey.pub, which the farm must know (Ayarlar → Mercury Farm → Bağlantıyı dene).
  spawnSync(adbPath, ["start-server"], { stdio: "ignore" });
  log(`ADB hazır: ${adbPath}`);
}
log(`Midscene Android ${installedVersion("@midscene/android") || "yok"}, iOS ${installedVersion("@midscene/ios") || "yok"}`);
