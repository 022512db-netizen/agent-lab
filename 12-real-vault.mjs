// 实验 12：把「我的知识」接上真正的知识库
//
// 背景：最开始 `mcp-my-knowledge/knowledge/` 只是一个 33 行的样例目录。
// 真正的开发知识在 Obsidian 库里（多层目录、60 个文件）。
// 这一步把工具接到真库上，并验证三件事：
//   1) 能递归读到子目录里的内容（原来只扫顶层，会漏掉大部分）
//   2) 子目录里的规则确实被检索到
//   3) 工具新写的内容不会污染真库（写到本地收件箱）
//
// 运行： node 12-real-vault.mjs
import { readFile } from "node:fs/promises";
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
const INBOX = path.join(HERE, "knowledge-inbox.md");

// 给 MCP 服务发两条 JSON-RPC，拿回指定 id 的响应。
function talk(messages, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    let buf = "";
    const out = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {}
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, 8000);
  });
}

const search = (query) => [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "knowledge_search", arguments: { query, limit: 3 } },
  },
];

console.log(`知识库: ${VAULT}\n`);

// 1) 拿一个只存在于子目录里的词去搜
const hit = (await talk(search("longnumber 树形基础资料"), { MY_KNOWLEDGE_DIR: VAULT }))
  .find((m) => m.id === 2)
  ?.result?.content?.[0]?.text ?? "";

console.log("=== 搜索「longnumber 树形基础资料」 ===");
console.log(hit.slice(0, 300) || "(没有结果)");

// 结果里应该带上子目录路径，而不是只有顶层文件名
const fromSubdir = /\d\d-[^/]+\/.*\.md/.test(hit);
console.log(`\n命中的文件来自子目录: ${fromSubdir ? "是" : "否"}`);

// 2) 写一条只在本地收件箱，真库不能出现它
const marker = `写入隔离验证-${Date.now()}`;
await talk(
  [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "knowledge_add", arguments: { title: marker, content: "只应出现在收件箱。" } },
    },
  ],
  { MY_KNOWLEDGE_DIR: VAULT, MY_KNOWLEDGE_ADD_FILE: INBOX },
);

const inboxText = await readFile(INBOX, "utf8").catch(() => "");
const inInbox = inboxText.includes(marker);
console.log(`\n新内容写进了本地收件箱: ${inInbox ? "是" : "否"}`);

// 真库里搜一下这个标记，搜到就是污染了
const polluted = (
  await talk(search(marker), { MY_KNOWLEDGE_DIR: VAULT })
)
  .find((m) => m.id === 2)
  ?.result?.content?.[0]?.text ?? "";
const clean = polluted.includes("没有匹配");

console.log(`真库未被污染: ${clean ? "是" : "否"}`);

const ok = fromSubdir && inInbox && clean;
console.log("\n=== 结论 ===");
console.log(ok ? "[PASS] 已接上真库：能递归读子目录，写入不污染真库" : "[FAIL] 接入有问题");
process.exit(ok ? 0 : 1);
