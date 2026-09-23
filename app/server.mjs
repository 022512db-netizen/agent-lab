// Agent Lab 本地桥：浏览器 <-> codex app-server
// 作用：把 codex 的 JSON-RPC 转成网页能用的 HTTP + SSE。
// 这是桌面 App 的最小内核，没有它浏览器就没法和 Codex 说话。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { loadLocalEnv } from "../lib/env.mjs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const KNOWLEDGE_FILE = path.join(HERE, "..", "knowledge.md");
const USAGE_FILE = path.join(HERE, "..", ".thread-usage.json");
// app -> agent-lab -> 工作区根目录
const DEFAULT_CWD = process.env.AGENT_CWD ?? path.resolve(HERE, "../..");

// ---------- 与 codex app-server 的通道 ----------
let child = null;
let buffer = "";
let nextId = 1;
let ready = false;
const pending = new Map(); // 我方发出的请求 id -> {resolve, reject}
const serverRequests = new Map(); // 服务端反问的请求 id -> 原始请求
const sseClients = new Set();

// 桌面启动时窗口一关就没人看这个服务了。但 Edge 刷新会瞬断一下，所以
// 空窗后先等一会儿再退；单独跑 server 调试时不启用（不受影响）。
const EXIT_WHEN_IDLE = process.env.AGENT_LAB_EXIT_WHEN_IDLE === "1";
// 宽限期可调，只为了让自检脚本不用等 15 秒。
const IDLE_GRACE_MS = Number(process.env.AGENT_LAB_IDLE_MS ?? 15000);
let idleTimer = null;
function noteClientChange() {
  if (!EXIT_WHEN_IDLE) return;
  if (sseClients.size > 0) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    return;
  }
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (sseClients.size > 0) return;
    if (child) child.kill();
    server.close(() => process.exit(0));
    // 兜底：还有别的连接挂着就 1 秒后硬退。
    setTimeout(() => process.exit(0), 1000).unref();
  }, IDLE_GRACE_MS);
}

// 会话累计用量缓存。内核的历史接口不带 token 数，但它在会话进行中会推
// thread/tokenUsage/updated。这里顺手记下每个会话的最后一个值，切回历史时
// 就能显示真实用量，而不是编一个 0。只活在本次进程里，重启即清。
const threadTokens = new Map();

// ---------- 每一圈的成本归集 ----------
// 内核探针说「现在第几圈」，工具事件说「圈里动了什么」。两边一对，就能
// 把「一共花了多少」拆成「哪一圈花了多少」。这是理解 agent 成本最直接的一段：
// 模型的每一圈都要把之前发生的全部事情重新发一遍，所以越往后越贵。
const loopState = { iteration: null, bytes: 0, calls: [], lastTokens: null, pending: null };

function shorten(text, max = 60) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

function bytesOf(value) {
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

// 工具结果回灌进上下文，就是下一圈的输入。参数和返回都算钱。
// 账本可能是「正在计」的那一圈，也可能是已封存等待结账的那份
// （探针先说这圈结束了，工具事件才姗姗来迟）。两种都要收。
function noteToolCost(item) {
  if (!item) return;
  const ledger = loopState.iteration !== null ? loopState : loopState.pending;
  if (!ledger) return;
  const isMcp = item.type === "mcpToolCall";
  const isCmd = item.type === "commandExecution";
  if (!isMcp && !isCmd) return;
  const bytes = bytesOf(item.arguments) + bytesOf(item.result) + bytesOf(item.aggregatedOutput);
  ledger.bytes += bytes;
  ledger.calls.push({
    name: isMcp ? `工具 ${item.server}/${item.tool}` : "执行命令",
    detail: shorten(isCmd ? item.command : JSON.stringify(item.arguments ?? {})),
    bytes,
  });
}

// 内核探针每圈报两次：开头一行、结尾一行。
// 结尾那行只把账本封存（pending），不立刻上报——工具结果走的是另一条管道，
// 有可能比这一行晚一点点到。等下一圈开始时再结账，最后一笔就不会被吃掉。
function flushLoopCost() {
  if (!loopState.pending) return;
  const bill = loopState.pending;
  loopState.pending = null;
  broadcast({ method: "lab/loopCost", params: bill });
}

function observeProbe(line) {
  const start = /循环第 (\d+) 圈开始/.exec(line);
  if (start) {
    flushLoopCost(); // 上一圈到此为止，账可以先结
    loopState.iteration = Number(start[1]);
    loopState.bytes = 0;
    loopState.calls = [];
    return;
  }
  const end = /循环第 (\d+) 圈结束.*token = (\d+)/.exec(line);
  if (!end) return;
  const tokens = Number(end[2]);

  // 引用而不是拷贝：晚到的工具事件要能直接补进这份账单。
  loopState.pending = {
    iteration: Number(end[1]),
    tokens,
    // 和上一圈的上下文比，这一圈净增了多少。第一圈没有参照物，就是 null。
    deltaTokens: loopState.lastTokens === null ? null : tokens - loopState.lastTokens,
    bytes: loopState.bytes,
    calls: loopState.calls,
  };
  loopState.lastTokens = tokens;
  loopState.iteration = null;
}

// 落盘，重启后历史会话也还能看到用量。（就一张小表，不必上数据库。）
try {
  const raw = JSON.parse(await readFile(USAGE_FILE, "utf8"));
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number") threadTokens.set(k, v);
} catch {}

let usageSaveTimer = null;
function scheduleUsageSave() {
  // 合并写：用量事件很密，没必要每次都落盘。
  if (usageSaveTimer) return;
  usageSaveTimer = setTimeout(async () => {
    usageSaveTimer = null;
    try {
      await writeFile(USAGE_FILE, JSON.stringify(Object.fromEntries(threadTokens)), "utf8");
    } catch {}
  }, 1000);
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }
  // 服务端主动发起的「请求」（审批等）：带 id + method，必须回话，否则这轮会卡住。
  if (msg.id !== undefined && msg.method) {
    serverRequests.set(String(msg.id), msg);
    broadcast({ id: msg.id, method: msg.method, params: msg.params, __isServerRequest: true });
    return;
  }
  if (msg.method) broadcast(msg); // 服务端主动推的事件
  // 新的一轮开始了，上一轮的上下文跟这一轮没关系，从零起算。
  // 不重置的话，一轮的「第 1 圈」会跟上一轮最后一圈比，凭白冒出一个负数。
  if (msg.method === "turn/started") loopState.lastTokens = null;
  // 工具调用结束 = 它的结果已经进了上下文，记到当前这一圈账上。
  if (msg.method === "item/completed") noteToolCost(msg.params?.item);
  // 最后一圈后面没有「下一圈开始」了，得在这里收尾结账。
  // 工具条目和 turn/completed 走的是同一条 stdout，顺序有保证，不会漏。
  if (msg.method === "turn/completed") flushLoopCost();
  // 顺手记下累计用量，供历史回放用。
  if (msg.method === "thread/tokenUsage/updated") {
    const id = msg.params?.threadId;
    const total = msg.params?.tokenUsage?.total?.totalTokens;
    if (id && typeof total === "number") {
      threadTokens.set(id, total);
      scheduleUsageSave();
    }
  }
}

// 我自己的 MCP 工具服务路径
const MY_MCP = path.join(HERE, "..", "mcp-my-knowledge", "server.mjs");

// 联网搜索服务。内核自带的「托管搜索」在本地中转上跑不通（那个端点不存在，
// 模型只会拿到 unsupported custom tool call），所以联网改由这个自建服务提供。
// 细节见 mcp-web-search/server.mjs 开头的说明。
const MY_WEB_MCP = path.join(HERE, "..", "mcp-web-search", "server.mjs");

// 「我的知识」到底读哪里。
// 默认读你真正的知识库（Obsidian 那个），而不是仓库里那份 33 行的样例。
// 想换回仓库内的样例库：设 AGENT_KNOWLEDGE_DIR=none。
const SAMPLE_VAULT = path.join(HERE, "..", "mcp-my-knowledge", "knowledge");
// 默认知识库在用户目录下，两个系统都能用 ~/Documents/... 表示。
const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "Codex", "CodexMemoryVault");
const KNOWLEDGE_DIR =
  process.env.AGENT_KNOWLEDGE_DIR === "none"
    ? SAMPLE_VAULT
    : process.env.AGENT_KNOWLEDGE_DIR ?? DEFAULT_VAULT;

// 工具新写的东西不能混进真知识库：那里只记特定项目、有自己的规矩。
// 写到一个本地 inbox 里，你看到合适的再手动搬进去。
const KNOWLEDGE_INBOX = process.env.AGENT_KNOWLEDGE_INBOX ?? path.join(HERE, "..", "knowledge-inbox.md");

// 独立配置目录：这个 App 只挂「我的知识」，不继承 ~/.codex 里那一堆全局工具。
// 实测：继承全局时开局 32 个工具，用这份配置只剩 2 个（见实验 11）。
// 想改回继承全局：设 AGENT_CODEX_HOME=global 或在启动器里改这个变量。
const CODEX_HOME =
  process.env.AGENT_CODEX_HOME === "global"
    ? process.env.CODEX_HOME
    : path.join(HERE, "..", "codex-home");

// 用哪个内核？默认系统装的，也可以用环境变量指向自己编译的。
// 例：CODEX_BIN="C:/dev/codex/.../codex.exe" node start.mjs
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

// 把苍穹开发要用的技能接进来。
//
// 苍穹的知识不适合塞进 knowledge.md 那种几十行的注入文本里：它是一整套
// 15 MB 的专家包（几百份 SKILL/reference、可以直接抄的 Java 模板、API 知识库、
// 写完用来查错的 lint 脚本）。这套东西已经在 ~/.codex/skills 里了，正确做法
// 不是复制一份（两个副本迟早各自变旧），而是让 App 的配置目录有一条通往它的链接。
//
// 内核按目录发现技能：<CODEX_HOME>/skills/<名字>/SKILL.md。所以建链接就够了。
//
// 为什么要两个技能，而不是只接 ok-cosmic：
// 工程自己的 AGENTS.md 里写着「任何苍穹相关编码任务开始前，必须依次加载
// load-memory、ok-cosmic」。load-memory 负责去读工程里的
// `.opencode/cosmic-sdk-reference.md`（项目规范、字段查询规则、命名约定等）。
// 少了它，agent 会用通用写法写苍穹代码——能编译，但不符合这个项目的规矩。
const COSMIC_SKILLS = ["ok-cosmic", "load-memory"];

function linkCosmicSkills() {
  if (process.env.AGENT_LAB_COSMIC_SKILL === "0") return;
  const userSkills = process.env.AGENT_COSMIC_SKILL_DIR
    ? path.dirname(process.env.AGENT_COSMIC_SKILL_DIR)
    : path.join(os.homedir(), ".codex", "skills");
  const linked = [];
  for (const name of COSMIC_SKILLS) {
    const source = path.join(userSkills, name);
    const target = path.join(CODEX_HOME, "skills", name);
    try {
      if (existsSync(target)) continue; // 已经接上了
      if (!existsSync(source)) continue; // 这台机器没装这个技能，不关 App 的事
      mkdirSync(path.dirname(target), { recursive: true });
      // Windows 上目录链接要用 "junction"，普通 "dir" 需要额外权限。
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      linked.push(name);
    } catch (err) {
      console.log("提示: 没能接入技能 " + name + "（" + (err?.message ?? err) + "），App 其余功能不受影响。");
    }
  }
  if (linked.length) console.log("已接入苍穹开发技能: " + linked.join(", ") + "（源: " + userSkills + "）");
}

// 本机密钥不进配置、不进版本库。
//
// 原来的写法是把 token 明文写在 codex-home/config.toml 里，而那个目录是要进
// 版本库的——一旦 commit 就等于公开。内核自己也在文档里写着
// `experimental_bearer_token`「不推荐，请用 env_key」。
//
// 所以改成：配置里只写 env_key = "AGENT_LAB_API_KEY"（一个变量名），
// 真正的值放在被 .gitignore 排除的 .env 里，启动时读进子进程环境。
// 环境变量优先于文件，方便临时覆盖。
//
// 读 .env 的逻辑抽到了 lib/env.mjs，因为直连内核的实验脚本也要用同一份——
// 只改 App 不改它们，就会留下一串「看起来毫不相关」的红灯（踩过）。
function startCodex() {
  linkCosmicSkills();
  // -c 覆盖只对本次启动生效，不会污染全局 config.toml。
  const args = [
    "app-server",
    "-c",
    `mcp_servers.my_knowledge.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.my_knowledge.args=${JSON.stringify([MY_MCP])}`,
    "-c",
    // 注意这里是 TOML 内联表（用 = 不用 :），不是 JSON。
    // 写成 JSON 的话 TOML 解析失败，整串会被当成字符串，配置直接报
    // 「invalid type: string, expected a map」。
    `mcp_servers.my_knowledge.env={ MY_KNOWLEDGE_DIR = ${JSON.stringify(KNOWLEDGE_DIR)}, MY_KNOWLEDGE_ADD_FILE = ${JSON.stringify(KNOWLEDGE_INBOX)} }`,
    // 覆盖整个 my_knowledge 表，所以 omit_tools_from 也要一起带上，
    // 否则 config.toml 里那条会被冲掉，工具又藏回「延迟暴露」。
    "-c",
    `mcp_servers.my_knowledge.omit_tools_from=${JSON.stringify(["deferred"])}`,
    // 自建的联网搜索服务。走公开网页，不涉及任何本地密钥。
    "-c",
    `mcp_servers.my_web_search.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.my_web_search.args=${JSON.stringify([MY_WEB_MCP])}`,
    "-c",
    `mcp_servers.my_web_search.omit_tools_from=${JSON.stringify(["deferred"])}`,
  ];
  // Windows 上走 cmd /c，是为了让 "codex" 这种能被 PATH 解析到；
  // macOS / Linux 直接 exec（那边本来就会查 PATH），少一层 shell 也更好收信号。
  const direct = process.platform !== "win32";
  // 循环刹车的圈数。内核默认 20 圈，那是问答时代的合适值；真实编码任务实测
  // 20 圈写不完一个插件（预检、查元数据、核对签名、写文件、跑检查，步数就是多），
  // 而且被掐断时的症状是「文件没生成」，看着像模型没干活。所以 App 起内核时
  // 显式放宽到 60；单次实验仍可用环境变量覆盖这个值。
  child = spawn(direct ? CODEX_BIN : "cmd.exe", direct ? args : ["/c", CODEX_BIN, ...args], {
    cwd: DEFAULT_CWD,
    env: {
      ...process.env,
      ...loadLocalEnv(),
      CODEX_HOME,
      AGENT_LAB_MAX_ITERATIONS: process.env.AGENT_LAB_MAX_ITERATIONS ?? "60",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onLine(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    process.stderr.write("[codex] " + d);
    // 内核里的探针输出会走到 stderr。把它也推给界面，
    // 这样在 App 里就能看见「循环第几圈」。
    for (const line of String(d).split("\n")) {
      if (line.includes("[AGENT-LAB]")) {
        observeProbe(line);
        broadcast({ method: "lab/innerLoop", params: { text: line.trim() } });
      }
    }
  });

  child.on("exit", (code) => {
    ready = false;
    broadcast({ method: "lab/serverExited", params: { code } });
  });
}

// 回复「服务端反问客户端」的请求（审批等）。
// 这类请求由 server 主动发起，带 id，客户端必须用同一个 id 回话。
function replyToServer(id, result) {
  if (!child || child.exitCode !== null) throw new Error("codex 未在运行");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function rpc(method, params, id = nextId++) {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null) return reject(new Error("codex 未在运行"));
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 超时`));
    }, 120000);
  });
}

async function ensureReady() {
  if (ready) return;
  if (!child || child.exitCode !== null) startCodex();
  const initId = nextId++;
  const res = await rpc(
    "initialize",
    {
      clientInfo: { name: "agent-lab", title: "Agent Lab", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    },
    initId,
  );
  if (res.error) throw new Error(JSON.stringify(res.error));
  ready = true;
}

// 读取「我自己的知识」，作为每次新会话的开发者指令注入进去。
async function loadKnowledge() {
  try {
    return await readFile(path.join(HERE, "..", "knowledge.md"), "utf8");
  } catch {
    return null;
  }
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    noteClientChange();
    req.on("close", () => {
      sseClients.delete(res);
      noteClientChange();
    });
    return;
  }

  if (url.pathname === "/api/rpc" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { method, params = {} } = JSON.parse(body);
        await ensureReady();
        // 历史回放需要知道这个会话之前的累计用量：历史接口里没有这个数，
        // 所以由读历史的一方顺带问一句，我们把它缓存过的值告诉它。
        if (method === "lab/threadTokens") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            // 包一层 result，跟其它方法的返回形状保持一致（前端读的是 json.result）。
            JSON.stringify({ result: { total: threadTokens.get(String(params.threadId)) ?? null } }),
          );
          return;
        }
        // 会话起点：把本地知识挂成开发者指令，模型从第一轮就看得到。
        let finalParams = params;
        if (method === "thread/start") {
          const knowledge = await loadKnowledge();
          if (knowledge) finalParams = { ...params, developerInstructions: knowledge };
        }
        const result = await rpc(method, finalParams);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // 前端对「服务端反问」的回话入口
  if (url.pathname === "/api/reply" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, decision } = JSON.parse(body);
        const req_ = serverRequests.get(String(id));
        if (!req_) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "未知请求 id" }));
          return;
        }
        serverRequests.delete(String(id));
        replyToServer(req_.id, { decision });
        broadcast({ method: "lab/approvalResolved", params: { id: req_.id, decision } });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (url.pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ cwd: DEFAULT_CWD, ready, port: PORT, pid: process.pid }),
    );
    return;
  }

  // 可选工作目录清单。苍穹专家技能要靠会话的工作目录往上找 ok-cosmic.json，
  // 所以「会话开在哪个项目」不是个小设置，它决定技能能不能真的生效。
  // 清单写在 projects.json；没有这个文件就退化成只有默认工作目录。
  if (url.pathname === "/api/projects") {
    const raw = await readFile(path.join(HERE, "..", "projects.json"), "utf8").catch(() => null);
    let list = [];
    try {
      list = JSON.parse(raw)?.projects ?? [];
    } catch {
      list = [];
    }
    // 路径不存在就别列出来。清单里存的是本机绝对路径，而 Windows 和 macOS
    // 的路径不一样，同一份清单带过去必然有一半是死的——与其让用户选到一个
    // 点开就报错的目录，不如直接不显示。
    list = list.filter((p) => p && typeof p.path === "string" && existsSync(p.path));
    // 一个都不剩（比如刚换机器、路径还没改）时，至少留默认工作目录可用。
    if (!list.length) list = [{ name: "默认工作目录", path: DEFAULT_CWD }];
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ projects: list }));
    return;
  }

  // 知识库读写：让 App 里能直接看和改「我自己的开发知识」。
  // 注意：新会话才会读到新版本；已开始的会话用的是启动时那份。
  if (url.pathname === "/api/knowledge") {
    if (req.method === "GET") {
      const text = await readFile(KNOWLEDGE_FILE, "utf8").catch(() => "");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text }));
      return;
    }
    let kbody = "";
    req.on("data", (c) => (kbody += c));
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(kbody);
        if (typeof text !== "string") throw new Error("缺少 text");
        await writeFile(KNOWLEDGE_FILE, text, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // 静态文件
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const file = await readFile(path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[\\/])+/, "")), "utf8");
    res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] ?? "text/plain; charset=utf-8" }).end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Lab 已启动: http://127.0.0.1:${PORT}`);
  console.log(`工作目录: ${DEFAULT_CWD}`);
});

process.on("SIGINT", () => {
  child?.kill();
  process.exit(0);
});
