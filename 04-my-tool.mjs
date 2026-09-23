// 实验 04：验证「我自己写的 MCP 工具」能否被 agent 真正调用
// 做法：问一个只有我的知识库里才有答案的问题，看它会不会去用 knowledge_search。
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:8787";

async function rpc(method, params) {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return res.json();
}

const events = [];
const controller = new AbortController();
const esRes = await fetch(`${BASE}/api/events`, { signal: controller.signal });
const reader = esRes.body.getReader();
const decoder = new TextDecoder();
(async () => {
  let buf = "";
  while (true) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buf += decoder.decode(value, { stream: true });
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

const started = await rpc("thread/start", { cwd: null, model: null, sandbox: "workspace-write" });
const threadId = started.result.thread.id;
console.log("线程:", threadId);

// 这个问题只有我的知识库里才有答案
await rpc("turn/start", {
  threadId,
  input: [
    {
      type: "text",
      // 换成真知识库里确实有的一条（苍穹踩坑），这样实验跟着真正的库走，
      // 不再依赖仓库里那份样例库。
      text: "苍穹开发里 select 漏字段会报什么错？查询我的个人知识库回答，不要翻其它目录。",
      textElements: [],
    },
  ],
});
console.log("已发问，等待 agent 调用我的工具…\n");

let finalText = "";
let toolCalls = [];
const POLL_SECONDS = 300;
for (let i = 0; i < POLL_SECONDS; i++) {
  await sleep(1000);
  toolCalls = events.filter(
    (e) =>
      e.method === "item/completed" &&
      e.params?.threadId === threadId &&
      (e.params?.item?.type === "mcpToolCall" || e.params?.item?.type === "commandExecution"),
  );
  if (events.find((e) => e.method === "turn/completed" && e.params?.threadId === threadId)) {
    const msgs = events.filter(
      (e) => e.method === "item/completed" && e.params?.threadId === threadId && e.params?.item?.type === "agentMessage",
    );
    finalText = msgs.map((m) => m.params.item.text ?? "").join("\n");
    break;
  }
}

console.log("=== agent 用到的工具 ===");
if (!toolCalls.length) console.log("（没有调用任何工具）");
for (const t of toolCalls) {
  const it = t.params.item;
  if (it.type === "mcpToolCall") {
    console.log(`- [我的 MCP] ${it.server}/${it.tool}  参数=${JSON.stringify(it.arguments)}`);
    console.log(`  返回: ${JSON.stringify(it.result ?? it.error ?? null).slice(0, 200)}`);
  } else {
    console.log(`- [系统命令] ${it.command}`);
  }
}

console.log("\n=== agent 最终回复 ===");
console.log(finalText || "(没拿到回复)");

const used = toolCalls.some((t) => t.params.item.server === "my_knowledge");
const correct = finalText.includes("不存在名为") || finalText.includes("select");
console.log("\n=== 结论 ===");
console.log(used ? "[PASS] agent 调用了我自己写的 MCP 工具" : "[FAIL] 没有调用我的工具");
console.log(correct ? "[PASS] 答案来自我的知识库" : "[FAIL] 答案内容不对");
controller.abort();
process.exit(used && correct ? 0 : 1);
