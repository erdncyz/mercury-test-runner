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

test("YAML'da yeni adımlar: kısa biçim ve argümanlı biçim; gösterilen metin Midscene'a giden argümanı bozmaz", () => {
  const steps = parseSteps(`cases:
  - name: "Sepet"
    steps:
      - aiKeyboardPress: Enter
      - aiKeyboardPress: Escape
          locate: "Arama kutusu"
      - aiScroll: "Ürün listesi"
      - aiScroll:
          direction: down
          scrollType: untilBottom
      - aiNumber: "Ürün fiyatı"
          name: fiyat
      - aiNumber:
          prompt: "Sepet tutarı"
          expect: "{{saved.fiyat}}"
      - aiPinch:
          direction: in
`);
  assert.deepEqual(steps, [
    { action: "aiKeyboardPress", text: "Enter" },
    { action: "aiKeyboardPress", text: "Escape · Arama kutusu", args: { keyName: "Escape", locate: "Arama kutusu" } },
    { action: "aiScroll", text: "Ürün listesi" },
    { action: "aiScroll", text: "Ekran · down · untilBottom", args: { direction: "down", scrollType: "untilBottom" } },
    { action: "aiNumber", text: "Ürün fiyatı → fiyat", args: { prompt: "Ürün fiyatı", name: "fiyat" } },
    { action: "aiNumber", text: "Sepet tutarı = {{saved.fiyat}}", args: { prompt: "Sepet tutarı", expect: "{{saved.fiyat}}" } },
    { action: "aiPinch", text: "Ekran · in", args: { direction: "in" } },
  ]);
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
