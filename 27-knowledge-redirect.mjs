// 实验 27：项目规则指向的知识，agent 到底能不能拿到
//
// 起因是一个真实的死链。项目 `C:\hnsh\sherp\AGENTS.md` 里写着：
//   调拨平衡工作台（前后端协议、清单生成链路、踩坑记录）的完整架构参考见
//   全局记忆 `~/.config/opencode/AGENTS.md`
// 但那个文件已经不存在了——整台机器上连 `.config` 目录都没有。
//
// 这类缺口很坏，因为规则看起来是完整的，agent 照着做只会得到「文件不存在」，
// 然后浪费几轮去别处乱找，最后要么空手而归、要么拿印象编一段。
//
// 内容其实没丢，是搬进了 Obsidian 记忆库（`20-项目/shscm-苍穹产销与调拨.md`），
// 而记忆库正好是 `my_knowledge` 工具在读的地方。所以修法不是去补那个旧路径，
// 而是把「这个引用已失效、改走知识检索」写进每次会话都会注入的 `knowledge.md`。
//
// 这个脚本验三件事，顺序是从「规则」到「能拿到」：
//   A. 前提：真工程 + 真失效路径的状态（防止有人修好了路径而实验还按老假设跑）
//   B. 桥：那条重定向真的写在 knowledge.md 里（不会随会话飘走）
//   C. 实质：对着同一个问题检索记忆库，真能拿到调拨平衡的内容
//
// 运行：node 27-knowledge-redirect.mjs
// 不需要 App 起着——A、C 两步直接读文件/直连 MCP，只有 B 是读一份文件。
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.COSMIC_PROJECT ?? "C:/hnsh/sherp";
const VAULT =
  process.env.AGENT_KNOWLEDGE_DIR ?? path.join(os.homedir(), "Documents/Codex/CodexMemoryVault");
const MY_MCP = path.join(HERE, "mcp-my-knowledge", "server.mjs");

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed++;
};

// ---------- A. 前提状态：这条死链还在不在 ----------
console.log("=== A. 前提：项目规则指的那份全局记忆 ===");
const DEAD = path.join(os.homedir(), ".config", "opencode", "AGENTS.md");
let deadExists = true;
try {
  await access(DEAD);
} catch {
  deadExists = false;
}
console.log(`规则里指的路径: ${DEAD}`);
console.log(deadExists ? "  -> 现在存在" : "  -> 不存在（这就是要绕开的死链）");

// 项目 AGENTS.md 里到底有没有这句引用。没有的话这个实验的前提就变了。
const agents = await readFile(path.join(PROJECT, "AGENTS.md"), "utf8").catch(() => "");
check(
  /\.config[\\/]opencode[\\/]AGENTS\.md/.test(agents),
  "项目 AGENTS.md 里仍然写着那个全局记忆路径（实验的前提还在）",
);
if (deadExists) {
  // 有人把文件补回去了——那就该改这个实验的前提，而不是继续按「要绕开」来判。
  console.log("  ⚠ 路径已存在，实验的前提假设过期了：重定向现在是冗余的，该复查 knowledge.md 那段。");
}

// ---------- B. 重定向写在会话会读到的地方 ----------
console.log("\n=== B. 桥：重定向是否写在每次会话都会注入的知识里 ===");
const knowledge = await readFile(path.join(HERE, "knowledge.md"), "utf8").catch(() => "");
check(knowledge.length > 0, "读得到 knowledge.md（每次新会话都会注入它）");
check(
  /\.config[\\/]opencode/.test(knowledge) && /已经不存在|已不存在|失效/.test(knowledge),
  "knowledge.md 里点名说了那个旧路径已失效（不是含糊带过）",
);
check(
  /my_knowledge|knowledge_search/.test(knowledge),
  "knowledge.md 指明了替代路径：走 my_knowledge 的检索",
);

// ---------- C. 实质：那条替代路径真能拿到内容 ----------
console.log("\n=== C. 实质：知识检索能不能拿到调拨平衡的架构内容 ===");
console.log(`记忆库: ${VAULT}`);
try {
  await access(VAULT);
  check(true, "记忆库目录在");
} catch {
  check(false, `记忆库不在：${VAULT}`);
}

// 直接跟 MCP 服务对话，不经过模型。这一步只验「工具能不能查到」，
// 模型会不会去用是另一个问题（那个由实验 03/04 那类负责）。
function mcpSearch(query) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MY_MCP], {
      env: { ...process.env, MY_KNOWLEDGE_DIR: VAULT },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const timer = setTimeout(() => {
      p.kill();
      resolve(null);
    }, 60000);
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          p.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "knowledge_search", arguments: { query } },
            }) + "\n",
          );
        } else if (m.id === 2) {
          clearTimeout(timer);
          p.kill();
          resolve(m.result?.content?.[0]?.text ?? "");
        }
      }
    });
    p.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "exp27", version: "1" } },
      }) + "\n",
    );
  });
}

const hit = await mcpSearch("调拨平衡 清单生成");
check(typeof hit === "string" && hit.length > 0, "检索有返回（不是空手）");
if (typeof hit === "string") {
  // 命中要落在项目笔记上，而不是随便一篇日志——不然等于没找到架构参考。
  const onProjectNote = /shscm-苍穹产销与调拨/.test(hit);
  const mentionsArchitecture = /TransferBalance|调拨清单|采购订单/.test(hit);
  console.log(hit.slice(0, 320).replace(/\n/g, " | "));
  check(onProjectNote, "命中的是项目笔记（20-项目/shscm-苍穹产销与调拨.md）");
  check(mentionsArchitecture, "返回内容确实在讲调拨平衡的链路（不是无关片段）");
}

console.log("\n=== 结论 ===");
console.log(
  failed === 0
    ? "[PASS] 规则里的死链已绕开，替代检索能拿到真实内容"
    : `[FAIL] ${failed} 项未通过`,
);
process.exit(failed === 0 ? 0 : 1);
