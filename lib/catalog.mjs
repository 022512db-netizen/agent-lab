// 模型目录自动补齐。
//
// 内核只认目录里有的模型；上游新增的模型不在目录里时，会报
// 「Model metadata for X not found」并用兜底参数跑（上下文窗口可能不对）。
// 这里在启动内核前、保存模型设置时，把 settings 里出现过的每个模型都补进目录：
// 1. 先找目录里「同名去前缀」的已知模型当模板（mimo-v2.6-flash -> xiaomi/mimo-v2.6-flash）；
// 2. 再找名字前缀最长的（claude-opus-5-5 -> claude-opus-4-6-thinking）；
// 3. 都没有就用保守模板：上下文窗口 128k。
// 已知真实参数写进数据目录的 model-overrides.json，会覆盖到对应条目上：
//   { "claude-opus-5-5": { "context_window": 200000, "max_context_window": 200000, "auto_compact_token_limit": 180000 } }
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

export const CATALOG_NAME = "relay-mu96ubev.json";
const SAFE_WINDOW = 128000;

function baseName(slug) {
  return String(slug).toLowerCase().split(/[/:]/).pop().replace(/\s+/g, "-");
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

function pickTemplate(slug, models) {
  const base = baseName(slug);
  const exact = models.find((m) => baseName(m.slug) === base);
  if (exact) return { template: exact, keepWindow: true };
  // 名字前缀最长的当模板：GPT-6 Sol -> gpt-6-astra，claude-opus-5-5 -> claude-opus-4-6-thinking。
  let best = null;
  let bestLen = 0;
  for (const m of models) {
    const n = commonPrefix(base, baseName(m.slug));
    if (n > bestLen) [best, bestLen] = [m, n];
  }
  if (best && bestLen >= 4) return { template: best, keepWindow: true };
  const fallback = models.find((m) => (m.context_window ?? 0) <= 272000) ?? models[0];
  return { template: fallback, keepWindow: false };
}

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

// 返回新增或被覆盖更新的模型名；目录没变化时返回空数组、不写盘。
export function ensureCatalog({ codexHome, dataDir, slugs }) {
  const file = path.join(codexHome, "model-catalogs", CATALOG_NAME);
  const catalog = readJson(file, null);
  if (!catalog?.models?.length) return [];
  const overrides = readJson(path.join(dataDir, "model-overrides.json"), {});
  const known = catalog.models;
  const changed = [];

  for (const slug of new Set(slugs.filter((s) => typeof s === "string" && s.trim()))) {
    let entry = known.find((m) => m.slug === slug);
    if (!entry) {
      const { template, keepWindow } = pickTemplate(slug, known);
      entry = structuredClone(template);
      Object.assign(entry, { slug, display_name: slug, description: slug, priority: (template.priority ?? 1000) + 1 });
      if (!keepWindow) {
        entry.context_window = SAFE_WINDOW;
        entry.max_context_window = SAFE_WINDOW;
        entry.auto_compact_token_limit = Math.floor(SAFE_WINDOW * 0.9);
      }
      known.push(entry);
      changed.push(slug);
    }
    const o = overrides[slug];
    if (o && typeof o === "object") {
      const before = JSON.stringify(entry);
      Object.assign(entry, o);
      if (JSON.stringify(entry) !== before && !changed.includes(slug)) changed.push(slug);
    }
  }

  if (changed.length) {
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(catalog, null, 2) + "\n");
    renameSync(tmp, file);
  }
  return changed;
}
