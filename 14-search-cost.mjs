// 实验 14：搜索工具自己有毛病——一次查询吐回几十 KB
//
// 背景：实验 13 的账单显示，模型搜不到答案时会换词重搜，上下文从 15K 涨到 75K。
// 查下去发现根子不在模型，在工具本身：
//   1. 段落只要有任意一个词命中就返回，**整段 Markdown 原样回传**（一次 40 KB）
//   2. 常见词（Agent、Lab）和稀有词（longnumber）一样算 1 分，排斥力为零
//   3. 搜不到答案时也没有区分度，模型只能不停换词
//
// 这个脚本量修完之后的两件事：一次查询最多吐多少字节，以及排序有没有变准。
// 运行：node 14-search-cost.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "mcp-my-knowledge", "server.mjs");
// 知识库在用户目录下，用 os.homedir() 拼——两个系统同一句就能用。
const VAULT =
  process.env.AGENT_KNOWLEDGE_DIR ??
  path.join(os.homedir(), "Documents/Codex/CodexMemoryVault");

// 一次查询来回要多久、吐回多少字节——这正是会被复制进下一圈上下文的东西。
function run(query, limit) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, MY_KNOWLEDGE_DIR: VAULT },
    });
    let buf = "";
    let out = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) out = msg.result?.content?.[0]?.text ?? "";
        } catch {}
      }
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "knowledge_search", arguments: { query, limit } } }) + "\n",
    );
    setTimeout(() => {
      child.kill();
      resolve(out ?? "");
    }, 8000);
  });
}

const cases = [
  // 一个真正有答案的问题
  { q: "苍穹开发 select 漏字段 报错", expect: /不存在名为|PlainObject/ },
  // 一个库里明显没有、但含有一堆常见词的问题（旧版会吐一大堆沾边段落）
  { q: "Agent Lab 新建实验脚本 命名要求", expect: null },
];

let maxBytes = 0;
console.log(`知识库: ${VAULT}\n`);

for (const c of cases) {
  const t0 = Date.now();
  const text = await run(c.q, 10);
  const bytes = Buffer.byteLength(text, "utf8");
  maxBytes = Math.max(maxBytes, bytes);
  console.log(`=== 查询「${c.q}」 ===`);
  console.log(`返回 ${bytes} B（${text.length} 字），耗时 ${Date.now() - t0}ms`);
  console.log(text.slice(0, 200).replace(/\n/g, " ") + (text.length > 200 ? "…" : ""));
  if (c.expect) console.log(`命中预期内容: ${c.expect.test(text) ? "是" : "否"}`);
  console.log();
}

// 单条结果截断上限 600 字，10 条最多 6KB 左右；留一点余量给序号和文件名。
const CAP = 12 * 1024;
const withinCap = maxBytes < CAP;
console.log("=== 结论 ===");
console.log(`单次查询最大返回: ${maxBytes} B（上限 ${CAP} B）`);
console.log(`不再随笔记长度爆量: ${withinCap ? "是" : "否"}`);

console.log(withinCap ? "[PASS] 搜索返回被压住了，不再把整篇笔记灌进上下文" : "[FAIL] 返回体积仍然失控");
process.exit(withinCap ? 0 : 1);
