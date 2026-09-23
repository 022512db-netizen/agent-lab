// 实验 28：让 agent 真的**写**苍穹代码，再用项目自己的规范去检查
//
// 为什么补这一课：实验 18/20/21 验的都是「会不会用技能、答得对不对」，
// 实验 21 检查的还是**别人已经写好的**文件。
// 但「苍穹开发专家」这个承诺的核心是「它写出来的代码能过项目的规范」——
// 这一条此前从没验过。问答答对和写码写对是两件事。
//
// 做法（三层证据，缺一层都不算）：
//   1. 让 agent 在**真实苍穹工程**里按项目规则生成一个插件类；
//      工程根有 ok-cosmic.json，所以 Step 0 预检能通过、能查在线元数据。
//   2. 把生成的文件交给 ok-cosmic 自己的 post-lint 判（项目规定的自检入口）。
//   3. 再用「人工核对表」查几条项目的硬规矩——lint 覆盖不到的那些。
//
// 第 3 层不是多余的：实验 21 已经证实 lint **不查「select 字段够不够」**，
// 而那条恰是项目里最容易栽的规矩。只跑 lint 会给出虚假的安心。
//
// 隔离措施：生成的文件放在工程之外的临时目录里（agent 往那儿写），
// 不碰工程里任何现有代码。工程本身只读。
//
// 运行：先起 App（默认实例即可）
//   node start.mjs
//   node 28-cosmic-generate.mjs
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPython, findSkillDir } from "./lib/platform.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const PROJECT = process.env.COSMIC_PROJECT ?? "C:/hnsh/sherp";
const SKILL = findSkillDir("ok-cosmic", process.env.COSMIC_SKILL);
const PY = await findPython();

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

if (!PY) {
  console.log("[FAIL] 找不到 Python，技能脚本跑不起来（macOS 装 python3，Windows 装 python）");
  process.exit(1);
}

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

// ---------- 前置 ----------
console.log("=== 前置：App 与工程 ===");
async function waitReady(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      last = await (await fetch(`${BASE}/api/info`)).json();
      if (last.ready === true) return last;
    } catch {
      last = null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}
const info = await waitReady();
check(info?.ready === true, `App 已就绪`);
if (info?.ready !== true) {
  console.log("\n[FAIL] 环境没就绪，先 node start.mjs");
  process.exit(1);
}

// 工程必须是真的（有 ok-cosmic.json），否则这一课退化成空目录问答。
try {
  await access(path.join(PROJECT, "ok-cosmic.json"));
  check(true, `工程有 ok-cosmic.json（Step 0 预检才可能通过）`);
} catch {
  check(false, `工程缺 ok-cosmic.json：${PROJECT}`);
  process.exit(1);
}

// ---------- 一、让 agent 写一个插件 ----------
// 目录刻意开在工程**外面**：agent 有写权限，但碰不到工程里的代码。
const OUT = await mkdtemp(path.join(os.tmpdir(), "cosmic-gen-"));
const OUT_POSIX = OUT.replace(/\\/g, "/");
console.log(`\n=== 一、让 agent 生成代码 ===`);
console.log(`输出目录（工程外，隔离）: ${OUT_POSIX}`);

const TASK = [
  "请按项目规则（先加载 load-memory 和 ok-cosmic）写一个苍穹**表单插件**。",
  `要求：新建文件 ${OUT_POSIX}/ProbeFormPlugin.java。`,
  "目标单据：销售出库单，formId = im_saloutbill（表体实体 billentry）。",
  "业务：在单据界面上，当分录的「数量」变化时，把同行「金额」重算为 数量 × 单价，并给出提示。",
  // 这三个字段是用在线元数据确认过的，确实同属 im_saloutbill 的 billentry：
  //   ## python cosmic-form-metadata.py get im_saloutbill --fuzzy qty price amount
  //   # 数量 qty / 单价 price / 金额 amount，均为表体（billentry）字段
  // 第一版题目里我随手编了三个 shfz_ 前缀的字段，模型正确地拒绝了：
  // 它说目标单据不明确、按项目规则不猜字段归属。**拒绝得对，是题目不对。**
  "字段标识（已用在线元数据确认，同属 billentry）：数量 = qty，单价 = price，金额 = amount。",
  "只写这一个文件，写完就停；不要改动工程里的任何现有文件，也不要执行 Gradle 编译。",
].join("\n");

const events = [];
const approved = new Set();
const started = await rpc("thread/start", {
  // 注意：工作目录仍是工程根（这样技能才找得到 ok-cosmic.json），
  // 但让 agent 往工程外的临时目录写文件。这两件事不冲突。
  cwd: PROJECT,
  model: null,
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
});

const es = await fetch(`${BASE}/api/events`);
const reader = es.body.getReader();
const dec = new TextDecoder();
let buf = "";
let resolveDone;
const done = new Promise((r) => (resolveDone = r));
(async () => {
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    const { value, done: end } = chunk;
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      events.push(m);
      // 自动化跑：没人按确认键就会一直卡住，所以自动放行。
      if (m.__isServerRequest && !approved.has(m.id)) {
        approved.add(m.id);
        fetch(BASE + "/api/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: m.id, decision: "accept" }),
        }).catch(() => {});
      }
      const item = m.params?.item;
      if (m.method === "item/completed" && item?.type === "commandExecution") {
        console.log(`  命令 | ${String(item.command ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
      }
      if (m.method === "item/completed" && item?.type === "agentMessage") {
        console.log(`  模型 | ${String(item.text ?? "").slice(0, 160)}`);
      }
      if (m.method === "turn/completed") resolveDone(m);
    }
  }
})();

await rpc("turn/start", {
  threadId: started.thread.id,
  input: [{ type: "text", text: TASK, textElements: [] }],
});

const WAIT_MS = Number(process.env.WAIT_MS ?? 600000);
let turnCompleted = null;
try {
  turnCompleted = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`超时（${WAIT_MS / 1000} 秒）`)), WAIT_MS)),
  ]);
} catch (err) {
  console.log(`\n[注意] ${err?.message ?? err}`);
}
const timedOut = turnCompleted === null;
try {
  await es.body.cancel?.().catch?.(() => {});
} catch {
  /* 流已关闭 */
}

// ---------- 二、文件真的落地了吗 ----------
console.log("\n=== 二、生成结果 ===");
const GEN = path.join(OUT, "ProbeFormPlugin.java");
let src = "";
try {
  src = await readFile(GEN, "utf8");
  check(true, `文件已生成（${src.length} 字符）`);
  console.log("\n--- 生成内容 ---");
  console.log(src.split("\n").slice(0, 60).join("\n"));
  console.log("--- 内容结束 ---\n");
} catch {
  check(false, `没找到生成的文件：${GEN}`);
  console.log(`  （这一轮状态：${turnCompleted?.params?.turn?.status ?? "未知"}）`);
}

if (!src) {
  await rm(OUT, { recursive: true, force: true }).catch(() => {});
  console.log("\n=== 结论 ===");
  console.log(timedOut ? "[BLOCKED] 超时且文件没落地，这次没验到" : "[FAIL] agent 没有生成文件");
  process.exit(1);
}

// ---------- 三、项目自己的规范检查 ----------
console.log("=== 三、用 ok-cosmic 的 post-lint 判它 ===");
let lintText = "";
let lintCode = 0;
try {
  const { stdout, stderr } = await run(
    PY,
    [path.join(SKILL, "scripts", "cosmic-post-lint.py"), GEN],
    { timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );
  lintText = ((stdout || "") + (stderr || "")).trim();
} catch (err) {
  lintCode = err.code ?? 1;
  lintText = String((err.stdout || "") + (err.stderr || "")).trim();
}
console.log(lintText.split("\n").slice(0, 12).join("\n") || "(无输出)");
const lintClean = lintCode === 0 && /\[PASS\]/.test(lintText);
check(lintClean, "lint 判定通过（退出码 0 且报 PASS）");

// ---------- 四、lint 覆盖不到、但项目硬性要求的几条 ----------
// 依据是项目记忆（.opencode/cosmic-sdk-reference.md）与 ok-cosmic 的 A 层约束。
// 这一层存在的理由见文件开头：lint 不查 select 够不够。
console.log("\n=== 四、人工核对表（lint 覆盖不到的项目硬规矩）===");

// 1) 中文注释。项目记忆要求「思考过程必须用中文」「注释写清业务逻辑」。
const hasChineseComment = /\/\/[^\n]*[\u4e00-\u9fff]|\/\*[\s\S]*?[\u4e00-\u9fff][\s\S]*?\*\//.test(src);
check(hasChineseComment, "有中文注释（项目要求注释写清业务逻辑）");

// 2) @author / @since。项目记忆里的类注释要求。
const hasAuthor = /@author\b/.test(src);
const hasSince = /@since\b/.test(src);
check(hasAuthor, "类注释带 @author");
check(hasSince, "类注释带 @since");

// 3) 表单插件必须继承项目封装层的入口类，而不是裸的 kd.bos 原生基类。
//    这是「封装优先、原生兜底」最直接的一条体现。
const usesWrapper = /kd\.cd\.common\.plugin\./.test(src);
check(usesWrapper, "继承的是项目封装层入口类（kd.cd.common.plugin.*），不是原生基类");

// 这一条不是拍脑袋定的规矩，两边都查过：
//   - 技能里就是这么要求的：assets/FormPluginTemplate.java 写 `extends AbstractFormPluginExt`，
//     注释还标了 `@extends AbstractFormPluginExt (kd.cd.common.plugin)`；
//     decision-matrix 的表单插件行也把入口类指向它。
//   - 这个类真实存在：在工程自带的 kd-cd-cosmic-commons.jar 里能看到
//     `kd/cd/common/plugin/AbstractFormPluginExt.class`。
// 实测（2026-09-23）：模型生成的代码继承的是 kd.bos.form.plugin.AbstractFormPlugin（原生），
// 而它在叙述里说自己「继承仓库优先封装的 AbstractFormPluginExt」——
// **说的和写的不是一回事**，而 post-lint 给的是 [PASS]。
// 所以这一条必须自己核，不能只看 lint，也不能只看模型怎么说。

// 4) 字段标识要按给定的写对。写错字段名是这类生成最常见的错。
//    这一条和 lint 无关，纯业务正确性。
const fieldNamesOk = /\bqty\b/.test(src) && /\bprice\b/.test(src) && /\bamount\b/.test(src);
check(fieldNamesOk, "三个字段标识都按在线元数据确认过的写（qty / price / amount）");

// 6) 表体字段要带分录 key（billentry）。项目里表单插件操表体字段时必须指明实体；
//    只写字段名不带分录的，运行时会取不到值——这是很典型的一个坑。
const usesEntryKey = /billentry/i.test(src);
check(usesEntryKey, "操表体字段时带上了分录 key（billentry）");

// 5) 该在 propertyChanged 里做联动——这是项目决策矩阵里表单字段联动的正确时机。
const rightHook = /propertyChanged/.test(src);
check(rightHook, "在 propertyChanged 里做字段联动（项目规定的时机）");

// ---------- 结论 ----------
await rm(OUT, { recursive: true, force: true }).catch(() => {});

console.log("\n=== 结论 ===");
if (failed === 0) {
  console.log("[PASS] agent 生成的苍穹插件同时过了项目规范检查和硬规矩核对");
} else if (timedOut) {
  console.log(`[BLOCKED] 这一轮没收尾（超时），${failed} 项未过——但已生成的文件其判定仍然有效`);
} else {
  console.log(`[FAIL] ${failed} 项未通过`);
}
process.exit(failed === 0 ? 0 : 1);
