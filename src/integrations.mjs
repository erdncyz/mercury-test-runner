function authHeader(user, key) {
  const token = Buffer.from(`${user}:${key}`).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json" };
}

export function testrailConfigured(settings) {
  return Boolean(String(settings.testrail_host || "").trim() && settings.testrail_user && settings.testrail_api_key);
}

export async function testrail(settings, path, { method = "GET", body } = {}) {
  const host = String(settings.testrail_host || "").replace(/\/$/, "");
  if (!testrailConfigured(settings)) {
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

// TestRail 6.7+ pages list endpoints ({ projects, _links.next }); older versions return a plain array.
async function fetchAll(settings, path, key) {
  const items = [];
  let next = path;
  for (let page = 0; next && page < 50; page += 1) {
    const data = await testrail(settings, next);
    if (data.skipped) return data;
    items.push(...(Array.isArray(data) ? data : data[key] || []));
    next = Array.isArray(data) ? "" : String(data._links?.next || "").replace(/^\/api\/v2\//, "");
  }
  return items;
}

export async function listProjects(settings) {
  const items = await fetchAll(settings, "get_projects&is_completed=0", "projects");
  return items.skipped ? items : items.map(({ id, name, suite_mode: suiteMode }) => ({ id: String(id), name, suiteMode: Number(suiteMode) || 1 }));
}

export async function listSuites(settings, projectId = settings.testrail_project_id) {
  if (!testrailConfigured(settings)) return { skipped: true, reason: "TestRail ayarı eksik" };
  if (!String(projectId || "").trim()) return { skipped: true, reason: "TestRail projesi seçilmedi" };
  const items = await fetchAll(settings, `get_suites/${String(projectId).trim()}`, "suites");
  return items.skipped ? items : items.filter((item) => !item.is_completed).map(({ id, name }) => ({ id: String(id), name }));
}

// Suites of the chosen TestRail project, or of every project when "Tüm projeler" is selected.
export async function listProjectSuites(settings) {
  const projects = await listProjects(settings);
  if (projects.skipped) return projects;
  const chosen = String(settings.testrail_project_id || "").trim();
  const scope = chosen ? projects.filter((project) => project.id === chosen) : projects;
  if (chosen && !scope.length) throw new Error(`TestRail'de #${chosen} numaralı açık proje yok`);
  const out = [];
  // A few projects at a time keeps large TestRail instances from rate-limiting the dialog.
  for (let start = 0; start < scope.length; start += 4) {
    const batch = await Promise.all(scope.slice(start, start + 4).map(async (project) => {
      const suites = await listSuites(settings, project.id);
      return suites.map((suite) => ({ ...suite, project_id: project.id, project_name: project.name, suite_mode: project.suiteMode }));
    }));
    out.push(...batch.flat());
  }
  return out;
}

// Each Mercury project may belong to its own TestRail project; the settings project is the fallback.
export async function addRun(settings, { projectId, suiteId, name, caseIds }) {
  return testrail(settings, `add_run/${projectId || settings.testrail_project_id}`, {
    method: "POST",
    body: { suite_id: Number(suiteId) || undefined, name, include_all: false, case_ids: caseIds },
  });
}

export const SCENARIO_SECTION = "Mercury · Anlık senaryolar";

// Chat scenarios have no TestRail cases, so each is filed under one Mercury section of the suite; a title that is
// already there is reused. Without a suite the project's first open suite is used (single-suite projects have one).
export async function ensureScenarioCases(settings, { projectId, suiteId, cases }) {
  let suite = String(suiteId || "").trim();
  if (!suite) {
    const suites = await listSuites(settings, projectId);
    if (suites.skipped) return suites;
    if (!suites.length) throw new Error(`TestRail projesi #${projectId} içinde açık suite yok`);
    suite = suites[0].id;
  }
  const sections = await fetchAll(settings, `get_sections/${projectId}&suite_id=${suite}`, "sections");
  if (sections.skipped) return sections;
  let section = sections.find((item) => item.name === SCENARIO_SECTION && !item.parent_id);
  if (!section) {
    section = await testrail(settings, `add_section/${projectId}`, {
      method: "POST",
      body: { suite_id: Number(suite), name: SCENARIO_SECTION, description: "Mercury Test Runner chat'inden koşulan anlık senaryolar" },
    });
  }
  const existing = await fetchAll(settings, `get_cases/${projectId}&suite_id=${suite}&section_id=${section.id}`, "cases");
  const byTitle = new Map((existing.skipped ? [] : existing).map((item) => [item.title, String(item.id)]));
  const caseIds = [];
  for (const item of cases) {
    let id = byTitle.get(item.title);
    if (!id) {
      const path = `add_case/${section.id}`;
      // custom_steps is the default template's steps field; an instance without it still gets the case by title.
      const created = await testrail(settings, path, { method: "POST", body: { title: item.title, custom_steps: item.stepsText || "" } })
        .catch(() => testrail(settings, path, { method: "POST", body: { title: item.title } }));
      id = String(created.id);
      byTitle.set(item.title, id);
    }
    caseIds.push(id);
  }
  return { suiteId: suite, caseIds };
}

export async function addPlan(settings, { projectId, name, entries }) {
  return testrail(settings, `add_plan/${projectId || settings.testrail_project_id}`, {
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
