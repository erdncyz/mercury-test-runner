import assert from "node:assert/strict";
import { test } from "node:test";
import { listModels, publicProviders, signAwsGet } from "../src/providers.mjs";

test("katalog Bedrock ve OmniRoute içerir", () => {
  const ids = publicProviders().map((item) => item.id);
  for (const id of ["openai", "anthropic", "gemini", "azure", "bedrock", "bedrock-iam", "omniroute", "ollama", "openrouter", "groq"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("OpenAI model listesi okunur", async () => {
  const seen = [];
  const result = await listModels(
    { provider: "openai", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" },
    async (url, options) => {
      seen.push({ url: String(url), auth: options.headers.Authorization });
      return new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }] }), { status: 200 });
    },
  );
  assert.deepEqual(result.models.map((item) => item.id), ["gpt-4.1", "gpt-4.1-mini"]);
  assert.equal(seen[0].auth, "Bearer sk-test");
});

test("Bedrock IAM imzası Authorization üretir", () => {
  const headers = signAwsGet({
    url: "https://bedrock.us-east-1.amazonaws.com/foundation-models",
    region: "us-east-1",
    service: "bedrock",
    accessKey: "AKIAEXAMPLE",
    secretKey: "secret",
  });
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
  assert.equal(headers.host, "bedrock.us-east-1.amazonaws.com");
});
