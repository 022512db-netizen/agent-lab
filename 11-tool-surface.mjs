// 实验 11：工具面污染——agent 每一轮到底背了多少工具
//
// 背景：模型每一轮都要把「所有工具的说明书」塞进上下文。实测这台机器上，
// Agent Lab 一开局就挂着 7 个工具服务 / 32 个工具，而「我的知识」只占 2 个。
// 工具越多 -> 每轮越贵、模型选错工具的概率越高。README 里那条「工具会抖动」，
// 根因就在这里。
//
// 做法：同一个内核跑两次，只有「读哪份配置」不同：
//   1) 全局 ~/.codex        —— 你在 Codex 桌面版用的那份
//   2) agent-lab/codex-home —— 这个 App 专用，里面只挂「我的知识」
// 各问一次 mcpServerStatus/list，对比服务数、工具数、以及后台报错。
//
// 顺手记一个坑：URL 型服务（idea / codex_apps）不能用 `-c mcp_servers.X.enabled=false` 关。
// 覆盖是「换掉这个 key」而不是「合并」：一写就只剩 enabled=false，
// transport 没了 -> invalid transport -> app-server 直接起不来。
// 所以隔离要用独立 CODEX_HOME，而不是一串 -c。
//
// 运行： node 11-tool-surface.mjs
import { spawn } from "node:child_process";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { findCodex } from "./lib/platform.mjs";
import os from "node:os";

// 内核路径交给 lib/platform.mjs 解析。两边产物路径不同（Windows 多一层
// 三元组目录和 .exe），写死一个会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();

// 「我的知识」这个服务不由全局配置提供，是 App 启动时挂上去的。
// 两次实验都把它算进来，对比才公平。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MY_MCP = path.join(HERE, "mcp-my-knowledge", "server.mjs");
const MINE = [
  "-c",
  `mcp_servers.my_knowledge.command=${JSON.stringify(process.execPath)}`,
  "-c",
  `mcp_servers.my_knowledge.args=${JSON.stringify([MY_MCP])}`,
  // 跟 App 启动时一样，把这个表整体盖掉；带上延迟暴露那条，两次实验才只差配置目录。
  "-c",
  `mcp_servers.my_knowledge.omit_tools_from=${JSON.stringify(["deferred"])}`,
];

const LAB_HOME = path.join(HERE, "codex-home");
// 全局配置目录用 os.homedir() 拼，不要写死 C:\Users\<名字>：换机器 / 换系统都会错，
// 而且错得很安静——只是对比出来的工具数看着不对。
const GLOBAL_HOME = process.env.GLOBAL_CODEX_HOME ?? path.join(os.homedir(), ".codex");

const WATCH_MS = 6000; // 光握手之后静置这么久，看谁在后台报错

function run(args, label, codexHome) {
  return new Promise((resolve) => {
    const server = spawn(CODEX_BIN, ["app-server", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // .env 里的密钥要带上，否则内核报 Missing environment variable
      env: { ...process.env, ...loadLocalEnv(), CODEX_HOME: codexHome },
    });
    const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");

    const errors = [];
    let servers = [];
    let totalTools = 0;
    let buffer = "";
    let done = false;
    let gotInventory = false;
    let fatal = null;

    server.stderr.setEncoding("utf8");
    let errBuf = "";
    server.stderr.on("data", (chunk) => {
      errBuf += chunk;
      let i;
      while ((i = errBuf.indexOf("\n")) !== -1) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (line.includes("ERROR")) errors.push(line.replace(/^\[codex\]\s*/, ""));
        // 启动失败（比如配置非法）会走这行。不抓住它，就会拿空清单冒充成功。
        if (line.startsWith("Error:")) fatal = line;
      }
    });

    const finish = () => {
      if (done) return;
      done = true;
      console.log(`\n=== ${label} ===`);
      console.log(`配置目录: ${codexHome}`);
      console.log(`MCP 服务数: ${servers.length}   工具总数: ${totalTools}`);
      console.log("每个服务的工具数:");
      for (const s of servers) {
        console.log(`  ${String(Object.keys(s.tools).length).padStart(3)}  ${s.name}`);
      }
      if (fatal) console.log(`启动失败: ${fatal}`);
      if (!gotInventory) console.log("没能拿到工具清单（进程没起来，或请求超时）");
      const uniq = [...new Set(errors.map((e) => e.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "")))];
      console.log(`静置 ${WATCH_MS / 1000} 秒内的后台报错: ${errors.length} 条`);
      for (const u of uniq.slice(0, 3)) console.log(`  ${u}`);
      server.kill();
      resolve({ totalTools, errors: errors.length, ok: gotInventory && !fatal });
    };

    const timer = setTimeout(() => {
      console.error(`[超时] ${label} 没在期限内拿到工具清单`);
      server.kill();
      finish();
    }, 60000);

    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "mcpServerStatus/list",
            params: { detail: "toolsAndAuthOnly" },
          });
        }
        if (msg.id === 2) {
          gotInventory = true;
          servers = msg.result?.data ?? [];
          totalTools = servers.reduce((n, s) => n + Object.keys(s.tools ?? {}).length, 0);
          // 拿到清单后先别急着退出，静置一会儿看后台有没有服务在刷报错
          setTimeout(() => {
            clearTimeout(timer);
            finish();
          }, WATCH_MS);
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-lab", title: "Agent Lab", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      },
    });
  });
}

console.log(`内核: ${CODEX_BIN}`);
const before = await run(MINE, "全局配置目录", GLOBAL_HOME);
const after = await run(MINE, "Agent Lab 独立配置目录", LAB_HOME);

const ok =
  before.ok && after.ok && after.totalTools < before.totalTools && after.errors < before.errors;
console.log("\n=== 结论 ===");
console.log(
  `工具总数 ${before.totalTools} -> ${after.totalTools}；后台报错 ${before.errors} -> ${after.errors} 条`,
);
console.log(
  ok ? "[PASS] 独立配置目录收窄了工具面，也止住了后台报错" : "[FAIL] 独立配置目录没起作用",
);
process.exit(ok ? 0 : 1);
