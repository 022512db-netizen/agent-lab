// 桌面启动器的两条硬要求：
//   1) 连点两次启动器，只能有一份服务在跑（第二、三次只开窗口）
//   2) 窗口关掉后，服务自己退出，端口释放
// 用 8899 端口跑，不碰日常在用的 8787。
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8899;
const URL = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info() {
  try {
    const res = await fetch(`${URL}/api/info`, { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForServer(timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const got = await info();
    if (got) return got;
    await sleep(150);
  }
  return null;
}

async function waitForPortFree(timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (!(await info())) return true;
    await sleep(150);
  }
  return false;
}

// 跑一次启动器，等它自己结束，收集它说了什么。
function runLauncher() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "start.mjs")], {
      env: { ...process.env, PORT: String(PORT), AGENT_LAB_NO_WINDOW: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => resolve({ code, out }));
  });
}

// 启动器是常驻进程，用这个版本拿到句柄。
function spawnLauncher() {
  const p = spawn(process.execPath, [path.join(HERE, "start.mjs")], {
    env: { ...process.env, PORT: String(PORT), AGENT_LAB_NO_WINDOW: "1", AGENT_LAB_IDLE_MS: "800" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  return p;
}

function exitIn(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

// 连一次 SSE 再断开，模拟「窗口打开」然后「窗口关掉」。
function connectThenClose() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/events`, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve(true);
      });
    });
    req.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 4000);
  });
}

const started = [];
try {
  // ---- 场景一：已经有服务在跑 ----
  const fake = spawn(process.execPath, [path.join(HERE, "app", "server.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  started.push(fake);

  const first = await waitForServer();
  check(!!first, "先手动起一份服务，端口可用");

  const a = await runLauncher();
  const b = await runLauncher();
  check(/已经在跑/.test(a.out), `启动器发现已有服务就说「已经在跑」（实际: ${a.out.trim().split("\n")[0] || "无输出"}）`);
  check(/已经在跑/.test(b.out), `再点一次还是一样，不会起第二份`);

  const stillSame = await info();
  check(stillSame?.pid === first?.pid, `服务进程没被顶掉（pid ${first?.pid} -> ${stillSame?.pid}）`);

  fake.kill();
  check(await waitForPortFree(), "关掉临时服务后端口释放");

  // ---- 场景二：启动器自己起服务，关窗后退出 ----
  const launcher = spawnLauncher();
  started.push(launcher);

  const booted = await waitForServer();
  check(!!booted, "启动器把服务拉起来了");

  check(await connectThenClose(), "窗口连上过一次");
  const code = await exitIn(launcher, 10000);
  check(code !== null, `窗口关掉后启动器自己退出了（exit=${code}）`);
  check(await waitForPortFree(), "退出后端口也释放了");

  // ---- 场景三：直接跑 server 调试时不该受影响 ----
  const debug = spawn(process.execPath, [path.join(HERE, "app", "server.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  started.push(debug);
  check(!!(await waitForServer()), "直接跑服务仍能用");
  await sleep(1500);
  check(!!(await info()), "没人连它也不会自己退（调试模式）");
  debug.kill();
  await waitForPortFree();
} finally {
  for (const p of started) p.kill();
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
