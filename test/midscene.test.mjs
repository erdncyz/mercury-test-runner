import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFamily, midsceneModel, resolveText, redactSecrets } from "../src/midscene.mjs";

test("Midscene model ailesi model adından algılanır", () => {
  assert.equal(detectFamily("qwen3-vl-plus"), "qwen3-vl");
  assert.equal(detectFamily("qwen3.7-plus"), "qwen3");
  assert.equal(detectFamily("qwen3.5-vl"), "qwen3.5");
  assert.equal(detectFamily("gemini-3.5-flash"), "gemini");
  assert.equal(detectFamily("openai/gpt-5.6-sol"), "gpt-5");
  assert.equal(detectFamily("gpt-6-astra"), "gpt-6");
  assert.equal(detectFamily("doubao-seed-2-1-turbo-260628"), "doubao-seed");
  assert.equal(detectFamily("UI-TARS-1.5-7B"), "vlm-ui-tars-doubao-1.5");
  assert.equal(detectFamily("gpt-4.1"), "");
});

test("model ayarı Midscene modelConfig'e çevrilir", () => {
  const gemini = midsceneModel({ model_provider: "gemini", model_name: "gemini-3.5-flash", model_api_key: "k", model_base_url: "https://generativelanguage.googleapis.com/v1beta" });
  assert.deepEqual(gemini.config, {
    MIDSCENE_MODEL_NAME: "gemini-3.5-flash",
    MIDSCENE_MODEL_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    MIDSCENE_MODEL_API_KEY: "k",
    MIDSCENE_MODEL_FAMILY: "gemini",
  });
  const override = midsceneModel({ model_provider: "openrouter", model_name: "my-vl", model_api_key: "k", midscene_model_family: "qwen3-vl" });
  assert.equal(override.config.MIDSCENE_MODEL_FAMILY, "qwen3-vl");
  const local = midsceneModel({ model_provider: "ollama", model_name: "qwen2.5-vl:7b" });
  assert.equal(local.config.MIDSCENE_MODEL_API_KEY, "not-needed");
  assert.match(midsceneModel({ model_provider: "openai", model_name: "gpt-4.1", model_api_key: "k" }).error, /ailesi belirlenemedi/);
  assert.match(midsceneModel({ model_provider: "bedrock-iam", model_name: "x", model_aws_secret: "s" }).error, /Bedrock IAM/);
  assert.match(midsceneModel({ model_provider: "openai", model_name: "gpt-5", model_api_key: "" }).error, /anahtarı yok/);
  assert.match(midsceneModel({}).error, /bağlı değil/);
});

test("adım değişkenleri çözülür, eksikse açık hata verir", () => {
  const vars = { launchUrl: "https://x.test", account: { email: "a@b.c", password: "p" } };
  assert.equal(resolveText("{{launchUrl}}/giris", vars), "https://x.test/giris");
  assert.equal(resolveText("{{ account.email }}", vars), "a@b.c");
  assert.throws(() => resolveText("{{account.phone}}", vars), /Değişken çözülemedi: account.phone/);
});

test("rapordaki test kullanıcısı şifresi her kaçış biçiminde maskelenir", () => {
  const secret = `P@ss"<w&rd>'1`;
  const report = [
    `{"param":{"value":${JSON.stringify(secret)}}}`,
    `<script>{"v":"${JSON.stringify(secret).slice(1, -1).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}"}</script>`,
    `<td>P@ss&quot;&lt;w&amp;rd&gt;&#39;1</td>`,
    "plain P@ss\"<w&rd>'1 end",
  ].join("\n");
  const clean = redactSecrets(report, [secret, "", "ab", undefined]);
  assert.doesNotMatch(clean, /P@ss/);
  assert.equal(clean.split("••••••••").length - 1, 4);
  assert.equal(redactSecrets("ab abc", ["ab"]), "ab abc", "çok kısa değerler maskelenmez");
});
