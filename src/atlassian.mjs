// Jira and Confluence: chat reads the issues and pages a tester points to ("PROJ-123 için test case çıkar ve koş",
// a browse link, a Confluence page link) so the QA agent can design test cases from the requirements.
// Only reads; nothing is written back. Cloud uses e-mail + API token (Basic), Server/Data Center a personal access
// token (Bearer, user left empty). Confluence falls back to the Jira address (Cloud: <jira>/wiki) and credentials.

const TIMEOUT_MS = 20_000;
const MAX_ISSUES = 3;
const MAX_PAGES = 3;
const ISSUE_TEXT_LIMIT = 8000;
const PAGE_TEXT_LIMIT = 6000;
const COMMENT_LIMIT = 5;

const ISSUE_KEY = /\b([A-Z][A-Z0-9_]{1,19}-[1-9]\d{0,6})\b/g;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>’)\]]+/gi;
// "bu task", "bu story'yi" … : the tester refers to an issue named earlier in the chat.
const REFERS_TO_ISSUE = /\b(task|taskı|taski|taska|görev\w*|gorev\w*|issue\w*|story\w*|stori\w*|hikaye\w*|bug\w*|ticket\w*|jira\w*|confluence\w*|gereksinim\w*|analiz\w*|dokuman\w*|doküman\w*|epic\w*)\b/i;
// Custom fields worth giving the model; everything else (sprints, ranks, dev info) is noise.
const USEFUL_FIELD = /acceptance|criteria|kabul|kriter|test|senaryo|scenario|steps|adım|adim|expected|beklenen|environment|ortam|url|how to|reproduce|tekrar/i;

const clean = (value) => String(value || "").trim().replace(/\/+$/, "");

export function jiraConfigured(settings) {
  return Boolean(clean(settings.jira_host) && settings.jira_api_token);
}

function confluenceSettings(settings) {
  const jira = clean(settings.jira_host);
  const host = clean(settings.confluence_host) || (/\.atlassian\.net$/i.test(safeHost(jira)) ? `${jira}/wiki` : "");
  const ownToken = Boolean(settings.confluence_api_token);
  return {
    host,
    user: ownToken ? String(settings.confluence_user || "").trim() : String(settings.jira_user || "").trim(),
    token: ownToken ? settings.confluence_api_token : settings.jira_api_token,
  };
}

export function confluenceConfigured(settings) {
  const { host, token } = confluenceSettings(settings);
  return Boolean(host && token);
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function authHeaders(user, token) {
  const auth = user ? `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` : `Bearer ${token}`;
  return { Authorization: auth, Accept: "application/json" };
}

// Turkish suffixes differ per product ("Jira'ya", "Confluence'a"), so every message is written out for both.
const MESSAGES = {
  Jira: {
    unreachable: (reason) => `Jira'ya ulaşılamadı (${reason})`,
    denied: (status) => `Jira kimlik bilgilerini reddetti (${status}); Ayarlar → Jira & Confluence`,
    missing: "Jira'da bu kayıt yok ya da hesabın erişimi yok (404)",
    notJson: "Jira yanıtı JSON değil",
  },
  Confluence: {
    unreachable: (reason) => `Confluence'a ulaşılamadı (${reason})`,
    denied: (status) => `Confluence kimlik bilgilerini reddetti (${status}); Ayarlar → Jira & Confluence`,
    missing: "Confluence'ta bu sayfa yok ya da hesabın erişimi yok (404)",
    notJson: "Confluence yanıtı JSON değil",
  },
};

async function request(label, base, path, user, token, fetchImpl) {
  const say = MESSAGES[label];
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, { headers: authHeaders(user, token), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(say.unreachable(error.name === "TimeoutError" ? "zaman aşımı" : error.cause?.code || error.message));
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
  if (response.status === 401 || response.status === 403) throw new Error(say.denied(response.status));
  if (response.status === 404) throw new Error(say.missing);
  if (!response.ok) {
    const detail = data?.errorMessages?.[0] || data?.message || "";
    throw new Error(`${label} ${response.status}${detail ? ` · ${String(detail).slice(0, 200)}` : ""}`);
  }
  // A login page (SSO proxy, wrong address) answers 200 with HTML.
  if (data === null) throw new Error(say.notJson);
  return data;
}

const jiraRequest = (settings, path, fetchImpl) =>
  request("Jira", clean(settings.jira_host), path, String(settings.jira_user || "").trim(), settings.jira_api_token, fetchImpl);

function confluenceRequest(settings, path, fetchImpl) {
  const { host, user, token } = confluenceSettings(settings);
  return request("Confluence", host, path, user, token, fetchImpl);
}

/* ---------- Text conversion ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|li|ul|ol|table|blockquote|pre)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, code) => {
      if (code[0] === "#") return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Atlassian Document Format (Jira Cloud REST v3 and some custom fields).
export function adfToText(node) {
  if (!node || typeof node !== "object") return String(node ?? "");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (["mention", "emoji", "status", "date"].includes(node.type)) return node.attrs?.text || node.attrs?.shortName || "";
  if (node.type === "inlineCard" || node.type === "blockCard") return node.attrs?.url || "";
  const inner = (node.content || []).map(adfToText).join(node.type === "tableRow" ? " | " : "");
  if (node.type === "listItem") return `- ${inner.trim()}\n`;
  if (["paragraph", "heading", "codeBlock", "blockquote", "panel", "tableRow", "bulletList", "orderedList", "rule"].includes(node.type)) return `${inner}\n`;
  return inner;
}

// Jira wiki markup (REST v2 and Server/Data Center): keep the words and the links, drop the formatting.
export function wikiToText(markup) {
  return String(markup || "")
    .replace(/\{(code|noformat|quote|panel)(:[^}]*)?\}/gi, "")
    .replace(/\{color(:[^}]*)?\}/gi, "")
    .replace(/^h[1-6]\.\s*/gim, "")
    .replace(/^\s*[*#]+\s+/gm, "- ")
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, "$1 ($2)")
    .replace(/\[(https?:[^\]]+)\]/g, "$1")
    .replace(/!([^!\s|]+)(\|[^!]*)?!/g, "")
    .replace(/(^|\s)[*_+-]([^*_+\n-][^*_+\n]*?)[*_+-](?=\s|$|[.,;:])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fieldText(value) {
  if (value == null) return "";
  if (typeof value === "string") return wikiToText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(", ");
  if (value.type === "doc") return adfToText(value).trim();
  return String(value.value ?? value.name ?? value.displayName ?? "");
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/* ---------- Finding references in chat ---------- */

const LINKED_KEY = /\/browse\/([A-Z][A-Z0-9_]{1,19}-[1-9]\d{0,6})\b|[?&](?:selectedIssue|issueKey)=([A-Z][A-Z0-9_]{1,19}-[1-9]\d{0,6})\b/;
const PAGE_LINK = /\/spaces\/[^/?#]+\/pages\/(\d{3,})\b|[?&]pageId=(\d{3,})\b/;

export function refersToIssue(text) {
  return REFERS_TO_ISSUE.test(String(text || ""));
}

// Issue keys and Confluence page ids written in `text`: Jira links (…/browse/KEY, selectedIssue=KEY), Confluence
// page links (…/spaces/SP/pages/123, pageId=123) and keys written on their own ("PROJ-123"). `linked` are the keys
// that came from a link; a bare key may be something else ("UTF-8", "COVID-19"), see `gatherReferences`.
export function findReferences(text) {
  const source = String(text || "");
  const linked = [];
  const pages = [];
  const urls = source.match(URL_IN_TEXT) || [];
  for (const url of urls) {
    const key = LINKED_KEY.exec(url);
    if (key) linked.push(key[1] || key[2]);
    const page = PAGE_LINK.exec(url);
    if (page) pages.push(page[1] || page[2]);
  }
  const outside = urls.reduce((rest, url) => rest.replace(url, " "), source);
  const bare = [...outside.matchAll(ISSUE_KEY)].map((match) => match[1]);
  return { issues: [...new Set([...linked, ...bare])], linked: [...new Set(linked)], pages: [...new Set(pages)] };
}

/* ---------- Reading ---------- */

export async function fetchJiraIssue(settings, key, fetchImpl = fetch) {
  const issue = await jiraRequest(settings, `/rest/api/2/issue/${encodeURIComponent(key)}?expand=names`, fetchImpl);
  const fields = issue.fields || {};
  const names = issue.names || {};
  const lines = [];
  const add = (label, value) => {
    const text = fieldText(value).trim();
    if (text) lines.push(`${label}: ${text}`);
  };
  add("Tür", fields.issuetype);
  add("Durum", fields.status);
  add("Öncelik", fields.priority);
  add("Etiketler", fields.labels);
  add("Bileşenler", fields.components);
  add("Sürüm", fields.fixVersions);
  if (fields.parent) add("Üst kayıt", `${fields.parent.key} ${fields.parent.fields?.summary || ""}`);
  const description = fieldText(fields.description).trim();
  if (description) lines.push(`Açıklama:\n${description}`);
  for (const [id, value] of Object.entries(fields)) {
    if (!id.startsWith("customfield_") || value == null) continue;
    const name = names[id] || "";
    if (!USEFUL_FIELD.test(name)) continue;
    const text = fieldText(value).trim();
    if (text && text.length > 1) lines.push(`${name}:\n${text}`);
  }
  const subtasks = (fields.subtasks || []).map((item) => `${item.key} ${item.fields?.summary || ""}`.trim());
  if (subtasks.length) lines.push(`Alt görevler:\n- ${subtasks.join("\n- ")}`);
  const links = (fields.issuelinks || []).map((link) => {
    const other = link.outwardIssue || link.inwardIssue;
    const kind = link.outwardIssue ? link.type?.outward : link.type?.inward;
    return other ? `${kind || "ilişkili"} ${other.key} ${other.fields?.summary || ""}`.trim() : "";
  }).filter(Boolean);
  if (links.length) lines.push(`Bağlı kayıtlar:\n- ${links.join("\n- ")}`);
  const comments = (fields.comment?.comments || []).slice(-COMMENT_LIMIT).map((item) => `${item.author?.displayName || "?"}: ${fieldText(item.body).trim()}`);
  if (comments.length) lines.push(`Son yorumlar:\n- ${comments.join("\n- ")}`);
  // Confluence pages linked from the issue (Cloud "mentioned in", Server remote links) are read too.
  const pages = findReferences(typeof fields.description === "string" ? fields.description : adfToText(fields.description)).pages;
  try {
    const remote = await jiraRequest(settings, `/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`, fetchImpl);
    for (const link of Array.isArray(remote) ? remote : []) pages.push(...findReferences(link.object?.url || "").pages);
  } catch { /* remote links are optional */ }
  return {
    kind: "jira",
    key: issue.key || key,
    url: `${clean(settings.jira_host)}/browse/${issue.key || key}`,
    title: fields.summary || "",
    text: clip(lines.join("\n\n"), ISSUE_TEXT_LIMIT),
    pages: [...new Set(pages)],
  };
}

export async function fetchConfluencePage(settings, id, fetchImpl = fetch) {
  const page = await confluenceRequest(settings, `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,space`, fetchImpl);
  const host = confluenceSettings(settings).host;
  return {
    kind: "confluence",
    key: String(page.id || id),
    url: page._links?.webui ? `${host}${page._links.webui}` : `${host}/pages/viewpage.action?pageId=${id}`,
    title: page.title || "",
    space: page.space?.name || page.space?.key || "",
    text: clip(htmlToText(page.body?.storage?.value || ""), PAGE_TEXT_LIMIT),
  };
}

// Reads the issues and pages named in `text`; when it names none but refers to "the task", the newest of `earlier`
// (the tester's previous messages, newest first) that names one is used. Failures come back per reference so the
// agent and the tester see which one could not be read. A bare key the sentence does not call a task ("UTF-8 ile
// kaydet") is looked up quietly: if Jira has no such issue, it was not one.
export async function gatherReferences(settings, text, earlier = [], fetchImpl = fetch) {
  let found = findReferences(text);
  const explicit = refersToIssue(text);
  if (!found.issues.length && !found.pages.length && explicit) {
    for (const previous of earlier) {
      const candidate = findReferences(previous);
      if (candidate.issues.length || candidate.pages.length) {
        found = candidate;
        break;
      }
    }
  }
  const references = [];
  const errors = [];
  const reported = (key) => explicit || found.linked.includes(key);
  const pageIds = [...found.pages];
  const issues = found.issues.slice(0, MAX_ISSUES);
  if (issues.length && !jiraConfigured(settings)) {
    const named = issues.filter(reported);
    if (named.length) errors.push(`${named.join(", ")}: Jira ayarı eksik (Ayarlar → Jira & Confluence)`);
  } else {
    for (const key of issues) {
      try {
        const issue = await fetchJiraIssue(settings, key, fetchImpl);
        pageIds.push(...issue.pages);
        delete issue.pages;
        references.push(issue);
      } catch (error) {
        if (reported(key) || !/\(404\)/.test(error.message)) errors.push(`${key}: ${error.message}`);
      }
    }
  }
  const pages = [...new Set(pageIds)].slice(0, MAX_PAGES);
  if (pages.length && !confluenceConfigured(settings)) {
    if (found.pages.length) errors.push(`Confluence sayfası ${found.pages.join(", ")}: Confluence ayarı eksik (Ayarlar → Jira & Confluence)`);
  } else {
    for (const id of pages) {
      try {
        references.push(await fetchConfluencePage(settings, id, fetchImpl));
      } catch (error) {
        // A page only linked from an issue is a bonus; one the tester wrote must be reported.
        if (found.pages.includes(id)) errors.push(`Confluence sayfası ${id}: ${error.message}`);
      }
    }
  }
  return { references, errors };
}

// Settings → "Bağlantıyı dene": who Jira sees, and whether Confluence answers with the same or its own credentials.
export async function testAtlassian(settings, fetchImpl = fetch) {
  if (!jiraConfigured(settings)) return { skipped: true, reason: "Jira ayarı eksik" };
  const me = await jiraRequest(settings, "/rest/api/2/myself", fetchImpl);
  const out = { ok: true, jiraUser: me.displayName || me.name || me.emailAddress || "" };
  if (confluenceConfigured(settings)) {
    try {
      await confluenceRequest(settings, "/rest/api/space?limit=1", fetchImpl);
      out.confluence = "ok";
    } catch (error) {
      out.confluence = `failed: ${error.message}`;
    }
  } else out.confluence = "missing";
  return out;
}
