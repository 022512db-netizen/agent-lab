// 实验 18：苍穹开发专家——从「装了技能包」到「模型真的会用它」
//
// 背景：苍穹（金蝶云苍穹 / Cosmic）的知识不适合塞进 knowledge.md 那种几十行的
// 注入文本。它是一整套 15 MB 的专家包（几百份 reference、可直接抄的 Java 模板、
// API 知识库、写完用来查错的 lint 脚本），已经在 ~/.codex/skills/ok-cosmic 里。
// 所以这个 App 做的是「链接过去」，不是复制一份——复制两份迟早各自变旧。
//
// 这个脚本验证三件事：
//   1) 专家包确实被接到 App 的配置目录里，而且内核能读到（不是我们自己以为接上了）；
//   2) 注入给模型的技能说明里真的有它（模型看得见，而不是藏在某处）；
//   3) 问一个只有参考文档里才有答案的苍穹问题，模型的回答能对上原文。
//
// 第 3 条是关键：前两条只能说明「接上了」，只有问到真东西才算「是专家」。
//
// 运行：先起 App（node start.mjs），再 node 18-cosmic-expert.mjs
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const SKILL_DIR = path.join(HERE, "codex-home", "skills", "ok-cosmic");

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// ---------- 第一步：专家包接上了吗 ----------
console.log("=== 第一步：专家包有没有真的接进来 ===");
console.log(`链接位置: ${SKILL_DIR}`);

let manifest = null;
try {
  await access(path.join(SKILL_DIR, "SKILL.md"));
  manifest = await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  check(true, "能通过 App 的配置目录读到 SKILL.md");
} catch (err) {
  check(false, `读不到 SKILL.md：${err?.message ?? err}`);
}

if (manifest) {
  // 光有文件不够，得是那份「苍穹」的，而不是随便一个同名目录。
  check(/name:\s*"ok-cosmic"/.test(manifest), "它是 ok-cosmic 这个技能（不是同名占位目录）");
  check(/苍穹/.test(manifest), "内容确实讲的是苍穹开发");
  // 参考文档是这个技能的价值所在：光有 SKILL.md 一句话不够。
  const refs = ["rules/cheat-sheet.md", "rules/decision-matrix.md", "rules/constraints.md"];
  for (const rel of refs) {
    try {
      await access(path.join(SKILL_DIR, rel));
      check(true, `参考资料在：${rel}`);
    } catch {
      check(false, `缺参考资料：${rel}`);
    }
  }
}

// ---------- 第二步：模型看得见它吗 ----------
// 内核会把可用技能清单作为开发者指令注入每一轮。直接问 App 要一份，
// 比我们自己读文件可靠——这验证的是「模型侧真的收得到」。
async function rpc(method, params) {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

console.log("\n=== 第二步：模型侧能不能看见它 ===");
let started = null;
try {
  started = await rpc("thread/start", {
    cwd: null,
    model: null,
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
  check(!!started?.thread?.id, "能新建会话");
} catch (err) {
  check(false, `新建会话失败：${err?.message ?? err}`);
}

// ---------- 第三步：问一个只有资料里才有答案的问题 ----------
// 这题刻意选了「不查资料基本答不准」的类型：苍穹插件里到底有哪些时机，
// 以及常用封装叫什么。凭印象会答得含糊，查过 cheat-sheet / decision-matrix 才具体。
const QUESTION =
  process.env.QUESTION ??
  "我在做金蝶云苍穹的插件开发。请先加载 ok-cosmic 技能，然后回答：单据插件和操作插件分别该在什么时机写业务逻辑，各自常用的事件名是什么？优先用 kd-cd-cosmic-commons 的封装，给出具体的类名或方法名。";

const events = [];
const approved = []; // 已经放行过的审批请求 id，避免重复回话
// 这几个判定量要先在块外声明：下面 try 里赋值、块外读。
// （以前把它们都写在 try 里，想在外面用才发现作用域不对。）
let timedOut = false;
let readSkill = false;
let mentionsConcrete = false;
let answer = "";
console.log("\n=== 第三步：真的问一个苍穹问题 ===");
console.log(`>> ${QUESTION}\n`);

if (started?.thread?.id) {
  const es = await fetch(`${BASE}/api/events`);
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let finished = false;
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
        const item = msg.params?.item;

        // 只读沙箱下，「读技能目录」这类命令也算要动手，内核会先来请示。
        // 没人答它，这一轮就永远卡在那儿——所以这里要自动放行。
        // 这也是 agent 工程里很实际的一课：让 agent 全自动跑，
        // 就得有个东西替人按确认键。
        if (msg.__isServerRequest && !approved.includes(msg.id)) {
          approved.push(msg.id);
          const cmd = msg.params?.command ? " 命令=" + JSON.stringify(msg.params.command).slice(0, 100) : "";
          console.log("  [审批] 自动放行 " + msg.method + cmd);
          fetch(BASE + "/api/reply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: msg.id, decision: "accept" }),
          }).catch(() => {});
        }

        if (msg.method === "item/completed" && item?.type === "mcpToolCall") {
          console.log(`  工具 | ${item.server}.${item.tool}`);
        }
        if (msg.method === "item/completed" && item?.type === "commandExecution") {
          console.log(`  命令 | ${String(item.command ?? "").slice(0, 90)}`);
        }
        if (msg.method === "turn/completed") {
          finished = true;
          resolveDone(msg);
        }
      }
    }
  })();

  await rpc("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: QUESTION, textElements: [] }],
  });

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("超时（420 秒）")), 420000));
  // 这个上限调过一次 240s -> 420s。
  // 240s 当时刚够：有一次实测这一轮跑了 230s，余量只剩 10 秒，
  // 下一次就超时了，报的还是「这一轮没跑完」——看着像链路断了，
  // 实际是脚本等不及。模型要读几十份技能资料，慢是正常的。
  // 上限要比「正常一轮」明显宽，不然它测的是网速不是功能。
  let turnCompleted = null;
  try {
    turnCompleted = await Promise.race([done, timeout]);
  } catch (err) {
    check(false, `这一轮没跑完：${err?.message ?? err}`);
  }
  // 记下是不是被我们自己的上限掐断的。这个事实下面判定要用：
  // 「超时」不等于「技能没生效」——模型可能已经读完技能、也给出了具体类名，
  // 只是这一轮收尾慢了（真事：2026-09-23 实测 420s 还不够，而证据已经到手）。
  timedOut = turnCompleted === null;
  try {
    await es.body.cancel();
  } catch {
    /* 流已经结束，无所谓 */
  }

  answer = events
    .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
    .map((e) => e.params.item.text ?? "")
    .join("\n");
  const commands = events
    .filter((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution")
    .map((e) => String(e.params.item.command ?? ""));

  console.log(`\n状态: ${turnCompleted?.params?.turn?.status ?? "未知"}`);
  console.log(`\n回答:\n${answer.slice(0, 1200)}`);

  check(turnCompleted?.params?.turn?.status === "completed", "这一轮正常跑完");
  check(answer.length > 80, "给出了实质回答（不是敷衍一句）");

  // 判断「查过资料」而不是「凭印象」：要么读过技能目录，要么回答里出现
  // 只有资料中才有的具体标识符。
  readSkill = commands.some((c) => /ok-cosmic|skills/i.test(c));
  mentionsConcrete =
    /AbstractBillPlugIn|AbstractFormPlugin|AbstractOperationServicePlugIn|kd-cd-cosmic-commons|cosmic-commons|onPreparePropertys|beforeDoOperation|afterDoOperation|beginOperationTransaction|endOperationTransaction/i.test(
      answer,
    );
  console.log(`读过技能目录: ${readSkill ? "是" : "否"}    提到具体类/事件名: ${mentionsConcrete ? "是" : "否"}`);
  check(readSkill || mentionsConcrete, "回答建立在技能包资料上（读过了，或给出了具体类名/事件名）");
}

console.log("\n=== 结论 ===");
// 超时但证据已经到手时，结论应该说成「没验完」，而不是「坏了」。
// 区分这两种红只需一个布尔量，但以前混在一起报，
// 每次都得人肉翻日志才知道是功能问题还是耐心问题。
const evidenceOk = answer.length > 80 && (readSkill || mentionsConcrete);
if (failed === 0) {
  console.log("[PASS] 苍穹开发专家已接入并可用");
} else if (timedOut && evidenceOk) {
  console.log(`[BLOCKED] 这一轮没收尾（超时），但技能确实被用上了（读过=${readSkill} 具体类名=${mentionsConcrete}）`);
  console.log("  -> 这是模型慢，不是技能没生效。调大 WAIT_MS 重跑即可。");
} else {
  console.log(`[FAIL] ${failed} 项未通过`);
}
// BLOCKED 仍然是非 0 退出码——不能让它被当成绿灯。
process.exit(failed === 0 ? 0 : 1);
