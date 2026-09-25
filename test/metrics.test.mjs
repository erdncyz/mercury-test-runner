import { test } from "node:test";
import assert from "node:assert/strict";
import { metricsFromReport, summarizeExecutions } from "../src/midscene.mjs";

const usage = (id, total, extra = {}) => ({
  request_id: id, prompt_tokens: total - 100, completion_tokens: 100, total_tokens: total, cached_input: 0, time_cost: 1000, response_model_name: "gemini-3.1-flash-lite", ...extra,
});

test("adımın AI kullanımı, eylemleri ve Midscene notu çıkarılır; yeniden yayınlanan çağrı bir kez sayılır, şifre maskelenir", () => {
  const executions = [{
    name: "Act - Giriş formunu aç",
    tasks: [
      { taskId: "a", type: "Planning", subType: "Plan", usage: usage("r1", 1000, { cached_input: 400 }), cache: { hit: false }, output: { log: "Giriş Yap'a tıklıyorum" } },
      { taskId: "b", type: "Action Space", subType: "Tap" },
      { taskId: "c", type: "Planning", subType: "Plan", usage: usage("r2", 2000), output: { output: "Form açık, şifre Gizli123 yazıldı" } },
      { taskId: "c2", type: "Planning", subType: "Plan", usage: usage("r2", 2000) },
      { taskId: "d", type: "Action Space", subType: "Sleep" },
    ],
  }];
  const summary = summarizeExecutions(executions, ["Gizli123"]);
  assert.deepEqual(summary.ai, {
    calls: 2, promptTokens: 2800, completionTokens: 200, cachedTokens: 400, totalTokens: 3000, timeMs: 2000, cacheHits: 0, models: ["gemini-3.1-flash-lite"],
  });
  assert.deepEqual(summary.actions, ["Tap"], "bekleme ve hata eylem sayılmaz");
  assert.equal(summary.note, "Form açık, şifre •••••••• yazıldı");
  assert.deepEqual(summarizeExecutions([]), {});
});

test("eski koşumların adım ölçüleri Midscene raporundan adım adımına eşlenir", () => {
  const dump = {
    executions: [
      { name: "Act - Çerezleri kapat", tasks: [{ type: "Planning", subType: "Plan", timing: { start: 1000, end: 3000 }, usage: usage("x1", 500), output: { output: "Pencere yok" } }] },
      { name: "Input - E-posta alanı", tasks: [{ type: "Planning", subType: "Locate", timing: { start: 3000, end: 4000 }, usage: usage("x2", 300) }, { type: "Action Space", subType: "Input", timing: { start: 4000, end: 4500 } }] },
    ],
  };
  const html = `<html><script type="midscene_web_dump" data-group-id="g">${JSON.stringify(dump)}</script></html>`;
  const steps = [
    { action: "launch", text: "https://acme.io", status: "passed" },
    { action: "aiAct", text: "Çerezleri kapat", status: "passed" },
    { action: "aiInput", text: "E-posta alanı ← a@b.c", args: { locate: "E-posta alanı", value: "a@b.c" }, status: "passed" },
    { action: "aiAssert", text: "Giriş yapıldı", status: "skipped" },
  ];
  const metrics = metricsFromReport(html, steps);
  assert.equal(metrics[0], null);
  assert.equal(metrics[1].durationMs, 2000);
  assert.equal(metrics[1].note, "Pencere yok");
  assert.deepEqual([metrics[2].durationMs, metrics[2].ai.calls, metrics[2].actions], [1500, 1, ["Input"]]);
  assert.equal(metrics[3], null);
  assert.equal(metricsFromReport("<html></html>", steps), null);
});
