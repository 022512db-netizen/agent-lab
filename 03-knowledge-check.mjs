// 实验 03：验证「我自己的知识」有没有真的注入到会话里
// 做法：走本地桥开一个新会话，问一个和知识无关的小问题，
//       看模型回复末尾有没有出现 knowledge.md 里要求的标记 [知识已生效]。
//
// 为什么改成「最多试 3 次」：
// 这个标记是个「知识被注入了」的观察点，但它靠**模型遵守指令**才会出现。
// 实测（2026-09-23，连跑 4 次）：会有一次模型正常回话、却漏掉那行标记。
// 注入本身没坏，是「模型按要求输出」这件事本来就是概率性的。
// 单次判定会把这种抖动报成「知识没有生效」，方向是错的。
//
// 所以判据改成：只要有一次观察到标记就算知识确实注入（并打印它发生在第几次）；
// 三次都跑了、三次都没标记，才算真的没注入。
// 同时把上游瞬时错误单独归为 [BLOCKED]，不混进这个判定。
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:8787";
const ATTEMPTS = Number(process.env.KNOWLEDGE_CHECK_ATTEMPTS ?? 3);

async function rpc(method, params) {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return res.json();
}

// 先挂上事件流（要在发消息之前）。一次订阅覆盖所有尝试，按 threadId 区分。
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

// 跑一次完整问答，返回 { finalText, errText, sawTurnEnd }。
// 无头脚本没人点「允许」：模型偶尔会顺手跑个命令来确认环境，内核会反问审批，
// 没人答就一直在那儿等，看起来也像「知识没生效」。这里只读小问答，直接自动放行。
async function attempt() {
  const started = await rpc("thread/start", { cwd: null, model: null, sandbox: "workspace-write" });
  const threadId = started.result.thread.id;
  console.log("线程:", threadId);

  await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "用一句话说明你是谁，然后结束。", textElements: [] }],
  });

  const handledApprovals = new Set();
  let finalText = "";
  let sawTurnEnd = false;

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    for (const req of events.filter((e) => e.__isServerRequest && !handledApprovals.has(e.id))) {
      handledApprovals.add(req.id);
      console.log(`[自动放行审批] ${req.method}`);
      await fetch(`${BASE}/api/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: req.id, decision: "accept" }),
      }).catch(() => {});
    }
    const done = events.find((e) => e.method === "turn/completed" && e.params?.threadId === threadId);
    if (done) {
      const msgs = events.filter(
        (e) =>
          e.method === "item/completed" &&
          e.params?.threadId === threadId &&
          e.params?.item?.type === "agentMessage",
      );
      finalText = msgs
        .map((m) => m.params.item.text ?? (m.params.item.content ?? []).map((c) => c.text ?? "").join(""))
        .join("\n");
      sawTurnEnd = true;
      break;
    }
  }

  // 这一轮没跑起来时，看看是不是上游的错，别一律报成「知识没生效」。
  // 踩过：本地中转偶尔喷「返回空结果」「未发送 finish-step」这类瞬时错误，
  // 此时根本没产生回复，不代表知识注入有问题。
  const errEvent = events.find(
    (e) => e.method === "error" && (e.params?.threadId === undefined || e.params?.threadId === threadId),
  );
  const errText = errEvent ? JSON.stringify(errEvent.params ?? {}).slice(0, 300) : "";
  return { finalText, errText, sawTurnEnd };
}

let passedAt = 0;
let blocked = 0;

for (let n = 1; n <= ATTEMPTS; n++) {
  console.log(`\n===== 第 ${n}/${ATTEMPTS} 次 =====`);
  const { finalText, errText, sawTurnEnd } = await attempt();

  console.log("\n=== 模型最终回复 ===");
  console.log(finalText || "(没拿到回复)");

  if (finalText.includes("[知识已生效]")) {
    passedAt = n;
    break;
  }
  if (!finalText && errText) {
    blocked++;
    console.log(`[环境问题] 内核报了错，这一轮没跑起来：${errText}`);
    console.log("  -> 上游网关的瞬时错误，不算「知识没生效」。");
    continue;
  }
  if (!finalText && !sawTurnEnd) {
    console.log("[环境问题] 这一轮没结束（超时），不算「知识没生效」。");
    blocked++;
    continue;
  }
  // 到这里是「模型回话但没带标记」——真观察到了，但可能是概率性漏掉，继续试。
  console.log("[观察] 模型回话了，但没带知识标记。可能只是这次没按要求输出，换一轮再验。");
}

console.log("\n=== 结论 ===");
if (passedAt) {
  console.log(`[PASS] 我自己的知识已成功生效（第 ${passedAt} 次观察到标记）`);
  if (passedAt > 1) {
    console.log(
      `  注意：前 ${passedAt - 1} 次模型回话但漏了标记——注入是按概率被遵守的，不是每次都输出。`,
    );
  }
} else if (blocked === ATTEMPTS) {
  console.log("[BLOCKED] 全部是环境问题（上游瞬时错误），这次没验到知识——重跑即可");
} else {
  console.log("[FAIL] 知识没有生效（模型确实回了话，但每次回复里都没有那行标记）");
}

controller.abort();
process.exit(passedAt ? 0 : 1);
