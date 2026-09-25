export function stringList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// UDIDs may arrive as a JSON list, an array, or text pasted one per line / comma separated.
export function serialList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
  const text = String(value || "").trim();
  if (text.startsWith("[")) return [...new Set(stringList(text))];
  return [...new Set(text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

export function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const MAX_PARALLEL = 20;

// Parallel lanes for one run: capped by the UDID pool on mobile and by the number of cases.
export function laneCount(config, caseCount = Infinity) {
  const parallel = Math.min(MAX_PARALLEL, Math.max(1, Math.trunc(Number(config.parallel)) || 1));
  const serials = serialList(config.device_serials);
  const pool = ["android", "ios"].includes(config.platform) && serials.length ? Math.min(parallel, serials.length) : parallel;
  return Math.max(1, Math.min(pool, caseCount || 1));
}

// Round-robin keeps each lane's share within one case of the others.
export function shardCases(caseCount, lanes) {
  const shards = Array.from({ length: Math.max(1, Math.min(lanes, caseCount)) }, () => []);
  for (let index = 0; index < caseCount; index += 1) shards[index % shards.length].push(index);
  return shards;
}

export function selectCases(config, cases) {
  const clientCases = cases.filter((item) => !item.client || item.client === config.client_name);
  const ids = new Set(stringList(config.case_ids));
  if (ids.size) return clientCases.filter((item) => ids.has(String(item.caseId)));
  const tags = new Set(stringList(config.case_tags).map((tag) => tag.toLocaleLowerCase("tr")));
  if (tags.size) {
    return clientCases.filter((item) => (item.tags || []).some((tag) => tags.has(tag.toLocaleLowerCase("tr"))));
  }
  return clientCases;
}

// `config.account_source_ready/_issue` come from the account store status of the selected source.
export function configurationPlan(config, cases, {
  modelReady = true,
  farmReady = true,
  adbReady = true,
  limits = {},
} = {}) {
  const selected = selectCases(config, cases);
  const issues = [];
  const warnings = [];
  const mobile = ["android", "ios"].includes(config.platform);
  const parallel = Math.max(1, Math.trunc(Number(config.parallel)) || 1);
  const serials = serialList(config.device_serials);
  const lanes = laneCount(config, selected.length);
  if (!config.enabled) issues.push("Konfigürasyon devre dışı");
  if (!selected.length) issues.push("Case kapsamıyla eşleşen YAML case yok");
  if (config.platform === "web" && !config.launch_url) issues.push("Web başlangıç adresi eksik");
  if (config.account_policy === "required" && !config.account_source_id) issues.push("Zorunlu hesap kaynağı seçilmemiş");
  if (config.account_policy !== "none" && config.account_source_id) {
    if (!config.account_source_name) issues.push("Seçili hesap kaynağı bulunamadı");
    else if (config.account_source_ready === false) {
      const text = `"${config.account_source_name}" hesap kaynağında ${config.account_source_issue || "eksik ayar var"}`;
      (config.account_policy === "required" ? issues : warnings).push(text);
    }
  }
  if ((config.platform === "web" || mobile) && !modelReady) issues.push("Midscene modeli hazır değil");
  if (mobile && !farmReady) issues.push("Mercury Farm bağlantısı hazır değil");
  if (config.platform === "android" && !adbReady) issues.push("Bu sunucuda ADB kurulu değil (npm run setup)");
  if (mobile && !config.package_id && !config.launch_url) {
    issues.push(config.platform === "android" ? "Android paket kimliği (applicationId) eksik" : "iOS bundle id eksik");
  }
  if (parallel > MAX_PARALLEL) issues.push(`Paralel koşum en fazla ${MAX_PARALLEL} olabilir`);
  if (mobile && serials.length && parallel > serials.length) {
    issues.push(`${parallel} paralel koşum için ${parallel} UDID gerekir, ${serials.length} girildi`);
  }
  if (mobile && !config.app_url) warnings.push("Uygulama dosyası adresi yok; cihazda kurulu sürüm açılır");
  if (selected.length && lanes < parallel && !(mobile && serials.length && parallel > serials.length)) {
    warnings.push(`${selected.length} case var; ${lanes} paralel hat kullanılır`);
  }
  const limit = config.platform === "web" ? Number(limits.web) || 0 : 0;
  if (limit && lanes > limit) warnings.push(`Bu sunucuda en fazla ${limit} tarayıcı açılır; ${lanes} hatlı koşum başka web koşumu yokken başlar`);
  if (config.platform === "tv") issues.push("Smart TV yürütücüsü henüz bağlı değil");
  return {
    ready: issues.length === 0,
    issues,
    warnings,
    caseCount: selected.length,
    caseIds: selected.map((item) => String(item.caseId)).filter(Boolean),
    lanes,
    serialCount: serials.length,
  };
}

export function normalizeConfigInput(body, current = {}) {
  const policy = ["none", "optional", "required"].includes(body.accountPolicy) ? body.accountPolicy : current.account_policy || "none";
  const platform = ["web", "android", "ios", "tv"].includes(body.platform) ? body.platform : current.platform;
  if (!String(body.name ?? current.name ?? "").trim()) throw new Error("Konfigürasyon adı zorunlu");
  if (!platform) throw new Error("Geçerli platform seç");
  const parallel = Math.trunc(Number(body.parallel ?? current.parallel ?? 1));
  if (!Number.isFinite(parallel) || parallel < 1 || parallel > MAX_PARALLEL) throw new Error(`Paralel koşum 1–${MAX_PARALLEL} arasında olmalı`);
  const filters = objectValue(body.accountFilters ?? current.account_filters);
  const wait = Math.trunc(Number(body.deviceWaitMinutes ?? current.device_wait_minutes ?? 30));
  if (!Number.isFinite(wait) || wait < 1 || wait > 1440) throw new Error("Boş cihaz bekleme süresi 1–1440 dakika olmalı");
  return {
    name: String(body.name ?? current.name).trim(),
    aliases: stringList(body.aliases ?? current.aliases),
    platform,
    farmType: ["android", "ios"].includes(platform) ? platform : "",
    deviceFilter: String(body.deviceFilter ?? current.device_filter ?? "").trim(),
    deviceSerials: serialList(body.deviceSerials ?? current.device_serials),
    parallel,
    deviceWaitMinutes: wait,
    appUrl: String(body.appUrl ?? current.app_url ?? "").trim(),
    packageId: String(body.packageId ?? current.package_id ?? "").trim(),
    launchUrl: String(body.launchUrl ?? current.launch_url ?? "").trim(),
    regression: body.regression === undefined ? Boolean(current.regression) : Boolean(body.regression),
    environment: String(body.environment ?? current.environment ?? "test").trim() || "test",
    accountSourceId: body.accountSourceId === null || body.accountSourceId === "" ? null : Number(body.accountSourceId ?? current.account_source_id) || null,
    accountPolicy: policy,
    accountFilters: Object.fromEntries(Object.entries(filters).map(([key, value]) => [String(key).trim(), String(value ?? "").trim()]).filter(([key]) => key)),
    caseIds: stringList(body.caseIds ?? current.case_ids),
    caseTags: stringList(body.caseTags ?? current.case_tags),
    enabled: body.enabled === undefined ? current.enabled !== 0 : Boolean(body.enabled),
  };
}
