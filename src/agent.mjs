import { stepLabel } from "./midscene.mjs";

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

export { deviceHint };

// iOS UDIDs: "00008140-001E21220240801C" (A12 and later) or 40 hex characters (older devices).
export function isIosUdid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{16}$/i.test(value) || /^[0-9a-f]{40}$/i.test(value);
}

// Words of the message that may be a device serial or UDID ("00008140-… cihazında", "R58M12ABCDE'de").
// Turkish suffixes after an apostrophe are dropped; plain words, numbers and addresses are not candidates.
export function serialCandidates(text) {
  const words = String(text || "").split(/[\s,;()"“”]+/).map((word) => word.replace(/['’].*$/, "").replace(/[.:]+$/, ""));
  return [...new Set(words.filter((word) => isIosUdid(word) || (/^[A-Za-z0-9][A-Za-z0-9._:-]{5,}$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word)
    && !/^https?:/i.test(word))))];
}

// Words a saved-run command may carry besides names: run verbs, Turkish suffixes split off by `fold`, politeness.
const RUN_FILLER = new Set([
  "regresyon", "regresyonu", "regresyonunu", "regression", "hepsi", "hepsini", "tum", "tumu", "tumunu", "butun", "lutfen",
  "de", "da", "te", "ta", "nin", "nun", "in", "un", "i", "u", "a", "e", "yi", "yu", "ye", "ya", "icin", "ile", "bir",
  "tekrar", "yeniden", "simdi", "hemen", "ve", "proje", "projesi", "projesini", "projesinde", "konfigurasyon", "konfigurasyonu",
  "all", "please", "the", "again", "now", "on", "for", "and", "project", "config", "configuration",
]);
const DEVICE_WORD = /^(iphone|ipad|pixel|samsung|galaxy|huawei|xiaomi|redmi|oppo|\d+(?:pro|max|plus|ultra)?|pro|max|plus|ultra|mini)$/;

// True when a run command is fully explained by project/configuration names, aliases, remembered phrases,
// run verbs and a device hint ("örnek proje web chrome koş", "örnek proje ios, iPhone 15 koş"). Such commands
// run deterministically; anything more ("… giriş testlerini koş", "… login ol") is left to the QA agent.
export function isPlainRunCommand(text, configs, clients, memories = []) {
  if (!wantsRun(text)) return false;
  if (!resolveConfigs(text, configs, clients, memories).configs.length) return false;
  const names = [
    ...clients.map((item) => item.name),
    ...configs.flatMap((item) => [item.name, ...JSON.parse(item.aliases || "[]")]),
    ...memories.map((item) => item.match_phrase),
  ].map(fold).filter(Boolean).sort((a, b) => b.length - a.length);
  let rest = ` ${fold(text)} `;
  for (const name of names) {
    const pattern = new RegExp(` ${escapeRegExp(name)}(?= )`, "g");
    rest = rest.replace(pattern, " ");
  }
  return rest.split(" ").filter(Boolean).every((word) => RUN_WORDS.includes(word) || RUN_FILLER.has(word) || DEVICE_WORD.test(word));
}

/* ---------- Ad-hoc scenarios ("example.com'u aç, girişe tıkla, hoş geldin yazısını doğrula") ---------- */

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>’]+/i;
const PACKAGE_PATTERN = /\b(?:com|org|net|tr|io|app|de|uk|co)\.[a-z0-9_]+(?:\.[a-z0-9_]+)+\b/i;
const DOMAIN_PATTERN = /\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|co|tv|ai|info|biz|me|tr)(?:\/[^\s"'<>’]*)?/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// A URL written in Turkish carries a suffix: "example.com'u aç", "site.com.tr’ye git".
const SUFFIX = String.raw`(?:['’][a-zçğıöşü]{1,4})?`;

const ACTION_WORDS = new Set([
  "ac", "acin", "acip", "git", "gidin", "gidip", "bas", "basin", "basip", "yaz", "yazin", "yazip", "sec", "secin", "secip",
  "gir", "girin", "girip", "yap", "yapin", "yapip", "ara", "arat", "ziyaret", "login", "click", "tap", "open", "type",
]);
const ACTION_PREFIXES = ["tikla", "dokun", "dogrula", "kaydir", "kontrol", "bekle", "doldur", "isaretle"];
const ASSERT_PATTERN = /\b(dogrula\w*|kontrol\w*|emin ol\w*|gorunmel\w*|gorundugunu|oldugunu|olmali\w*|icermel\w*|icerdigini|yazdigini|verify|assert|check)\b/;
const WAIT_PATTERN = /\bbekle\w*\b/;
const SLEEP_PATTERN = /(\d+(?:[.,]\d+)?)\s*(saniye|sn|sec|s)\b/i;
// Words that only say where to go; a clause made of nothing else is the "open the site/app" clause.
const FILLER = new Set([
  "uygulama", "uygulamasi", "uygulamasini", "uygulamayi", "uygulamasina", "uygulamada", "site", "sitesi", "sitesini", "sitesine",
  "siteyi", "siteye", "sitede", "adres", "adresi", "adresine", "adresini", "web", "chrome", "tarayici", "tarayicida", "android",
  "ios", "iphone", "ipad", "mobil", "de", "da", "te", "ta", "u", "a", "e", "i", "ya", "ye", "yu", "yi", "nu", "ni", "ac", "acin", "acip",
  "git", "gidin", "gidip", "baslat", "baslatin", "ziyaret", "et", "ve", "once", "ilk", "olarak", "hemen", "lutfen", "proje",
  "projesi", "projesinde", "projesini", "projede", "kos", "kostur", "run", "open", "senaryo", "senaryoyu", "su", "sunu", "bu", "bunu",
]);

export function hasScenarioAction(text) {
  return fold(text).split(" ").some((word) => ACTION_WORDS.has(word) || ACTION_PREFIXES.some((prefix) => word.startsWith(prefix)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns null when the message is not a scenario. `rawUrl`/`packageId` are the text as written, `url` is launchable.
export function parseScenario(text) {
  const raw = String(text || "").trim();
  const masked = raw.replace(EMAIL_PATTERN, (match) => " ".repeat(match.length));
  let rawUrl = masked.match(URL_PATTERN)?.[0] || "";
  let rest = rawUrl ? masked.replace(rawUrl, " ") : masked;
  const packageId = rest.match(PACKAGE_PATTERN)?.[0] || "";
  if (packageId) rest = rest.replace(packageId, " ");
  if (!rawUrl) rawUrl = rest.match(DOMAIN_PATTERN)?.[0] || "";
  rawUrl = rawUrl.replace(/[.,;:!?)\]]+$/, "");
  if (!rawUrl && !packageId && !hasScenarioAction(raw)) return null;
  const url = rawUrl ? (/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`) : "";
  const words = new Set(fold(raw).split(" "));
  const platformHint = ["iphone", "ipad", "ios"].some((word) => words.has(word)) ? "ios"
    : words.has("android") ? "android"
      : ["web", "chrome", "tarayici", "tarayicida"].some((word) => words.has(word)) ? "web" : "";
  return { text: raw, url, rawUrl, packageId, platformHint };
}

function aliasScore(folded, config) {
  return [config.name, ...JSON.parse(config.aliases || "[]")].reduce((best, name) => {
    const needle = fold(name);
    return needle && folded.includes(needle) ? Math.max(best, needle.length) : best;
  }, 0);
}

// Picks where the scenario runs: an explicit URL or package wins; otherwise a configuration of the named project.
export function resolveScenarioTarget(parsed, configs, clients) {
  const folded = fold(parsed.text);
  const client = clients.find((item) => fold(item.name) && folded.includes(fold(item.name)));
  const pool = client ? configs.filter((item) => item.client_id === client.id && item.enabled !== 0) : [];
  const best = (list) => list.map((item) => ({ item, score: aliasScore(folded, item) })).sort((a, b) => b.score - a.score)[0]?.item || null;
  const ignore = (config) => new Set([client?.name, config?.name, ...JSON.parse(config?.aliases || "[]")].flatMap((name) => fold(name).split(" ")).filter(Boolean));
  if (parsed.url) {
    const config = best(pool.filter((item) => item.platform === "web"));
    return { platform: "web", config, launchUrl: parsed.url, packageId: "", ignore: ignore(config) };
  }
  if (parsed.packageId) {
    const platform = parsed.platformHint === "ios" ? "ios" : "android";
    const config = best(pool.filter((item) => item.platform === platform));
    return { platform, config, launchUrl: "", packageId: parsed.packageId, ignore: ignore(config) };
  }
  if (!client) {
    return { error: "Senaryoyu nerede koşayım? Bir adres (örn. https://example.com), bir paket kimliği (com.firma.app) ya da kayıtlı bir proje adı yaz." };
  }
  const candidates = parsed.platformHint ? pool.filter((item) => item.platform === parsed.platformHint) : pool;
  const scored = candidates.filter((item) => aliasScore(folded, item) > 0);
  const config = scored.length ? best(scored) : candidates.length === 1 ? candidates[0] : null;
  if (!config) {
    return {
      error: candidates.length
        ? `"${client.name}" projesinde hangi konfigürasyonda koşayım? ${candidates.map((item) => item.name).join(", ")}`
        : `"${client.name}" projesinde ${parsed.platformHint ? `${parsed.platformHint} için ` : ""}etkin bir konfigürasyon yok.`,
    };
  }
  return { platform: config.platform, config, launchUrl: "", packageId: "", ignore: ignore(config) };
}

// Splits the scenario into Midscene steps. The first step always opens the target ({{launchUrl}} is the site or app id).
export function buildScenarioSteps(parsed, ignore = new Set()) {
  const steps = [{ action: "launch", text: "{{launchUrl}}" }];
  const meaningful = (text) => fold(text).split(" ").some((word) => word && !FILLER.has(word) && !ignore.has(word));
  const clauses = parsed.text.split(/(?:[.;!?]+(?=\s|$)|\n+|,\s+|\s+(?:sonra|ardından|ardindan|daha sonra|then)\s+)/i);
  for (let clause of clauses) {
    if (parsed.rawUrl) clause = clause.replace(new RegExp(escapeRegExp(parsed.rawUrl) + SUFFIX, "i"), " ");
    if (parsed.packageId) clause = clause.replace(new RegExp(escapeRegExp(parsed.packageId) + SUFFIX, "i"), " ");
    clause = clause.replace(/\s+/g, " ").trim().replace(/^(?:(?:ve|sonra|ardından|önce|once|and|then)\s+)+/i, "");
    if (!meaningful(clause)) continue;
    clause = clause.replace(/^(?:git|gidin|aç|açın|ziyaret et)\s+(?:ve\s+)?/i, "");
    // "tod web'de girişe tıkla" → "girişe tıkla": project/configuration names and "where" words mean nothing to Midscene.
    const tokens = clause.split(" ");
    let start = 0;
    while (start < tokens.length - 1 && fold(tokens[start]).split(" ").every((word) => !word || FILLER.has(word) || ignore.has(word))) start += 1;
    clause = tokens.slice(start).join(" ");
    // "giriş yap ve hoş geldin yazısını doğrula" / "giriş yap ve 3 saniye bekle": the parts before are actions.
    const parts = clause.split(/\s+ve\s+/i);
    // "kedi yaz ve Enter'a bas", "sayfanın sonuna kadar kaydır" become key and scroll steps; the rest stays aiAct.
    const pushActions = (list) => {
      let buffer = [];
      const flush = () => {
        const text = buffer.join(" ve ");
        if (buffer.length && meaningful(text)) steps.push({ action: "aiAct", text });
        buffer = [];
      };
      for (const part of list) {
        const special = specialStep(part);
        if (special) {
          flush();
          steps.push(special);
        } else buffer.push(part);
      }
      flush();
    };
    const leading = (at) => {
      if (at > 0) pushActions(parts.slice(0, at));
    };
    const sleepAt = parts.findIndex((part) => WAIT_PATTERN.test(fold(part)) && SLEEP_PATTERN.test(part));
    if (sleepAt >= 0) {
      leading(sleepAt);
      const seconds = Number(SLEEP_PATTERN.exec(parts[sleepAt])[1].replace(",", "."));
      steps.push({ action: "sleep", text: String(Math.round(seconds * 1000)) });
      continue;
    }
    const assertAt = parts.findIndex((part) => ASSERT_PATTERN.test(fold(part)));
    if (assertAt >= 0) {
      leading(assertAt);
      steps.push({ action: "aiAssert", text: parts.slice(assertAt).join(" ve ") });
      continue;
    }
    if (WAIT_PATTERN.test(fold(clause))) steps.push({ action: "aiWaitFor", text: clause });
    else pushActions(parts);
  }
  return steps;
}

const KEY_CLAUSE = /^(?:klavyede\s+|klavyeden\s+)?(enter|esc|escape|tab)(?:['’][a-zçğıöşü]*)?\s+(?:tuşuna\s+|tusuna\s+)?bas\w*$/i;
const SCROLL_CLAUSE = /^(?:sayfa\w*\s+)?(?:en\s+)?(asagi|yukari|sonuna|alta|basina|uste)\s+(?:kadar\s+)?kaydir\w*$/;

function specialStep(part) {
  const key = KEY_CLAUSE.exec(part.trim())?.[1];
  if (key) {
    const keyName = { enter: "Enter", tab: "Tab" }[key.toLowerCase()] || "Escape";
    return { action: "aiKeyboardPress", text: stepLabel("aiKeyboardPress", { keyName }), args: { keyName } };
  }
  const where = SCROLL_CLAUSE.exec(fold(part))?.[1];
  if (!where) return null;
  const args = {
    direction: ["yukari", "basina", "uste"].includes(where) ? "up" : "down",
    scrollType: { sonuna: "scrollToBottom", alta: "scrollToBottom", basina: "scrollToTop", uste: "scrollToTop" }[where] || "singleAction",
  };
  return { action: "aiScroll", text: stepLabel("aiScroll", args), args };
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
