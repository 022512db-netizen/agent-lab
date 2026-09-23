// 实验 22：密钥不进版本库，而且启动时真的读得到
//
// 背景：这个项目原来的写法是把 API token 明文写在 codex-home/config.toml 里。
// 两个问题：
//   1. 那个目录是要进版本库的，明文密钥一旦 commit 就等于公开；
//   2. 内核自己就把 experimental_bearer_token 标成「不推荐，请用 env_key」。
//
// 改法：配置里只留 env_key = "AGENT_LAB_API_KEY"（一个变量名），
// 真值放被 .gitignore 排除的 .env，启动时注入子进程环境。
//
// 这个脚本不打印任何密钥内容，只检查「该有的约束在不在」。
//
// 运行： node 22-secret-hygiene.mjs
import { readFile, access } from "node:fs/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// 一眼判断某段文本里有没有「像密钥」的东西。
// 只用于判定，绝不打印命中的内容。
const SECRET_SHAPE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;

console.log("=== 一、配置文件里不该有明文密钥 ===");
for (const rel of ["codex-home/config.toml", ".env.example", "start.mjs", "app/server.mjs"]) {
  const p = path.join(HERE, rel);
  let text = "";
  try {
    text = await readFile(p, "utf8");
  } catch {
    continue; // 文件不在就跳过（比如 .env.example 被删掉）
  }
  const hasSecret = SECRET_SHAPE.test(text);
  check(!hasSecret, `${rel} 里没有明文密钥`);
}

console.log("\n=== 二、配置该用 env_key 而不是内联 token ===");
try {
  const cfg = await readFile(path.join(HERE, "codex-home", "config.toml"), "utf8");
  check(/^\s*env_key\s*=\s*"[A-Z_][A-Z0-9_]*"\s*$/m.test(cfg), "配置里声明了 env_key（指向一个环境变量名）");
  check(!/^\s*experimental_bearer_token\s*=/m.test(cfg), "配置里没有 experimental_bearer_token（内核说它不推荐）");
} catch (err) {
  check(false, `读不到配置：${err?.message ?? err}`);
}

// 这段不再扒 .gitignore 的文本，而是丢给 git 本人去判。
// 原因：规则写对了不等于生效。gitignore 有条硬规矩——父目录被整个排除时，
// 子文件的 ! 否定规则会被无视。文本匹配看不出这个差别，问 git 才看得出来。
//
// 另一个坑：agent-lab 自己**不是** git 仓库（在仓库外），所以不能直接在本目录跑
// git check-ignore——它会以 128 退出，如果当成「没被忽略」就正好判反。
// 所以先在临时目录 git init，把这份 .gitignore 和同名空文件放进去，再问。
const ignoreText = await readFile(path.join(HERE, ".gitignore"), "utf8").catch(() => null);
const probe = await mkdtemp(path.join(os.tmpdir(), "agent-lab-ignore-"));
try {
  if (ignoreText) {
    await writeFile(path.join(probe, ".gitignore"), ignoreText);
    await run("git", ["init", "-q", "."], { cwd: probe });
  }
} catch {
  /* git 不可用也不该让这一节崩掉 */
}

async function gitIgnored(rel) {
  if (!ignoreText) return null; // 没有 .gitignore，交给调用方报错
  // 把路径的父目录先建出来。为什么必要：`.edge-profile/` 这种带尾斜杠的规则
  // 只对**目录**生效，而 git 只能看磁盘上真实存在的条目来判断这到底是目录还是文件。
  // 不建的话它当成普通路径，判定变成「没被忽略」——实测就这么误红过一次。
  // 把路径本身当一个目录建出来。
  // 为什么必要：`.edge-profile/` 这种带尾斜杠的规则只对**目录**生效，而 git 只能
  // 看磁盘上真实存在的条目来判断这到底是目录还是文件。不建的话它当成普通路径，
  // 判定会变成「没被忽略」——实测误红过两次：第一次父目录没建，第二次只建了父目录。
  // 把叶子也建成目录是安全的：目录同样会命中 `.env` 这类普通路径规则。
  await mkdir(path.join(probe, rel), { recursive: true }).catch(() => {});
  try {
    await run("git", ["check-ignore", "-q", "--no-index", rel], { cwd: probe });
    return true; // 退出码 0 = 被忽略
  } catch (err) {
    if (err?.code === 1) return false; // 退出码 1 = 没被忽略，这是正常结果
    return null; // 其它退出码 = git 本身出问题了
  }
}

console.log("\n=== 三、.gitignore 要挡住密钥和运行数据（问 git 本人）===");
for (const [rel, why] of [
  [".env", "本机密钥"],
  ["codex-home/sessions", "会话记录，属于运行数据"],
  ["codex-home/logs_2.sqlite", "日志库，很大"],
  [".edge-profile", "546M 浏览器 profile"],
]) {
  const ignored = await gitIgnored(rel);
  if (ignored === null) check(false, `无法判断 ${rel}（git 不可用）`);
  else check(ignored, `${rel} 被挡住（${why}）`);
}

// 反过来的那半边同样重要：配置必须**能**进版本库。
// 全挡住曾造成真问题：新机器 clone 下来没有配置，内核静默退回默认值，
// 表现是「模型一句话都不回」，排查方向会完全跑偏。
for (const [rel, why] of [
  ["codex-home/config.toml", "内核配置（模型、工具挂载、env_key）"],
  ["codex-home/model-catalogs/relay-mu96ubev.json", "模型元数据，缺了会悄悄退回默认值"],
]) {
  const ignored = await gitIgnored(rel);
  // 注意 null 要单独报错：直接取反会让「git 没跑起来」静默变成 PASS。
  if (ignored === null) check(false, `无法判断 ${rel}（git 不可用）`);
  else check(!ignored, `${rel} 没有被挡（${why}）`);
}

// probe 要用完（两轮检查都过了）才能拆。
await rm(probe, { recursive: true, force: true }).catch(() => {});


console.log("\n=== 四、.env 在、可读，而 .env.example 不含真值 ===");
let envText = "";
try {
  envText = await readFile(path.join(HERE, ".env"), "utf8");
  await access(path.join(HERE, ".env"));
  check(/^\s*AGENT_LAB_API_KEY\s*=/m.test(envText), ".env 里有 AGENT_LAB_API_KEY");
} catch {
  // 没 .env 也可能是「用环境变量传的」，不算硬失败——但要说清楚。
  console.log("  （没有 .env；如果靠环境变量传密钥这是正常的）");
}

// ---------- 五、真正要紧的一条：启动链路上密钥到得了内核 ----------
// 前面四条都只是「文件写对了」。密钥真正的考验是「不报认证错也能跑通一轮」。
console.log("\n=== 五、端到端：拿 .env 里的密钥能不能跑通一轮 ===");
const rpc = async (method, params) => {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return res.json();
};

const events = [];
const approved = [];
let es;
try {
  es = await fetch(`${BASE}/api/events`);
} catch {
  check(false, `连不上 App（${BASE}）——先 node start.mjs`);
  console.log("\n=== 结论 ===");
  console.log(`[FAIL] ${failed} 项未通过`);
  process.exit(1);
}
const reader = es.body.getReader();
const dec = new TextDecoder();
let resolveDone;
const done = new Promise((r) => (resolveDone = r));
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
      if (msg.__isServerRequest && !approved.includes(msg.id)) {
        approved.push(msg.id);
        fetch(BASE + "/api/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: msg.id, decision: "accept" }),
        }).catch(() => {});
      }
      if (msg.method === "turn/completed") resolveDone(msg);
    }
  }
})();

const started = await rpc("thread/start", {
  cwd: null,
  model: null,
  sandbox: "read-only",
  approvalPolicy: "never",
});
check(!!started.result?.thread?.id, "能建会话");

await rpc("turn/start", {
  threadId: started.result.thread.id,
  input: [{ type: "text", text: "说 ok 就停。", textElements: [] }],
});

let turn = null;
try {
  turn = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error("超时（90 秒）")), 90000)),
  ]);
} catch (err) {
  console.log(`  这一轮没跑完：${err?.message ?? err}`);
}
try {
  await es.body.cancel();
} catch {}

const raw = JSON.stringify(events);
const authError = /401|unauthor|invalid.*api.?key|missing.*api.?key|EnvVar/i.test(raw);
const answer = events
  .filter((e) => e.method === "item/completed" && e.params?.item?.type === "agentMessage")
  .map((e) => e.params.item.text ?? "")
  .join("\n");

check(turn?.params?.turn?.status === "completed", "这一轮正常跑完");
check(!authError, "没有任何认证类错误（说明密钥确实送到了内核）");
check(answer.length > 0, "模型给出了回复");

console.log("\n=== 结论 ===");
console.log(failed === 0 ? "[PASS] 密钥不进版本库，而且启动链路读得到" : `[FAIL] ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
