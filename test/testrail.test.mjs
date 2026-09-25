import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIO_SECTION, ensureScenarioCases } from "../src/integrations.mjs";

test("anlık senaryo case'leri TestRail'de Mercury bölümüne yazılır; aynı başlık yeniden kullanılır", async () => {
  const calls = [];
  const cases = [{ id: 900, title: "Kullanıcı girişi", section_id: 77 }];
  const sections = [{ id: 10, name: "Giriş", parent_id: null }];
  const fake = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split("?")[1] || "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push([req.method, path, body]);
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path === "/api/v2/get_suites/3") return reply(200, [{ id: 31, name: "Master" }]);
    if (path === "/api/v2/get_sections/3&suite_id=31") return reply(200, { sections, _links: { next: null } });
    if (path === "/api/v2/add_section/3") {
      const section = { id: 77, name: body.name, parent_id: null };
      sections.push(section);
      return reply(200, section);
    }
    if (path === "/api/v2/get_cases/3&suite_id=31&section_id=77") return reply(200, { cases: cases.filter((item) => item.section_id === 77), _links: { next: null } });
    const add = path.match(/^\/api\/v2\/add_case\/(\d+)$/);
    if (add) {
      if (body.custom_steps !== undefined) return reply(400, { error: "Field :custom_steps is not a valid field" });
      const created = { id: 901 + calls.filter(([, item]) => item.startsWith("/api/v2/add_case")).length, title: body.title, section_id: Number(add[1]) };
      cases.push(created);
      return reply(200, created);
    }
    return reply(404, { error: "unknown" });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const settings = { testrail_host: `http://127.0.0.1:${fake.address().port}/`, testrail_user: "qa@acme.io", testrail_api_key: "k" };
  try {
    const first = await ensureScenarioCases(settings, { projectId: "3", suiteId: "", cases: [{ title: "Arama", stepsText: "1. Aç: https://acme.io" }] });
    assert.equal(first.suiteId, "31", "suite verilmezse projenin ilk açık suite'i kullanılır");
    assert.equal(sections.at(-1).name, SCENARIO_SECTION, "Mercury bölümü yoksa açılır");
    const created = calls.filter(([, path]) => path === "/api/v2/add_case/77");
    assert.equal(created[0][2].custom_steps, "1. Aç: https://acme.io");
    assert.deepEqual(created[1][2], { title: "Arama" }, "adım alanı olmayan şablonda case yalnız başlıkla açılır");

    cases.push({ id: 950, title: "Kullanıcı girişi", section_id: 77 });
    const again = await ensureScenarioCases(settings, { projectId: "3", suiteId: "31", cases: [{ title: "Kullanıcı girişi" }, { title: "Arama" }] });
    assert.deepEqual(again.caseIds, ["950", first.caseIds[0]], "Mercury bölümündeki aynı başlıklı case yeniden kullanılır");
    assert.equal(calls.filter(([, path]) => path === "/api/v2/add_section/3").length, 1, "bölüm bir kez açılır");
  } finally {
    fake.close();
  }
});
