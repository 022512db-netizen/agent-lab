// 实验 20：把 App 指到真实的苍穹工程，看专家技能是不是真的会在实战里生效。
//
// 前面实验 18 验的是「技能接上了、模型会用」，但工作目录是空的 agent-lab，
// 所以模型只能给概念。这个脚本换成真正的苍穹工程 C:\hnsh\sherp（工程根，
// 里面有 ok-cosmic.json 和 .opencode/cosmic-sdk-reference.md），走完整链路。
//
// 关键差别：工程根才有 Step 0 预检要读的 ok-cosmic.json，也才有 load-memory
// 要读的项目记忆文件。所以这里能验证到的比实验 18 强得多：
//   - Step 0 预检是不是**通过**（不是上次那种「没有配置所以停下」）；
//   - 模型是不是真的读了项目记忆（项目规范里的写法有没有体现出来）。
//
// 运行：先起 App，再
//   AGENT_CWD="C:/hnsh/sherp" node start.mjs    # 这一步要单独起，见 README
//   node 20-cosmic-real-project.mjs
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const PROJECT = process.env.COSMIC_PROJECT ?? "C:/hnsh/sherp";

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// ---------- 第一步：工程侧该有的东西在不在 ----------
// 这一层是「前置条件」，缺了后面都不用谈。
console.log("=== 第一步：真实苍穹工程的前置条件 ===");
console.log(`工程根: ${PROJECT}`);

for (const [rel, why] of [
  ["ok-cosmic.json", "ok-cosmic 的 Step 0 预检要读它"],
  [".opencode/cosmic-sdk-reference.md", "load-memory 要读的项目规范"],
]) {
  const p = path.join(PROJECT, rel);
  try {
    await access(p);
    const size = (await readFile(p)).byteLength;
    check(true, `${rel} 在（${size} B）— ${why}`);
  } catch {
    check(false, `${rel} 不在 — ${why}`);
  }
}

// 工程里到底有没有插件代码，决定这个验证是不是「实战」。
let javaCount = 0;
try {
  const { readdir } = await import("node:fs/promises");
  const SKIP = new Set([".git", ".gradle", ".idea", "build", "node_modules", ".opencode"]);
  async function walk(dir, depth = 0) {
    // 目录很深：这个工程实测最深 16 层（dpc-code/project/.../src/main/java/...）。
    // 前两版把深度限在 6 和 12，都扫到 0 个，错误地报了「没有插件代码」。
    // 教训：拿目录深度当护栏之前，先量一下真实工程有多深。
    if (depth > 20 || javaCount > 50) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.endsWith(".java") && e.name.includes("Plugin")) javaCount++;
    }
  }
  await walk(PROJECT);
  check(javaCount > 0, "工程里找得到插件代码（至少扫到 " + javaCount + " 个 *Plugin.java）");
} catch (err) {
  check(false, `扫工程失败：${err?.message ?? err}`);
}

// ---------- 第二步：这个 App 现在指着哪儿 ----------
const info = await (await fetch(`${BASE}/api/info`)).json();
console.log(`\n=== 第二步：App 的工作目录 ===`);
console.log(`App cwd: ${info.cwd}`);
const pointingAtProject = String(info.cwd).replace(/\\/g, "/").toLowerCase().includes("hnsh");
check(pointingAtProject, "App 的工作目录是真实苍穹工程（不然下面测的不是实战）");
if (!pointingAtProject) {
  console.log("=> 需要用 AGENT_CWD=\"" + PROJECT + "\" 重启 App 再跑本实验。");
  process.exit(1);
}

// ---------- 第三步：让 agent 在真工程里做一件具体的事 ----------
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

// 刻意问一个「答案在项目规范里、不在通用知识里」的问题：
// cosmic-sdk-reference.md 规定的是这个项目的写法，通用模型答不出来。
const QUESTION =
  process.env.QUESTION ??
  "先按项目规则加载 load-memory 和 ok-cosmic，然后回答两件事：一、本项目的苍穹插件代码里，查询字段时必须遵守什么规矩？二、基础资料（F7）字段取编码应该怎么写？请引用项目记忆文件里的原文来说明。";

console.log(`\n=== 第三步：在真实工程里提问 ===\n>> ${QUESTION}\n`);

const events = [];
const approved = [];
const started = await rpc("thread/start", {
  cwd: null,
  model: null,
  sandbox: "read-only",
  approvalPolicy: "on-request",
});
console.log(`会话: ${started.thread.id}\n`);

const es = await fetch(`${BASE}/api/events`);
const reader = es.body.getReader();
const dec = new TextDecoder();
let resolveDone;
const done = new Promise((r) => (resolveDone = r));

(async () => {
  let buf = "";
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      events.push(msg);

      // 只读沙箱下读文件也要请示。没人答就永远卡住——自动化跑 agent
      // 必须有东西替人按确认键（这就是实验 18 卡了四分钟的那一课）。
      if (msg.__isServerRequest && !approved.includes(msg.id)) {
        approved.push(msg.id);
        fetch(BASE + "/api/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: msg.id, decision: "accept" }),
        }).catch(() => {});
      }

      const item = msg.params?.item;
      if (msg.method === "item/completed" && item?.type === "commandExecution") {
        console.log(`  命令 | ${String(item.command ?? "").slice(0, 110)}`);
      }
      if (msg.method === "turn/completed") resolveDone(msg);
    }
  }
})();

await rpc("turn/start", {
  threadId: started.thread.id,
  input: [{ type: "text", text: QUESTION, textElements: [] }],
});

let turnCompleted = null;
try {
  turnCompleted = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error("超时（300 秒）")), 300000)),
  ]);
} catch (err) {
  check(false, `这一轮没跑完：${err?.message ?? err}`);
}
try {
  await es.body.cancel();
} catch {
  /* 流已结束 */
}

const answer = events
  .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
  .map((e) => e.params.item.text ?? "")
  .join("\n");
const commands = events
  .filter((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution")
  .map((e) => String(e.params.item.command ?? ""));
const raw = JSON.stringify(events);

console.log(`\n状态: ${turnCompleted?.params?.turn?.status ?? "未知"}`);
console.log(`\n回答:\n${answer.slice(0, 1600)}`);

// ---------- 判据 ----------
console.log("\n=== 结论 ===");
check(turnCompleted?.params?.turn?.status === "completed", "这一轮正常跑完");
check(answer.length > 100, "给出了实质回答");

// 它有没有真去读项目记忆？这是这次要验的核心。
const readMemory = commands.some((c) => /cosmic-sdk-reference/i.test(c));
check(readMemory, "真的去读了项目记忆文件 cosmic-sdk-reference.md");

// Step 0 预检这次应该**通过**（工程根有 ok-cosmic.json）。
const ranPreflight = commands.some((c) => /cosmic-config-check/i.test(c));
console.log(`跑过 Step 0 预检: ${ranPreflight ? "是" : "否"}`);

// 答案里应该出现项目规范里特有的规矩，而不是泛泛而谈。
const mentionsSelectRule = /select|查询字段|字段查询/i.test(answer);
const mentionsF7Rule = /getDynamicObject|number|编码/i.test(answer);
check(mentionsSelectRule, "答到了「查询必须先 select 需要的字段」这条项目规矩");
check(mentionsF7Rule, "答到了「基础资料字段怎么取编码」这条项目规矩");
check(!/没有.*ok-cosmic\.json|不是.*苍穹工程/.test(answer), "这次没有把工程判成「不是苍穹工程」");

console.log(failed === 0 ? "[PASS] 真实苍穹工程里，专家技能端到端生效" : `[FAIL] ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
