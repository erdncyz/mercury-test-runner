import { decrypt, encrypt, maskSecret } from "./security.mjs";

export const SOURCE_TYPES = ["http", "manual"];
export const AUTH_TYPES = ["none", "login", "header", "basic"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const RESERVED_FIELDS = new Set(["email", "password", "phone", "id"]);
const MASK = "•";

function readPath(data, path) {
  if (!path) return data;
  return String(path).split(".").reduce((node, key) => (node == null ? undefined : node[key]), data);
}

function fill(value, vars) {
  if (typeof value === "string") return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] ?? ""));
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)]));
  return value;
}

function objectOf(value, label) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new Error(`${label} geçerli JSON değil`); }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  throw new Error(`${label} bir JSON nesnesi olmalı`);
}

function method(value, fallback) {
  const upper = String(value || "").toUpperCase();
  return METHODS.includes(upper) ? upper : fallback;
}

// Accepts the current shape and the shape older installations stored (top-level tokenHeader/tokenPath,
// list.query or list.body) so existing installations keep working without a data migration.
export function normalizeSpec(raw = {}) {
  const spec = typeof raw === "string" ? objectOf(raw || "{}", "Kaynak tanımı") : raw || {};
  const auth = spec.auth || {};
  const type = AUTH_TYPES.includes(auth.type) ? auth.type : spec.auth ? "login" : "none";
  const list = spec.list || {};
  const listMethod = method(list.method, "GET");
  const fields = spec.fields || {};
  const extras = Object.fromEntries(Object.entries(objectOf(spec.extras, "Ek alanlar"))
    .map(([name, path]) => [String(name).trim(), String(path ?? "").trim()])
    .filter(([name, path]) => /^[A-Za-z_]\w*$/.test(name) && !RESERVED_FIELDS.has(name) && path));
  const mark = spec.markUsed && spec.markUsed.path ? spec.markUsed : null;
  return {
    auth: {
      type,
      method: method(auth.method, "POST"),
      path: String(auth.path || "").trim(),
      body: objectOf(auth.body, "Giriş isteği gövdesi"),
      tokenPath: String(auth.tokenPath ?? spec.tokenPath ?? "token").trim(),
      tokenHeader: String(auth.tokenHeader ?? spec.tokenHeader ?? (type === "header" ? "x-api-key" : "Authorization")).trim(),
      tokenPrefix: String(auth.tokenPrefix ?? ""),
    },
    list: {
      method: listMethod,
      path: String(list.path || "").trim(),
      params: objectOf(list.params ?? (listMethod === "GET" ? list.query : list.body), "Hesap listesi parametreleri"),
      itemsPath: String(list.itemsPath || "").trim(),
    },
    fields: {
      email: String(fields.email || "email").trim(),
      password: String(fields.password || "password").trim(),
      phone: String(fields.phone || "phoneNumber").trim(),
      id: String(fields.id || "_id").trim(),
    },
    extras,
    markUsed: mark ? { method: method(mark.method, "PUT"), path: String(mark.path).trim(), body: objectOf(mark.body, "Kullanıldı isteği gövdesi") } : null,
  };
}

// Filter keys the admin may tune per configuration (package, country, user type…). Availability
// flags such as isLocked/isValid and the environment are managed by Mercury itself.
export function filterFields(spec) {
  return Object.entries(normalizeSpec(spec).list.params)
    .filter(([key, value]) => key !== "environment" && !/^is[A-Z]/.test(key) && (value === null || typeof value !== "object"))
    .map(([key, value]) => ({ key, default: String(value ?? "") }));
}

function applyFilters(params, filters) {
  for (const [key, raw] of Object.entries(filters || {})) {
    if (key === "environment" || /^is[A-Z]/.test(key)) continue;
    const original = params[key];
    params[key] = typeof original === "boolean" ? raw === "true" : typeof original === "number" ? Number(raw) : raw;
  }
}

async function call(fetchImpl, url, { method: verb, headers, body, timeoutMs }, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: verb,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error.cause?.errors?.[0] || error.cause;
    const reason = error.name === "TimeoutError" ? "zaman aşımı" : cause?.code || cause?.message || error.message;
    throw new Error(`${label}: servise ulaşılamadı (${reason})`);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { if (response.ok) throw new Error(`${label}: yanıt JSON değil`); }
  }
  if (!response.ok) {
    const detail = data?.message || data?.description || data?.error;
    throw new Error(`${label}: HTTP ${response.status}${typeof detail === "string" ? ` · ${detail.slice(0, 160)}` : ""}`);
  }
  return data;
}

function mapRow(row, spec) {
  const text = (path) => {
    const value = readPath(row, path);
    return value === undefined || value === null ? "" : String(value);
  };
  return {
    email: text(spec.fields.email),
    password: text(spec.fields.password),
    phone: text(spec.fields.phone),
    id: text(spec.fields.id),
    extras: Object.fromEntries(Object.entries(spec.extras).map(([name, path]) => [name, text(path)])),
  };
}

// Talks to any HTTP test-user service: optional auth step, list request, field mapping, optional "mark used".
export async function fetchHttpAccount(source, credentials = {}, {
  environment = "test", filters = {}, exclude = new Set(), markUsed = true, fetchImpl = fetch, timeoutMs = 30_000,
} = {}) {
  const spec = normalizeSpec(source.spec ?? source.spec_json);
  const base = String(source.base_url || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Servis adresi eksik");
  const vars = {
    username: credentials.username || "", password: credentials.password || "", secret: credentials.secret || "",
    serviceEmail: credentials.username || "", servicePassword: credentials.password || "", environment,
  };
  const headers = { Accept: "application/json" };
  const options = { timeoutMs };
  if (spec.auth.type === "login") {
    const data = await call(fetchImpl, `${base}${fill(spec.auth.path, vars)}`, { ...options, method: spec.auth.method, headers, body: fill(spec.auth.body, vars) }, "Servis girişi");
    const token = readPath(data, spec.auth.tokenPath);
    if (!token) throw new Error(`Servis girişi: yanıtta "${spec.auth.tokenPath}" alanında token yok`);
    headers[spec.auth.tokenHeader || "Authorization"] = `${spec.auth.tokenPrefix}${token}`;
  } else if (spec.auth.type === "header") {
    headers[spec.auth.tokenHeader || "x-api-key"] = `${spec.auth.tokenPrefix}${vars.secret}`;
  } else if (spec.auth.type === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${vars.username}:${vars.password}`).toString("base64")}`;
  }

  const params = fill(spec.list.params, vars);
  if (Object.hasOwn(params, "environment")) params.environment = environment;
  applyFilters(params, filters);
  const url = new URL(`${base}${fill(spec.list.path, vars)}`);
  let body;
  if (spec.list.method === "GET") {
    for (const [key, value] of Object.entries(params)) if (value !== "" && value !== null && value !== undefined) url.searchParams.set(key, String(value));
  } else {
    body = params;
  }
  const data = await call(fetchImpl, url, { ...options, method: spec.list.method, headers, body }, "Hesap listesi");
  const picked = spec.list.itemsPath ? readPath(data, spec.list.itemsPath) : data;
  const rows = Array.isArray(picked) ? picked : picked && typeof picked === "object" ? [picked] : [];
  const lockKey = (item) => `${source.id ?? "test"}:${item.id || item.email}`;
  const account = rows.map((row) => mapRow(row, spec)).find((item) => (item.id || item.email) && !exclude.has(lockKey(item)));
  if (!account) throw new Error(rows.length ? "Listedeki uygun hesapların hepsi başka koşumlarda" : "Uygun test hesabı yok");
  account.lockKey = lockKey(account);

  if (markUsed && spec.markUsed) {
    const markVars = { ...vars, id: encodeURIComponent(account.id), email: encodeURIComponent(account.email) };
    try {
      await call(fetchImpl, `${base}${fill(spec.markUsed.path, markVars)}`, {
        ...options, method: spec.markUsed.method, headers, body: fill(spec.markUsed.body, { ...vars, id: account.id, email: account.email }),
      }, "Kullanıldı işareti");
    } catch (error) {
      account.warning = `Test hesabı kilitlenemedi: ${error.message}`;
    }
  }
  return account;
}

// Account lines accept "email, password, phone" separated by tab (Excel paste), ";" or ",".
export function parseAccountLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const [email = "", password = "", ...rest] = line.split(separator).map((part) => part.trim());
    return { email, password, phone: rest.join(separator).trim() };
  });
}

export function normalizeSourceInput(body = {}) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("Kaynak adı zorunlu");
  const type = SOURCE_TYPES.includes(body.type) ? body.type : "http";
  const scope = body.clientId === null || body.clientId === undefined || body.clientId === "" ? null : Number(body.clientId);
  if (scope !== null && !Number.isInteger(scope)) throw new Error("Geçersiz client");
  const credentials = body.credentials || {};
  const result = {
    name,
    type,
    clientId: scope,
    template: String(body.template || "").trim(),
    useMode: body.useMode === "once" ? "once" : "reuse",
    credentials: { username: String(credentials.username ?? "").trim(), password: String(credentials.password ?? ""), secret: String(credentials.secret ?? "") },
    baseUrl: "",
    spec: normalizeSpec({}),
  };
  if (type === "http") {
    result.baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
    if (result.baseUrl && !/^https?:\/\/[^\s/]+/i.test(result.baseUrl)) throw new Error("Servis adresi http:// veya https:// ile başlamalı");
    result.spec = normalizeSpec(body.spec || {});
    const paths = [["Hesap listesi yolu", result.spec.list.path], ["Giriş yolu", result.spec.auth.type === "login" ? result.spec.auth.path : ""], ["Kullanıldı isteği yolu", result.spec.markUsed?.path || ""]];
    for (const [label, path] of paths) if (path && !path.startsWith("/")) throw new Error(`${label} / ile başlamalı`);
  }
  if (body.accounts !== undefined) {
    const lines = Array.isArray(body.accounts) ? body.accounts : parseAccountLines(body.accounts);
    const seen = new Set();
    result.accounts = lines.map((line, index) => {
      const entry = { email: String(line.email || "").trim(), password: String(line.password ?? ""), phone: String(line.phone || "").trim() };
      if (!entry.email) throw new Error(`${index + 1}. satırda kullanıcı adı/e-posta eksik`);
      const key = entry.email.toLowerCase();
      if (seen.has(key)) throw new Error(`${entry.email} listede iki kez var`);
      seen.add(key);
      return entry;
    });
  }
  return result;
}

export function createAccountStore({ db, key, fetchImpl = fetch }) {
  const readCredentials = (row) => {
    try { return JSON.parse(decrypt(key, row?.credentials || "") || "{}"); } catch { return {}; }
  };
  const load = (row) => row && { ...row, spec: normalizeSpec(row.spec_json || "{}"), credentials: readCredentials(row) };
  const sourceById = (id) => load(db.prepare("SELECT * FROM sources WHERE id = ?").get(id));

  function counts(source) {
    const row = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS unused FROM source_accounts WHERE source_id = ?").get(source.id);
    const total = row.total || 0;
    return { total, available: source.use_mode === "once" ? row.unused || 0 : total };
  }

  function status(source) {
    if (source.type === "manual") {
      const { total, available } = counts(source);
      if (!total) return { ready: false, issue: "listede hesap yok" };
      if (!available) return { ready: false, issue: "kullanılabilir hesap kalmadı" };
      return { ready: true, issue: "" };
    }
    const { spec, credentials } = source;
    if (!source.base_url) return { ready: false, issue: "servis adresi eksik" };
    if (!spec.list.path) return { ready: false, issue: "hesap listesi yolu eksik" };
    if (spec.auth.type === "login" && !spec.auth.path) return { ready: false, issue: "giriş yolu eksik" };
    if (["login", "basic"].includes(spec.auth.type) && (!credentials.username || !credentials.password)) return { ready: false, issue: "servis giriş bilgileri eksik" };
    if (spec.auth.type === "header" && !credentials.secret) return { ready: false, issue: "API anahtarı eksik" };
    return { ready: true, issue: "" };
  }

  function acquireManual(source, exclude) {
    const rows = db.prepare(
      `SELECT * FROM source_accounts WHERE source_id = ? ${source.use_mode === "once" ? "AND used_at IS NULL" : ""}
       ORDER BY last_used_at IS NOT NULL, last_used_at, id`,
    ).all(source.id);
    const row = rows.find((item) => !exclude.has(`${source.id}:${item.id}`));
    if (!row) throw new Error(rows.length ? "Listedeki tüm hesaplar şu an başka koşumlarda" : "Kullanılabilir hesap kalmadı");
    const now = new Date().toISOString();
    db.prepare("UPDATE source_accounts SET last_used_at = ?, used_at = CASE WHEN ? = 'once' THEN ? ELSE used_at END WHERE id = ?")
      .run(now, source.use_mode, now, row.id);
    return { email: row.email, password: decrypt(key, row.password), phone: row.phone, id: String(row.id), extras: {}, lockKey: `${source.id}:${row.id}` };
  }

  // Picks and immediately locks one account: HTTP sources are marked used at the service, "once" lists persist it.
  async function acquire(source, { environment, filters, exclude = new Set() } = {}) {
    if (source.type === "manual") return acquireManual(source, exclude);
    return fetchHttpAccount(source, source.credentials, { environment, filters, exclude, fetchImpl });
  }

  function publicSource(row) {
    const source = load(row);
    const credentials = source.credentials;
    const usedBy = db.prepare("SELECT configs.name, clients.name AS client_name FROM configs JOIN clients ON clients.id = configs.client_id WHERE account_source_id = ? ORDER BY configs.id").all(source.id);
    return {
      id: source.id,
      client_id: source.client_id,
      client_name: row.client_name || null,
      name: source.name,
      type: source.type,
      template: source.template,
      base_url: source.base_url,
      use_mode: source.use_mode,
      spec: source.spec,
      credentials: { username: credentials.username || "", password: maskSecret(credentials.password), secret: maskSecret(credentials.secret) },
      filters: filterFields(source.spec),
      accounts: source.type === "manual" ? counts(source) : null,
      used_by: usedBy.map((item) => `${item.client_name} · ${item.name}`),
      ...status(source),
    };
  }

  function list() {
    return db.prepare("SELECT sources.*, clients.name AS client_name FROM sources LEFT JOIN clients ON clients.id = sources.client_id ORDER BY sources.client_id IS NOT NULL, clients.name, sources.name").all().map(publicSource);
  }

  // Masked values ("••••") mean "keep what is stored" — on edit from the row itself, on clone from the original.
  function mergeCredentials(input, previous = {}) {
    const keep = (value, old) => (String(value).includes(MASK) ? old || "" : value);
    return { username: input.username, password: keep(input.password, previous.password), secret: keep(input.secret, previous.secret) };
  }

  function writeAccounts(sourceId, accounts, previousId) {
    const previous = new Map(db.prepare("SELECT * FROM source_accounts WHERE source_id = ?").all(previousId ?? sourceId).map((row) => [row.email.toLowerCase(), row]));
    const current = new Map(db.prepare("SELECT * FROM source_accounts WHERE source_id = ?").all(sourceId).map((row) => [row.email.toLowerCase(), row]));
    const keepIds = [];
    for (const entry of accounts) {
      const lookup = entry.email.toLowerCase();
      let password;
      if (!entry.password || entry.password.includes(MASK)) {
        const old = previous.get(lookup);
        if (!old) throw new Error(`${entry.email} için şifre gir`);
        password = old.password;
      } else {
        password = encrypt(key, entry.password);
      }
      const existing = current.get(lookup);
      if (existing) {
        db.prepare("UPDATE source_accounts SET email = ?, password = ?, phone = ? WHERE id = ?").run(entry.email, password, entry.phone, existing.id);
        keepIds.push(existing.id);
      } else {
        const inserted = db.prepare("INSERT INTO source_accounts (source_id, email, password, phone, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(sourceId, entry.email, password, entry.phone, new Date().toISOString());
        keepIds.push(Number(inserted.lastInsertRowid));
      }
    }
    const stale = [...current.values()].filter((row) => !keepIds.includes(row.id));
    for (const row of stale) db.prepare("DELETE FROM source_accounts WHERE id = ?").run(row.id);
  }

  function assertScope(input, id) {
    if (input.clientId !== null && !db.prepare("SELECT id FROM clients WHERE id = ?").get(input.clientId)) throw new Error("Client bulunamadı");
    const clash = db.prepare("SELECT id FROM sources WHERE lower(name) = lower(?) AND client_id IS ? AND id IS NOT ?").get(input.name, input.clientId, id);
    if (clash) throw new Error(`Bu kapsamda "${input.name}" adlı kaynak zaten var`);
    if (id && input.clientId !== null) {
      const outside = db.prepare("SELECT configs.name FROM configs WHERE account_source_id = ? AND client_id != ?").all(id, input.clientId);
      if (outside.length) throw new Error(`Başka client'lardaki konfigürasyonlar bu kaynağı kullanıyor: ${outside.map((item) => item.name).join(", ")}`);
    }
  }

  function save(input, { id = null, cloneOf = null } = {}) {
    assertScope(input, id);
    const previous = id ? sourceById(id) : cloneOf ? sourceById(cloneOf) : null;
    if (id && !previous) throw new Error("Kaynak bulunamadı");
    const credentials = encrypt(key, JSON.stringify(mergeCredentials(input.credentials, previous?.credentials)));
    const values = [input.clientId, input.name, input.type, input.template, input.baseUrl, JSON.stringify(input.spec), input.useMode, credentials];
    db.exec("BEGIN");
    try {
      let sourceId = id;
      if (id) {
        db.prepare("UPDATE sources SET client_id = ?, name = ?, type = ?, template = ?, base_url = ?, spec_json = ?, use_mode = ?, credentials = ? WHERE id = ?").run(...values, id);
      } else {
        sourceId = Number(db.prepare("INSERT INTO sources (client_id, name, type, template, base_url, spec_json, use_mode, credentials) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(...values).lastInsertRowid);
      }
      if (input.type === "manual" && input.accounts) writeAccounts(sourceId, input.accounts, previous?.id);
      if (input.type !== "manual") db.prepare("DELETE FROM source_accounts WHERE source_id = ?").run(sourceId);
      db.exec("COMMIT");
      return sourceId;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function remove(id) {
    const users = db.prepare("SELECT name FROM configs WHERE account_source_id = ?").all(id);
    if (users.length) throw new Error(`Önce bu konfigürasyonlardan kaynağı kaldır: ${users.map((item) => item.name).join(", ")}`);
    db.prepare("DELETE FROM source_accounts WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  }

  function accountLines(id) {
    return db.prepare("SELECT email, phone, used_at FROM source_accounts WHERE source_id = ? ORDER BY id").all(id)
      .map((row) => ({ email: row.email, password: MASK.repeat(8), phone: row.phone, used: Boolean(row.used_at) }));
  }

  function resetUsed(id) {
    return Number(db.prepare("UPDATE source_accounts SET used_at = NULL WHERE source_id = ? AND used_at IS NOT NULL").run(id).changes);
  }

  // Tries the (possibly unsaved) definition without locking or marking anything.
  async function test(input, { id = null, cloneOf = null, environment = "test" } = {}) {
    const previous = id ? sourceById(id) : cloneOf ? sourceById(cloneOf) : null;
    if (input.type === "manual") {
      const lines = input.accounts ?? (previous ? accountLines(previous.id) : []);
      const missing = lines.filter((line) => (!line.password || line.password.includes(MASK)) && !(previous && accountLines(previous.id).some((row) => row.email.toLowerCase() === line.email.toLowerCase())));
      if (!lines.length) throw new Error("Listede hesap yok");
      if (missing.length) throw new Error(`Şifresi eksik hesap: ${missing.map((line) => line.email).join(", ")}`);
      return { message: `${lines.length} hesap okundu`, preview: null };
    }
    const account = await fetchHttpAccount({ id: previous?.id, base_url: input.baseUrl, spec: input.spec }, mergeCredentials(input.credentials, previous?.credentials), {
      environment, markUsed: false, fetchImpl,
    });
    return {
      message: "Servisten bir test hesabı okundu (kilitlenmedi)",
      preview: { email: account.email, phone: account.phone, id: account.id, password: account.password ? "alındı" : "boş", extras: account.extras },
    };
  }

  return { sourceById, status, acquire, list, publicSource, save, remove, accountLines, resetUsed, test };
}
