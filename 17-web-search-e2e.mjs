// 实验 17：端到端联网——界面问一句有时效性的问题，模型真的上网查了
//
// 实验 16 验证的是「工具在了、服务能搜」。但工具存在不等于模型会用。
// 这个脚本走完整链路（App 桥 -> 内核 -> 模型 -> my_web_search），
// 检查三件事：
//   1) 模型确实调用了 web_search，而不是绕开它说「我没法联网」；
//   2) 没有再出现 `unsupported custom tool call: web_search` 这个老报错；
//   3) 最终的答复里带了引用链接。
//
// 运行：先起 App（node start.mjs），再 node 17-web-search-e2e.mjs
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

// 问题刻意选了「靠记忆答会明显不准」的类型：今天有什么发布。
const QUESTION =
  process.env.QUESTION ??
  "请上网查一下 OpenAI 的 Codex 开源仓库（github.com/openai/codex）最近有什么更新，用中文两句话总结，并附上你查到的来源链接。";

console.log(`App: ${BASE}`);
const info = await (await fetch(`${BASE}/api/info`)).json();
console.log(`服务状态: ready=${info.ready}`);

const events = [];
const es = await fetch(`${BASE}/api/events`);
const reader = es.body.getReader();
const dec = new TextDecoder();
let resolveDone;
const done = new Promise((r) => (resolveDone = r));

(async () => {
  let buf = "";
  for (;;) {
    // read() 会抛：连接被底层空闲超时掐断（BodyTimeoutError）或别的网络错误。
    // 不接住的话它是个未处理的 Promise 拒绝，直接崩掉整个脚本——
    // 实测就是这样：搜了 7 次之后连接被掐，日志里只剩一段栈，结论一个字都没有。
    // 事件流断了不代表这次观察白做：已经收到的事件还在 events 里，
    // 所以这里安静退出循环，把结论留给下面正常报。
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      console.log(`\n[注意] 事件流中断：${err?.message ?? err}`);
      console.log("       已收到的事件仍可用于结论。");
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
      let msg;
      try {
        msg = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      events.push(msg);
      const item = msg.params?.item;
      if (msg.method === "item/completed" && item?.type === "mcpToolCall") {
        console.log(`  工具调用 | ${item.server}.${item.tool}  ${JSON.stringify(item.arguments ?? {}).slice(0, 120)}`);
      }
      if (msg.method === "turn/completed") resolveDone(msg);
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
console.log(`新会话: ${threadId}\n`);
console.log(`>> 提问：${QUESTION}\n`);

await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: QUESTION, textElements: [] }],
});

// 上限调过一次 180s -> 420s，而且不再让超时直接抛异常。
// 旧写法两个毛病撞在一起：一是 180 秒对「搜两次再总结」本来就紧，
// 二是超时直接抛到顶层，脚本崩掉，连结论都不打印——看日志只知道崩了，
// 不知道搜到没有。实测就是这么一次（搜了 2 次，180s 没等到收尾）。
// 超时只是个观察结果，应该走结论阶段分开报，而不是绷断整个脚本。
let turnCompleted = null;
try {
  turnCompleted = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error("超时（420 秒）")), 420000)),
  ]);
} catch (err) {
  console.log(`\n[注意] ${err?.message ?? err}`);
}
// 取消要包起来：流还被 reader 占用（locked）时 cancel() 会抛 ERR_INVALID_STATE。
// 实测：这一行让一个「结论已经正常打印完」的运行在最后一步崩掉，退出码也乱了。
// 收尾动作失败不该盖掉上面刚拿到的结论。
await es.body.cancel?.().catch?.(() => {});

const calls = events
  .filter((e) => e.method === "item/completed" && e.params?.item?.type === "mcpToolCall")
  .map((e) => e.params.item);
const webCalls = calls.filter((c) => c.server === "my_web_search" && c.tool === "web_search");

const raw = JSON.stringify(events);
const unsupported = raw.includes("unsupported custom tool call");

// 搜索后端自己被限流时，这不是 App 的问题，也不该报成「联网坏了」。
// 证据来自工具自己的回复（它会明确写 429 / 限流），不是我们猜的。
// 判定要看**工具返回的内容**（item.result），不是只看它收到的参数。
// 踩过：先前只读了 arguments，
// 而 `raw` 里同时包含请求参数和返回结果，搜了个「rate limit 相关词会不会出现在别处」，
// 于是把一次**成功**的搜索（真拿到了 Releases 和版本号）误报成「被限流」。
// 现在只看 call.result.content 的文本，这是工具真正返回给模型的东西。
const toolText = calls
  .map((c) => c.result?.content?.map((x) => x.text ?? "").join("\n") ?? "")
  .join("\n");
// 两个信号：真的报限流，以及真的搜到了东西。后者优先——搜到就不算被挡。
const rateLimited = /429|限流|rate.?limit/i.test(toolText);
const searchWorked = /搜索「.*」的结果/.test(toolText);

const finalText = events
  .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
  .map((e) => e.params.item.text ?? "")
  .join("\n");

console.log(`\n=== 结论 ===`);
console.log(`状态: ${turnCompleted?.params?.turn?.status ?? "未知（超时未收尾）"}`);
console.log(`工具调用: ${calls.length} 次（其中联网 ${webCalls.length} 次）`);
console.log(`最终回复:\n${finalText.slice(0, 600)}`);

// 把过程存下来，方便事后核对（不写进任何知识库）。
const audit = path.join(HERE, ".web-search-audit.json");
await writeFile(
  audit,
  JSON.stringify({ question: QUESTION, calls: calls.map((c) => ({ server: c.server, tool: c.tool, args: c.arguments })), finalText }, null, 2),
  "utf8",
);

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// 注意这里要用可选链：超时那一支 turnCompleted 是 null，直接读 .params 会抛，
// 把「超时未收尾」变成一次崩溃。踩过一次。
check(turnCompleted?.params?.turn?.status === "completed", "这一轮正常跑完");
check(webCalls.length > 0, "模型主动调用了联网搜索（不是绕开它硬答）");
check(!unsupported, "没有再出现 unsupported custom tool call: web_search");
check(/https?:\/\/\S+/.test(finalText), "答复里带了来源链接");
// 被自己的上限掐断时要说清楚：是在搜但没收尾，还是根本没搜。
// 以前超时直接崩，连这几行都不打，看日志只能看到一行 Error。
const timedOut = turnCompleted === null;
if (timedOut) {
  console.log(`\n[注意] 脚本等到 420 秒先收手。已经发生的联网调用 ${webCalls.length} 次，`);
  console.log("       这一条因此不能当结论——要么调大上限重跑，要么只看联网本身通不通。");
}
console.log(`\n过程记录: ${audit}`);
// 三种结论分开报。以前只有 PASS/FAIL，于是「搜索后端被限流」也被归成「联网坏了」，
// 而它其实是外部服务的临时状态，重跑或等一会儿就好。
// 注意：真问题（unsupported 工具）仍然必须报 FAIL，不能被这类降级掩盖。
if (failed === 0) {
  console.log("[PASS] 端到端联网可用");
} else if (rateLimited && !unsupported && webCalls.length > 0) {
} else if (searchWorked && !unsupported) {
  // 搜到了、但这一轮没在时限内收尾（比如模型转去逐页核对原文）。
  // 这不能报「联网坏了」——联网恰恰是通的；它只是没按时收尾。
  console.log("[BLOCKED] 联网通了（工具确实返回了结果），但这一轮没在时限内收尾。");
  console.log("  -> 前半段（搜得到）已经验到；没验到的是「模型按时收尾并给出链接」。");
} else if (rateLimited && !unsupported && webCalls.length > 0) {
  console.log("[BLOCKED] 搜索没成（后端被限流或返回不可用内容）。");
  console.log("  -> 这是外部服务的临时状态，不是 App 的问题；过一会儿重跑。");
} else {
  console.log(`[FAIL] ${failed} 项未通过`);
}
process.exit(failed === 0 ? 0 : 1);
