import { fold } from "./agent.mjs";
import { farmRequest } from "./integrations.mjs";

// Farm answers 409 when no free device matches and 403 when the group quota is full; both mean "try later".
export class NoFreeDeviceError extends Error {}

const DEVICE_FIELDS = "serial,model,marketName,manufacturer,platform,version,name,present,ready,status,owner,using,ios";
const LABEL = { android: "Android", ios: "iOS" };

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  return search.toString();
}

function ensureConfigured(data) {
  if (data?.skipped) throw new Error(data.reason || "Farm ayarı eksik");
  return data;
}

export function devicePlatform(device) {
  const platform = String(device?.platform || "").toLowerCase();
  if (device?.ios === true || platform === "ios" || platform === "tvos") return "ios";
  if (String(device?.manufacturer || "").toLowerCase() === "apple") return "ios";
  return "android";
}

export function isFreeDevice(device) {
  return device.present !== false && device.ready !== false && !device.owner && !device.using
    && (device.status === undefined || device.status === 3);
}

export function matchesDeviceFilter(device, filter) {
  const words = fold(filter).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = fold([device.serial, device.model, device.marketName, device.manufacturer, device.name, device.version].join(" "));
  return words.every((word) => haystack.includes(word));
}

export function deviceLabel(device) {
  const name = device.marketName || device.model || device.name || "";
  return [name, device.version ? `${LABEL[devicePlatform(device)]} ${device.version}` : "", device.serial].filter(Boolean).join(" · ");
}

// Every device the token may book, for the configuration dialog's UDID picker.
export async function listDevices(settings, { timeoutMs } = {}) {
  const listed = ensureConfigured(await farmRequest(settings, `/api/v1/devices?${query({ target: "bookable", fields: DEVICE_FIELDS })}`, { timeoutMs }));
  return (listed.devices || []).filter((device) => device?.serial).map((device) => ({
    serial: String(device.serial),
    platform: devicePlatform(device),
    name: device.marketName || device.model || device.name || device.serial,
    manufacturer: device.manufacturer || "",
    version: device.version ? String(device.version) : "",
    state: device.present === false || device.ready === false ? "offline" : isFreeDevice(device) ? "free" : "busy",
  }));
}

// Serials of the `platform` devices a message names by model ("Galaxy S25 Ultra'da", "iPhone 17 Pro ile"). Names
// match on whole words and the longest name wins, so "iPhone 17 Pro" does not also pick "iPhone 17". Several
// devices of the same model all match; the run then takes whichever of them is free.
export function devicesNamedIn(text, devices, platform) {
  const folded = ` ${fold(text)} `;
  const named = devices
    .filter((device) => device.platform === platform)
    .map((device) => ({ serial: device.serial, needle: fold(device.name) }))
    .filter(({ needle }) => (/\d/.test(needle) || needle.includes(" ")) && folded.includes(` ${needle} `));
  const longest = Math.max(0, ...named.map(({ needle }) => needle.length));
  return named.filter(({ needle }) => needle.length === longest).map(({ serial }) => serial);
}

function captured(data, amount, known = []) {
  const group = data?.group || {};
  const devices = (group.devices || []).filter(Boolean).map((item) => {
    const device = typeof item === "string" ? { serial: item } : item;
    return { ...known.find((entry) => entry.serial === device.serial), ...device };
  });
  if (!group.id || devices.length < amount) throw new NoFreeDeviceError(`Farm ${amount} cihaz istedi, ${devices.length} döndü`);
  return { groupId: String(group.id), devices };
}

async function capture(settings, params, amount, known) {
  try {
    return captured(ensureConfigured(await farmRequest(settings, `/api/v1/autotests?${query(params)}`)), amount, known);
  } catch (error) {
    if (error instanceof NoFreeDeviceError || error.status === 409 || error.status === 403) {
      throw new NoFreeDeviceError(error.message);
    }
    throw error;
  }
}

// Reserves `amount` devices in one Farm group (one Builds entry, released once). Pool precedence:
// explicit UDIDs, then the text filter, then any free device of the platform. Farm's own `model`
// filter is an exact match, so filters are matched here and the chosen devices reserved by serial.
export async function reserveDevices(settings, { platform, amount = 1, serials = [], filter = "", run, project, timeoutSec = 1800 }) {
  const base = { run, project, timeout: timeoutSec };
  if (!serials.length && !fold(filter)) {
    return capture(settings, { ...base, amount, need_amount: true, type: platform }, amount);
  }
  const listed = ensureConfigured(await farmRequest(settings, `/api/v1/devices?${query({ target: "bookable", fields: DEVICE_FIELDS })}`));
  const known = (listed.devices || []).filter((device) => devicePlatform(device) === platform);
  let pool;
  if (serials.length) {
    const unknown = serials.filter((serial) => !known.some((device) => device.serial === serial));
    if (unknown.length) throw new Error(`Farm'da bu ${LABEL[platform]} UDID bulunamadı: ${unknown.join(", ")}`);
    pool = serials.map((serial) => known.find((device) => device.serial === serial));
  } else {
    pool = known.filter((device) => matchesDeviceFilter(device, filter));
    if (!pool.length) throw new Error(`Farm'da "${filter}" filtresine uyan ${LABEL[platform]} cihaz tanımlı değil`);
  }
  const free = pool.filter(isFreeDevice);
  // Another runner can grab a listed device first; slide over the free pool before giving up.
  for (let start = 0; start + amount <= free.length; start += 1) {
    try {
      return await capture(settings, { ...base, serials: free.slice(start, start + amount).map((device) => device.serial).join(",") }, amount, known);
    } catch (error) {
      if (!(error instanceof NoFreeDeviceError)) throw error;
    }
  }
  throw new NoFreeDeviceError(`${amount} boş ${LABEL[platform]} cihaz gerekiyor, havuzda ${free.length} boş cihaz var`);
}

export async function reserveDevice(settings, options) {
  const { groupId, devices } = await reserveDevices(settings, { ...options, amount: 1 });
  return { groupId, device: devices[0] };
}

// The Farm provider opens the device tunnel (ADB / WebDriverAgent) on demand and can briefly answer
// "Device is not responding (failed to connect to device)" while it comes up; such failures are retried.
function isTransientConnectError(error) {
  return error.status >= 500 || error.name === "TimeoutError" || /not responding|failed to connect/i.test(error.message);
}

function connectUrl(data) {
  if (!data.remoteConnectUrl) throw new Error("Farm cihaz bağlantı adresi döndürmedi");
  return String(data.remoteConnectUrl);
}

// A useDevice that times out (504) can still hand the device to our group, and Farm then refuses every further
// useDevice with 403 "Device is currently in use or not available". Farm shows the owner the tunnel address on
// the device; if the tunnel never started, remoteConnect starts it. Null when the device is not in our group
// (`using` means owned by this Farm user, which every runner sharing the token is).
async function ownedConnection(settings, serial, groupId) {
  const path = `/api/v1/devices/${encodeURIComponent(serial)}?${query({ fields: "serial,owner,using,remoteConnect,remoteConnectUrl" })}`;
  const device = ensureConfigured(await farmRequest(settings, path)).device || {};
  if (!device.using || (groupId && device.owner?.group !== groupId)) return null;
  if (device.remoteConnect && device.remoteConnectUrl) return String(device.remoteConnectUrl);
  return connectUrl(ensureConfigured(await farmRequest(settings, `/api/v1/user/devices/${encodeURIComponent(serial)}/remoteConnect`, { method: "POST" })));
}

export async function useDevice(settings, serial, { groupId, attempts = 3, delayMs = 5_000 } = {}) {
  let owned = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (!owned) return connectUrl(ensureConfigured(await farmRequest(settings, "/api/v1/autotests/useDevice", { method: "POST", body: { serial } })));
      const url = await ownedConnection(settings, serial, groupId);
      if (url === null) throw new Error("Farm cihazı bu koşumun grubundan çıktı");
      return url;
    } catch (caught) {
      let error = caught;
      if (!owned && error.status === 403) {
        const reconnect = await ownedConnection(settings, serial, groupId).catch((failure) => failure);
        if (typeof reconnect === "string") return reconnect;
        if (reconnect === null || !isTransientConnectError(reconnect)) throw error;
        owned = true;
        error = reconnect;
      }
      if (!isTransientConnectError(error)) throw error;
      if (attempt >= attempts) {
        error.message = `Farm cihaz bağlantısını açamadı (${attempts} deneme): ${error.message}`;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export async function installApp(settings, serial, url) {
  ensureConfigured(await farmRequest(settings, `/api/v1/autotests/install/${encodeURIComponent(serial)}`, {
    method: "POST",
    body: { url },
    timeoutMs: 10 * 60_000,
  }));
}

export async function releaseDevice(settings, groupId, result) {
  if (!groupId) return;
  const params = query({ group: groupId, result: ["passed", "failed"].includes(result) ? result : "" });
  await farmRequest(settings, `/api/v1/autotests?${params}`, { method: "DELETE" });
}

export async function reportScenarios(settings, groupId, scenarios) {
  if (!groupId || !scenarios.length) return;
  await farmRequest(settings, `/api/v1/builds/${encodeURIComponent(groupId)}/scenarios`, { method: "PUT", body: { scenarios } });
}

export async function registerAdbKey(settings, publickey) {
  if (!publickey) return "missing";
  try {
    ensureConfigured(await farmRequest(settings, "/api/v1/user/adbPublicKeys", {
      method: "POST",
      body: { publickey, title: "Mercury Test Runner" },
    }));
    return "registered";
  } catch (error) {
    if (error.status === 409 || /exist|already/i.test(error.message)) return "exists";
    throw error;
  }
}

// iOS remoteConnectUrl is the WebDriverAgent endpoint; Farm may return a bare HOST:PORT.
export function parseWdaUrl(remote) {
  const url = new URL(/^[a-z]+:\/\//i.test(remote) ? remote : `http://${remote}`);
  return { host: url.hostname, port: Number(url.port) || 8100 };
}
