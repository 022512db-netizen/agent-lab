// 实验 23：历史会话「能看」不等于「能接着聊」
//
// 这个 bug 是走真实界面才撞到的——之前所有测试都走 HTTP 桥或直连内核，
// 全都测不到它。
//
// 现象：点开左边的历史会话，历史正常显示；一发消息就弹
//   {"code":-32600,"message":"thread not found: 01a0c8d9-..."}
// 原始 JSON 直接摔给用户。
//
// 根因：界面的 openThread() 只调了 thread/read（从磁盘读历史），
// 没有调 thread/resume（把会话重新挂进当前内核进程）。
// 两个调用名字很像，职责完全不同：
//   thread/read    = 只读历史。会话在磁盘上，读完界面就有内容了。
//   thread/resume  = 把它变成「活会话」。只有活会话才能收新消息。
//
// 为什么平时看不出来：App 不重启的话，之前的会话一直在当前进程的活会话表里，
// thread/read 之后直接发消息也能通。**只有 App 重启过、会话已经不在活表里时，
// 这个洞才露出来。** 这也解释了为什么它藏了这么久。
//
// 这个脚本把上面那段契约固定下来：在一个全新的内核进程里，
// 拿一个磁盘上已有的会话，先证明「只 read 就发消息」会失败，
// 再证明「resume 之后就能发」。
//
// 运行：先起一次 App（它会产生历史会话），再 node 23-thread-resume.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { findCodex } from "./lib/platform.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 内核路径交给 lib/platform.mjs 解析。两边产物路径不同（Windows 多一层
// 三元组目录和 .exe），写死一个会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HERE, "codex-home");

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// 起一个全新的内核进程。用同一个 CODEX_HOME，所以它磁盘上能看到历史会话。
function startKernel() {
  const child = spawn(CODEX_BIN, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...loadLocalEnv(), CODEX_HOME },
  });
  let buf = "";
  const waiters = new Map();
  let nextId = 1;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // id + method 同时出现 = 服务端反问（审批），这个实验里直接放行。
      if (msg.id !== undefined && msg.method) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } }) + "\n");
        continue;
      }
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(method + " 超时")), 90000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  return { child, call };
}

// 等一轮 turn 结束（只看结果，不关心过程）
async function runTurn(kernel, threadId, text) {
  await kernel.call("turn/start", {
    threadId,
    input: [{ type: "text", text, textElements: [] }],
  });
  // turn/start 会立刻返回 turn id；这里靠轮询 thread/read 看它是不是跑完了。
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await kernel.call("thread/read", { threadId, includeTurns: true });
    const turns = res.result?.thread?.turns ?? [];
    const last = turns[turns.length - 1];
    if (last?.status && last.status !== "inProgress" && last.status !== "running") return last.status;
  }
  return "(超时)";
}

console.log("=== 准备：起第一个内核，造一个有历史的会话 ===");
const k1 = startKernel();
await k1.call("initialize", { clientInfo: { name: "lab23", title: "lab23", version: "0.1.0" } });
const created = await k1.call("thread/start", {
  cwd: path.resolve(HERE, ".."),
  model: null,
  sandbox: "read-only",
  approvalPolicy: "never",
});
const threadId = created.result?.thread?.id;
check(!!threadId, "造出一个会话: " + threadId);
if (threadId) {
  const status = await runTurn(k1, threadId, "说 ok 就停。");
  check(status === "completed", "这一轮跑完了（" + status + "）");
}
k1.child.kill();
// 等一下，确保会话落盘、旧进程退出
await new Promise((r) => setTimeout(r, 2000));

console.log("\n=== 关键：换一个全新的内核进程（模拟 App 重启过） ===");
const k2 = startKernel();
await k2.call("initialize", { clientInfo: { name: "lab23", title: "lab23", version: "0.1.0" } });

// 第一步：只读历史。这一步应该成功——磁盘上有。
const read = await k2.call("thread/read", { threadId, includeTurns: true });
const turnsRead = read.result?.thread?.turns?.length ?? 0;
check(turnsRead > 0, "只调 thread/read 就能读到历史（" + turnsRead + " 轮）");
console.log("  ——注意：这里界面看起来一切正常，正是 bug 藏身之处——");

// 第二步：在读完之后直接发消息。这应该失败，因为会话不是「活」的。
const beforeResume = await k2.call("turn/start", {
  threadId,
  input: [{ type: "text", text: "说 ok。", textElements: [] }],
});
const beforeErr = beforeResume.error?.message ?? "";
console.log("  直接发消息的结果: " + (beforeErr || "居然成功了"));
check(/thread not found/i.test(beforeErr), "只 read 不 resume 时，发消息会被内核拒绝（thread not found）");

// 第三步：resume。这才是把会话重新挂进当前进程的那一步。
const resumed = await k2.call("thread/resume", { threadId });
check(!resumed.error, "thread/resume 成功" + (resumed.error ? "：" + resumed.error.message : ""));

// 第四步：resume 之后再发消息，应该能通。
const after = await k2.call("turn/start", {
  threadId,
  input: [{ type: "text", text: "说 ok 就停。", textElements: [] }],
});
check(!after.error, "resume 之后就能接着聊了" + (after.error ? "：" + after.error.message : ""));
k2.child.kill();

console.log("\n=== 结论 ===");
if (failed === 0) {
  console.log("[PASS] 契约成立：thread/read 只读历史，thread/resume 才让会话能继续");
  console.log("       所以界面的 openThread() 必须先 resume 再 read——这一条别再省。");
} else {
  console.log(`[FAIL] ${failed} 项未通过`);
}
process.exit(failed === 0 ? 0 : 1);
