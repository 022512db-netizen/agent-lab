// 实验 16：联网搜索——从「模型想上网」到「真的查到了」
//
// 背景（这是真实踩到的坑，不是假设）：
// 读日志发现模型发起过一次这样的调用：
//   {"type":"custom_tool_call","name":"web_search", ...}
// 结果内核回的是：
//   unsupported custom tool call: web_search
// 也就是说模型想联网，但我们这边一个字都给不出来。
//
// 查下来是两层问题：
//   1) 内核自带一个叫 web_search 的「托管搜索」工具，而「托管」= 由模型服务方搜。
//      本地中转没有这个端点（实测 /v1/alpha/search 返回 404），但工具照样告诉了模型。
//      ——对模型许诺一个兑现不了的工具，比没有这个工具更糟。
//   2) 我们自己也没有联网工具。
//
// 所以修法有两步，这个脚本两步都验证：
//   A. 配置里 web_search = "disabled"，那个空头工具不再出现在工具清单里；
//   B. 自建的 my_web_search 服务出现在工具清单里，而且真的能搜出东西。
//
// 运行： node 16-web-search.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { findCodex } from "./lib/platform.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 内核路径交给 lib/platform.mjs 解析。两边产物路径不同（Windows 多一层
// 三元组目录和 .exe），写死一个会在另一个系统上直接 ENOENT。
const CODEX_BIN = findCodex();
const LAB_HOME = path.join(HERE, "codex-home");
const MY_KNOWLEDGE = path.join(HERE, "mcp-my-knowledge", "server.mjs");
const MY_WEB = path.join(HERE, "mcp-web-search", "server.mjs");

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// ---------- 第一步：工具面 ----------
// 问 app-server「你挂了哪些服务、每个服务有哪些工具」。
function listTools() {
  return new Promise((resolve) => {
    const server = spawn(CODEX_BIN, [
      "app-server",
      "-c",
      `mcp_servers.my_knowledge.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.my_knowledge.args=${JSON.stringify([MY_KNOWLEDGE])}`,
      "-c",
      `mcp_servers.my_knowledge.omit_tools_from=${JSON.stringify(["deferred"])}`,
      "-c",
      `mcp_servers.my_web_search.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.my_web_search.args=${JSON.stringify([MY_WEB])}`,
      "-c",
      `mcp_servers.my_web_search.omit_tools_from=${JSON.stringify(["deferred"])}`,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      // .env 里的密钥要带上，否则内核报 Missing environment variable
      env: { ...process.env, ...loadLocalEnv(), CODEX_HOME: LAB_HOME },
    });

    const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");
    let buf = "";
    let servers = null;
    let fatal = null;
    let errBuf = "";

    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (c) => {
      errBuf += c;
      for (const line of errBuf.split("\n")) {
        if (line.startsWith("Error:")) fatal = line.trim();
      }
    });

    const done = () => {
      server.kill();
      resolve({ servers, fatal });
    };
    setTimeout(done, 45000);

    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "mcpServerStatus/list",
            params: { detail: "toolsAndAuthOnly" },
          });
        }
        if (msg.id === 2) {
          servers = msg.result?.data ?? [];
          done();
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agent-lab", title: "Agent Lab", version: "0.1.0" } },
    });
  });
}

// ---------- 第二步：搜索本身 ----------
function callWebSearch(query) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MY_WEB], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let text = null;
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
          if (msg.id === 2) text = msg.result?.content?.[0]?.text ?? "";
        } catch {}
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "web_search", arguments: { query, limit: 5 } },
      }) + "\n",
    );
    setTimeout(() => {
      child.kill();
      resolve(text ?? "");
    }, 30000);
  });
}

console.log(`内核: ${CODEX_BIN}\n`);

console.log("=== 第一步：工具面里有什么 ===");
const { servers, fatal } = await listTools();
if (fatal) console.log(`内核报错: ${fatal}`);
const byName = new Map((servers ?? []).map((s) => [s.name, s]));
for (const s of servers ?? []) {
  const names = Object.keys(s.tools ?? {});
  console.log(`  ${s.name}: ${names.join(", ") || "（没有工具）"}`);
}

const web = byName.get("my_web_search");
check(!!web, "自建的联网搜索服务已经挂上");
check(
  !!web && Object.keys(web.tools ?? {}).includes("web_search"),
  "它的 web_search 工具对模型可见（没有被延迟暴露藏起来）",
);
check(
  !!byName.get("my_knowledge"),
  "「我的知识」服务还在（没有为了联网把原来的工具挤掉）",
);

// 托管搜索被关掉后，其名字不应再作为内核工具出现。
// 这里只能看 MCP 服务清单，托管工具不在这张表里；它的开关由配置决定，
// 所以下面这条检查的是配置文件确实写进去了。
const cfg = await (await import("node:fs/promises")).readFile(
  path.join(LAB_HOME, "config.toml"),
  "utf8",
);
check(/^\s*web_search\s*=\s*"disabled"\s*$/m.test(cfg), '配置里已把关不掉的托管搜索设为 "disabled"');

console.log("\n=== 第二步：真查一次 ===");
const text = await callWebSearch("openai codex github repository");
const bytes = Buffer.byteLength(text, "utf8");
console.log(`返回 ${bytes} B（${text.length} 字）`);
console.log(text.slice(0, 260).replace(/\n/g, " ") + (text.length > 260 ? "…" : ""));

const failedSearch = /搜索失败|没有搜到/.test(text);
check(text.length > 20, "搜索一定会给出一段有意义的回复（不管成不成功）");
check(bytes < 8 * 1024, "返回体积受控（" + bytes + " B < 8 KB）");

if (failedSearch) {
  // 没搜到不算失败，但失败得很含糊就是 bug。
  check(/brave|bing/i.test(text), "失败时说明了是哪个后端出的问题");
  check(/不要再换关键词|不要反复搜索/.test(text), "失败时明确叫模型别反复换关键词（省下最贵的那些圈）");
  console.log("（本次外网不可用，走的是失败分支；这是允许的结果）");
} else {
  // 搜到了就必须能引用，而且不能是无关内容。
  check(/https?:\/\/\S+/m.test(text), "结果里带来源链接（能引用出处）");
  check(/openai|codex/i.test(text), "结果确实跟查询有关，不是后端的填充内容");
}

console.log("\n=== 结论 ===");
console.log(failed === 0 ? "[PASS] 联网通了，而且空头的托管搜索已经摘掉" : `[FAIL] ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
// 第二步验证的是**契约**，不是「此刻外网恰好可用」。
// 原因：Brave 是 IP 级限流（连着测就会 429），Bing 又时常返回无关内容。
// 把测试写成「必须搜到」的话，这个项目的对错就取决于外部站点的脸色了。
// 所以允许「明确报告失败」这个结果，但两种结果各自的契约必须成立：
//   搜到了 -> 必须带来源链接、体积受控，且不能是无关内容；
//   没搜到 -> 必须讲清楚原因，并且明确叫模型别再换关键词。
// 换个角度说：这个测试拦的是「返回 200 但内容全无关」和「含糊的失败」，
// 这两种才是真正会让 agent 变贵的坑。
console.log("\n=== 第二步：真查一次 ===");
