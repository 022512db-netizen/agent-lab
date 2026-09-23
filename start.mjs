// Agent Lab 桌面启动器
// 作用：启动本地桥，然后用 Edge 的「应用模式」打开一个没有地址栏的独立窗口。
// 这样它看起来就是一个桌面 App，而不是浏览器里的一个网页。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodex } from "./lib/platform.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const URL = `http://127.0.0.1:${PORT}`;
const AGENT_CWD = process.env.AGENT_CWD ?? path.resolve(HERE, "..");
const IS_WIN = process.platform === "win32";

// 内核选择：优先用自己编译的（带探针 + 循环上限），没有就回退到系统装的 codex。
// 想强制指定就设 CODEX_BIN 环境变量，这里不覆盖已有的值。
// 自编译内核的产物路径两边不一样（Windows 那个 target 目录多一层）。
// 这件事交给 lib/platform.mjs 统一处理：那边列了两个平台的候选路径并逐个检查存在性，
// 找不到就回退到 PATH 里的 codex。写死这里一次会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();

// 只有 Chromium 系浏览器才支持 --app= 这种「像原生窗口」的模式，所以候选里只有它们。
// 两个系统分别列常见安装位置；都没有就退化成「打印网址让你自己开」。
const BROWSER_CANDIDATES = IS_WIN
  ? [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ]
  : [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];

function findBrowser() {
  const explicit = process.env.AGENT_LAB_BROWSER;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function openWindow() {
  if (process.env.AGENT_LAB_NO_WINDOW === "1") return; // 自检脚本用，不弹窗
  const browser = findBrowser();
  if (!browser) {
    console.log("没找到 Chromium 系浏览器，请手动打开 " + URL);
    return;
  }
  const win = spawn(
    browser,
    [
      `--app=${URL}`,
      "--window-size=1280,860",
      // 单独的用户数据目录，避免和日常浏览器互相干扰
      `--user-data-dir=${path.join(HERE, ".edge-profile")}`,
    ],
    { stdio: "ignore", detached: true },
  );
  win.unref();
}

// 端口上已经有 Agent Lab 在跑吗？有就只开窗口，不重复起服务。
async function alreadyRunning() {
  try {
    const res = await fetch(`${URL}/api/info`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// 冷启动时服务要加载模块、拉内核，不一定比浏览器快。等它能应答再开窗口，
// 否则窗口会先渲染出一张「无法访问」的页面，要靠人手动刷新。
async function waitUntilReady(timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await alreadyRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  if (await alreadyRunning()) {
    console.log("Agent Lab 已经在跑了，直接开窗口。");
    openWindow();
    return;
  }

  // 关掉窗口后自己退出，别在后台留一份。
  const server = spawn(process.execPath, [path.join(HERE, "app", "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_CWD,
      CODEX_BIN,
      AGENT_LAB_EXIT_WHEN_IDLE: "1",
    },
    stdio: "inherit",
  });

  server.on("exit", (code) => process.exit(code ?? 0));
  waitUntilReady().then((ok) => {
    if (ok) openWindow();
    else console.log("等服务应答超时，请手动打开 " + URL);
  });

  console.log(`Agent Lab 启动中… 工作目录: ${AGENT_CWD}`);
  console.log(`内核: ${CODEX_BIN}`);

  process.on("SIGINT", () => {
    server.kill();
    process.exit(0);
  });
}

main();
