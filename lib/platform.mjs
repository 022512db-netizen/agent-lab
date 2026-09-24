// 两系统通用的小工具：找 Python、找技能目录。
//
// 为什么要有这个文件：实验脚本原来各写各的，踩到的都是同一类坑——
//
//   1. Python 的名字两边不一样。macOS 从 12 起就**不自带 `python`**，只有
//      `python3`（Apple 明确不再提供 python 别名）；这台 Windows 机器反过来，
//      只有 `python`，`python3` 是个会弹应用商店的占位程序。
//      写死哪个都会在另一个系统上断，而且是「命令找不到」这种硬断。
//
//   2. 技能目录不能靠 USERPROFILE。macOS 上根本没有这个变量，
//      拼出来的路径会变成一个奇怪的相对目录。两个系统都用 os.homedir()。
//
// 这两条都不是猜的：写 26 号实验时在 Windows 上跑，`python` 通了、
// `python3` 不存在；而 macOS 的情况是平台既有事实。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// 本文件位于 agent-lab/lib/ 下；推导出 agent-lab 根目录，供「仓库内技能副本」候选用。
// 不能用 process.cwd()：实验脚本可能从任何目录跑（实测从上级目录跑就会解析错）。
const LAB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 找一个真能跑的 Python。顺序刻意是「先试本平台常见名」：
// 两个都试是必要的，不能只挑一个——哪边缺另一个都可能补上。
const CANDIDATES = ["python3", "python"];

let cached = null;

export async function findPython() {
  if (process.env.COSMIC_PYTHON) return process.env.COSMIC_PYTHON;
  if (cached) return cached;
  for (const cmd of CANDIDATES) {
    try {
      // --version 只是探活；能跑起来就算找到，不看它输出什么。
      await run(cmd, ["--version"], { timeout: 15000 });
      cached = cmd;
      return cmd;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

// 技能目录按优先级找：仓库里链接的那份（App 实际用的）优先，
// 其次是全局 ~/.codex/skills——不然在 Mac 上首次运行会找不到技能。
export function findSkillDir(name, explicit) {
  const list = [
    explicit,
    path.join(LAB_ROOT, "codex-home/skills", name),
    path.join(os.homedir(), ".codex", "skills", name),
  ].filter(Boolean);
  return list.find((p) => existsSync(path.join(p, "SKILL.md"))) ?? list[list.length - 1];
}

// 找内核（codex 可执行文件）。
//
// 这一步在 Mac 上是必需品：自编译那份内核在 Windows 有自己的 target 目录
// （还多一层三元组目录和 .exe 后缀），macOS 上是另一个；写死哪个，
// 另一个系统就直接 ENOENT。实测：6 个直连内核的实验脚本都写死了 Windows 路径，
// 换到 Mac 会全体挂掉。这里根据平台拼路径 + 检查存在性，最后回退到 PATH 里的 codex。
export function findCodex(explicit) {
  if (explicit) return explicit;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  // NOTE: 两边放源码的位置本来就不同（这台机器在 C:\dev，不是用户目录下），
  // 所以两个候选都要试，不能假设它们同构。这个和 start.mjs 里那份保持一致。
  const devCandidates =
    process.platform === "win32"
      ? [
          "C:/dev/codex/codex-rs/target/x86_64-pc-windows-gnu/debug/codex.exe",
          path.join(os.homedir(), "dev/codex/codex-rs/target/x86_64-pc-windows-gnu/debug/codex.exe"),
        ]
      : [path.join(os.homedir(), "dev/codex/codex-rs/target/debug/codex")];
  const found = devCandidates.find((p) => existsSync(p));
  if (found) return found;

  // 再扫一遍已知安装位置。为什么必须有这一步：从桌面双击 .command 时跑的是
  // 非登录 shell，PATH 里根本没有 codex（实测 macOS 上直接 spawn("codex") =>
  // ENOENT 崩溃）；而用户明明装了，只是不在 PATH 里。
  const installed = (process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? "", "npm", "codex.cmd"),
        path.join(os.homedir(), "AppData", "Roaming", "npm", "codex.cmd"),
      ]
    : [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        path.join(os.homedir(), ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        path.join(os.homedir(), ".npm-global", "bin", "codex"),
      ]
  ).find((p) => p && existsSync(p));
  if (installed) return installed;

  // 最后才交给 PATH 解析（macOS: brew install codex / npm i -g @openai/codex）。
  return "codex";
}
