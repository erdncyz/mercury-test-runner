import { test } from "node:test";
import assert from "node:assert/strict";
import { listCases, parseSteps } from "../src/worker.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("YAML adımları sırasıyla okunur", () => {
  const steps = parseSteps(`client: Örnek Proje
cases:
  - name: "Giriş"
    tags: [a]
    steps:
      # yorum
      - launch:
          uri: "{{launchUrl}}"
      - aiAct: "Giriş'e bas"
      - aiInput:
          locate: "Şifre alanı"
          value: "{{account.password}}"
      - aiAssert: 'Üye alanı görünür'
  - name: "İkinci"
    steps:
      - aiWaitFor: Ana sayfa yüklendi
tags: [x]
`);
  assert.deepEqual(steps, [
    { action: "launch", text: "{{launchUrl}}", args: { uri: "{{launchUrl}}" } },
    { action: "aiAct", text: "Giriş'e bas" },
    { action: "aiInput", text: "Şifre alanı ← {{account.password}}", args: { locate: "Şifre alanı", value: "{{account.password}}" } },
    { action: "aiAssert", text: "Üye alanı görünür" },
    { action: "aiWaitFor", text: "Ana sayfa yüklendi" },
  ]);
  assert.deepEqual(parseSteps("client: x"), []);
});

test("YAML case etiketleri planlama için okunur", () => {
  const root = mkdtempSync(join(tmpdir(), "mtr-cases-"));
  writeFileSync(join(root, "C1.yaml"), `testrailCaseId: 1
client: demo
tags: [smoke, regression]
cases:
  - name: "Demo"
    tags: [login]
    steps:
      - launch: "https://example.com"
`);
  const [item] = listCases(root);
  assert.deepEqual(item.tags, ["smoke", "regression", "login"]);
});
