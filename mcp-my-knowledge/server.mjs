#!/usr/bin/env node
// 我自己的 MCP 工具服务：给 agent 一个存取「我的开发知识」的能力。
//
// MCP = Model Context Protocol，是 agent 世界里的「工具插座标准」。
// 实现它只要做三件事：
//   1. 用 JSON-RPC 说协议（一行一个 JSON）
//   2. 回答 initialize（自报家门）
//   3. 回答 tools/list（我能干啥）和 tools/call（真的干）
//
// 这个文件零依赖，只用 Node 标准库。
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 知识库位置，可以用环境变量覆盖
const VAULT = process.env.MY_KNOWLEDGE_DIR ?? path.join(HERE, "knowledge");
// 「写」跟「读」分开。
// 读的库可以外接（比如你真正的 Obsidian 库），但那种库往往有自己的规矩
// （只记某个项目、不许混入杂事）。工具生成的内容不该直接混进去，
// 所以写入目标单独一个开关；默认仍写回原位置，保持原来的行为。
const ADD_FILE = process.env.MY_KNOWLEDGE_ADD_FILE ?? path.join(VAULT, "index.md");

// ---------- 工具定义 ----------
const TOOLS = [
  {
    name: "knowledge_search",
    description:
      "搜索我的个人开发知识库，返回匹配的笔记片段。当你需要我的偏好、项目约定、踩坑记录时用它。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，例如「提交规范」「苍穹 字段缺失」" },
        limit: { type: "number", description: "最多返回几条，默认 5" },
      },
      required: ["query"],
    },
    // 告诉客户端「我只是读，不动任何东西」。
    // 内核会用这个声明判断要不要弹审批：不声明的话，默认按「可能有破坏性」处理，
    // 每次只读查询都要人点一下允许。实测中就卡在这里，模型以为被拒绝就放弃了。
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "knowledge_add",
    description:
      "把一条新的开发知识追加到我的知识库。当我说「记住这个」或确认了一条长期有效的结论时用它。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "这条知识的简短标题" },
        content: { type: "string", description: "正文内容" },
        tags: { type: "array", items: { type: "string" }, description: "可选标签" },
      },
      required: ["title", "content"],
    },
    // 这一条会写文件，所以刻意不声明为只读，保留审批。
  },
];

// ---------- 工具实现 ----------
// 知识库可能是多层目录（比如 Obsidian 那种 20-项目/xx.md）。
// 只扫顶层会把大部分内容漏掉，所以这里递归收集。相对路径当文件名用。
async function collectMarkdown(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    // 跳过 Obsidian 的隐藏目录（.obsidian/.trash 之类）
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(path.join(dir, entry.name), rel)));
    } else if (entry.name.endsWith(".md")) {
      out.push({ file: rel, full: path.join(dir, entry.name) });
    }
  }
  return out;
}

async function loadNotes() {
  await mkdir(VAULT, { recursive: true });
  const files = await collectMarkdown(VAULT);
  const notes = [];
  for (const f of files) {
    const text = await readFile(f.full, "utf8").catch(() => "");
    if (text.trim()) notes.push({ file: f.file, text });
  }
  return notes;
}

// 一条结果最多吐多少字。工具返回会原样进下一圈的上下文，
// 而整个上下文每转一圈都要重发一次——长笔记原样回传，成本是乘着圈数走的。
// 实测：不截断时一次查询能回 40 KB，模型为此多转了四圈。
const MAX_BLOCK_CHARS = 600;

// 命中率低于这个值就直说「没找到」。
// 这道门槛比看上去重要：库里有答案却返回一堆沾边段，模型会以为自己没搜对，
// 于是换个词再搜一遍。实测：没门槛时它为确认「库里没有」白搜了 9 次，上下文翻了 5 倍。
const MIN_COVERAGE = 0.35;

// 分词。中文必须切成二字词（bigram），不能按空格切：
// 「命名要求」在库里是一整串连写的字，按空格切永远匹配不上，
// 等于只拿单个字去撞——这样搜中文的召回率会低到几乎不可用。
function tokenize(text) {
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]+/g)) {
    const t = m[0];
    if (/^[\u4e00-\u9fff]+$/.test(t)) {
      if (t.length === 1) out.push(t);
      else for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
    } else {
      out.push(t);
    }
  }
  return [...new Set(out)];
}

function clipBlock(text) {
  const t = text.trim();
  return t.length > MAX_BLOCK_CHARS ? t.slice(0, MAX_BLOCK_CHARS) + "…（截断）" : t;
}

async function knowledgeSearch({ query = "", limit = 5 }) {
  const notes = await loadNotes();
  const terms = tokenize(query);
  if (!terms.length) return "请提供搜索关键词。";

  const allBlocks = notes.flatMap((n) =>
    n.text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean),
  );

  // 每个词的「稀有度」。到处都出现的词（比如搜索日志里遍地是「实验」）没什么
  // 区分力，权重就低；只在少数笔记出现的词权重高。
  // 一个字都碰不到的词给最高权重——它最能说明「这组的不是我要找的」。
  const weight = new Map();
  for (const t of terms) {
    const df = allBlocks.reduce((n, b) => n + (b.toLowerCase().includes(t) ? 1 : 0), 0);
    // ponytail: 粗糙的 IDF，够用就行；真要排序质量上 BM25 再说。
    weight.set(t, Math.log(1 + allBlocks.length / (df || 0.5)));
  }
  const totalWeight = terms.reduce((n, t) => n + weight.get(t), 0);

  const hits = [];
  for (const note of notes) {
    for (const block of note.text.split(/\n\s*\n/)) {
      const t = block.trim();
      if (!t) continue;
      const low = t.toLowerCase();
      let covered = 0;
      for (const term of terms) if (low.includes(term)) covered += weight.get(term);
      // 按「覆盖了查询里多少分量」判断，而不是「碰到任意一个词」。
      // 否则「Agent」「Lab」这种满库都有的词就会把无关段落全捞上来。
      const coverage = covered / totalWeight;
      if (coverage >= MIN_COVERAGE) hits.push({ coverage, text: t, file: note.file });
    }
  }

  if (!hits.length) {
    // 明确说「换个说法也没用」：模型收不到这句话时，会执着地换关键词重搜，
    // 每一轮都把整段上下文重发一遍。这句话是为省下那些圈数。
    return `知识库里没有匹配「${query}」的内容。换关键词也没用，请直接告诉用户库里没有，不要反复搜索。`;
  }

  hits.sort((a, b) => b.coverage - a.coverage);
  return hits
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
    .map((h, i) => `${i + 1}. [${h.file}] (相关度 ${h.coverage.toFixed(2)})\n${clipBlock(h.text)}`)
    .join("\n\n");
}

async function knowledgeAdd({ title, content, tags = [] }) {
  await mkdir(VAULT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = `\n\n## ${title}\n\n- 记录日期：${stamp}${tags.length ? `\n- 标签：${tags.join(", ")}` : ""}\n\n${content}\n`;
  await mkdir(path.dirname(ADD_FILE), { recursive: true });
  await writeFile(ADD_FILE, entry, { flag: "a" });
  return `已写入知识库：${title}（${ADD_FILE}）`;
}

async function callTool(name, args) {
  switch (name) {
    case "knowledge_search":
      return knowledgeSearch(args ?? {});
    case "knowledge_add":
      return knowledgeAdd(args ?? {});
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ---------- MCP 协议实现 ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // 通知类消息没有 id，不需要回
  if (msg.id === undefined) return;

  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (message) =>
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(message) } });

  try {
    switch (msg.method) {
      case "initialize":
        reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "my-knowledge", version: "0.1.0" },
        });
        break;

      case "tools/list":
        reply({ tools: TOOLS });
        break;

      case "tools/call": {
        const { name, arguments: args } = msg.params ?? {};
        const text = await callTool(name, args);
        reply({ content: [{ type: "text", text }], isError: false });
        break;
      }

      // 有些客户端会问这些，礼貌回应即可
      case "resources/list":
        reply({ resources: [] });
        break;
      case "prompts/list":
        reply({ prompts: [] });
        break;
      case "ping":
        reply({});
        break;

      default:
        fail(`不支持的方法: ${msg.method}`);
    }
  } catch (err) {
    fail(err?.message ?? err);
  }
});
