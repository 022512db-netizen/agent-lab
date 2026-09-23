// 一键安装自检：新机器上跑这一个脚本，就知道环境缺什么。
//
// 为什么需要它：QUICKSTART 里的排查路径散落在不同章节（密钥、模型、项目、
// 内核、Python），新用户/新机器（包括 Mac 首次部署）容易漏。这里把
// 「能不能跑起来」的前置条件按依赖顺序一次性查完，每项都给人话结论。
//
// 覆盖五层，顺序就是依赖顺序：
//   1. Node 本身 + 项目文件齐全
//   2. 密钥（.env / 环境变量）
//   3. 配置（codex-home/config.toml + 模型目录）
//   4. 内核（自编译或 PATH）+ Python（苍穹技能脚本需要）
//   5. 运行态：App 起得来、模型真的回话
//
// 运行：node verify-install.mjs
// App 不需要先起：第 5 层会自己试着拉起并探活。
import { readFile, access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPython, findCodex, findSkillDir } from "./lib/platform.mjs";
import { loadLocalEnv } from "./lib/env.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

let failed = 0;
let warned = 0;
const check = (ok, msg, { warn = false } = {}) => {
  const tag = ok ? "PASS  " : warn ? "WARN  " : "FAIL  ";
  console.log(tag + msg);
  if (!ok) warn ? warned++ : failed++;
  return ok;
};

const env = loadLocalEnv();
const apiKey = process.env.AGENT_LAB_API_KEY ?? env.AGENT_LAB_API_KEY;

// ---------- 1. Node + 项目文件 ----------
console.log("=== 1. 项目文件 ===");
check(true, `Node ${process.version} 可用`);
for (const f of [
  "start.mjs", "app/server.mjs", "app/public/index.html",
  "knowledge.md", "projects.json", "lib/platform.mjs",
  "codex-home/config.toml", "codex-home/model-catalogs/relay-mu96ubev.json",
]) {
  const ok = existsSync(path.join(HERE, f));
  check(ok, ok ? f : `${f} 缺失（新 clone 的话检查 .gitignore 是否漏放行）`);
}

// ---------- 2. 密钥 ----------
console.log("\n=== 2. 密钥 ===");
if (apiKey) {
  check(true, `AGENT_LAB_API_KEY 已设置（${process.env.AGENT_LAB_API_KEY ? "环境变量" : ".env"}，共 ${apiKey.length} 字符）`);
  check(!/sk-在这里填/.test(apiKey), "不是模板占位值");
} else {
  check(false, "缺 AGENT_LAB_API_KEY：复制 .env.example 为 .env 并填入 token");
}

// ---------- 3. 配置内容 ----------
console.log("\n=== 3. 配置 ===");
try {
  const cfg = await readFile(path.join(HERE, "codex-home", "config.toml"), "utf8");
  const model = cfg.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
  check(!!model, `默认模型：${model ?? "（未找到）"}`);
  check(/^\s*env_key\s*=\s*"AGENT_LAB_API_KEY"/m.test(cfg), "配置用 env_key 引用密钥（正确）");

  const catalog = await readFile(
    path.join(HERE, "codex-home", "model-catalogs", "relay-mu96ubev.json"), "utf8",
  );
  check(
    !!model && catalog.includes(`"slug": "${model}"`),
    model ? `模型 ${model} 在目录里有元数据（不会静默降级）`
          : "模型未知，跳过目录核对",
    { warn: true },
  );
} catch (err) {
  check(false, `读配置失败：${err?.message ?? err}`);
}

// ---------- 4. 内核 / Python / 技能 ----------
console.log("\n=== 4. 内核与脚本依赖 ===");
const codex = findCodex();
if (codex === "codex") {
  check(true, "内核：使用 PATH 里的 codex（未找到自编译版本，属正常回退）", { warn: true });
} else {
  check(existsSync(codex), `内核（自编译）：${codex}`);
}
const py = await findPython();
if (py) {
  check(true, `Python：${py}（苍穹技能脚本需要）`);
} else {
  check(false, "找不到 python3 / python——苍穹技能脚本会跑不了（macOS: brew install python）");
}
const skill = findSkillDir("ok-cosmic");
check(
  existsSync(path.join(skill, "SKILL.md")),
  `苍穹技能 ok-cosmic：${skill}`,
  { warn: true },
);

// ---------- 5. 运行态 ----------
console.log("\n=== 5. 运行态（App + 模型真回话）===");
async function waitReady(timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      last = await (await fetch(`${BASE}/api/info`)).json();
      if (last.ready === true) return last;
    } catch { last = null; }
    await new Promise((r) => setTimeout(r, 800));
  }
  return last;
}
const info = await waitReady();
if (!check(info?.ready === true, `App 已就绪（${BASE}）`)) {
  console.log("\n=== 结论 ===");
  console.log("[FAIL] App 起不来。先在项目目录跑：node start.mjs，再看其它项。");
  process.exit(1);
}
console.log(`  工作目录: ${info.cwd}`);

// 最小问答：模型真的能回话，密钥/网络/模型名才算全通。
const rpc = async (method, params) => {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
};

try {
  const started = await rpc("thread/start", {
    cwd: null, model: null, sandbox: "read-only", approvalPolicy: "never",
  });
  const threadId = started.thread.id;
  const events = [];
  const es = await fetch(`${BASE}/api/events`);
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    let buf = "";
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try { events.push(JSON.parse(line.slice(6))); } catch {}
      }
    }
  })();
  await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "回复两个字：在的", textElements: [] }],
  });

  let reply = "";
  for (let i = 0; i < 60 && !reply; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const doneEvt = events.find(
      (e) => e.method === "turn/completed" && e.params?.threadId === threadId,
    );
    if (doneEvt) {
      reply = events
        .filter(
          (e) =>
            e.method === "item/completed" &&
            e.params?.threadId === threadId &&
            e.params?.item?.type === "agentMessage",
        )
        .map((e) => e.params.item.text ?? "")
        .join("");
    }
  }
  try { await es.body.cancel?.().catch?.(() => {}); } catch {}

  if (reply) {
    check(true, `模型回话：${reply.slice(0, 60).replace(/\n/g, " ")}`);
  } else {
    const err = events.find((e) => e.method === "error");
    const detail = err ? JSON.stringify(err.params ?? {}).slice(0, 200) : "超时无回复";
    check(false, `模型没有回话（${detail}）——查模型是否可用、密钥是否有效`);
  }
} catch (err) {
  check(false, `运行态检查失败：${err?.message ?? err}`);
}

// ---------- 结论 ----------
console.log("\n=== 结论 ===");
if (failed === 0) {
  console.log(`[PASS] 安装完整，可以正常使用${warned ? `（另有 ${warned} 项提示）` : ""}`);
} else {
  console.log(`[FAIL] ${failed} 项未通过${warned ? `，${warned} 项提示` : ""}。按上面 FAIL 的顺序修。`);
}
process.exit(failed === 0 ? 0 : 1);
