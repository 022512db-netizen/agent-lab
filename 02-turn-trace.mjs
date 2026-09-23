// 实验 02：抓取一次真实 turn 的完整事件流
// 目的：把「模型想 -> 工具做 -> 结果回灌 -> 再想」的每一帧都打印出来。
// 运行： node 02-turn-trace.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";

// 用 App 自己那份配置。不设的话内核会读全局 ~/.codex/config.toml，
// 而那份里的模型在当前本地中转上是挂的（请求直接 503）——实验会红在错误的地方。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HERE, "codex-home");

const server = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
  shell: true,
  // ...loadLocalEnv() 把 .env 里的密钥带进来（密钥已从配置文件挪走）
  env: { ...process.env, ...loadLocalEnv(), CODEX_HOME },
});

const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");
const log = (...a) => console.log(...a);

let buffer = "";
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6, " ") + "ms";

let threadId = null;
const TIMEOUT_MS = 180000;
const timer = setTimeout(() => {
  console.error(`\n[超时] ${TIMEOUT_MS / 1000} 秒内 turn 没有结束`);
  server.kill();
  process.exit(1);
}, TIMEOUT_MS);

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

    if (msg.id !== undefined) {
      log(`${stamp()} [响应] id=${msg.id} ${JSON.stringify(msg.result ?? msg.error).slice(0, 300)}`);
      if (msg.id === 1) {
        log("\n--- 第 1 步：开一个新线程（thread/start）---");
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "thread/start",
          params: { cwd: process.cwd(), model: null, sandbox: "workspace-write" },
        });
      } else if (msg.id === 2) {
        threadId = msg.result.thread.id;
        log(`\n线程 id = ${threadId}`);
        log("\n--- 第 2 步：发一条真实任务（turn/start）---");
        log("--- 观察下面每一步的类型，这就是 agent 的心跳 ---\n");
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [
              {
                type: "text",
                text: "在当前目录建一个 hello.txt，内容写 agent-ok，然后用一条命令确认它存在。做完就停下，不要做别的事。",
                textElements: [],
              },
            ],
          },
        });
      } else if (msg.id === 3) {
        log(`\n[turn 已受理] ${JSON.stringify(msg.result).slice(0, 200)}`);
      }
      continue;
    }

    // 服务端主动推的事件：这才是 agent 的「心跳」
    const method = msg.method ?? "(notification)";
    const p = msg.params ?? {};
    let detail = "";

    switch (method) {
      case "turn/started":
        detail = "◀ turn 开始";
        break;
      case "item/started":
        detail = `◀ 动作开始: [${p.item?.type}]`;
        break;
      case "item/completed":
        detail = `◀ 动作完成: [${p.item?.type}] ${summarizeItem(p.item)}`;
        break;
      case "item/updated":
        detail = `◀ 动作更新: [${p.item?.type}]`;
        break;
      case "item/agentMessage/delta":
        detail = `◀ 模型说话(流式): ${JSON.stringify(p.delta ?? "").slice(0, 120)}`;
        break;
      case "item/reasoning/summaryTextDelta":
        detail = `◀ 模型思考(流式): ${JSON.stringify(p.delta ?? "").slice(0, 120)}`;
        break;
      case "turn/completed":
        detail = `◀ turn 结束: ${JSON.stringify(p.turn?.status ?? p).slice(0, 200)}`;
        break;
      case "turn/failed":
        detail = `◀ turn 失败: ${JSON.stringify(p).slice(0, 300)}`;
        break;
      default:
        detail = `◀ ${method} ${JSON.stringify(p).slice(0, 160)}`;
    }
    // 过滤掉噪音事件
    if (method === "remoteControl/status/changed" || method === "mcpServer/startupStatus/updated") return;
    log(`${stamp()} ${detail}`);

    if (method === "turn/completed") {
      clearTimeout(timer);
      log("\n[OK] turn 跑完了，上面就是一次完整 agent 循环。");
      server.kill();
      process.exit(0);
    }
  }
});

function summarizeItem(item) {
  if (!item) return "";
  switch (item.type) {
    case "commandExecution":
      return `命令: ${JSON.stringify(item.command)} 退出码=${item.exitCode}`;
    case "fileChange":
      return `改文件: ${(item.changes ?? []).map((c) => c.path).join(", ")}`;
    case "agentMessage":
      return `文本: ${JSON.stringify(item.text ?? "").slice(0, 200)}`;
    case "reasoning":
      return "（思考）";
    default:
      return JSON.stringify(item).slice(0, 200);
  }
}

log(">> 发送 initialize");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "agent-lab", title: "Agent Lab", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  },
});
