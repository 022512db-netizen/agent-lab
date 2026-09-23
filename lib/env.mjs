// 读本机密钥（.env）。App 和各个实验脚本共用这一份逻辑。
//
// 为什么单独抽出来：密钥从 codex-home/config.toml 挪到 .env 之后，
// 所有**直连内核**的脚本（不走 App 桥的那批）就断了——它们读不到 .env，
// 内核于是报 `Missing environment variable: AGENT_LAB_API_KEY`。
// 这是那次改密钥引起的真实回归：07、09、10 三个实验同时变红。
//
// 教训：把「配置」从一个地方挪到另一个地方，要顺手查一遍**谁也在读它**。
// 只改主路径（App）而漏掉旁路（实验脚本），就会留下一串看起来毫不相关的红灯。
//
// 用发： import { loadLocalEnv } from "./lib/env.mjs";
//        env: { ...process.env, ...loadLocalEnv() }
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本文件在 agent-lab/lib/ 下，往上一级就是 agent-lab 根。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 读 agent-lab/.env，返回一个对象（不覆盖已存在的环境变量）。
 * 文件不存在就返回空对象——没配密钥时由内核自己报错，不必在这里拦。
 */
export function loadLocalEnv() {
  const out = {};
  const file = path.join(ROOT, ".env");
  try {
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      const eq = text.indexOf("=");
      if (eq < 1) continue;
      const key = text.slice(0, eq).trim();
      let value = text.slice(eq + 1).trim();
      // 值可能带引号，去掉包着的引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // 已存在的环境变量优先，方便临时覆盖
      if (!process.env[key]) out[key] = value;
    }
  } catch {
    // 读不了就当没有：不该因为一个可选的密钥文件让脚本崩掉。
  }
  return out;
}
