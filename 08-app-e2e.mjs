// 实验 08：端到端确认 App（HTTP 桥）跑在自编译内核上
// 目的：实验 07 是直接对话内核，绕过了 App。这里走 App 自己的桥，
//       确认「界面 -> server.mjs -> 自编译内核」这条完整链路是通的。
// 运行：先起 App（node start.mjs 或 node app/server.mjs），再 node 08-app-e2e.mjs
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";

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

const log = (...a) => console.log(...a);

log(`App: ${BASE}`);
const info = await (await fetch(`${BASE}/api/info`)).json();
log(`服务状态: ready=${info.ready} cwd=${info.cwd}`);

// 挂上 SSE，把所有事件都收下来
const events = [];
const es = await fetch(`${BASE}/api/events`);
const reader = es.body.getReader();
const dec = new TextDecoder();
let pending = Promise.resolve();

const done = new Promise((resolve) => {
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
        if (msg.method === "lab/innerLoop") {
          log(`  内核探针 | ${String(msg.params?.text ?? "").replace("[AGENT-LAB]", "").trim()}`);
        }
        if (msg.method === "warning") log(`  警告 | ${msg.params?.message}`);
        if (msg.method === "turn/completed") resolve(msg);
      }
    }
  })();
});

// 新会话 + 一个只读任务，不触发审批，只看链路
const started = await rpc("thread/start", {
  cwd: null,
  model: null,
  sandbox: "read-only",
  approvalPolicy: "on-request",
});
const threadId = started.thread.id;
log(`新会话: ${threadId}\n`);

log(">> 发任务：用一句话说明你是谁，然后结束。");
await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: "用一句话说明你是谁，然后结束。", textElements: [] }],
});

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("超时")), 120000));
const turnCompleted = await Promise.race([done, timeout]);
es.body.cancel?.();

const probes = events.filter((e) => e.method === "lab/innerLoop");
const finalText = events
  .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
  .map((e) => e.params.item.text ?? "")
  .join("");

log(`\n=== 结论 ===`);
log(`状态: ${turnCompleted.params?.turn?.status}`);
log(`内核探针条数: ${probes.length}`);
log(`模型最终回复: ${finalText.slice(0, 200)}`);

const pass = probes.length > 0 && turnCompleted.params?.turn?.status === "completed";
log(pass ? "[PASS] App -> 自编译内核 整条链路是通的" : "[FAIL] 链路有问题");
process.exit(pass ? 0 : 1);
