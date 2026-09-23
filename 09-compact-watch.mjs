// 实验 09：亲眼看一次「上下文压缩」
// 目的：前面知道 token 会涨，这一课要知道涨到头会发生什么。
// 做法：把 auto-compact 门槛压到 15000 token（正常会话起步就 21000+，
//       所以这个值一定会触发），给一个要转几圈的任务，看内核中途压缩。
// 预期：出现 contextCompaction 事件，压缩后上下文 token 明显回落。
// 运行： node 09-compact-watch.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { findCodex } from "./lib/platform.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 内核路径交给 lib/platform.mjs 解析。两边产物路径不同（Windows 多一层
// 三元组目录和 .exe），写死一个会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();

// 真实模型窗口是几十万 token。把门槛压低是为了小成本看清机制：
// 门槛要低于「当前会话的基础上下文 + 几圈增长」，这样每圈都会撞上，才看得到压缩。
//
// 这个数改过一次。原来写 15000，当时基础上下文是 2 万出头，一定撞得到；
// 后来把工具面收窄了（只留 my_knowledge + my_web_search），开局上下文掉到
// 9700 左右，几圈下来也才一万出头，15000 就再也碰不到了——实验于是变红，
// 但红的是「假设过期」，不是功能坏了。
//
// 教训：门槛类实验的常量，要跟着被测系统的变化一起复查，
// 否则红灯指向的是过期的假设，而不是真的缺陷。
//
// 后来又调过一次 10500 -> 10000：压缩的触发检查发生在**每圈开始之前**，
// 而当时的轨迹是 9737 -> 10267 -> 10587。10500 卡在中间——第 3 圈开始检查时
// 只有 10267，没够门槛，等涨到 10587 时这一轮已经收尾了。所以门槛要压到
// 低于「第二圈结束时的上下文」，才会在第 3 圈开始前真的踩到。
// 换成 mimo 之后轨迹变成 9498 -> 9920 -> 10274，10000 又卡在中间（同上）。
// 压到 9000：第 1 圈结束 9498 就已越过门槛，第 2 圈开始前必定触发压缩。
// 调这个值的规矩：门槛要低于「第一圈结束时的上下文」才稳，别贴着后面几圈调。
const COMPACT_LIMIT = process.env.COMPACT_LIMIT ?? "9000";

const server = spawn(
  CODEX_BIN,
  ["app-server", "-c", `model_auto_compact_token_limit=${COMPACT_LIMIT}`],
  {
    stdio: ["pipe", "pipe", "pipe"],
    // 用 App 自己那份配置。不设的话会读全局 ~/.codex/config.toml，
    // 而那份里的模型在当前本地中转上是挂的（直接 503），实验会无端变红。
    env: {
      ...process.env,
      ...loadLocalEnv(),
      CODEX_HOME: process.env.CODEX_HOME ?? path.join(HERE, "codex-home"),
      AGENT_LAB_MAX_ITERATIONS: "20",
    },
  },
);

const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");
const log = (...a) => console.log(...a);

const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6, " ") + "ms";
let buffer = "";
let threadId = null;

const tokenHistory = []; // {at, tokens}
const activeContextHistory = []; // 探针报的「活跃上下文」大小
let compactionEvents = 0;
let compactionSeen = false;

const TIMEOUT_MS = 300000;
const timer = setTimeout(() => {
  console.error(`\n[超时] ${TIMEOUT_MS / 1000} 秒内 turn 没有结束`);
  server.kill();
  process.exit(1);
}, TIMEOUT_MS);

log(`内核: ${CODEX_BIN}`);
log(`压缩门槛: ${COMPACT_LIMIT} token\n`);

server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
let stderrBuf = "";
server.stderr.on("data", (chunk) => {
  stderrBuf += chunk;
  let i;
  while ((i = stderrBuf.indexOf("\n")) !== -1) {
    const line = stderrBuf.slice(0, i).trim();
    stderrBuf = stderrBuf.slice(i + 1);
    if (line.includes("[AGENT-LAB]")) {
      log(`${stamp()} 内核 | ${line.replace("[AGENT-LAB]", "").trim()}`);
      const m = line.match(/当前上下文 token = (\d+)/);
      if (m) activeContextHistory.push(Number(m[1]));
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
            sandbox: "workspace-write",
            approvalPolicy: "never",
          },
        });
      } else if (msg.id === 2) {
        threadId = msg.result.thread.id;
        // 故意给一个要多步的任务：每一步都会往上下文里加东西。
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [
              {
                type: "text",
                text: "在当前目录建一个 compact-demo.txt 写入 compact-ok，然后确认它的内容，再看一眼当前目录有哪些文件，做完就停。",
                textElements: [],
              },
            ],
          },
        });
      }
      continue;
    }

    const method = msg.method;
    const item = msg.params?.item;

    if (item?.type === "contextCompaction") {
      if (method === "item/started") {
        compactionEvents++;
        compactionSeen = true;
        log(`${stamp()} >>> [上下文压缩] 开始（第 ${compactionEvents} 次）`);
      } else if (method === "item/completed") {
        log(`${stamp()} <<< [上下文压缩] 完成`);
      }
    }

    if (method === "item/completed" && item?.type === "agentMessage") {
      log(`${stamp()} [模型收尾] ${JSON.stringify(item.text ?? "").slice(0, 160)}`);
    }

    if (method === "thread/tokenUsage/updated") {
      const tokens = msg.params?.tokenUsage?.total?.totalTokens ?? msg.params?.tokenUsage?.totalTokens;
      if (typeof tokens === "number") {
        tokenHistory.push({ at: stamp(), tokens });
        log(`${stamp()} 累计用量(计费) = ${tokens}`);
      }
    }

    if (method === "warning") {
      log(`${stamp()} [警告] ${msg.params?.message ?? ""}`);
    }

    if (method === "turn/completed") {
      clearTimeout(timer);
      log(`\n${stamp()} [turn 结束] status=${msg.params?.turn?.status}`);
      finish();
    }
  }
});

function finish() {
  server.kill();
  log("\n=== 结论 ===");
  log(`看到的压缩次数: ${compactionEvents}`);
  if (activeContextHistory.length) {
    log(`活跃上下文轨迹: ${activeContextHistory.join(" -> ")}`);
  }
  if (tokenHistory.length) {
    log(`累计用量轨迹: ${tokenHistory.map((t) => t.tokens).join(" -> ")}`);
    log("（上面是累计计费量，只会涨；真正决定会不会撑爆窗口的是探针里的活跃上下文）");
  }
  const pass = compactionSeen;
  log(pass ? "[PASS] 压缩被触发：上下文涨到头时，内核做了摘要压缩" : "[FAIL] 没看到压缩事件");
  process.exit(pass ? 0 : 1);
}

log(">> 发送 initialize");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "agent-lab", version: "0.1.0", title: "Agent Lab 09" },
    capabilities: { experimentalApi: false },
  },
});
