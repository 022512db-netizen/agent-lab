// 实验 26：把会话开在真正的苍穹工程里——「项目选择」这一层到底通不通
//
// 为什么单独有这一课：
// 实验 18 证明技能接上了、模型会用；实验 20 证明指到真工程时链路完整。
// 但这两条都依赖手工用 AGENT_CWD 起一份特殊实例。日常那个窗口一直是开在
// C:\新建文件夹 的，而 ok-cosmic 的 Step 0 预检是从**会话工作目录**逐级往上
// 找 ok-cosmic.json —— 在默认目录里永远找不到，结果是模型只能讲概念、
// 拿不到配置就不会写代码。
//
// 所以界面加了「项目选择」，每个新会话把选中的路径作为 cwd 传给内核。
// 这个脚本验的就是那条路：不走 AGENT_CWD，只按界面同款调用传 cwd。
//
// 判据分两层，一层快一层慢，避免一红就不知道是谁的锅：
//   A. 内核侧：thread/start 传了 cwd 之后，会话真的落在那儿，且自动加载了
//      项目的 AGENTS.md（这是「项目规则跟着会话走」的证据）。
//   B. 技能侧：在那个目录下跑 ok-cosmic 的 Step 0 预检，errors=0
//      （这是「ok-cosmic.json 找得到、在线能力可用」的证据）。
//
// 运行：先起 App（默认实例即可，不用 AGENT_CWD）
//   node start.mjs
//   node 26-cosmic-project.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { findPython, findSkillDir } from "./lib/platform.mjs";

const run = promisify(execFile);
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const PROJECT = process.env.COSMIC_PROJECT ?? "C:/hnsh/sherp";
// 技能目录和 Python 都走共用探测：macOS 上只有 python3，没有 python。
const SKILL = findSkillDir("ok-cosmic", process.env.COSMIC_SKILL);
const PY = await findPython();

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

console.log("=== 前置：App 得先起着 ===");
try {
  const info = await waitReady();
  check(info?.ready === true, `App 已就绪（cwd=${info?.cwd ?? "?"}）`);
} catch (err) {
  check(false, `连不上 App（${BASE}）：${err?.message ?? err} —— 先 node start.mjs`);
  console.log("\n[FAIL] 环境没就绪，后面的检查没意义");
  process.exit(1);
}
// ready 是「内核拉起来了」的意思，刚起服务时它还是 false。
// 这里等一下再判，否则红的是自己的竞态，不是被测的东西。
// 踩过：不加等待时这一项必红，而 A/B 两层其实全过，非常误导。
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
console.log("\n=== A. 内核侧：会话能不能开在苍穹工程里 ===");
console.log(`目标工程: ${PROJECT}`);

let started = null;
try {
  // 这里刻意跟界面用同一条路径：cwd 直接传给 thread/start。
  // 注意没有依赖 AGENT_CWD —— 那个是启动期的默认值，界面不走它。
  started = await rpc("thread/start", {
    cwd: PROJECT,
    model: null,
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
} catch (err) {
  check(false, `thread/start 失败：${err?.message ?? err}`);
}

if (started) {
  const got = String(started.thread?.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const want = PROJECT.replace(/\\/g, "/").replace(/\/+$/, "");
  check(got.toLowerCase() === want.toLowerCase(), `会话工作目录就是苍穹工程（${got}）`);

  // 项目规则是内核自己找的，不是我们注入的。它出现 = 会话确实「进了这个项目」。
  const src = started.instructionSources ?? started.instruction_sources ?? [];
  const hasAgents = src.some((s) => /AGENTS\.md$/i.test(String(s)));
  check(hasAgents, `自动加载了项目的 AGENTS.md（${JSON.stringify(src)}）`);
}

console.log("\n=== B. 技能侧：这个目录下 Step 0 预检能不能过 ===");
console.log(`技能目录: ${SKILL}`);
console.log(`Python: ${PY ?? "（没找到）"}`);

// 没 Python 就是环境问题，直接说清楚，别让它伪装成「预检没通过」。
if (!PY) {
  check(false, "找不到 Python（python3 / python 都试过）——技能脚本跑不起来");
  console.log("\n[FAIL] 环境缺 Python，先装一个（macOS: brew install python）");
  process.exit(1);
}

// 直接跑预检，不经过模型：这一层只验「配置找得到、在线能力可用」，
// 模型行为留给实验 18/20 去验，两边职责分开就不容易互相掩盖。
try {
  const { stdout } = await run(
    PY,
    [path.join(SKILL, "scripts", "cosmic-config-check.py"), "--config", `${PROJECT}/ok-cosmic.json`],
    { cwd: PROJECT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  const out = String(stdout);
  const errorsZero = /errors=0/.test(out);
  const noError = !/\[ERROR\]/.test(out);
  const warnings = (out.match(/errors=(\d+) warnings=(\d+)/) || []).slice(1);
  console.log(out.trim().split("\n").map((l) => "  " + l).join("\n"));
  check(errorsZero && noError, `预检通过（errors=${warnings[0] ?? "?"} warnings=${warnings[1] ?? "?"}）`);
} catch (err) {
  // 脚本非 0 退出时 stdout 挂在 err 上，照样打出来，别把证据吞了。
  const out = String(err?.stdout ?? "");
  if (out) console.log(out.trim().split("\n").map((l) => "  " + l).join("\n"));
  check(false, `预检没通过：${err?.message ?? err}`);
}

console.log("\n=== 结论 ===");
console.log(
  failed === 0
    ? "[PASS] 界面能把会话开进苍穹工程，项目规则和技能配置都能到位"
    : `[FAIL] ${failed} 项未通过`,
);
process.exit(failed === 0 ? 0 : 1);
