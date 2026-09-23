// 实验 25：你在界面上改的知识，agent 真的会用上吗？
//
// 这是整个项目最核心的一句话的验证：「加入我自己开发常用的知识」。
// 界面上那个编辑器保存后写着「开一个新会话生效」——这个承诺到底成不成立？
//
// 这个脚本把它当成一个闭环来验，四步缺一不可：
//   1. 备份当前 knowledge.md（测完必须还原，不能留下垃圾）
//   2. 往知识里加一条**能被客观检验**的规则：
//      要求模型在每次回复的第一行写一个特定的口令
//      （用「开头写口令」而不是「末尾写标记」，因为末尾标记容易和已有的
//       [知识已生效] 混淆，而口令是这次临时编的，旧知识里绝对没有）
//   3. 走桥开一个**新会话**，问一个无关的问题，看它有没有照做
//   4. 还原文件
//
// 这里同时验了两件事：
//   - 「保存生效」不是空头支票（新会话真的读到新内容）
//   - 而且只影响**新**会话 —— 旧会话用的是它启动时那份，不该突然变
//
// 运行：先起 App（node start.mjs），再 node 25-knowledge-loop.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const KNOWLEDGE = path.join(HERE, "knowledge.md");

// 临时口令。刻意用一串不可能自然出现的字符，避免误判。
const TOKEN = "ZK-7742-CHECK";

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

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

const newThread = async () =>
  (await rpc("thread/start", { cwd: null, model: null, sandbox: "workspace-write" })).thread.id;

// 在指定会话里问一句，把模型说过的话收集回来。
// 顺手自动放行审批：无头脚本没人按确认键，卡住的话会假装成「知识没生效」。
async function askExisting(threadId, question) {
  const events = [];
  const handled = new Set();
  const ac = new AbortController();
  const es = await fetch(BASE + "/api/events", { signal: ac.signal });
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  (async () => {
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read().catch(() => ({ value: undefined, done: true }));
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
        // 无头脚本没人按确认键；卡住会假装成「知识没生效」。
        if (msg.__isServerRequest && !handled.has(msg.id)) {
          handled.add(msg.id);
          await fetch(BASE + "/api/reply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: msg.id, decision: "accept" }),
          }).catch(() => {});
        }
        if (msg.method === "turn/completed") resolveDone(msg);
      }
    }
  })();

  await rpc("turn/start", { threadId, input: [{ type: "text", text: question, textElements: [] }] });

  let turn = null;
  try {
    turn = await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("超时（180 秒）")), 180000)),
    ]);
  } catch (err) {
    console.log("  这一轮没跑完：" + (err?.message ?? err));
  }
  ac.abort();
  await new Promise((r) => setTimeout(r, 300));

  const answer = events
    .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
    .map((e) => e.params.item.text ?? "")
    .join("\n");
  return { answer, status: turn?.params?.turn?.status };
}

// ---------- 第一步：备份 ----------
console.log("=== 一、备份当前知识 ===");
const original = await readFile(KNOWLEDGE, "utf8");
console.log("  已读入 " + Buffer.byteLength(original, "utf8") + " 字节");
check(original.length > 0, "knowledge.md 有内容");

let failed_guard = false;
let oldThread = null;
try {
  // ---------- 第二步：先建一个「改动之前」的会话 ----------
  // 顺序很要紧：它必须在写入口令**之前**建好。
  // 它是第五步的对照物——没有它，就分不清「新会话有口令」是因为新会话
  // 读到了新知识，还是因为所有会话都跟着文件变了。
  console.log("\n=== 二、先建会话 A（此时知识里还没有口令）===");
  oldThread = await newThread();
  {
    const before = await askExisting(oldThread, "用一句话说明你是谁。");
    console.log("  A 的回复: " + before.answer.trim().slice(0, 120).replace(/\n/g, " / "));
    check(!before.answer.includes(TOKEN), "A 没有口令（符合预期：知识还没加）");
  }

  // ---------- 第三步：加一条能被客观检验的规则 ----------
  console.log("\n=== 三、往知识里加规则（要求回复第一行写口令）===");
  const patched =
    original.trimEnd() +
    "\n\n## 临时自检规则\n\n" +
    "- 你的每一条回复，**第一行必须原样写出** `" + TOKEN + "`，然后再写其它内容。\n";
  await writeFile(KNOWLEDGE, patched, "utf8");
  const onDisk = await readFile(KNOWLEDGE, "utf8");
  check(onDisk.includes(TOKEN), "规则已写进 knowledge.md");

  // ---------- 第四步：新会话应该读到它 ----------
  console.log("\n=== 四、开新会话 B，看它有没有照做 ===");
  const freshThread = await newThread();
  const fresh = await askExisting(freshThread, "用一句话说明你是谁。");
  console.log("  状态: " + fresh.status);
  console.log("  回复: " + fresh.answer.trim().slice(0, 160).replace(/\n/g, " / "));
  check(fresh.answer.includes(TOKEN), "B 出现了口令 —— 界面说的「开一个新会话生效」是真的");

  // ---------- 第五步：旧会话不该被追溯改写（这一课的重点）----------
  console.log("\n=== 五、回到会话 A 再问一次：不该跟着变 ===");
  if (oldThread) {
    const again = await askExisting(oldThread, "用一句话说明你是谁。");
    console.log("  A 的回复: " + again.answer.trim().slice(0, 120).replace(/\n/g, " / "));
    check(!again.answer.includes(TOKEN), "A 仍然没有口令 —— 知识是会话创建时的快照，不追溯改写");
    console.log("  这一条说明：改完知识要开新会话，不是因为旧会话「懒」，");
    console.log("  而是它里面那份上下文早就发出去了，改文件动不了它。");
  }
} finally {
  // ---------- 还原 ----------
  await writeFile(KNOWLEDGE, original, "utf8");
  const restored = await readFile(KNOWLEDGE, "utf8");
  const clean = restored === original && !restored.includes(TOKEN);
  console.log("\n=== 六、还原 ===");
  check(clean, "knowledge.md 与原文件逐字节一致，没有留下测试口令");
  if (!clean) failed_guard = true;
}

console.log("\n=== 结论 ===");
if (failed === 0 && !failed_guard) {
  console.log("[PASS] 知识闭环成立：改文件 -> 新会话 -> agent 真的照做 -> 原样还原");
} else {
  console.log(`[FAIL] ${failed} 项未通过`);
}
process.exit(failed === 0 && !failed_guard ? 0 : 1);
