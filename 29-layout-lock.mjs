// 实验 29：侧边栏不跟着对话滚——布局锁定的回归检查
//
// 背景：body 原来没锁 height，侧边栏会话一多就把整页撑高，
// 左栏跟着对话一起滚，.stream / .threads 的 overflow-y: auto 也不生效。
// 修法是三层各锁一层：body height:100vh + overflow:hidden；
// .main / .rail min-height:0（grid 子项默认 auto，不锁会撑破父级）。
//
// 这个脚本查的是「约束是否还在」：六条布局规则任何一条被改掉都会红。
// 它不连浏览器、不连内核，纯读 CSS，秒级出结果——适合随手跑。
//
// 运行：node 29-layout-lock.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = await readFile(path.join(HERE, "app/public/style.css"), "utf8");

// 每条正则对应一处锁定；正则允许属性顺序变化，所以用 [^}]* 松散匹配整块。
const checks = [
  [/body\s*\{[^}]*height:\s*100vh/, "body 锁定视口高度（height: 100vh）——整页不许滚的前提"],
  [/body\s*\{[^}]*overflow:\s*hidden/, "body 禁止整页滚动（overflow: hidden）"],
  [/\.main\s*\{[^}]*min-height:\s*0/, ".main 锁 min-height（grid 子项默认 auto，会撑破父级）"],
  [/\.rail\s*\{[^}]*min-height:\s*0/, ".rail 锁 min-height（同上，会话列表一侧）"],
  [/\.threads\s*\{[^}]*overflow-y:\s*auto/, ".threads 自己滚（会话列表内部滚动）"],
  [/\.stream\s*\{[^}]*overflow-y:\s*auto/, ".stream 自己滚（对话区内部滚动）"],
];

let bad = 0;
for (const [re, label] of checks) {
  const ok = re.test(css);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) bad++;
}

console.log("\n=== 结论 ===");
if (bad === 0) {
  console.log("[PASS] 布局约束全部在位：侧边栏与对话区各自内部滚动");
  console.log("  想肉眼确认：整页无滚动条；左栏里滚只有列表动；对话区滚只有对话动。");
} else {
  console.log(`[FAIL] ${bad} 项约束丢失——侧边栏会重新跟着整页滚。对照 README「侧边栏不跟着对话滚」恢复。`);
}
process.exit(bad === 0 ? 0 : 1);
