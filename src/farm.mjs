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

export async function useDevice(settings, serial) {
  const data = ensureConfigured(await farmRequest(settings, "/api/v1/autotests/useDevice", { method: "POST", body: { serial } }));
  if (!data.remoteConnectUrl) throw new Error("Farm cihaz bağlantı adresi döndürmedi");
  return String(data.remoteConnectUrl);
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
