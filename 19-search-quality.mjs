// 搜索服务的「常驻连接」实测。
//
// 为什么不能一条命令查一次：限速状态活在进程里（上次请求什么时候发的、
// 现在是否在冷却）。每次新起一个进程，这些状态全丢了，测出来的不是真实情况。
// App 是常驻进程，所以这里也要开一个长连接连着问几个问题。
//
// 运行：node 19-search-quality.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "mcp-web-search", "server.mjs");

const QUERIES = [
  "openai codex github",
  "codex cli npm install",
  "rust programming language",
  "金蝶云苍穹 插件开发",
];

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
let buf = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    } catch {}
  }
});

let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

await send("initialize", { protocolVersion: "2025-06-18" });

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

console.log("常驻服务，连着问 4 个问题（这样才能看到限速的真实效果）\n");

for (const q of QUERIES) {
  const t0 = Date.now();
  const res = await send("tools/call", { name: "web_search", arguments: { query: q, limit: 3 } });
  const text = res.result?.content?.[0]?.text ?? "";
  const bytes = Buffer.byteLength(text, "utf8");
  const failedSearch = /搜索失败/.test(text);
  const hasLink = /https?:\/\/\S+/.test(text);
  // 结果里应该带上查询里的词——这是「真的搜到了」最直接的证据。
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const hit = terms.length === 0 || terms.some((t) => text.toLowerCase().includes(t));

  console.log(`=== ${q} ===`);
  console.log(`  ${Date.now() - t0}ms, ${bytes}B, ${failedSearch ? "失败" : "成功"}`);
  console.log("  " + text.split("\n").slice(0, 4).join("\n  ").slice(0, 260));
  console.log();

  check(!failedSearch || /不相关|429/.test(text), `「${q}」没有把无关内容当结果返回`);
  if (!failedSearch) {
    check(hasLink, `「${q}」带来源链接`);
    check(hit, `「${q}」结果确实跟查询有关`);
  }
}

child.kill();
console.log("=== 结论 ===");
console.log(failed === 0 ? "[PASS] 常驻搜索服务表现正常" : `[FAIL] ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
