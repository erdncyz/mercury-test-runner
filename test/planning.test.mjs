import { test } from "node:test";
import assert from "node:assert/strict";
import { configurationPlan, laneCount, normalizeConfigInput, selectCases, serialList, shardCases } from "../src/planning.mjs";

const cases = [
  { client: "demo", caseId: "1", tags: ["smoke", "login"] },
  { client: "demo", caseId: "2", tags: ["regression"] },
  { client: "other", caseId: "3", tags: ["smoke"] },
];

test("konfigürasyon case ID, etiket ve client sınırına göre case seçer", () => {
  assert.deepEqual(selectCases({ client_name: "demo", case_ids: '["2"]', case_tags: '["smoke"]' }, cases).map((item) => item.caseId), ["2"]);
  assert.deepEqual(selectCases({ client_name: "demo", case_ids: "[]", case_tags: '["smoke"]' }, cases).map((item) => item.caseId), ["1"]);
  assert.deepEqual(selectCases({ client_name: "demo", case_ids: "[]", case_tags: "[]" }, cases).map((item) => item.caseId), ["1", "2"]);
});

test("zorunlu hesap ve web hedefi hazır olmadan plan çalıştırılmaz", () => {
  const plan = configurationPlan({
    client_name: "demo",
    enabled: 1,
    platform: "web",
    launch_url: "",
    account_policy: "required",
    account_source_id: null,
    case_ids: "[]",
    case_tags: "[]",
  }, cases);
  assert.equal(plan.ready, false);
  assert.match(plan.issues.join(" "), /başlangıç adresi/);
  assert.match(plan.issues.join(" "), /hesap kaynağı seçilmemiş/);

  const source = {
    client_name: "demo", enabled: 1, platform: "web", launch_url: "https://x", case_ids: "[]", case_tags: "[]",
    account_source_id: 3, account_source_name: "Staging", account_source_ready: false, account_source_issue: "servis giriş bilgileri eksik",
  };
  const required = configurationPlan({ ...source, account_policy: "required" }, cases);
  assert.equal(required.ready, false);
  assert.match(required.issues.join(" "), /"Staging" hesap kaynağında servis giriş bilgileri eksik/);
  const optional = configurationPlan({ ...source, account_policy: "optional" }, cases);
  assert.equal(optional.ready, true, "opsiyonel kaynakta eksik yalnız uyarıdır");
  assert.match(optional.warnings.join(" "), /Staging/);
});

test("mobil konfigürasyon Farm, ADB, model ve paket kimliği hazır olunca çalıştırılabilir", () => {
  const base = {
    client_name: "demo", enabled: 1, platform: "android", account_policy: "none",
    account_source_id: null, case_ids: "[]", case_tags: "[]", package_id: "",
  };
  const missing = configurationPlan(base, cases, { farmReady: false, adbReady: false, modelReady: false });
  assert.equal(missing.ready, false);
  assert.match(missing.issues.join(" "), /Mercury Farm/);
  assert.match(missing.issues.join(" "), /ADB/);
  assert.match(missing.issues.join(" "), /Midscene modeli/);
  assert.match(missing.issues.join(" "), /applicationId/);

  const android = configurationPlan({ ...base, package_id: "com.demo" }, cases);
  assert.equal(android.ready, true);
  assert.match(android.warnings.join(" "), /kurulu sürüm/);
  const ios = configurationPlan({ ...base, platform: "ios", package_id: "com.demo.ios", app_url: "https://f/app.ipa" }, cases, { adbReady: false });
  assert.equal(ios.ready, true, "iOS ADB gerektirmez");
  assert.equal(configurationPlan({ ...base, platform: "tv" }, cases).ready, false);
});

test("konfigürasyon girdisi güvenli enum ve listelere normalize edilir", () => {
  const input = normalizeConfigInput({
    name: " Web ",
    platform: "web",
    aliases: [" web ", ""],
    accountPolicy: "required",
    caseIds: ["1", " 2 "],
  });
  assert.equal(input.name, "Web");
  assert.deepEqual(input.aliases, ["web"]);
  assert.deepEqual(input.caseIds, ["1", "2"]);
  assert.equal(input.accountPolicy, "required");
});

test("paralel hat sayısı UDID havuzu ve case sayısıyla sınırlanır, case'ler dengeli bölünür", () => {
  assert.deepEqual(serialList("A1\nB2, C3;A1"), ["A1", "B2", "C3"]);
  assert.deepEqual(serialList('["X","Y"]'), ["X", "Y"]);
  assert.equal(laneCount({ platform: "android", parallel: 3, device_serials: '["A","B"]' }, 10), 2);
  assert.equal(laneCount({ platform: "web", parallel: 4, device_serials: '["A"]' }, 10), 4, "web UDID kullanmaz");
  assert.equal(laneCount({ platform: "ios", parallel: 5 }, 2), 2);
  assert.deepEqual(shardCases(5, 2), [[0, 2, 4], [1, 3]]);
  assert.deepEqual(shardCases(1, 3), [[0]]);

  const base = { client_name: "demo", enabled: 1, platform: "android", account_policy: "none", package_id: "com.demo", case_ids: "[]", case_tags: "[]" };
  const short = configurationPlan({ ...base, parallel: 3, device_serials: '["A","B"]' }, cases);
  assert.equal(short.ready, false);
  assert.match(short.issues.join(" "), /3 UDID gerekir, 2 girildi/);
  const wide = configurationPlan({ ...base, parallel: 3 }, cases, { limits: { web: 1 } });
  assert.equal(wide.ready, true);
  assert.equal(wide.lanes, 2, "2 case olduğu için 2 hat");
  assert.match(wide.warnings.join(" "), /2 paralel hat kullanılır/);
  assert.doesNotMatch(wide.warnings.join(" "), /tarayıcı/, "mobil satır sunucunun tarayıcı sınırından etkilenmez");
  const web = configurationPlan({ ...base, platform: "web", launch_url: "https://x", parallel: 2 }, cases, { limits: { web: 1 } });
  assert.match(web.warnings.join(" "), /en fazla 1 tarayıcı/);
  assert.throws(() => normalizeConfigInput({ name: "x", platform: "ios", deviceWaitMinutes: 0 }), /1–1440/);
  assert.equal(normalizeConfigInput({ name: "x", platform: "ios", deviceWaitMinutes: "120" }).deviceWaitMinutes, 120);
  assert.throws(() => normalizeConfigInput({ name: "x", platform: "web", parallel: 0 }), /1–20/);
  assert.deepEqual(normalizeConfigInput({ name: "x", platform: "ios", deviceSerials: "U1\nU2", accountFilters: { userPackage: " FULL " } }).accountFilters, { userPackage: "FULL" });
});
