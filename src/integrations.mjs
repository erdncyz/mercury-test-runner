function authHeader(user, key) {
  const token = Buffer.from(`${user}:${key}`).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json" };
}

export async function testrail(settings, path, { method = "GET", body } = {}) {
  const host = String(settings.testrail_host || "").replace(/\/$/, "");
  if (!host || !settings.testrail_user || !settings.testrail_api_key) {
    return { skipped: true, reason: "TestRail ayarı eksik" };
  }
  let response;
  try {
    response = await fetch(`${host}/index.php?/api/v2/${path}`, {
      method,
      headers: authHeader(settings.testrail_user, settings.testrail_api_key),
      body: body ? JSON.stringify(body) : undefined,
      // Chat waits for add_run before replying; a hung TestRail must not hang the chat.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`TestRail'e ulaşılamadı (${error.name === "TimeoutError" ? "zaman aşımı" : error.cause?.code || error.message})`);
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { if (response.ok) throw new Error("TestRail yanıtı JSON değil"); }
  }
  if (!response.ok) throw new Error(`TestRail ${response.status}${data.error ? ` · ${data.error}` : ""}`);
  return data;
}

export async function addRun(settings, { suiteId, name, caseIds }) {
  return testrail(settings, `add_run/${settings.testrail_project_id}`, {
    method: "POST",
    body: { suite_id: Number(suiteId) || undefined, name, include_all: false, case_ids: caseIds },
  });
}

export async function addPlan(settings, { name, entries }) {
  return testrail(settings, `add_plan/${settings.testrail_project_id}`, {
    method: "POST",
    body: { name, entries },
  });
}

export async function addResults(settings, runId, results) {
  if (!runId) return { skipped: true };
  return testrail(settings, `add_results_for_cases/${runId}`, {
    method: "POST",
    body: { results },
  });
}

export async function farmRequest(settings, path, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const host = String(settings.farm_base_url || "").replace(/\/$/, "");
  if (!host || !settings.farm_token) return { skipped: true, reason: "Farm ayarı eksik" };
  const response = await fetch(`${host}${path}`, {
    method,
    headers: { Authorization: `Bearer ${settings.farm_token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.description || data.error || data.message || `Farm ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
