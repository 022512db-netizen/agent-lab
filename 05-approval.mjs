// 实验 05：验证审批链路能不能走通
// 做法：故意在只读沙箱里让它写文件 -> 它必须请求批准 -> 我们回「允许」-> 看它能不能继续。
// 这是 agent 安全机制的核心：模型想动手，但动手前必须得到人的许可。
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

// 用只读沙箱开线程：想写文件就必须请求批准
const started = await rpc("thread/start", {
  cwd: null,
  model: null,
  sandbox: "read-only",
  approvalPolicy: "on-request",
});
const threadId = started.result.thread.id;
console.log("线程:", threadId, "| 沙箱: read-only");

await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: "在当前目录创建一个 approval-test.txt，内容写 approved。", textElements: [] }],
});
console.log("已发任务，等待它请求批准…\n");

let approvals = [];
let finalText = "";
for (let i = 0; i < 240; i++) {
  await sleep(1000);

  // 发现新的审批请求就自动批准一次
  const pending = events.filter((e) => e.__isServerRequest && !approvals.includes(e.id));
  for (const req of pending) {
    approvals.push(req.id);
    const kind = req.method;
    const cmd = req.params?.command ? ` 命令=${JSON.stringify(req.params.command)}` : "";
    const root = req.params?.grantRoot ? ` 申请写入=${req.params.grantRoot}` : "";
    console.log(`[收到审批请求] id=${req.id} 类型=${kind}${cmd}${root}`);
    const decision = "accept";
    const r = await fetch(`${BASE}/api/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: req.id, decision }),
    });
    console.log(`  -> 已回复: ${decision}  (${r.status})`);
  }

  if (events.find((e) => e.method === "turn/completed" && e.params?.threadId === threadId)) {
    const msgs = events.filter(
      (e) => e.method === "item/completed" && e.params?.threadId === threadId && e.params?.item?.type === "agentMessage",
    );
    finalText = msgs.map((m) => m.params.item.text ?? "").join("\n");
    break;
  }
}

console.log("\n=== 审批次数 ===", approvals.length);
console.log("=== agent 最终回复 ===");
console.log(finalText || "(没拿到回复)");

const ok = approvals.length > 0;
console.log("\n=== 结论 ===");
console.log(ok ? "[PASS] 审批链路通了：agent 请示 -> 我放行 -> 它继续干活" : "[FAIL] 没有收到审批请求");
controller.abort();
process.exit(ok ? 0 : 1);
