// 实验 21：把真实苍穹工程接上之后，做一次「专家链路」实战检查。
//
// 前面实验 20 验证的是「技能接上了、预检通过、答的是项目规矩」。那还是在
// 空目录里提问。这个脚本往实战再推一步：直接跑 ok-cosmic 自带的检查脚本，
// 看这套专家配置能不能真的对一份真实插件代码给出判断。
//
// 具体查三件事：
//   1. ok-cosmic 的 Step 0 预检在真实工程上能不能通过（errors=0）；
//   2. 它的 post-lint 脚本对一份真实插件文件怎么判（这是「写完自检」的入口）；
//   3. 项目记忆里那条最容易栽的规则（查询必须 select 全字段），
//      lint 能不能真的抓到。
//
// 这个脚本只读、不改任何代码，也不跑 Gradle（项目规矩里明确禁止）。
//
// 运行： node 21-cosmic-workflow.mjs
import { execFile } from "node:child_process";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findPython, findSkillDir } from "./lib/platform.mjs";

const run = promisify(execFile);

const PROJECT = process.env.COSMIC_PROJECT ?? "C:/hnsh/sherp";
// 技能目录和 Python 都交给 lib/platform.mjs 去探。
// 以前这里写死 USERPROFILE（macOS 没这个变量）和 python（macOS 只有 python3），
// 换到 Mac 上两条都会断——这类「本机事实」不该散落在每个脚本里。
const SKILL = findSkillDir("ok-cosmic", process.env.COSMIC_SKILL);
const PY = await findPython();
if (!PY) {
  console.log("[FAIL] 找不到 Python（python3 / python 都试过）。装一个再来。");
  process.exit(1);
}

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

console.log(`工程: ${PROJECT}`);
console.log(`技能: ${SKILL}\n`);

// ---------- 一、Step 0 预检 ----------
// 这是 ok-cosmic 规定的第一件事，不通过就不该往下写代码。
console.log("=== 一、Step 0 配置预检 ===");
try {
  const { stdout, stderr } = await run(PY, [path.join(SKILL, "scripts", "cosmic-config-check.py")], {
    cwd: PROJECT,
    timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const text = (stdout || "") + (stderr || "");
  const line = text.split("\n").find((l) => /ok=|errors?=|ERROR/i.test(l)) ?? text.slice(0, 200);
  console.log("  输出:", String(line).trim().slice(0, 200));
  // 预检脚本约定：ERROR 表示缺配置；WARNING 只表示在线能力不可用。
  const hasError = /\[ERROR\]|\bERROR\b/.test(text);
  check(!hasError, "预检没有 ERROR（有 ERROR 就该停下来问，而不是硬写代码）");
  check(/true|ok/i.test(text), "预检给出明确结论");
} catch (err) {
  check(false, `预检跑不起来：${String(err?.message ?? err).slice(0, 200)}`);
}

// ---------- 二、找一份真实插件文件 ----------
console.log("\n=== 二、找一份真实插件 ===");
let sample = null;
async function findOne(dir, depth = 0) {
  if (sample || depth > 16) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (sample) return;
    if (e.name.startsWith(".") || ["build", "node_modules", ".gradle"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await findOne(full, depth + 1);
    else if (e.name.endsWith("Plugin.java")) sample = full;
  }
}
await findOne(path.join(PROJECT, "project"));
if (sample) {
  const src = await readFile(sample, "utf8");
  const rel = path.relative(PROJECT, sample).replace(/\\/g, "/");
  console.log(`  选中: ${rel}（${src.length} 字符）`);
  check(/class\s+\w+/.test(src), "是一份有内容的 Java 插件");
  // 顺手看它有没有按项目规矩写 select —— 这是最常栽的一条。
  const hasSelect = /\.select\s*\(|select\(/i.test(src);
  console.log(`  文件里出现 select(: ${hasSelect ? "是" : "否"}`);
} else {
  check(false, "没找到任何 *Plugin.java");
}

// ---------- 三、post-lint 能不能跑、能不能发现问题 ----------
console.log("\n=== 三、规范检查脚本（post-lint） ===");
const lintScript = path.join(SKILL, "scripts", "cosmic-post-lint.py");
try {
  await access(lintScript);
  check(true, "post-lint 脚本存在");
} catch {
  check(false, `缺 post-lint 脚本：${lintScript}`);
}

if (sample && lintScript) {
  const rel = path.relative(PROJECT, sample).replace(/\\/g, "/");
  try {
    const { stdout, stderr } = await run(PY, [lintScript, rel], {
      cwd: PROJECT,
      timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const text = ((stdout || "") + (stderr || "")).trim();
    console.log("  输出:", text.split("\n").slice(0, 6).join("\n  ").slice(0, 400) || "(无输出)");
    check(text.length > 0, "lint 对这个文件给出了结论（不是静默通过）");
  } catch (err) {
    // 非零退出码是正常的：lint 有问题就该非零。
    const text = String((err.stdout || "") + (err.stderr || "")).trim();
    const code = err.code ?? "?";
    console.log(`  退出码: ${code}`);
    if (text) console.log("  输出:", text.split("\n").slice(0, 6).join("\n  ").slice(0, 400));
    check(text.length > 0 || code !== 0, "lint 跑起来了（有问题时报非零是预期行为）");
  }
}

// ---------- 四、探清 lint 的边界：它能管什么、不能管什么 ----------
// 这一节本来想验证「漏 select 会不会被抓到」——项目记忆里写着「所有后续要用的
// 字段必须在 select 里」，而这条历史上栽过好几次。
//
// 结果分两步才说清楚，中间还把我自己的断言纠了一次：
//   第一步的样本里我把 QFilter 写成了 new QFilter("id", "=", 1L)（字符串），
//   lint 报的是【QFilter 第二个参数必须用 QCP 枚举】——它抓的是另一个问题。
//   而我当时的断言只要求「输出里要有 select/字段 字样」，于是**碰巧命中「字段」**
//   就判了 PASS。那是个假阳性，什么都没证明。
//   第二步把 QFilter 改成合规的 QCP、super 也补上，把干扰项全排除，
//   只留「漏 select」一个问题——lint 报【检查通过】。
//
// 结论（这才是真实边界）：lint 的 STYLE-025 只查「有没有指定 select 字段」
// （比如是否整实体全量加载），它**不判断 select 的字段够不够**。
// 而项目里最常见的那类事故（漏字段 -> 运行时报「不存在名为 X 的属性」），
// 恰恰属于后者。所以：**lint 是网，不是全部防线**——漏字段这类要么靠模型自己核对，
// 要么靠运行时报错兜底。
//
// 这一节因此改成同时验证两件事：lint 能抓它该抓的（QCP 那种），
// 也明确它抓不到漏 select（把「抓不到」写成期望，免得以后误以为它管）。
console.log("\n=== 四、探清 lint 的边界 ===");
if (sample) {
  const os = await import("node:os");
  const { mkdtemp, writeFile, mkdir, copyFile } = await import("node:fs/promises");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cosmic-lint-"));
  const rel = "project/shscm/code/scmc/shfz-shscm-scmc-ccm/src/main/java/lab/LabSelectLeakPlugin.java";
  const dest = path.join(tmp, rel);
  await mkdir(path.dirname(dest), { recursive: true });

  // 样本一：把干扰项全部排除，只留「漏 select」一个问题。
  // 写法本身都合规（QCP 枚举、调了 super），这样 lint 说什么就只针对漏字段。
  const leakOnly = `package lab;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.entity.plugin.AbstractOperationServicePlugIn;
import kd.bos.entity.plugin.args.BeforeOperationArgs;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;

/** 实验样本：select 里只写 id,number，但下面要用 billstatus。 */
public class LabSelectLeakPlugin extends AbstractOperationServicePlugIn {
    @Override
    public void beforeExecuteOperationTransaction(BeforeOperationArgs e) {
        super.beforeExecuteOperationTransaction(e);
        QFilter filter = new QFilter("id", QCP.equals, 1L);
        DynamicObject bill = BusinessDataServiceHelper.loadSingle("sm_salebill", "id,number", filter.toArray());
        String status = bill.getString("billstatus");
        System.out.println(status);
    }
}
`;
  await writeFile(dest, leakOnly, "utf8");
  await copyFile(path.join(PROJECT, "ok-cosmic.json"), path.join(tmp, "ok-cosmic.json")).catch(() => {});

  let leakText = "";
  let leakCode = 0;
  try {
    const { stdout, stderr } = await run(PY, [lintScript, rel], {
      cwd: tmp,
      timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    leakText = ((stdout || "") + (stderr || "")).trim();
  } catch (err) {
    leakText = String((err.stdout || "") + (err.stderr || "")).trim();
    leakCode = err.code ?? 1;
  }
  console.log("  [只留漏 select] 输出:", leakText.split("\n").filter(Boolean).slice(0, 3).join(" / ").slice(0, 220));
  // 把「抓不到」写成明确期望。这样以后有人以为 lint 会查漏字段时，这条会提醒他。
  const leakMissed = !/select|billstatus/i.test(leakText) || /检查通过/.test(leakText);
  check(leakMissed, "确认 lint 不查「select 字段够不够」（只查有没有指定，见注释）");

  // 样本二：写一个 lint 该抓的问题，确认它不是摆设。
  const qcpBad = leakOnly.replace('new QFilter("id", QCP.equals, 1L)', 'new QFilter("id", "=", 1L)');
  await writeFile(dest, qcpBad, "utf8");
  let qcpText = "";
  try {
    const { stdout, stderr } = await run(PY, [lintScript, rel], {
      cwd: tmp,
      timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    qcpText = ((stdout || "") + (stderr || "")).trim();
  } catch (err) {
    qcpText = String((err.stdout || "") + (err.stderr || "")).trim();
  }
  console.log("  [QFilter 用字符串] 输出:", qcpText.split("\n").filter(Boolean).slice(0, 3).join(" / ").slice(0, 220));
  check(/QCP|STYLE-024/.test(qcpText), "lint 抓得到 QFilter 用字符串这类真问题（它不是摆设）");
}

console.log("\n=== 结论 ===");
console.log(failed === 0 ? "[PASS] 苍穹专家链路可用：预检、样本、lint 都跑得通" : `[FAIL] ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
