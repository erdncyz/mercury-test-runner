export function fold(value) {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .replaceAll("ı", "i")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const RUN_WORDS = ["kos", "kostur", "baslat", "run", "start"];

export function wantsRun(text) {
  const folded = fold(text);
  return RUN_WORDS.some((word) => folded.split(" ").includes(word) || folded.includes(` ${word}`));
}

export function parseMemory(text) {
  const raw = text.trim();
  const inline = raw.match(/^(.+?)\s+(?:demek|deyince)\s+(.+)$/i);
  if (inline) return { phrase: fold(inline[1]), rest: inline[2].trim() };
  const trailing = raw.match(/^(.+?)\s+demek$/i);
  if (!trailing) return null;
  return { phrase: "", rest: trailing[1].trim() };
}

export function resolveConfigs(message, configs, clients, memories) {
  const folded = fold(message);
  const remembered = memories.find((item) => item.match_phrase && folded.includes(item.match_phrase));
  const client = clients.find((item) => folded.includes(fold(item.name)));
  const pool = client ? configs.filter((item) => item.client_id === client.id) : configs;
  if (remembered?.config_id) {
    const hit = configs.find((item) => item.id === remembered.config_id);
    if (hit) return { configs: [hit], deviceHint: deviceHint(folded, hit) };
  }
  if (folded.includes("regresyon") || folded.includes("regression")) {
    const many = pool.filter((item) => item.regression);
    return { configs: many, deviceHint: "" };
  }
  const ranked = pool
    .map((item) => {
      const names = [item.name, ...JSON.parse(item.aliases || "[]")];
      const score = names.reduce((best, name) => {
        const needle = fold(name);
        return needle && folded.includes(needle) ? Math.max(best, needle.length) : best;
      }, 0);
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { configs: [], deviceHint: "" };
  return { configs: [ranked[0].item], deviceHint: deviceHint(folded, ranked[0].item) };
}

function deviceHint(folded, config) {
  const filter = fold(config.device_filter);
  const extra = folded
    .split(" ")
    .filter((word) => word.length > 2 && !fold(config.name).includes(word) && word !== filter)
    .find((word) => /iphone|pixel|samsung|huawei|ipad/.test(word));
  return extra || "";
}

export function isSettingsUtterance(text) {
  return /^(ayar|settings)\s+/i.test(text.trim());
}

const SETTING_KEYS = {
  "model key": "model_api_key",
  "model name": "model_name",
  "model url": "model_base_url",
  "model family": "model_family",
  "testrail host": "testrail_host",
  "testrail user": "testrail_user",
  "testrail key": "testrail_api_key",
  "testrail project": "testrail_project_id",
  "farm url": "farm_base_url",
  "farm token": "farm_token",
  "web limit": "web_concurrency",
  "guncelleme url": "update_manifest_url",
  "public url": "public_base_url",
};

export function parseSetting(text) {
  const body = text.trim().replace(/^(ayar|settings)\s+/i, "");
  const folded = fold(body);
  const keys = Object.keys(SETTING_KEYS).sort((a, b) => b.length - a.length);
  for (const label of keys) {
    if (folded.startsWith(label)) {
      const value = body.slice(body.toLowerCase().indexOf(label) + label.length).trim();
      return { key: SETTING_KEYS[label], label, value };
    }
  }
  return null;
}
