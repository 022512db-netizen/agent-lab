// Agent Lab 的本地设置层：模型 provider、上游模型清单、工作区。
//
// 为什么要独立一份，而不是继续只读 codex-home/config.toml：
//   config.toml 是要进版本库的「配置」，里面只能放占位符（env_key 名字），
//   不能放某个人的中转地址和密钥。但 App 里又确实需要在界面上改这些东西。
//   所以拆成两层——
//     codex-home/config.toml   默认值 + 结构，能提交
//     agent-lab.settings.json  本机覆盖值，被 .gitignore 排除
//   启动内核时把本机覆盖值拼成 -c 参数传进去，不落盘、不污染可提交的配置。
//
// 密钥永远不放 settings.json，只放 .env（同样被排除，权限 600）。
// settings.json 里只留一个变量名（envKey），和 config.toml 的做法一致。
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SETTINGS_FILE = path.join(ROOT, "agent-lab.settings.json");
export const ENV_FILE = path.join(ROOT, ".env");
export const CODEX_HOME = path.join(ROOT, "codex-home");
export const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");

// 从 config.toml 抠出默认值。只认几个固定键，不做完整 TOML 解析：
// 这份文件的结构是仓库自己钉死的，写一个通用解析器反而是新的出错点。
function readConfigDefaults() {
  const out = { baseUrl: "http://127.0.0.1:57321/v1", model: "", providerId: "custom", envKey: "AGENT_LAB_API_KEY" };
  try {
    const text = readFileSync(CONFIG_FILE, "utf8");
    out.model = text.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? out.model;
    out.providerId = text.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? out.providerId;
    out.baseUrl = text.match(/^\s*openai_base_url\s*=\s*"([^"]+)"/m)?.[1] ?? out.baseUrl;
    out.envKey = text.match(/^\s*env_key\s*=\s*"([^"]+)"/m)?.[1] ?? out.envKey;
    // [model_providers.custom] 里的 base_url 是内核真正用的那个，优先于顶层。
    const block = text.match(/\[model_providers\.[^\]]+\]([\s\S]*?)(?=\n\[|$)/g) ?? [];
    for (const b of block) {
      const url = b.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1];
      if (url) out.baseUrl = url;
    }
  } catch {}
  return out;
}

// provider id 只允许这些字符：它会被拼进 TOML 键名和 .env 变量名，
// 放开引号/点的后果是配置串被注入，不是「名字不好看」这么轻。
export function safeId(raw, fallback = "custom") {
  const id = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || fallback;
}

function netlocLabel(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.host || baseUrl;
  } catch {
    return baseUrl;
  }
}

function defaultSettings() {
  const cfg = readConfigDefaults();
  return {
    activeProvider: cfg.providerId,
    activeModel: cfg.model,
    reasoningEffort: "high",
    providers: [
      {
        id: cfg.providerId,
        name: netlocLabel(cfg.baseUrl),
        baseUrl: cfg.baseUrl,
        wireApi: "responses",
        envKey: cfg.envKey,
        models: cfg.model ? [cfg.model] : [],
        updatedAt: null,
      },
    ],
  };
}

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  } catch {}
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") {
    cache = base;
    return cache;
  }
  const providers = Array.isArray(raw.providers) && raw.providers.length ? raw.providers : base.providers;
  cache = {
    activeProvider: raw.activeProvider ?? base.activeProvider,
    activeModel: raw.activeModel ?? base.activeModel,
    reasoningEffort: raw.reasoningEffort ?? base.reasoningEffort,
    providers: providers.map((p) => ({
      id: safeId(p.id),
      name: p.name || netlocLabel(p.baseUrl),
      baseUrl: p.baseUrl ?? base.providers[0].baseUrl,
      wireApi: p.wireApi === "chat" ? "chat" : "responses",
      envKey: p.envKey || `AGENT_LAB_KEY_${safeId(p.id).toUpperCase().replace(/-/g, "_")}`,
      models: Array.isArray(p.models) ? p.models.filter((m) => typeof m === "string" && m) : [],
      updatedAt: p.updatedAt ?? null,
    })),
  };
  return cache;
}

export function saveSettings(next) {
  cache = next;
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function getActiveProvider() {
  const s = loadSettings();
  return s.providers.find((p) => p.id === s.activeProvider) ?? s.providers[0];
}

// ---------- .env 里的密钥 ----------
export function readEnvFile() {
  try {
    return readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
}

export function readEnvMap() {
  const out = {};
  for (const line of readEnvFile().split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 1) continue;
    let value = text.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[text.slice(0, eq).trim()] = value;
  }
  return out;
}

// 只改目标那一行，其余原样保留——.env 是人手维护过的文件，整体重写会丢注释。
export function writeEnvValue(key, value) {
  const safeKey = String(key).replace(/[^A-Za-z0-9_]/g, "_");
  const lines = readEnvFile().split("\n");
  const next = `${safeKey}=${value}`;
  let hit = false;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*${safeKey}\\s*=`).test(lines[i])) {
      lines[i] = next;
      hit = true;
      break;
    }
  }
  if (!hit) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(next);
  }
  writeFileSync(ENV_FILE, lines.join("\n"), "utf8");
  try {
    chmodSync(ENV_FILE, 0o600);
  } catch {}
  return safeKey;
}

export function providerApiKey(provider) {
  const env = readEnvMap();
  const name = provider?.envKey || "AGENT_LAB_API_KEY";
  return process.env[name] || env[name] || "";
}

export function hasProviderKey(provider) {
  return providerApiKey(provider).length > 0;
}

// ---------- 从上游拉模型名 ----------
// 「OpenAI 兼容」在实践中至少有三种形状，都要认：
//   {data:[{id}]}（标准）、{data:[{name}]}、{models:["a"]}，以及裸数组。
// 只认第一种的话，用户换个中转就会被判成「拉不到模型」，其实是解析没覆盖到。
export function parseModelList(json) {
  const out = new Set();
  const push = (v) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
    else if (v && typeof v === "object") {
      const name = v.id ?? v.name ?? v.model ?? v.slug;
      if (typeof name === "string" && name.trim()) out.add(name.trim());
    }
  };
  const list = Array.isArray(json) ? json : json?.data ?? json?.models ?? json?.data?.data;
  if (Array.isArray(list)) list.forEach(push);
  else if (list && typeof list === "object") Object.keys(list).forEach((k) => out.add(k));
  return [...out];
}

export function normalizeBaseUrl(raw) {
  let base = String(raw ?? "").trim();
  if (!base) return "";
  if (!/^https?:\/\//i.test(base)) base = "http://" + base;
  return base.replace(/\/+$/, "");
}

// baseUrl 到 /models 的拼法不唯一：有人给的是带 /v1 的根，有人给的是裸域名。
// 依次试两种，谁先成功用谁——这比让用户自己猜该不该带 /v1 友好。
export async function fetchUpstreamModels({ baseUrl, apiKey, timeoutMs = 20000 }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error("缺少 base URL");
  const candidates = /\/(v\d+|[^/]*v\d+)$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
  const tried = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        tried.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        tried.push(`${url} → 返回的不是 JSON`);
        continue;
      }
      const models = parseModelList(json);
      if (models.length) return { url, models };
      tried.push(`${url} → 返回里没有模型名`);
    } catch (err) {
      tried.push(`${url} → ${err?.message ?? err}`);
    }
  }
  throw new Error("拉取失败：" + tried.join("；"));
}

// 把 settings 里的 provider 变成内核的 -c 覆盖参数。
// 只覆盖运行期，不改 codex-home/config.toml——那份是要提交的默认值。
export function providerConfigOverrides(settings = loadSettings()) {
  const provider = getActiveProvider();
  const args = [];
  const push = (k, v) => {
    args.push("-c", `${k}=${JSON.stringify(v)}`);
  };
  if (provider) {
    push("model_provider", provider.id);
    push("openai_base_url", provider.baseUrl);
    // name 是必填：内核没有它就直接拒绝启动（实测报 provider name must not be empty）。
    push(`model_providers.${provider.id}.name`, provider.name || provider.id);
    push(`model_providers.${provider.id}.base_url`, provider.baseUrl);
    push(`model_providers.${provider.id}.env_key`, provider.envKey);
    // 内核已废弃 wire_api="chat"，即使旧配置残留也自动修正为 responses
    push(`model_providers.${provider.id}.wire_api`, "responses");
  }
  if (settings.activeModel) push("model", settings.activeModel);
  if (settings.reasoningEffort) push("model_reasoning_effort", settings.reasoningEffort);
  return args;
}
