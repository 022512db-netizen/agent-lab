// 实验 13：把「一趟活花了多少」拆成「每一圈花了多少」
//
// 背景：内核探针只说「这是第几圈、上下文多大」，没说这一圈动了什么。
// 工具事件（参数 + 返回）走的是另一条管道，带着体积信息。
// 桥把两边按圈对上，就能回答最实在的问题：钱花在哪了。
//
// 运行：先起 App，再 node 13-loop-cost.mjs
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
import { setTimeout as sleep } from "node:timers/promises";

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

const events = [];
const controls = new AbortController();
const es = await fetch(`${BASE}/api/events`, { signal: controls.signal });
const reader = es.body.getReader();
const dec = new TextDecoder();
(async () => {
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
})();

const started = await rpc("thread/start", {
  cwd: null,
  model: null,
  sandbox: "read-only",
  approvalPolicy: "on-request",
});
const threadId = started.thread.id;
console.log("线程:", threadId);

// 故意问一个必须查我自己知识库的问题：它至少要转两圈
// （第一圈调工具，第二圈拿着结果回答）。这样才测得到工具结果归到了哪一圈。
const QUESTION = "查我的个人知识库：苍穹开发里 select 漏字段会报什么错？一句话回答。";
console.log(`>> 发任务：${QUESTION}\n`);
await rpc("turn/start", {
  threadId,
  input: [
    {
      type: "text",
      text: QUESTION,
      textElements: [],
    },
  ],
});

// 只读小问答，模型偶尔会顺手跑个命令确认环境，自动放行免得干等。
const handled = new Set();
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  for (const req of events.filter((e) => e.__isServerRequest && !handled.has(e.id))) {
    handled.add(req.id);
    await fetch(`${BASE}/api/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: req.id, decision: "accept" }),
    }).catch(() => {});
  }
  if (events.some((e) => e.method === "turn/completed" && e.params?.threadId === threadId)) break;
}

// 等最后一圈的账单落地（桥里压了 150ms 才结账）。
await sleep(600);

// 先把这轮真实发生的条目列出来。账单为空时，一眼就能看出是「模型压根没调工具」
// 还是「归集逻辑没接上」。
const items = events.filter((e) => e.method === "item/completed" && e.params?.threadId === threadId);
console.log(
  "=== 这轮实际条目 ===" +
    (items.length ? "" : "（无）")
);
for (const it of items) {
  const item = it.params.item;
  const extra = item.type === "mcpToolCall" ? ` ${item.server}/${item.tool}` : "";
  console.log(`  - ${item.type}${extra}`);
}

// 关键：桥是按什么顺序收到这两条管道的？探针走 stderr，工具事件走 stdout。
// 顺序不对的话，账单就跟真实的花费错位。
console.log("\n=== 桥收件的真实先后顺序 ===");
for (const e of events) {
  if (e.method === "lab/innerLoop" && /开始|结束/.test(e.params?.text ?? "")) {
    console.log(`  探针  ${(e.params.text.match(/第 \d+ 圈(开始|结束)/) ?? [""])[0]}`);
  } else if (e.method === "item/completed" && (e.params?.item?.type === "mcpToolCall" || e.params?.item?.type === "commandExecution")) {
    console.log(`  工具  ${e.params.item.type}`);
  } else if (e.method === "lab/loopCost") {
    console.log(`  账单  第 ${e.params.iteration} 圈（${e.params.calls.length} 次工具）`);
  }
}


const costs = events.filter((e) => e.method === "lab/loopCost");
console.log("=== 每一圈的账单 ===");
for (const c of costs) {
  const p = c.params;
  console.log(
    `第 ${p.iteration} 圈: 上下文 ${p.tokens} token` +
      (typeof p.deltaTokens === "number" ? `（+${p.deltaTokens}）` : "") +
      `, 工具 ${p.calls.length} 次, 结果 ${p.bytes} B`,
  );
  for (const call of p.calls) console.log(`    · ${call.name} ${call.bytes} B | ${call.detail}`);
}

// 断言三件事：
//   1) 至少报出圈数（探针链路通）
//   2) 有一圈真的记到了工具调用的体积（工具事件和圈数对上了）
//   3) 有第二圈，且带上一圈的增量（说明对比是可算的）
const hasRounds = costs.length >= 2;
const costed = costs.find((c) => c.params.bytes > 0 && c.params.calls.length > 0);
const hasDelta = costs.some((c) => typeof c.params.deltaTokens === "number");

console.log("\n=== 结论 ===");
console.log(`报出圈数: ${costs.length} 圈`);
console.log(`把工具体积归到了具体某一圈: ${costed ? `是（第 ${costed.params.iteration} 圈）` : "否"}`);
console.log(`能算出圈与圈之间的增量: ${hasDelta ? "是" : "否"}`);

const ok = hasRounds && Boolean(costed) && hasDelta;
console.log(ok ? "[PASS] 每圈的成本可以拆开看了" : "[FAIL] 成本归集有问题");
controls.abort();
process.exit(ok ? 0 : 1);
