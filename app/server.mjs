// Agent Lab 本地桥：浏览器 <-> codex app-server
// 作用：把 codex 的 JSON-RPC 转成网页能用的 HTTP + SSE。
// 这是桌面 App 的最小内核，没有它浏览器就没法和 Codex 说话。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { loadLocalEnv } from "../lib/env.mjs";
import { findCodex } from "../lib/platform.mjs";
import {
  loadSettings,
  saveSettings,
  getActiveProvider,
  providerConfigOverrides,
  fetchUpstreamModels,
  writeEnvValue,
  providerApiKey,
  hasProviderKey,
  safeId,
  normalizeBaseUrl,
  ROOT as LAB_ROOT,
  CODEX_HOME,
  DATA_DIR,
  PROJECTS_FILE,
  USAGE_FILE,
  KNOWLEDGE_INBOX_FILE,
  ensureDataLayout,
} from "../lib/settings.mjs";
import { isReadOnlyCommand } from "../lib/readonly.mjs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const KNOWLEDGE_FILE = path.join(HERE, "..", "knowledge.md");
// app -> agent-lab -> 工作区根目录
const DEFAULT_CWD = process.env.AGENT_CWD ?? path.resolve(HERE, "../..");

// 首次启动会把包内默认配置迁到用户目录；之后所有可变状态都留在 App 外。
ensureDataLayout();

// ---------- 与 codex app-server 的通道 ----------
let child = null;
let buffer = "";
let nextId = 1;
let ready = false;
let startupError = null;
const pending = new Map(); // 我方发出的请求 id -> {resolve, reject}
const serverRequests = new Map(); // 服务端反问的请求 id -> 原始请求
const sseClients = new Set();

const EXIT_WHEN_IDLE = process.env.AGENT_LAB_EXIT_WHEN_IDLE === "1";
//
// 桌面启动时窗口一关就没人看这个服务了，所以闲下来要能自己退出。
// 单独跑 server 调试时不启用（不受影响）。
// 但这里踩过一个坑：早先只看「SSE 断了就退出」，结果窗口一旦被系统挂起、
// 或浏览器回收了长连接，服务就自杀，用户看到的是「页面还在、状态灯变灰、
// 发什么都没反应」——看起来就像服务起不来。
//
// 所以退出的条件收紧成三个同时成立：曾经有客户端连过、当前既没有 SSE 也没有
// 在飞的请求、且连续 IDLE_GRACE_MS 完全没人访问过（含普通 HTTP 请求）。
// 宽限期默认 10 分钟：窗口切后台一会儿再回来，服务必须还在。
const IDLE_GRACE_MS = Number(process.env.AGENT_LAB_IDLE_MS ?? 10 * 60 * 1000);
let idleTimer = null;
let hadClient = false;
let lastActivity = Date.now();

// 任何一次 HTTP 访问（页面、轮询、API）都算「有人在用」。
function noteActivity() {
  lastActivity = Date.now();
  // 计时器已经在跑就按新的剩余时间重排，保证「最后一次访问 + 宽限期」退出。
  if (EXIT_WHEN_IDLE && idleTimer && sseClients.size === 0) armIdleTimer();
}

// 按「距离真正闲置满还差多久」重排，而不是每次都重排一整段宽限期，
// 否则实际存活时间会变成宽限期的两倍，语义不精确。
function armIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const remaining = Math.max(0, IDLE_GRACE_MS - (Date.now() - lastActivity));
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // 退出前重新确认一次：这段时间里可能又有人连回来了。
    const stillIdle = sseClients.size === 0 && pending.size === 0;
    const quietFor = Date.now() - lastActivity;
    if (!hadClient || !stillIdle || quietFor < IDLE_GRACE_MS) {
      if (hadClient && stillIdle) armIdleTimer();
      return;
    }
    console.log(`已连续 ${Math.round(quietFor / 60000)} 分钟没有窗口连接，关闭服务。`);
    if (child) child.kill();
    server.close(() => process.exit(0));
    // 兜底：还有别的连接挂着就 2 秒后硬退。
    setTimeout(() => process.exit(0), 2000).unref();
  }, remaining);
}


function noteClientChange() {
  if (!EXIT_WHEN_IDLE) return;
  if (sseClients.size > 0) {
    hadClient = true;
    noteActivity();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    return;
  }
  armIdleTimer();
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
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") threadTokens.set(k, { total: v, activeContext: null, contextWindow: null });
    else if (v && typeof v === "object") threadTokens.set(k, v);
  }
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
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {}
  }
}

// 每 15 秒向所有 SSE 客户端发一次心跳注释，防止长思考或长耗时工具执行期间连接被断开
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": keep-alive\n\n");
    } catch {}
  }
}, 15000);

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
    // 审批规则：纯查询命令自动放行，其余（写文件、装依赖、改库等）交给用户决定。
    if (msg.method === "item/commandExecution/requestApproval" && isReadOnlyCommand(msg.params?.command)) {
      replyToServer(msg.id, { decision: "accept" });
      broadcast({ method: "lab/autoApproved", params: { command: msg.params?.command } });
      return;
    }
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

  // 顺手记下累计用量与当前活跃上下文占用，供历史回放与容量条显示用。
  if (msg.method === "thread/tokenUsage/updated") {
    const id = msg.params?.threadId;
    const u = msg.params?.tokenUsage;
    if (id && u) {
      const total = u.total?.totalTokens ?? 0;
      const activeContext = (u.last?.inputTokens ?? 0) + (u.last?.cachedInputTokens ?? 0);
      const contextWindow = u.modelContextWindow ?? getModelContextWindow(settings().activeModel);
      threadTokens.set(id, { total, activeContext, contextWindow });
      scheduleUsageSave();
    }
  }
}

function getModelContextWindow(modelSlug) {
  try {
    const catalogPath = path.join(CODEX_HOME, "model-catalogs", "relay-mu96ubev.json");
    if (existsSync(catalogPath)) {
      const cat = JSON.parse(readFileSync(catalogPath, "utf8"));
      const m = cat.models?.find((x) => x.slug === modelSlug || x.id === modelSlug);
      if (m?.context_window) return m.context_window;
    }
  } catch {}
  return 128000;
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
const KNOWLEDGE_INBOX = process.env.AGENT_KNOWLEDGE_INBOX ?? KNOWLEDGE_INBOX_FILE;

// 用哪个内核？默认系统装的，也可以用环境变量指向自己编译的。
// 例：CODEX_BIN="C:/dev/codex/.../codex.exe" node start.mjs
// 用统一的查找函数，不要自己回退成字符串 "codex"：
// 从桌面双击启动时 PATH 里常常没有 codex，直接 spawn("codex") 就是 ENOENT。
// findCodex() 会先扫自编译产物、再扫已知安装位置（比如 ChatGPT.app 里那份），
// 最后才交给 PATH 解析。
const CODEX_BIN = findCodex();

// 本机设置（模型 provider / 当前模型 / 推理强度）。懒加载，改完立刻生效。
function settings() {
  return loadSettings();
}

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
  startupError = null;
  // -c 覆盖只对本次启动生效，不会污染全局 config.toml。
  const args = [
    "app-server",
    // 模型 provider / 模型 / 推理强度从本机 settings 覆盖，不改可提交的 config.toml。
    ...providerConfigOverrides(settings()),
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
    // 留着最后一行错误，内核退出时能把它带给界面，而不是只说「退出了」。
    const text = String(d);
    const errLine = text.split("\n").find((l) => /error|Error|panic|failed/i.test(l));
    if (errLine) startupError = errLine.trim().slice(0, 300);
    // 内核里的探针输出会走到 stderr。把它也推给界面，
    // 这样在 App 里就能看见「循环第几圈」。
    for (const line of String(d).split("\n")) {
      if (line.includes("[AGENT-LAB]")) {
        observeProbe(line);
        broadcast({ method: "lab/innerLoop", params: { text: line.trim() } });
      }
    }
  });

  // 内核直接退出（配置错误、端口冲突等）时，把在飞的请求都拒掉。
  // 只广播事件不 reject 的话，调用方要等到 120 秒超时才知道失败。
  child.on("exit", (code) => {
    ready = false;
    if (pending.size) {
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error(`内核已退出（code ${code}）` + (startupError ? `：${startupError}` : "")));
      }
    }
    broadcast({ method: "lab/serverExited", params: { code } });
  });
  // 内核启动失败（比如配置写错）时一定要把在飞的 initialize 拒掉。
  // 不拒的话 restartCodex 会一直挂到 120 秒超时，界面上表现就是「保存卡死」。
  child.on("error", (err) => {
    ready = false;
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error("内核启动失败: " + (err?.message ?? err)));
    }
  });
}

// 回复「服务端反问客户端」的请求（审批等）。
// 这类请求由 server 主动发起，带 id，客户端必须用同一个 id 回话。
// 运行中的内核要换模型时不能只改配置：模型、provider 都是启动期绑定的。
// 所以「切到另一个 provider」= 杀掉内核重启，让它用新参数重新初始化。
// 同一 provider 内换模型不需要重启，turn/start 每轮都能带 model。
async function restartCodex() {
  const old = child;
  ready = false;
  child = null;
  buffer = "";
  pending.clear();
  if (old && old.exitCode === null) {
    // 断开所有监听，避免旧进程退出时污染新内核的状态。
    old.removeAllListeners();
    old.kill();
  }
  await ensureReady();
}
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

// 初始化必须合并成一次。页面一加载会同时打几个接口（模型清单、技能、设置），
// 它们各自 await ensureReady()；没有合并时第二个会再发一次 initialize，
// 内核回 "Already initialized"，异常逃出请求处理器——Node 默认直接结束进程，
// 现象就是「窗口刚打开，服务就没了」。
let readyPromise = null;

async function ensureReady() {
  if (ready) return;
  if (!readyPromise) {
    readyPromise = initializeKernel().finally(() => {
      readyPromise = null;
    });
  }
  return readyPromise;
}

async function initializeKernel() {
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
  if (res.error) {
    // 万一另一个初始化赢了（内核已经初始化过），这不是错误：当作已就绪即可。
    if (/already initialized/i.test(JSON.stringify(res.error))) {
      ready = true;
      return;
    }
    throw new Error(JSON.stringify(res.error));
  }
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

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
}

// 读一个 JSON 请求体，解析失败直接回 400。写接口都走这一个入口。
function readJson(req, res, done) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: "请求体不是合法 JSON" });
      return;
    }
    Promise.resolve()
      .then(() => done(body))
      .catch((err) => sendJson(res, 400, { error: String(err?.message ?? err) }));
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  // 任何请求都算「有人在用」：空闲退出的判断依赖它。
  noteActivity();

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
          const entry = threadTokens.get(String(params.threadId));
          const result = typeof entry === "number"
            ? { total: entry, activeContext: null, contextWindow: null }
            : (entry ? { ...entry } : { total: null, activeContext: null, contextWindow: null });
          if (!result.contextWindow) {
            result.contextWindow = getModelContextWindow(settings().activeModel);
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({ result }),
          );
          return;
        }
        // 会话起点：知识注入 + 带上当前选中的模型。
        let finalParams = params;
        if (method === "thread/start") {
          const knowledge = await loadKnowledge();
          const s = settings();
          if (s.activeModel) finalParams = { ...finalParams, model: finalParams.model || s.activeModel };
          // 新会话也要一开始就用上所选强度，否则首个 turn 之前会话会是内核
          // 启动时的旧值（实测刚切完强度，新会话读回来还是 high）。
          // 注意：thread/start 的参数表里没有 effort（只有 turn/start 有），
          // 传 effort 会被内核静默忽略。新会话要靠 config 覆盖才真的生效，
          // 否则首个 turn 之前会话会停在启动时的旧强度。
          if (s.reasoningEffort) {
            finalParams = {
              ...finalParams,
              config: { ...(finalParams.config ?? {}), model_reasoning_effort: s.reasoningEffort },
            };
          }
          if (knowledge) finalParams = { ...finalParams, developerInstructions: knowledge };
        }
        // 每一轮都带当前模型：这样在 App 里切完模型，下一条消息就用新的，
        // 不用重开会话。用户显式传了 model 就尊重用户的。
        if (method === "turn/start") {
          const s = settings();
          if (s.activeModel) finalParams = { ...finalParams, model: finalParams.model || s.activeModel };
          if (s.reasoningEffort) finalParams = { ...finalParams, effort: finalParams.effort ?? s.reasoningEffort };
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

  // ---------- 模型设置 ----------
  // 读当前 provider / 模型 / 可选模型。密钥只回「有没有」，不回值。
  if (url.pathname === "/api/settings" && req.method === "GET") {
    const s = settings();
    const active = getActiveProvider();
    sendJson(res, 200, {
      activeProvider: s.activeProvider,
      activeModel: s.activeModel,
      reasoningEffort: s.reasoningEffort,
      activeBaseUrl: active?.baseUrl ?? "",
      activeHasKey: active ? hasProviderKey(active) : false,
      providers: s.providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        wireApi: p.wireApi,
        envKey: p.envKey,
        models: p.models,
        updatedAt: p.updatedAt,
        hasKey: hasProviderKey(p),
      })),
    });
    return;
  }

  // 写设置：新增/更新 provider、写密钥、切换 provider、切换模型、删除 provider。
  // 切 provider 要重启内核（provider 是启动期绑定的）；同 provider 内切模型不重启。
  if (url.pathname === "/api/settings" && req.method === "POST") {
    readJson(req, res, async (body) => {
      const s = settings();
      let restartNeeded = false;

      if (body.provider) {
        const incoming = body.provider;
        const id = safeId(incoming.id || incoming.name, "custom");
        const baseUrl = normalizeBaseUrl(incoming.baseUrl);
        if (!baseUrl) throw new Error("缺少 base URL");
        const existing = s.providers.find((p) => p.id === id);
        // 保留已有 provider 的 envKey：默认那份用的是 AGENT_LAB_API_KEY，
        // 如果这里重算成 AGENT_LAB_KEY_CUSTOM，用户没重填密钥就会“密钥突然丢了”。
        const envKey = existing?.envKey || `AGENT_LAB_KEY_${id.toUpperCase().replace(/-/g, "_")}`;
        const models = Array.isArray(incoming.models)
          ? [...new Set(incoming.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))]
          : existing?.models ?? [];
        const next = {
          id,
          name: String(incoming.name || existing?.name || id).trim(),
          baseUrl,
          wireApi: incoming.wireApi === "chat" ? "chat" : "responses",
          envKey,
          models,
          updatedAt: new Date().toISOString(),
        };
        const idx = s.providers.findIndex((p) => p.id === id);
        if (idx >= 0) s.providers[idx] = next;
        else s.providers.push(next);
        // 空字符串不当成“清空密钥”——输入框留空就只是没改。
        if (typeof incoming.apiKey === "string" && incoming.apiKey.trim()) {
          writeEnvValue(envKey, incoming.apiKey.trim());
          // The key is injected into the kernel process at spawn time.
          restartNeeded = true;
        }
        if (incoming.activate) {
          if (s.activeProvider !== id) restartNeeded = true;
          s.activeProvider = id;
          if (!next.models.includes(s.activeModel)) s.activeModel = next.models[0] ?? "";
        }
      }

      if (body.activeProvider) {
        const id = safeId(body.activeProvider);
        const provider = s.providers.find((p) => p.id === id);
        if (!provider) throw new Error("没有这个 provider：" + id);
        if (s.activeProvider !== id) restartNeeded = true;
        s.activeProvider = id;
        if (!provider.models.includes(s.activeModel)) s.activeModel = provider.models[0] ?? "";
      }

      // 切模型：不重启，下一轮 turn/start 带过去。同时把名字记到 provider 里。
      if (typeof body.activeModel === "string" && body.activeModel.trim()) {
        s.activeModel = body.activeModel.trim();
        const provider = getActiveProvider();
        if (provider && !provider.models.includes(s.activeModel)) provider.models.push(s.activeModel);
      }

      if (body.removeProvider) {
        const id = safeId(body.removeProvider);
        if (id === s.activeProvider) throw new Error("不能删除正在使用的 provider");
        s.providers = s.providers.filter((p) => p.id !== id);
      }

      if (body.reasoningEffort) s.reasoningEffort = String(body.reasoningEffort);
      saveSettings(s);
      if (restartNeeded) await restartCodex();
      const active = getActiveProvider();
      sendJson(res, 200, {
        ok: true,
        restarted: restartNeeded,
        activeProvider: s.activeProvider,
        activeModel: s.activeModel,
        activeHasKey: active ? hasProviderKey(active) : false,
      });
    });
    return;
  }

  // 从上游拉模型名。用「正在编辑的那份参数」，因为用户常常还没保存就想先看见清单。
  if (url.pathname === "/api/models/upstream" && req.method === "POST") {
    readJson(req, res, async (body) => {
      const baseUrl = normalizeBaseUrl(body.baseUrl);
      if (!baseUrl) throw new Error("缺少 base URL");
      const known = settings().providers.find((p) => p.id === safeId(body.providerId || ""));
      const apiKey = body.apiKey || providerApiKey(known) || "";
      const { url: from, models } = await fetchUpstreamModels({ baseUrl, apiKey });
      sendJson(res, 200, { ok: true, from, models });
    });
    return;
  }

  // 内核自己认可的模型清单，用来给用户一个「内核能识别」的参照。
  if (url.pathname === "/api/models/kernel" && req.method === "GET") {
    await ensureReady();
    const result = await rpc("model/list", { includeHidden: true });
    const data = result?.result?.data ?? result?.data ?? [];
    sendJson(res, 200, {
      ok: true,
      // 把推理强度元数据一并给前端：输入框里的「思考强度」菜单要按模型
      // 实际支持的档位来列，不能硬编码一份，否则会出现内核不认的死选项。
      models: data.map((m) => ({
        id: m.id ?? m.model,
        displayName: m.displayName ?? m.id ?? m.model,
        hidden: !!m.hidden,
        supportedReasoningEfforts: m.supportedReasoningEfforts ?? null,
        defaultReasoningEffort: m.defaultReasoningEffort ?? null,
      })),
    });
    return;
  }

  // ---------- 技能 ----------
  // 列出内核实际发现的技能（含来源和作用域），前端据此做开关和展示。
  if (url.pathname === "/api/skills" && req.method === "GET") {
    await ensureReady();
    const cwd = url.searchParams.get("cwd") || DEFAULT_CWD;
    const result = await rpc("skills/list", { cwds: [cwd], forceReload: true });
    const entry = result?.result?.data?.[0] ?? result?.data?.[0] ?? { skills: [], errors: [] };
    sendJson(res, 200, { cwd, skills: entry.skills ?? [], errors: entry.errors ?? [] });
    return;
  }

  // 技能写操作，四选一：
  //   { name, enabled }  开关某个已发现的技能
  //   { path, enabled }  按路径开关
  //   { addRoot }        把外部技能根目录加进扫描范围（一个目录里可放多个技能）
  //   { linkTo, name }   把一个外部技能目录软链进 codex-home/skills（单个技能）
  if (url.pathname === "/api/skills" && req.method === "POST") {
    readJson(req, res, async (body) => {
      await ensureReady();

      // 「加入 skill」：源目录自己维护，App 只留一条链接，不像拷贝那样会各自变旧。
      if (body.linkTo) {
        const source = path.resolve(String(body.linkTo));
        if (!existsSync(source)) throw new Error("源目录不存在：" + source);
        // 允许两种输入：直接是技能目录（含 SKILL.md），或它的上一级目录。
        const isSkillDir = existsSync(path.join(source, "SKILL.md"));
        const name = safeId(body.name || (isSkillDir ? path.basename(source) : ""));
        const finalSource = isSkillDir ? source : path.join(source, name);
        if (!existsSync(path.join(finalSource, "SKILL.md"))) {
          throw new Error("没找到 SKILL.md：" + path.join(finalSource, "SKILL.md"));
        }
        // 内核只认带 YAML frontmatter（--- name/description ---）的 SKILL.md。
        // 不带 frontmatter 的文件会被静默忽略：链接建好了、列表里却没有这个技能，
        // 用户完全不知道错在哪。所以这里提前拦住，直接告诉他要补什么。
        const skillText = await readFile(path.join(finalSource, "SKILL.md"), "utf8");
        if (!/^---\s*\n[\s\S]*?\n---/.test(skillText.trimStart())) {
          throw new Error(
            "SKILL.md 缺少 YAML frontmatter，内核会忽略它。开头需要：\n" +
            '---\nname: "技能名"\ndescription: "一句话说明"\n---',
          );
        }
        const skillsDir = path.join(CODEX_HOME, "skills");
        mkdirSync(skillsDir, { recursive: true });
        const target = path.join(skillsDir, name);
        if (existsSync(target)) throw new Error("已经有一个叫 " + name + " 的技能了");
        symlinkSync(finalSource, target, process.platform === "win32" ? "junction" : "dir");
        const list = await rpc("skills/list", { cwds: [DEFAULT_CWD], forceReload: true });
        sendJson(res, 200, {
          ok: true,
          linked: { name, source: finalSource },
          skills: list?.result?.data?.[0]?.skills ?? list?.data?.[0]?.skills ?? [],
        });
        return;
      }

      // 「加入一个技能根目录」：里面可以放多个技能。
      if (body.addRoot) {
        const root = path.resolve(String(body.addRoot));
        if (!existsSync(root)) throw new Error("目录不存在：" + root);
        const roots = new Set(Array.isArray(body.roots) ? body.roots : []);
        roots.add(root);
        await rpc("skills/extraRoots/set", { extraRoots: [...roots] });
        const list = await rpc("skills/list", { cwds: [DEFAULT_CWD], forceReload: true });
        sendJson(res, 200, {
          ok: true,
          roots: [...roots],
          skills: list?.result?.data?.[0]?.skills ?? list?.data?.[0]?.skills ?? [],
        });
        return;
      }

      // 开关技能：内核原生支持按 name 或 path 写。
      const params = { enabled: !!body.enabled };
      if (body.path) params.path = path.resolve(String(body.path));
      else if (body.name) params.name = String(body.name);
      else throw new Error("需要 name 或 path");
      const result = await rpc("skills/config/write", params);
      const list = await rpc("skills/list", { cwds: [DEFAULT_CWD], forceReload: true });
      sendJson(res, 200, {
        ok: true,
        effectiveEnabled: result?.result?.effectiveEnabled ?? result?.effectiveEnabled,
        skills: list?.result?.data?.[0]?.skills ?? list?.data?.[0]?.skills ?? [],
      });
    });
    return;
  }

  if (url.pathname === "/api/projects") {
    // 可选工作目录清单。苍穹专家技能要靠会话的工作目录往上找 ok-cosmic.json，
    // 所以「会话开在哪个项目」不是个小设置，它决定技能能不能真的生效。
    // 清单写在 projects.json；路径不存在的会被过滤，保证下拉框里没有死选项。
    // 工作区新增/删除：写进 projects.json。路径先做存在性校验。
    if (req.method === "POST") {
      readJson(req, res, async (body) => {
        const file = PROJECTS_FILE;
        let list = [];
        try {
          list = JSON.parse(await readFile(file, "utf8")).projects ?? [];
        } catch {
          list = [];
        }
        if (body.path) {
          const target = path.resolve(String(body.path));
          if (!existsSync(target)) throw new Error("目录不存在：" + target);
          if (!list.some((p) => path.resolve(p.path) === target)) {
            list.push({ name: String(body.name || path.basename(target) || target).trim(), path: target });
          }
        }
        if (body.removePath) {
          const target = path.resolve(String(body.removePath));
          list = list.filter((p) => path.resolve(p.path) !== target);
        }
        await writeFile(file, JSON.stringify({ projects: list }, null, 2) + "\n", "utf8");
        const visible = list.filter((p) => existsSync(p.path));
        sendJson(res, 200, {
          ok: true,
          projects: visible.length ? visible : [{ name: "默认工作目录", path: DEFAULT_CWD }],
        });
      });
      return;
    }
    const raw = await readFile(PROJECTS_FILE, "utf8").catch(() => null);
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

  // 用系统目录选择器选工作区。浏览器拿不到本地绝对路径，所以调系统对话框：
  // macOS 用 osascript，Windows 用 PowerShell 的 FolderBrowserDialog。
  if (url.pathname === "/api/pick-directory" && req.method === "POST") {
    let out = "";
    if (process.platform === "darwin") {
      const script = 'POSIX path of (choose folder with prompt "选择要加入的工作区")';
      out = await new Promise((resolve) => {
        const p = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
        let buf = "";
        p.stdout.on("data", (d) => (buf += d));
        p.on("error", () => resolve(""));
        p.on("exit", (code) => resolve(code === 0 ? buf.trim() : ""));
      });
    } else if (process.platform === "win32") {
      const ps = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择要加入的工作区'; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}";
      out = await new Promise((resolve) => {
        const p = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] });
        let buf = "";
        p.stdout.on("data", (d) => (buf += d));
        p.on("error", () => resolve(""));
        p.on("exit", () => resolve(buf.trim()));
      });
    }
    // 取消也是正常操作，返回 canceled 而不是报错。
    sendJson(res, 200, out ? { ok: true, path: out } : { ok: false, canceled: true });
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
}

// 请求处理器里抛出的异常绝不能逃逸：async 函数里未接住的异常会变成
// unhandledRejection，Node 默认直接结束进程（前面两次「服务起不来」都是这个）。
// 这里统一兜底，把错误变成一条 500 JSON，服务继续活着。
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[http] 处理请求失败:", err?.message ?? err);
    sendJson(res, 500, { error: String(err?.message ?? err) });
  });
});

// 最后一道防线。上面的 try/catch 已经盖住了 HTTP 路径，但只要将来有任何一处
// 漏掉 await/catch，Node 默认会直接结束进程——一个后台小毛病就能把整个桌面 App
// 干掉，而且终端一闪就没了，很难查。这里至少把它降级成一条显眼的日志。
process.on("unhandledRejection", (err) => {
  console.error("[unhandled] 未处理的 Promise 拒绝（已拦住，服务继续）:", err?.stack ?? err);
});

// 父进程守护：由原生壳拉起时，壳一旦退出，桥不能变成孤儿进程继续占端口。
// 用 PPID 轮询（Node 里比 PCAP/processgroup 更跨平台），2 秒一次，
// 只在显式传了 AGENT_LAB_PARENT_PID 时才启用，不影响命令行直接跑的场景。
const PARENT_PID = Number(process.env.AGENT_LAB_PARENT_PID ?? 0);
if (PARENT_PID > 0) {
  const parentWatch = setInterval(() => {
    try {
      // process.kill(pid, 0) 只是探测，不真的发信号；进程不存在时会抛 ESRCH。
      process.kill(PARENT_PID, 0);
    } catch {
      console.log("父进程已退出，桥随之退出，避免孤儿进程占用端口。");
      if (child) child.kill();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    }
  }, 2000);
  parentWatch.unref();
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Lab 已启动: http://127.0.0.1:${PORT}`);
  console.log(`工作目录: ${DEFAULT_CWD}`);
  console.log(`用户数据: ${DATA_DIR}`);
});

// 端口被占时不要抛一堆栈就死：告诉用户是谁占着，该怎么办。
// 踩过：重复双击启动（或旧进程没退干净）时，第二个进程直接 EADDRINUSE 崩溃，
// 终端一闪而过，用户只看到「服务起不来了」。
server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已经被占用了。`);
    console.error("可能是已经有一份 Agent Lab 在跑（那就直接用，重复启动是安全的）。");
    console.error(`想确认是谁占着：lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error(`想换端口启动：PORT=8788 node start.mjs`);
  } else {
    console.error("服务启动失败:", err?.message ?? err);
  }
  if (child) child.kill();
  process.exit(1);
});

process.on("SIGINT", () => {
  child?.kill();
  process.exit(0);
});
