// 实验 07：验证循环刹车真的会踩下去
// 目的：光看到循环在转还不够，要看到「它被我们拦住」。
// 做法：用自己编译的内核，把上限压到 2 圈，然后给一个本来要转 4 圈的任务。
// 预期：第 2 圈之后内核强制停止，界面/stderr 出现「达到循环上限」。
// 运行： node 07-loop-brake.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { findCodex } from "./lib/platform.mjs";

// 必须用 App 自己那份配置（codex-home）。
//
// 踩过的坑：最早这里没设 CODEX_HOME，于是内核读了全局 ~/.codex/config.toml，
// 那份配置里的模型是 mimo-v2.6-flash——而本地中转上这个模型的上游是挂的，
// 请求直接 503。表现出来是「第 1 圈开始」之后就没有下文，脚本报「刹车没生效」，
// 看起来像循环上限的功能坏了，实际上**这一轮压根没跑起来**。
// 这种误判最费时间：测试红了，但红的地方不是它声称的那件事。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HERE, "codex-home");

// 自己编译的内核（GNU 路线，产物路径见 BUILD-RUST.md）
// 内核路径交给 lib/platform.mjs 解析。两边产物路径不同（Windows 多一层
// 三元组目录和 .exe），写死一个会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();

// 把刹车拧到 2 圈。正常这个任务要 4 圈，所以一定踩得到。
const MAX_ITERATIONS = process.env.AGENT_LAB_MAX_ITERATIONS ?? "2";

const server = spawn(CODEX_BIN, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  // ...loadLocalEnv() 把 .env 里的密钥带进来。不带上内核会报
  // 「Missing environment variable: AGENT_LAB_API_KEY」——密钥挪到 .env 之后，
  // 所有直连内核的脚本都必须自己加载它。
  env: { ...process.env, ...loadLocalEnv(), CODEX_HOME, AGENT_LAB_MAX_ITERATIONS: MAX_ITERATIONS },
});

const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");
const log = (...a) => console.log(...a);

let buffer = "";
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6, " ") + "ms";
let threadId = null;

let sawLimitWarning = false;
let loopEnds = [];

const TIMEOUT_MS = 180000;
const timer = setTimeout(() => {
  console.error(`\n[超时] ${TIMEOUT_MS / 1000} 秒内 turn 没有结束`);
  server.kill();
  process.exit(1);
}, TIMEOUT_MS);

log(`内核: ${CODEX_BIN}`);
log(`循环上限: ${MAX_ITERATIONS} 圈\n`);

server.stdout.setEncoding("utf8");
// 内核探针走 stderr（eprintln!）。这里接住它，才能数清楚转了几圈。
server.stderr.setEncoding("utf8");
let stderrBuf = "";
server.stderr.on("data", (chunk) => {
  stderrBuf += chunk;
  let i;
  while ((i = stderrBuf.indexOf("\n")) !== -1) {
    const line = stderrBuf.slice(0, i).trim();
    stderrBuf = stderrBuf.slice(i + 1);
    if (!line) continue;
    if (line.includes("[AGENT-LAB]")) {
      log(`       内核 | ${line.replace("[AGENT-LAB]", "").trim()}`);
      if (line.includes("圈结束")) loopEnds.push(line);
    }
  }
});

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
      if (msg.id === 1) {
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "thread/start",
          params: {
            cwd: process.cwd(),
            model: null,
            // 放开写权限，这样不会卡在审批上，干干净净看刹车
            sandbox: "workspace-write",
            approvalPolicy: "never",
          },
        });
      } else if (msg.id === 2) {
        threadId = msg.result.thread.id;
        // 这个任务正常情况下要转 4 圈：写文件 -> 确认 -> 再想 -> 收尾
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [
              {
                type: "text",
                text: "在当前目录建一个 brake.txt，内容写 braked，然后用一条命令确认它的内容。做完就停下，不要做别的事。",
                textElements: [],
              },
            ],
          },
        });
      }
      continue;
    }

    const method = msg.method;

    // 内核 stderr 的探针走 inherit，这里主要看事件
    if (method === "item/completed" && msg.params?.item?.type === "agentMessage") {
      log(`${stamp()} [模型收尾] ${JSON.stringify(msg.params.item.text ?? "").slice(0, 200)}`);
    }

    if (method === "warning") {
      const text = msg.params?.message ?? "";
      log(`${stamp()} [警告] ${text}`);
      if (text.includes("循环上限")) sawLimitWarning = true;
    }

    if (method === "turn/completed") {
      clearTimeout(timer);
      const status = msg.params?.turn?.status ?? "(未知)";
      log(`\n${stamp()} [turn 结束] status=${status}`);
      finish();
    }
  }
});

function finish() {
  server.kill();
  log("\n=== 结论 ===");
  log(`探针记录的循环结束次数: ${loopEnds.length}`);
  log(`收到「达到循环上限」警告: ${sawLimitWarning ? "是" : "否"}`);
  const pass = sawLimitWarning;
  log(pass ? "[PASS] 刹车生效：模型还想继续，但被内核拦住了" : "[FAIL] 刹车没生效");
  process.exit(pass ? 0 : 1);
}

log(">> 发送 initialize");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "agent-lab", version: "0.1.0", title: "Agent Lab 07" },
    capabilities: { experimentalApi: false },
  },
});
