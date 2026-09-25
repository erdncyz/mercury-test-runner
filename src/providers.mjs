import { createHash, createHmac } from "node:crypto";

export const PROVIDERS = [
  { id: "openai", label: "OpenAI", group: "Bulut", auth: "bearer", base: "https://api.openai.com/v1", family: "openai", hint: "platform.openai.com anahtarı" },
  { id: "azure", label: "Azure OpenAI", group: "Bulut", auth: "azure", base: "https://RESOURCE.openai.azure.com", family: "openai", hint: "Kaynak adresi ve anahtar. Model, deployment adıdır." },
  { id: "anthropic", label: "Anthropic", group: "Bulut", auth: "anthropic", base: "https://api.anthropic.com", family: "anthropic", hint: "console.anthropic.com anahtarı" },
  { id: "gemini", label: "Google Gemini", group: "Bulut", auth: "gemini", base: "https://generativelanguage.googleapis.com/v1beta", family: "gemini", hint: "AI Studio anahtarı" },
  { id: "vertex", label: "Google Vertex AI", group: "Bulut", auth: "bearer", base: "https://aiplatform.googleapis.com/v1/projects/PROJECT/locations/LOCATION/endpoints/openapi", family: "gemini", hint: "OpenAI uyumlu Vertex adresi" },
  { id: "bedrock", label: "Amazon Bedrock", group: "Bulut", auth: "bedrock-key", base: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", family: "openai", hint: "Bedrock API anahtarı. Bölge adresin içinde." },
  { id: "bedrock-iam", label: "Amazon Bedrock IAM", group: "Bulut", auth: "bedrock-iam", base: "https://bedrock.us-east-1.amazonaws.com", family: "openai", hint: "Access key, secret ve bölge. Modeller ListFoundationModels ile gelir." },
  { id: "bedrock-mantle", label: "Amazon Bedrock Mantle", group: "Bulut", auth: "bedrock-key", base: "https://bedrock-mantle.us-east-1.api.aws/openai/v1", family: "openai", hint: "Mantle uç noktası ve Bedrock API anahtarı" },
  { id: "xai", label: "xAI", group: "Bulut", auth: "bearer", base: "https://api.x.ai/v1", family: "openai", hint: "console.x.ai anahtarı" },
  { id: "mistral", label: "Mistral", group: "Bulut", auth: "bearer", base: "https://api.mistral.ai/v1", family: "openai", hint: "console.mistral.ai anahtarı" },
  { id: "groq", label: "Groq", group: "Bulut", auth: "bearer", base: "https://api.groq.com/openai/v1", family: "openai", hint: "console.groq.com anahtarı" },
  { id: "deepseek", label: "DeepSeek", group: "Bulut", auth: "bearer", base: "https://api.deepseek.com/v1", family: "openai", hint: "platform.deepseek.com anahtarı" },
  { id: "cohere", label: "Cohere", group: "Bulut", auth: "bearer", base: "https://api.cohere.ai/compatibility/v1", family: "openai", hint: "OpenAI uyumlu Cohere anahtarı" },
  { id: "perplexity", label: "Perplexity", group: "Bulut", auth: "bearer", base: "https://api.perplexity.ai", family: "openai", hint: "Sonar modelleri. Liste kapalıysa model adını elle yaz." },
  { id: "cerebras", label: "Cerebras", group: "Bulut", auth: "bearer", base: "https://api.cerebras.ai/v1", family: "openai", hint: "cloud.cerebras.ai anahtarı" },
  { id: "sambanova", label: "SambaNova", group: "Bulut", auth: "bearer", base: "https://api.sambanova.ai/v1", family: "openai", hint: "cloud.sambanova.ai anahtarı" },
  { id: "nvidia", label: "NVIDIA NIM", group: "Bulut", auth: "bearer", base: "https://integrate.api.nvidia.com/v1", family: "openai", hint: "build.nvidia.com anahtarı" },
  { id: "fireworks", label: "Fireworks", group: "Bulut", auth: "bearer", base: "https://api.fireworks.ai/inference/v1", family: "openai", hint: "fireworks.ai anahtarı" },
  { id: "together", label: "Together", group: "Bulut", auth: "bearer", base: "https://api.together.xyz/v1", family: "openai", hint: "api.together.ai anahtarı" },
  { id: "openrouter", label: "OpenRouter", group: "Ağ geçidi", auth: "bearer", base: "https://openrouter.ai/api/v1", family: "openai", hint: "openrouter.ai anahtarı" },
  { id: "omniroute", label: "OmniRoute", group: "Ağ geçidi", auth: "bearer", base: "http://localhost:20128/v1", family: "openai", keyOptional: true, hint: "Dashboard → Endpoints anahtarı. Model listesi GET /v1/models." },
  { id: "litellm", label: "LiteLLM", group: "Ağ geçidi", auth: "bearer", base: "http://localhost:4000/v1", family: "openai", keyOptional: true, hint: "Proxy anahtarı ve adresi" },
  { id: "helicone", label: "Helicone", group: "Ağ geçidi", auth: "bearer", base: "https://oai.helicone.ai/v1", family: "openai", hint: "Helicone üzerinden OpenAI" },
  { id: "portkey", label: "Portkey", group: "Ağ geçidi", auth: "bearer", base: "https://api.portkey.ai/v1", family: "openai", hint: "Portkey sanal anahtarı" },
  { id: "huggingface", label: "Hugging Face", group: "Bulut", auth: "bearer", base: "https://router.huggingface.co/v1", family: "openai", hint: "Inference Providers anahtarı" },
  { id: "moonshot", label: "Moonshot", group: "Bulut", auth: "bearer", base: "https://api.moonshot.ai/v1", family: "openai", hint: "platform.moonshot.ai anahtarı" },
  { id: "glm", label: "Zhipu GLM", group: "Bulut", auth: "bearer", base: "https://open.bigmodel.cn/api/paas/v4", family: "openai", hint: "open.bigmodel.cn anahtarı" },
  { id: "qwen", label: "Qwen DashScope", group: "Bulut", auth: "bearer", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", family: "qwen", hint: "DashScope uyumlu anahtar" },
  { id: "minimax", label: "MiniMax", group: "Bulut", auth: "bearer", base: "https://api.minimax.io/v1", family: "openai", hint: "platform.minimax.io anahtarı" },
  { id: "siliconflow", label: "SiliconFlow", group: "Bulut", auth: "bearer", base: "https://api.siliconflow.cn/v1", family: "openai", hint: "cloud.siliconflow.cn anahtarı" },
  { id: "novita", label: "Novita", group: "Bulut", auth: "bearer", base: "https://api.novita.ai/v3/openai", family: "openai", hint: "novita.ai anahtarı" },
  { id: "ollama", label: "Ollama", group: "Yerel", auth: "ollama", base: "http://localhost:11434/v1", family: "openai", keyOptional: true, hint: "Anahtar gerekmez. Modeller /api/tags ile gelir." },
  { id: "lmstudio", label: "LM Studio", group: "Yerel", auth: "bearer", base: "http://localhost:1234/v1", family: "openai", keyOptional: true, hint: "Yerel sunucu. Anahtar boş kalabilir." },
  { id: "vllm", label: "vLLM", group: "Yerel", auth: "bearer", base: "http://localhost:8000/v1", family: "openai", keyOptional: true, hint: "OpenAI uyumlu yerel sunucu" },
  { id: "custom", label: "OpenAI uyumlu", group: "Ağ geçidi", auth: "bearer", base: "", family: "openai", hint: "Kendi adresin. /v1 ile bitsin." },
];

const byId = new Map(PROVIDERS.map((item) => [item.id, item]));

export function providerById(id) {
  return byId.get(id) || null;
}

export function publicProviders() {
  return PROVIDERS.map(({ id, label, group, auth, base, family, keyOptional, hint }) => ({
    id, label, group, auth, base, family, keyOptional: Boolean(keyOptional), hint,
  }));
}

function trimBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function assertHttp(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Adres http veya https olmalı");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Adres http veya https olmalı");
  return url;
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function signAwsGet({ url, region, service, accessKey, secretKey, sessionToken }) {
  const parsed = assertHttp(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256("");
  const headers = { host: parsed.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [
    "GET",
    parsed.pathname || "/",
    [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
  const signing = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), service), "aws4_request");
  const signature = createHmac("sha256", signing).update(stringToSign).digest("hex");
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

function regionOf(base, fallback) {
  const hit = String(base || "").match(/bedrock(?:-runtime|-mantle)?[.-]([a-z0-9-]+)/);
  return hit?.[1] || fallback || "us-east-1";
}

async function readJson(response) {
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 180) };
  }
  if (!response.ok) {
    const message = body.error?.message || body.message || body.raw || response.statusText || "Model listesi alınamadı";
    throw new Error(`${response.status} ${message}`);
  }
  return body;
}

function namesFrom(body) {
  const rows = body.data || body.models || body.modelSummaries || [];
  const names = [];
  for (const row of rows) {
    const id = row.id || row.name || row.modelId || "";
    const label = row.display_name || row.displayName || row.modelName || id;
    if (!id) continue;
    names.push({ id: String(id).replace(/^models\//, ""), label: String(label).replace(/^models\//, "") });
  }
  const seen = new Set();
  return names.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
}

export function assertCredentials(input) {
  const provider = providerById(input.provider);
  if (!provider) throw new Error("Sağlayıcı yok");
  const apiKey = String(input.apiKey || "").trim();
  if (provider.auth === "bedrock-iam") {
    if (!String(input.awsAccessKey || "").trim() || !String(input.awsSecret || "").trim()) throw new Error("Access key ve secret gerekli");
    return provider;
  }
  if (!provider.keyOptional && !apiKey) throw new Error("API anahtarı gerekli");
  if (!trimBase(input.baseUrl || provider.base)) throw new Error("Adres gerekli");
  return provider;
}

export async function listModels(input, fetchImpl = fetch) {
  const provider = assertCredentials(input);
  const base = trimBase(input.baseUrl || provider.base);
  const apiKey = String(input.apiKey || "").trim();
  if (provider.auth === "bedrock-iam") {
    const region = String(input.region || "us-east-1").trim();
    const accessKey = String(input.awsAccessKey || "").trim();
    const secretKey = String(input.awsSecret || "").trim();
    const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
    const headers = signAwsGet({ url, region, service: "bedrock", accessKey, secretKey, sessionToken: String(input.awsSession || "").trim() });
    const body = await readJson(await fetchImpl(url, { headers }));
    return { models: namesFrom(body), base: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1` };
  }
  if (!base) throw new Error("Adres gerekli");
  assertHttp(base);
  if (provider.auth === "gemini") {
    const url = new URL(`${base}/models`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    return { models: namesFrom(await readJson(await fetchImpl(url))), base };
  }
  if (provider.auth === "anthropic") {
    const body = await readJson(await fetchImpl(`${base}/v1/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    }));
    return { models: namesFrom(body), base };
  }
  if (provider.auth === "azure") {
    const version = String(input.azureApiVersion || "2024-10-21").trim();
    const url = new URL(`${base}/openai/models`);
    url.searchParams.set("api-version", version);
    const body = await readJson(await fetchImpl(url, { headers: { "api-key": apiKey } }));
    return { models: namesFrom(body), base };
  }
  if (provider.auth === "ollama") {
    const root = base.replace(/\/v1$/, "");
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    try {
      const tags = await readJson(await fetchImpl(`${root}/api/tags`, { headers }));
      const models = (tags.models || []).map((item) => ({ id: item.name, label: item.name }));
      if (models.length) return { models, base };
    } catch {
      /* OpenAI yolu denenecek */
    }
  }
  const headers = { Authorization: `Bearer ${apiKey || "local"}` };
  if (provider.id === "openrouter") headers["HTTP-Referer"] = "http://localhost:8080";
  const body = await readJson(await fetchImpl(`${base}/models`, { headers }));
  return { models: namesFrom(body), base, region: provider.auth === "bedrock-key" ? regionOf(base, input.region) : "" };
}
