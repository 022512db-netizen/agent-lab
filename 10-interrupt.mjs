// 实验 10：中断——把循环的主导权从内核拿回人手里
// 目的：实验 07 的刹车是「按圈数硬停」，这条是「人说了算，随时能停」。
// 做法：给一个两步任务（先建 A 再建 B），等第一步的工具真的跑完，中途发 turn/interrupt。
// 预期：内核把这一轮报成 interrupted；A 已落地、B 没有——证明循环是在中间被掐断的，
//       而不是任务根本没开始、或者跑完了才停。
//
// 关键坑：两步如果**互相独立**，模型会把两条命令放在同一圈里并发发出去，
// 中断只能踩在其中一条之后，第二步照样落地，实验红得毫无道理。
// 所以第二步必须依赖第一步的**输出**（一个模型事先不知道的随机串），
// 它就只能等第一圈结束、拿到输出，才有资格进入第二圈——这才有可中断的中间态。
// 运行： node 10-interrupt.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { findCodex } from "./lib/platform.mjs";

// 必须用 App 自己那份配置（codex-home）。
// 踩过的坑：没设 CODEX_HOME 时内核会读全局 ~/.codex/config.toml，
// 那份配置里的模型 mimo-v2.6-flash 在本地中转上上游是挂的，请求直接 503。
// 表现是第 1 圈之后就没动静，脚本却报「中断没生效」——**这一轮根本没跑起来**，
// 报的却是另一件事。测试红在错误的地方，比测试红更费时间。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HERE, "codex-home");

// 内核路径交给 lib/platform.mjs 解析。两边产物路径不同（Windows 多一层
// 三元组目录和 .exe），写死一个会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();


const server = spawn(CODEX_BIN, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  // .env 里的密钥要带上，否则内核报 Missing environment variable
  env: { ...process.env, ...loadLocalEnv(), CODEX_HOME },
});

const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");
const log = (...a) => console.log(...a);

let buffer = "";
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6, " ") + "ms";
let threadId = null;
let turnId = null;

// 目标文件刻意挑一个不会撞车的名字：中断有没有真的拦住工具，看它存不存在就知道。
// 第一步写入的随机串，模型看不到，必须先跑完第一步才知道，第二步因此只能进第二圈。
const A = `interrupt-step1-${Date.now()}.txt`;
const B = `interrupt-step2-${Date.now()}.txt`;

let interruptSentAt = null;
let finalStatus = null;
let completedToolCalls = 0;

const TIMEOUT_MS = 180000;
const timer = setTimeout(() => {
  console.error(`\n[超时] ${TIMEOUT_MS / 1000} 秒内 turn 没有结束`);
  server.kill();
  process.exit(1);
}, TIMEOUT_MS);

log(`内核: ${CODEX_BIN}`);
log(`第一步产物: ${A}`);
log(`第二步产物: ${B}`);
log("中断时机: 第一个工具调用完成之后\n");

server.stderr.setEncoding("utf8");
let stderrBuf = "";
server.stderr.on("data", (chunk) => {
  stderrBuf += chunk;
  let i;
  while ((i = stderrBuf.indexOf("\n")) !== -1) {
    const line = stderrBuf.slice(0, i).trim();
    stderrBuf = stderrBuf.slice(i + 1);
    if (line.includes("[AGENT-LAB]")) {
      log(`       内核 | ${line.replace("[AGENT-LAB]", "").trim()}`);
    }
  }
});

server.stdout.setEncoding("utf8");
// 一个工具真的跑完，才发中断。这样「停在第几圈」就是可判定的。
function maybeInterrupt(reason) {
  if (interruptSentAt || !threadId || !turnId) return;
  interruptSentAt = Date.now();
  log(`${stamp()} [发中断·${reason}] 已完成工具调用 ${completedToolCalls} 次`);
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "turn/interrupt",
    params: { threadId, turnId },
  });
}

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
            sandbox: "workspace-write",
            approvalPolicy: "never",
          },
        });
      } else if (msg.id === 2) {
        threadId = msg.result.thread.id;
        log(`${stamp()} [会话] ${threadId}`);
        // 明确写成两步，并且禁止合并成一条命令，这样每步各占一圈。
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [
              {
                type: "text",
                text: [
                  "严格按顺序做两件事，每件各用一条独立的 shell 命令，不要合并，也不要并行：",
                  `第一步：运行 node -e "console.log(require('crypto').randomUUID())" 拿到一个随机串，并把它写进文件 ${A}。不要自己去编这个串。`,
                  `第二步：先读出 ${A} 的真实内容，再把它原样写进新文件 ${B}。`,
                  "第二步必须用到第一步的内容，所以不能和第一步同时执行。",
                  "两步都做完就停，不要做别的。",
                ].join("\n"),
                textElements: [],
              },
            ],
          },
        });
      } else if (msg.id === 4) {
        log(`${stamp()} [中断回执] ${JSON.stringify(msg.result ?? msg.error)}`);
      }
      continue;
    }

    const method = msg.method;
    if (method === "turn/started") {
      turnId = msg.params?.turn?.id ?? null;
      log(`${stamp()} [turn 开始] ${turnId}`);
    }
    if (method === "item/completed") {
      const type = msg.params?.item?.type;
      if (type === "commandExecution" || type === "mcpToolCall") {
        completedToolCalls += 1;
        log(`${stamp()} [工具完成 #${completedToolCalls}] ${type}`);
        // 第一步可能拆成多次工具调用（先生成随机串、再写文件），
        // 所以不能「第一个工具一落地就踩刹车」，那可能踩在写文件之前，
        // 结果就是 A 都没建出来、中断看起来没生效。
        // 判据换成：第一步的产物真的落盘了，才发中断。
        if (existsSync(A)) maybeInterrupt("首步落盘之后");
      }
      if (type === "agentMessage") {
        log(`${stamp()} [模型收尾] ${JSON.stringify(msg.params.item.text ?? "").slice(0, 200)}`);
      }
    }
    if (method === "turn/completed") {
      clearTimeout(timer);
      finalStatus = msg.params?.turn?.status ?? "(未知)";
      log(`\n${stamp()} [turn 结束] status=${finalStatus}`);
      finish();
    }
  }
});

// 兜底：模型要是迟迟不发工具（比如直接回话），20 秒后也把中断打出去，别让脚本干等。
// 兜底：模型要是彻底不动了（比如链路挂了），60 秒后也把中断打出去，别让脚本干等。
// 这个值调过一次 20s -> 60s：20 秒比当前模型的单圈延迟还短，中断会在第一步
// 动手之前发出，结果 A/B 两个文件都没建，实验报「中断没生效」——其实什么都没发生。
// 兜底是防卡死的，不是给模型计时的，必须宽到正常一轮肯定能跑完。
const fallback = setTimeout(() => maybeInterrupt("兜底"), 60000);
fallback.unref?.();

function finish() {
  clearTimeout(fallback);
  server.kill();

  // 中断成不成立，三个证据都要对上，缺一个都说明「不是真拦住」：
  // 1) 内核把这一轮报成 interrupted
  // 2) 第一步已经落地——说明任务确实开始跑了，不是提前掐掉
  // 3) 第二步没落地——说明循环是在中间被掐断的
  const step1 = existsSync(A);
  const step2 = existsSync(B);

  log("\n=== 结论 ===");
  log(`turn 最终状态: ${finalStatus}`);
  log(`完成的工具调用次数: ${completedToolCalls}`);
  log(`第一步产物(${A}): ${step1 ? "已创建" : "未创建"}`);
  log(`第二步产物(${B}): ${step2 ? "已创建（没拦住）" : "未创建"}`);
  const pass = finalStatus === "interrupted" && step1 && !step2;
  log(
    pass
      ? "[PASS] 中断生效：第一步已落地，第二步被拦下，轮次标记为 interrupted"
      : "[FAIL] 中断没生效，或者拦晚了/拦早了",
  );
  process.exit(pass ? 0 : 1);
}

log(">> 发送 initialize");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "agent-lab", version: "0.1.0", title: "Agent Lab 10" },
    capabilities: { experimentalApi: false },
  },
});
