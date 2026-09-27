// Agent Lab 前端：对话 + 实时事件流
const $ = (id) => document.getElementById(id);
const stream = $("stream");
const input = $("input");

let threadId = null;
let currentTurn = null;
// turn/start 还在路上时点的停止：先记下来，等 turn id 一到就补发中断。
let stopRequested = false;

// ---------- 成本可见化 ----------
// 上下文里最贵的不是你说的话，是工具吐回来的东西。这里把每条工具
// 返回的体积量出来，并把内核报的累计用量显示在顶部。
// （数据本来就跟着事件到达，不需要改内核。）
let totalTokens = 0;
let activeContextTokens = 0;
let modelContextWindow = 128000;
let toolBytes = 0;
let toolCalls = 0;
let compacting = false;

function byteSize(value) {
  try {
    return new Blob([JSON.stringify(value ?? "")]).size;
  } catch {
    return 0;
  }
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatTokenCount(num) {
  if (num === null || num === undefined) return "0";
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(num);
}

function renderContextMeter() {
  const meter = $("context-meter");
  const fill = $("meter-fill");
  const text = $("meter-text");
  const compactBtn = $("compact-btn");
  if (!meter || !fill || !text) return;

  if (!threadId) {
    meter.hidden = true;
    if (compactBtn) compactBtn.hidden = true;
    return;
  }

  meter.hidden = false;
  if (compactBtn) {
    compactBtn.hidden = false;
    compactBtn.disabled = !!currentTurn || compacting;
  }

  const current = activeContextTokens || 0;
  const max = modelContextWindow || 128000;
  const ratio = Math.min(100, Math.max(0, (current / max) * 100));

  fill.style.width = `${Math.max(ratio, current > 0 ? 2 : 0)}%`;
  fill.className = "meter-bar-fill" + (ratio >= 90 ? " danger" : ratio >= 70 ? " warn" : "");

  text.textContent = `${formatTokenCount(current)} / ${formatTokenCount(max)} (${ratio.toFixed(1)}%)`;
  meter.title = `当前活跃上下文：${current.toLocaleString()} token\n模型上下文窗口：${max.toLocaleString()} token\n占用比例：${ratio.toFixed(2)}%`;
}

function renderCost() {
  const el = $("cost");
  if (el) {
    if (!totalTokens && !toolCalls) {
      el.textContent = "";
    } else {
      const tokenPart = totalTokens
        ? `累计 <b>${totalTokens.toLocaleString()}</b> token · `
        : "历史会话（token 未记录）· ";
      el.innerHTML = tokenPart + `工具返回 <b>${toolCalls}</b> 次 / <b>${human(toolBytes)}</b>`;
    }
  }
  renderContextMeter();
}

// ---------- 后端通信 ----------
async function rpc(method, params) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(humanError(json.error));
  return json.result;
}

// 内核的报错是给程序看的 JSON-RPC 结构。直接摔给用户会是这样：
//   {"code":-32600,"message":"thread not found: 01a0c8d9-..."}
// 这样难看，也看不出该做什么。
//
// 这里只做两件事：把 message 挑出来、把几个常见的按「人该怎么办」改写。
// 认不出来的就把 message 原样给人——总比一串 JSON 强。
function humanError(err) {
  const raw = typeof err === "string" ? err : err?.message ?? JSON.stringify(err);
  if (/thread not found/i.test(raw)) {
    return "这个会话在内核里已经不存在了（可能是 App 重启过）。点「新会话」开一个，或者换个会话再发。";
  }
  if (/env(ironment)? var.*not|Missing environment variable/i.test(raw)) {
    return "缺少模型密钥。检查项目根目录的 .env 里有没有 AGENT_LAB_API_KEY，然后重启 App。";
  }
  if (/401|unauthor/i.test(raw)) {
    return "模型服务拒绝了这个密钥（401）。检查 .env 里的 token 是不是过期了。";
  }
  return raw;
}

// ---------- 事件流 ----------
const itemNodes = new Map();
// 刚发出去、内核还没回显的那条用户消息对应的卡片。用来避免重复，而不是用来缓存。
let localUserEcho = null;

// tool/file/reasoning 超过 3 行默认折叠，结论不折
const FOLDABLE_KINDS = ["tool", "file", "reasoning"];

function isFoldable(el) {
  return FOLDABLE_KINDS.some((k) => el.classList.contains(k));
}

function countLines(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r\n|\r|\n/).length;
}

function updateFoldBtn(el, isCollapsed) {
  const btn = el.querySelector(".fold-btn");
  if (!btn) return;
  const bodyText = el.querySelector(".card-body")?.textContent ?? "";
  const lines = countLines(bodyText);
  const approx = Math.max(lines, Math.ceil(bodyText.trim().length / 80));
  const displayLines = lines > 3 ? lines : approx;
  btn.textContent = isCollapsed ? `展开 (共 ${displayLines} 行)` : "折叠";
  btn.title = isCollapsed ? "展开查看完整内容" : "收起内容";
}

function bindFoldToggle(el) {
  const btn = el.querySelector(".fold-btn");
  const head = el.querySelector(".card-head");
  const toggle = (e) => {
    if (e) e.stopPropagation();
    if (!el.classList.contains("foldable")) return;
    el.dataset.userToggled = "true";
    const isCollapsed = el.classList.toggle("collapsed");
    updateFoldBtn(el, isCollapsed);
  };
  if (btn) btn.onclick = toggle;
  if (head) {
    head.onclick = (e) => {
      if (e.target === btn) return;
      toggle(e);
    };
  }
}

// ---------- 轻量 Markdown 渲染 ----------
// 先转义 HTML，再只把认识的那几种语法拼回标签。模型的输出是外部文本，
// 直接 innerHTML 等于把页面交给它；这里只允许我们白名单内的结构。
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// 行内语法：代码、粗体、斜体、删除线、链接。链接只放行 http/https。
function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, href) => {
    const safe = href.replace(/&amp;/g, "&");
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  return out;
}

function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let list = null; // 'ul' | 'ol' | null

  const closeList = () => {
    if (list) { html.push(`</${list}>`); list = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块：``` 到下一个 ```，原样保留（但仍然是转义过的）
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : "";
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      html.push(`<pre><code${lang}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (list !== "ul") { closeList(); html.push("<ul>"); list = "ul"; }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (list !== "ol") { closeList(); html.push("<ol>"); list = "ol"; }
      html.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInline(line)}</p>`);
  }
  closeList();
  return html.join("");
}

function setCardBody(el, text) {
  const bodyEl = el.querySelector(".card-body");
  if (!bodyEl) return;
  // 苍穹的回复按 Markdown 渲染；用户消息、思考、工具输出保持原文。
  if (el.dataset.md === "1") {
    bodyEl.classList.add("markdown");
    // 顺手记下原文：流式片段要拿它做累加，不能从渲染后的 HTML 里反推。
    el.dataset.raw = text ?? "";
    bodyEl.innerHTML = renderMarkdown(text);
  } else {
    bodyEl.textContent = text ?? "";
  }

  if (!isFoldable(el)) return;

  const foldBtn = el.querySelector(".fold-btn");
  if (!foldBtn) return;

  const raw = text ?? "";
  const lineCount = countLines(raw);
  const approxLines = Math.max(lineCount, Math.ceil(raw.trim().length / 80));
  const exceedsThree = lineCount > 3 || approxLines > 3;

  if (!exceedsThree) {
    el.classList.remove("foldable", "collapsed");
    foldBtn.hidden = true;
    return;
  }

  el.classList.add("foldable");
  foldBtn.hidden = false;

  // 用户如果没有手动点过展开/折叠，默认折叠
  if (!el.dataset.userToggled) {
    el.classList.add("collapsed");
  }

  updateFoldBtn(el, el.classList.contains("collapsed"));
}

function addCard(kind, title, body) {
  const el = document.createElement("article");
  el.className = `card ${kind}`;
  // agent 卡片的正文走 Markdown 渲染，其余按纯文本展示。
  if (kind === "agent") el.dataset.md = "1";
  el.innerHTML = `<div class="card-head"><div class="card-title"></div><button class="fold-btn" type="button" hidden></button></div><div class="card-body"></div>`;
  el.querySelector(".card-title").textContent = title;
  bindFoldToggle(el);
  setCardBody(el, body ?? "");
  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
  return el;
}

// ---------- 「正在思考」动画 ----------
// 内核从收到消息到吐出第一个 item 之间有一段空窗（模型还在推理）。
// 这段什么都不显示的话，界面看起来就像卡住了。这里先摆一个动效占位，
// 真 item 一到就让位——它只是代替空白，不参与对话内容。
let thinkingEl = null;
// 计时器状态：占位不能只是个动画，得显示真实等待了多久。
let thinkingTimer = null;
let thinkingStart = 0;
let thinkingBase = "正在思考";

// reasoning item 开始到第一帧思考文本之间，卡片正文是空的。这段时间把
// "思考中… Ns" 写进卡片，让"思考"跟模型思考流的生命周期绑在一起：
// 思考流一来就被真内容顶掉，思考结束就停。不是独立播一遍的演示动画。
let liveReasoning = null; // { id, el, start, timer }

// 哪些 item 一出现就意味着"界面上已经有东西了"，可以撤掉占位。
// reasoning 不在这里：它的思考卡由 startLiveReasoning 接管。
const THINKING_CLEARING_TYPES = new Set([
  "agentMessage",
  "commandExecution",
  "mcpToolCall",
  "fileChange",
]);


function thinkingDots() {
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
  return dots;
}

// 运行中的卡片标题：转圈 + 人话 + 跳动的点。
// 思考、执行命令、调工具、改文件都共用这一套，看起来才一致。
function runningTitle(el, text) {
  const titleEl = el.querySelector(".card-title");
  titleEl.textContent = "";
  const spinner = document.createElement("span");
  spinner.className = "thinking-spinner";
  const label = document.createElement("span");
  label.textContent = text;
  titleEl.append(spinner, label, thinkingDots());
}

function elapsedSuffix(start) {
  const s = Math.max(0, Math.round((Date.now() - start) / 1000));
  return s >= 1 ? ` ${s}s` : "";
}

function tickThinking() {
  const label = thinkingEl?.querySelector(".thinking-label");
  if (label) label.textContent = thinkingBase + elapsedSuffix(thinkingStart);
}

function showThinking(text = "正在思考") {
  thinkingBase = text;
  if (thinkingEl) {
    tickThinking();
    return;
  }
  thinkingStart = Date.now();
  const el = document.createElement("div");
  el.className = "thinking";
  const spinner = document.createElement("span");
  spinner.className = "thinking-spinner";
  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = text;
  el.append(spinner, label, thinkingDots());
  stream.appendChild(el);
  thinkingEl = el;
  tickThinking();
  // 每秒刷新真实耗时：一眼能看出它跟着模型在跑，不是固定播一遍的动画。
  if (!thinkingTimer) thinkingTimer = setInterval(tickThinking, 1000);
  stream.scrollTop = stream.scrollHeight;
}

function hideThinking() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  thinkingEl?.remove();
  thinkingEl = null;
}

// reasoning item 开始后正文还是空的，把"思考中… Ns"写进去并每秒刷新。
// 模型的思考文本一流过来就立刻停手让位（见 item/reasoning/*Delta 的处理）。
function startLiveReasoning(id, el) {
  stopLiveReasoning();
  if (!id || !el) return;
  const bodyEl = el.querySelector(".card-body");
  if (!bodyEl || (bodyEl.textContent ?? "").trim()) return;
  const start = Date.now();
  liveReasoning = { id, el, start, timer: null };
  bodyEl.textContent = "思考中…";
  liveReasoning.timer = setInterval(() => {
    const b = el.querySelector(".card-body");
    // 已经有真思考内容了就停手，绝不覆盖模型吐出来的东西。
    if (!b || !/^思考中/.test(b.textContent ?? "")) {
      stopLiveReasoning();
      return;
    }
    b.textContent = `思考中… ${Math.round((Date.now() - start) / 1000)}s`;
  }, 1000);
}

function stopLiveReasoning(id) {
  if (!liveReasoning) return;
  if (id && liveReasoning.id !== id) return;
  if (liveReasoning.timer) clearInterval(liveReasoning.timer);
  liveReasoning = null;
}

function upsertItem(item, phase) {
  if (!item?.id) return;
  // 自己发出去的话是当场画出来的（不等内核回显）。内核回显到了就把它认领过来，
  // 免得同一句话在屏幕上出现两次。
  let el = null;
  if (item.type === "userMessage" && localUserEcho && !itemNodes.has(item.id)) {
    el = localUserEcho;
    localUserEcho = null;
    itemNodes.set(item.id, el);
  } else {
    el = itemNodes.get(item.id);
  }
  if (!el) {
    const { kind, title } = describe(item);
    el = addCard(kind, title, "");
    itemNodes.set(item.id, el);
  }
  el.classList.toggle("running", phase === "started");
  // 运行中的卡片标题换成动效文案，跑完换回静态标题。
  // 命令执行尤其需要这个：它可能要跑很久，不给反馈就像卡住了。
  const { title } = describe(item);
  const RUNNING_LABELS = {
    reasoning: "正在思考",
    commandExecution: "正在执行命令",
    mcpToolCall: "正在调用工具",
    fileChange: "正在改动文件",
  };
  const runningLabel = RUNNING_LABELS[item.type];
  if (runningLabel) {
    if (phase === "started") runningTitle(el, runningLabel);
    else el.querySelector(".card-title").textContent = title;
  }
  const body = renderItemBody(item);
  if (body !== null) setCardBody(el, body);
  if (phase === "completed") countToolCost(item);
  stream.scrollTop = stream.scrollHeight;
}

// 一条工具调用到底往上下文里塞了多少东西？
// 参数和返回都算进去，因为两者都会原样进入下一圈的上下文。
const counted = new Set();

function resetCost() {
  totalTokens = 0;
  activeContextTokens = 0;
  toolBytes = 0;
  toolCalls = 0;
  counted.clear();
  renderCost();
}

function countToolCost(item, el = itemNodes.get(item.id)) {
  const isTool = item.type === "mcpToolCall" || item.type === "commandExecution";
  if (!isTool || counted.has(item.id)) return;
  counted.add(item.id);
  const bytes = byteSize(item.arguments) + byteSize(item.result) + byteSize(item.aggregatedOutput);
  toolBytes += bytes;
  toolCalls += 1;
  renderCost();
  // 直接标在那张卡片上，哪条调用贵一眼就看到。
  if (!el) return;
  const tag = document.createElement("div");
  tag.className = "cost-tag";
  tag.textContent = `进入上下文 ≈ ${human(bytes)}`;
  el.appendChild(tag);
}

function describe(item) {
  switch (item.type) {
    case "userMessage":
      return { kind: "user", title: "你" };
    case "agentMessage":
      return { kind: "agent", title: "苍穹" };
    case "reasoning":
      return { kind: "reasoning", title: "思考" };
    case "commandExecution":
      return { kind: "tool", title: "执行命令" };
    case "mcpToolCall":
      return { kind: "tool", title: `工具 · ${item.server}/${item.tool}` };
    case "fileChange":
      return { kind: "file", title: "改动文件" };
    case "contextCompaction":
      // 上下文压缩：内核把旧历史摘要掉，避免撑爆模型窗口。不显示的话
      // 用户只会看到「上下文突然变小」，不知道为什么。
      return { kind: "probe", title: "上下文压缩" };
    default:
      return { kind: "tool", title: item.type ?? "事件" };
  }
}

function renderItemBody(item) {
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
      return (item.content ?? []).map((c) => c.text ?? "").join("") || item.text || "";
    case "reasoning": {
      const fromContent = (item.content ?? []).map((c) => c.text ?? "").join("");
      const fromSummary = Array.isArray(item.summary)
        ? item.summary.map((s) => s.text ?? s).join("\n")
        : (item.summary?.text ?? item.summary ?? "");
      const fromSummaryText = Array.isArray(item.summaryText)
        ? item.summaryText.join("\n")
        : (item.summaryText ?? "");
      return fromContent || fromSummary || fromSummaryText || item.text || "";
    }
    case "commandExecution":
      return `${item.command ?? ""}\n${item.aggregatedOutput ?? ""}`.trim();
    case "mcpToolCall":
    {
      const args = JSON.stringify(item.arguments ?? {}, null, 2);
      let out = "";
      if (item.result !== undefined) {
        if (Array.isArray(item.result?.content)) {
          out = item.result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
        } else if (typeof item.result === "string") {
          out = item.result;
        } else {
          out = JSON.stringify(item.result, null, 2);
        }
      } else if (item.error !== undefined) {
        out = typeof item.error === "string" ? item.error : JSON.stringify(item.error, null, 2);
      }
      return out ? `${args}\n\n--- 返回 ---\n${out}`.trim() : args;
    }
    case "fileChange":
      return (item.changes ?? []).map((c) => `${c.path}\n${c.diff ?? ""}`).join("\n");
    case "contextCompaction":
      return "旧历史已被摘要压缩，活跃上下文回落（详见实验 09）";
    default:
      return "";
  }
}

// ---------- 每一圈的账单 ----------
// 说人话地告诉用户：这一圈上下文多大了、比上一圈多花多少，
// 以及贵的那部分到底是哪个工具的返回。
function showLoopCost(p) {
  // 上下文会涨也会落（触发压缩、或裁掉旧内容）。不能硬拼一个加号，
  // 否则负数会显示成「+-1417」。
  let delta = "";
  if (typeof p.deltaTokens === "number") {
    const d = p.deltaTokens;
    delta = `（比上一圈 ${d >= 0 ? "+" : "-"}${Math.abs(d).toLocaleString()}）`;
  }
  const head = `上下文 ${Number(p.tokens).toLocaleString()} token${delta}`;

  const lines = p.calls?.length
    ? p.calls.map((c) => `· ${c.name}  ${human(c.bytes)}\n  ${c.detail}`)
    : [`· 这一圈没调工具`];

  addCard("probe", `第 ${p.iteration} 圈结束 · ${head}`, lines.join("\n"));
}

// ---------- 审批卡片 ----------
// 服务端会反问过来：某个命令/改动要不要放行。这里把它显示成一张卡片。
const approvalNodes = new Map();

function showApproval(msg) {
  const p = msg.params ?? {};
  if (approvalNodes.has(msg.id)) return;

  const isCommand = msg.method === "item/commandExecution/requestApproval";
  const el = document.createElement("article");
  el.className = "card approval";
  el.innerHTML = `
    <div class="card-title"></div>
    <div class="card-body"></div>
    <div class="approval-actions">
      <button class="ok">允许一次</button>
      <button class="ok-session">本会话都允许</button>
      <button class="no">拒绝</button>
    </div>`;

  el.querySelector(".card-title").textContent = isCommand ? "需要你批准：执行命令" : "需要你批准：修改文件";
  const rawCommand = Array.isArray(p.command) ? p.command.join(" ") : p.command;
  const detail = [
    rawCommand ? "命令: " + rawCommand : "",
    p.cwd ? "目录: " + p.cwd : "",
    p.reason ? "原因: " + p.reason : "",
    p.grantRoot ? "申请写入: " + p.grantRoot : "",
  ]
    .filter(Boolean)
    .join("\n");
  el.querySelector(".card-body").textContent = detail;

  const reply = async (decision) => {
    // 必须看桥的返回，不能回完就当成功。
    //
    // 踩过：这里原来只 fetch 一下、不检查结果。于是点一个**过期的**审批卡片
    // （内核那个请求早就没了）时，桥回 404「未知请求 id」，界面却照样把卡片
    // 标成「已回复」。界面在擒谎：活没干，却告诉你已经干了。
    // 对审批这种安全闸门来说，这是最不能接受的一类错。
    const res = await fetch("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: msg.id, decision }),
    }).catch(() => null);

    const title = el.querySelector(".card-title");
    // 不管成功失败都把按钮禁掉：失败也不能让人反复去点。
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    el.classList.remove("approval");

    if (!res || !res.ok) {
      // 说清楚发生了什么：这个请求已经不在内核里了，通常是它早已超时或被顶掉。
      // 人需要知道「这一次没拦住」，而不是以为拦住了。
      el.classList.add("error");
      title.textContent += " [回复失败：这个请求已经不在了]";
      return;
    }

    title.textContent += " [已回复：" + decision + "]";
  };

  el.querySelector(".ok").onclick = () => reply("accept");
  el.querySelector(".ok-session").onclick = () => reply("acceptForSession");
  el.querySelector(".no").onclick = () => reply("decline");

  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
  approvalNodes.set(msg.id, el);
}

function onEvent(msg) {
  const m = msg.method;
  const p = msg.params ?? {};
  // 服务端反问：审批。这条不能按 threadId 过滤，必须先接住。
  if (msg.__isServerRequest) {
    showApproval(msg);
    return;
  }
  if (m === "lab/autoApproved") {
    const c = p.command;
    addCard("probe", "查询命令已自动放行", Array.isArray(c) ? c.join(" ") : String(c ?? ""));
    return;
  }
  if (m === "lab/innerLoop") {
    // 「结束」那行不单独出卡片：紧跟着的账单把同一件事说得更清楚，
    // 两张卡重复同一条消息只是噪音。保留「开始」那行当圈与圈的分界。
    if (!/圈结束/.test(p.text ?? "")) addCard("probe", "内核探针", p.text);
    return;
  }
  // 一圈结束时的账单：这一圈把哪些工具的结果背进了上下文，各有多大。
  if (m === "lab/loopCost") {
    showLoopCost(p);
    return;
  }
  if (p.threadId && threadId && p.threadId !== threadId) return;

  switch (m) {
    case "turn/started":
      currentTurn = p.turn?.id ?? null;
      $("turn-meta").textContent = "运行中";
      if (stopRequested && currentTurn) {
        stopRequested = false;
        stop();
      }
      break;
    case "item/started": {
      const started = p.item;
      upsertItem(started, "started");
      // 占位只在"界面上真的有东西可看"时才撤。
      // reasoning 开始时正文还是空的（内核先建卡、思考文本后面才流过来），
      // 这时撤掉占位就会变成"思考卡空着 + 什么提示都没有"，也就是一闪而过。
      if (started?.type === "reasoning") {
        startLiveReasoning(started.id, itemNodes.get(started.id));
        hideThinking(); // 思考卡自己接着显示"思考中… Ns"
      } else if (started?.type && started.type !== "userMessage" && THINKING_CLEARING_TYPES.has(started.type)) {
        hideThinking();
      }
      break;
    }
    case "item/completed": {
      const done = p.item;
      if (done?.type === "reasoning") stopLiveReasoning(done.id);
      if (done?.type && done.type !== "userMessage") hideThinking();
      if (done?.id) {
        const el = itemNodes.get(done.id);
        if (el) delete el.dataset.renderPending;
      }
      upsertItem(done, "completed");
      break;
    }
    case "item/agentMessage/delta": {
      hideThinking();
      const el = p.itemId ? itemNodes.get(p.itemId) : null;
      if (el) {
        // 流式片段累加后整段重渲染：Markdown 语法（代码块、列表）
        // 只有拿到完整片段才能正确解析，见半截的 ``` 反而会闪。
        el.dataset.raw = (el.dataset.raw ?? "") + (p.delta ?? "");
        // 使用 requestAnimationFrame 批处理 Markdown 渲染，避免高频流式片段把主线程卡死导致断流或卡顿
        if (!el.dataset.renderPending) {
          el.dataset.renderPending = "1";
          requestAnimationFrame(() => {
            delete el.dataset.renderPending;
            setCardBody(el, el.dataset.raw);
            stream.scrollTop = stream.scrollHeight;
          });
        }
      }
      break;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/delta": {
      const el = p.itemId ? itemNodes.get(p.itemId) : null;
      if (el) {
        // 模型真的在吐思考了：先停掉"思考中…"的计时，再把这帧内容接上去。
        stopLiveReasoning(p.itemId);
        const bodyEl = el.querySelector(".card-body");
        const prev = bodyEl?.textContent || "";
        // 第一帧要把占位文案清掉，不能和真思考内容粘在一起。
        const base = /^思考中/.test(prev) ? "" : prev;
        setCardBody(el, base + (p.delta ?? ""));
        stream.scrollTop = stream.scrollHeight;
      }
      break;
    }
    case "turn/completed":
      hideThinking();
      currentTurn = null;
      stopRequested = false;
      if (compacting) {
        compacting = false;
        const btn = $("compact-btn");
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("loading");
          btn.querySelector("span").textContent = "压缩上下文";
        }
      }
      const status = p.turn?.status;
      $("turn-meta").textContent =
        status === "completed" ? "完成" : status === "interrupted" ? "已停止" : status === "failed" ? "执行失败" : status ?? "";
      if (status === "failed") {
        let msg = p.turn?.error?.message || "上游模型或网关请求失败";
        try {
          const parsed = JSON.parse(msg);
          if (parsed.error?.message) msg = parsed.error.message;
        } catch {}
        addCard("error", "本轮执行失败", msg);
      }
      setBusy(false);
      renderContextMeter();
      break;
    case "thread/tokenUsage/updated": {
      const u = p.tokenUsage;
      if (typeof u?.total?.totalTokens === "number") {
        totalTokens = Math.max(totalTokens, u.total.totalTokens);
      }
      if (typeof u?.last?.inputTokens === "number" || typeof u?.last?.cachedInputTokens === "number") {
        activeContextTokens = (u.last?.inputTokens ?? 0) + (u.last?.cachedInputTokens ?? 0);
      }
      if (typeof u?.modelContextWindow === "number" && u.modelContextWindow > 0) {
        modelContextWindow = u.modelContextWindow;
      }
      renderCost();
      break;
    }
    case "warning":
      // 内核主动报警（比如碰到循环上限）。不显式处理就会被 default 默默丢掉，
      // 用户只看到「跑完了」，不知道为什么停。
      addCard("error", "内核警告", p.message ?? "");
      break;
    case "turn/failed":
      hideThinking();
      currentTurn = null;
      stopRequested = false;
      if (compacting) {
        compacting = false;
        const btn = $("compact-btn");
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("loading");
          btn.querySelector("span").textContent = "压缩上下文";
        }
      }
      addCard("error", "失败", JSON.stringify(p).slice(0, 500));
      setBusy(false);
      renderContextMeter();
      break;
    default:
      break;
  }
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {}
  };
  let hadConnected = false;
  es.onopen = async () => {
    $("status-dot").classList.add("ok");
    if (hadConnected && threadId && currentTurn) {
      // 意外断流重连后从内核同步最新轮次状态，防止漏掉 turn/completed 或最后片段
      try {
        const res = await rpc("thread/read", { threadId, includeTurns: true });
        const turns = res?.thread?.turns ?? [];
        const latestTurn = turns[turns.length - 1];
        if (latestTurn && latestTurn.status !== "in_progress") {
          currentTurn = null;
          $("turn-meta").textContent =
            latestTurn.status === "completed" ? "完成" : latestTurn.status === "interrupted" ? "已停止" : latestTurn.status ?? "";
          setBusy(false);
          hideThinking();
          const items = latestTurn.items ?? [];
          for (const it of items) upsertItem(it, "completed");
        }
      } catch {}
    }
    hadConnected = true;
  };
  es.onerror = () => $("status-dot").classList.remove("ok");
}

// ---------- 动作 ----------
function setBusy(busy) {
  $("send").disabled = busy;
  $("send").title = busy ? "运行中" : "发送";
  // 有轮次在跑的时候才能停。没东西可停，就别摆个按钮在那里。
  $("stop").hidden = !busy;
  $("stop").disabled = false;
  const compactBtn = $("compact-btn");
  if (compactBtn) compactBtn.disabled = busy || compacting;
}

// 建会话不能重入。点「新会话」和点「发送」都可能触发它，如果两次请求同时在飞，
// 后回来的那次会把 threadId 覆盖掉、顺手清空对话区——刚发出去的话就这样没了。
// 所以同一时刻只允许一次，后来的直接等同一个结果。
let startingThread = null;

function newThread() {
  if (!startingThread) {
    startingThread = startThread().finally(() => {
      startingThread = null;
    });
  }
  return startingThread;
}

// 审批规则：只读查询由内核自动放行，其余操作（写文件、装依赖、改库等）一律由用户审批。
// untrusted = 只有内核认定的安全只读命令免审批。每轮 turn/start 都带上，恢复的旧会话也生效。
const APPROVAL_POLICY = "untrusted";

async function startThread() {
  // 允许在工作区目录写入（workspace-write），避免在选定项目中无法直接修改代码。
  // 超出工作区范围的操作依然会走审批闸门。
  // 工作目录跟着上面那个项目选择器走。指定了目录，内核才会在那里加载
  // 项目的 AGENTS.md、也才找得到 ok-cosmic.json——这是苍穹专家能不能
  // 真的干活的分界线（不选就只能在默认目录里讲概念）。
  const res = await rpc("thread/start", {
    cwd: selectedProjectPath(),
    model: null,
    sandbox: "workspace-write",
    approvalPolicy: APPROVAL_POLICY,
  });
  threadId = res.thread.id;
  $("thread-title").textContent = "新会话";
  stream.innerHTML = "";
  itemNodes.clear();
  hideThinking();
  resetCost();
  loadThreads();
}

async function send() {
  const text = input.value.trim();
  if (!text || currentTurn) return;
  if (!threadId) await newThread();

  input.value = "";
  input.style.height = "auto";
  setBusy(true);
  stopRequested = false;
  // 先把它画出来。内核也会回显一条，但那是网络一来一回之后的事；
  // 中间这段时间对话区是空的，看起来像没发出去（尤其是刚发就点停止的时候）。
  const empty = $("empty");
  if (empty) empty.remove();
  localUserEcho = addCard("user", "你", text);
  $("turn-meta").textContent = "启动中";

  try {
    const res = await rpc("turn/start", {
      threadId,
      approvalPolicy: APPROVAL_POLICY,
      input: [{ type: "text", text, textElements: [] }],
    });
    // 请求本身就回了 turn id，不用等 turn/started 通知。否则刚点完发送就点停止，
    // 会因为 currentTurn 还是 null 而没反应。
    currentTurn = res.turn?.id ?? currentTurn;
    $("turn-meta").textContent = "运行中";
    // 从发出到第一个事件之间会有一段空窗，先给个动效占位。
    showThinking();
    if (stopRequested && currentTurn) {
      stopRequested = false;
      stop();
    }
  } catch (err) {
    addCard("error", "发送失败", String(err));
    hideThinking();
    setBusy(false);
    stopRequested = false;
  }
}

// 中断这一轮。内核的 turn/interrupt 只是把 cancellation_token 按下去，
// 循环里每一个 await 都挂在这颗 token 上，所以信号一到，模型请求和正在跑
// 的工具会一起被放弃。停止不代表撤销——已经写过的文件不会自己回去。
async function stop() {
  const btn = $("stop");
  if (!threadId) return;
  if (!currentTurn) {
    // turn/start 还在路上：这次点击先记下来，等 turn id 一到就补发。
    // 只有正在发送时才算数，避免闲置时误记一个“下次自动停”。
    if ($("send").disabled) {
      stopRequested = true;
      $("stop").disabled = true;
      $("stop").title = "停止中…";
    }
    return;
  }
  btn.disabled = true;
  btn.title = "停止中…";
  showThinking("正在停止");
  try {
    // 必须报上内核认得的那一轮 turnId，否则内核会拒绝这个中断。
    await rpc("turn/interrupt", { threadId, turnId: currentTurn });
  } catch (err) {
    addCard("error", "停止失败", String(err));
    btn.disabled = false;
  }
  btn.title = "停止";
}

async function loadThreads() {
  try {
    const res = await rpc("thread/list", {});
    const box = $("threads");
    box.innerHTML = "";
    for (const t of (res.data ?? []).slice(0, 25)) {
      const b = document.createElement("button");
      b.className = "thread";
      b.textContent = t.name || t.preview?.slice(0, 40) || t.id;
      b.title = t.id;
      b.onclick = () => openThread(t.id);
      box.appendChild(b);
    }
  } catch {}
}

// 从内核读回这个会话的历史并渲染出来（thread/read + includeTurns）。
async function openThread(id) {
  threadId = id;
  // 切到别的会话就把当前这一轮从「界面」上放下：它属于原来的会话。
  // （要做到跨会话也能停，得再维护一张 threadId -> turnId 的表，现在不需要。）
  currentTurn = null;
  setBusy(false);
  $("thread-title").textContent = id.slice(0, 8);
  stopRequested = false;
  stream.innerHTML = "";
  itemNodes.clear();
  hideThinking();
  resetCost();
  addCard("tool", "正在读取会话历史…", "");
  try {
    // 关键一步：既要「读历史」，也要「把它恢复成活会话」。
    //
    // 这两件事是分开的，踩过：只调 thread/read 的话，界面能正常显示历史，
    // 但内核的活会话表里没有这个 id；这时一发消息就得到
    //   {"code":-32600,"message":"thread not found: ..."}
    // 而且原始 JSON 是直接摔给用户的。
    //
    // thread/read    = 从磁盘读历史（只读）
    // thread/resume  = 把它重新挂进当前内核进程，之后才能继续对话
    //
    // 先恢复再渲染：恢复不了的话，这个会话本来就发不出消息，得说清楚。
    try {
      await rpc("thread/resume", { threadId: id });
    } catch (err) {
      addCard("tool", "这个会话接不回来了", "内核没能恢复它：" + String(err));
    }

    const res = await rpc("thread/read", { threadId: id, includeTurns: true });
    stream.innerHTML = "";
    const turns = res.thread?.turns ?? [];
    if (!turns.length) {
      addCard("tool", "这个会话还没有内容", "发一条新消息就会继续它。");
      return;
    }
    // 先把历史画出来，再把它计入成本统计，这样切换会话后读数依然准。
    // 历史里没带 token 数，问一下桥有没有缓存过这个会话的最后一个值。
    const usage = await rpc("lab/threadTokens", { threadId: id }).catch(() => ({}));
    if (typeof usage?.total === "number") totalTokens = usage.total;
    if (typeof usage?.activeContext === "number") activeContextTokens = usage.activeContext;
    if (typeof usage?.contextWindow === "number") modelContextWindow = usage.contextWindow;
    renderCost();
    for (const turn of turns) {
      for (const item of turn.items ?? []) {
        renderHistoryItem(item);
      }
      if (turn.status === "failed") {
        let msg = turn.error?.message || "上游模型或网关请求失败";
        try {
          const parsed = JSON.parse(msg);
          if (parsed.error?.message) msg = parsed.error.message;
        } catch {}
        addCard("error", "本轮执行失败", msg);
      }
    }
    const latestTurn = turns[turns.length - 1];
    if (latestTurn) {
      $("turn-meta").textContent =
        latestTurn.status === "completed" ? "完成" : latestTurn.status === "interrupted" ? "已停止" : latestTurn.status === "failed" ? "执行失败" : latestTurn.status ?? "";
    }
  } catch (err) {
    stream.innerHTML = "";
    addCard("error", "历史读取失败", String(err));
  }
}

// 历史条目直接成卡，不进入实时流的 itemNodes（那是增量更新用的）。
function renderHistoryItem(item) {
  const { kind, title } = describe(item);
  const el = addCard(kind, title, renderItemBody(item));
  countToolCost(item, el);
}

// ---------- 绑定 ----------
$("send").onclick = send;
$("new-thread").onclick = newThread;

async function compactCurrentThread() {
  if (!threadId) return;
  if (currentTurn) {
    alert("当前轮次正在执行中，请等待完成或停止后再压缩。");
    return;
  }
  if (compacting) return;
  compacting = true;
  const btn = $("compact-btn");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("loading");
    btn.querySelector("span").textContent = "正在压缩…";
  }
  addCard("probe", "触发上下文压缩", "正在请求模型提炼前序历史摘要，释放活跃上下文空间…");
  try {
    const res = await rpc("thread/compact/start", { threadId });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  } catch (err) {
    compacting = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.querySelector("span").textContent = "压缩上下文";
    }
    addCard("error", "压缩上下文失败", String(err?.message ?? err));
  }
}

$("compact-btn")?.addEventListener("click", compactCurrentThread);

// ---------- 项目选择 ----------
// 苍穹专家技能靠「会话的工作目录」往上找 ok-cosmic.json 和 .opencode/ 那份
// 项目规范。所以这里选的不只是个路径，而是「这次会话算在哪个项目里」。
// 切换后要开新会话才生效（已开始的会话工作目录是定住的）。
const projectSel = $("project");

function selectedProjectPath() {
  const opt = projectSel?.selectedOptions?.[0];
  // 没选就返回 null，内核会用它自己的默认目录（兼容老行为）。
  return opt?.value || null;
}

async function loadProjects() {
  if (!projectSel) return;
  try {
    const res = await fetch("/api/projects").then((r) => r.json());
    const list = res.projects ?? [];
    projectSel.innerHTML = "";
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.path;
      opt.textContent = p.name;
      projectSel.appendChild(opt);
    }
    const show = selectedProjectPath();
    if (show) $("cwd").textContent = show;
  } catch {
    /* 取不到就保持空，startThread 会退回内核默认目录 */
  }
}

projectSel?.addEventListener("change", () => {
  const show = selectedProjectPath();
  if (show) $("cwd").textContent = show;
  // 切换项目直接重置会话上下文，确保后续对话和工具执行真正工作在选中的工作区里
  threadId = null;
  currentTurn = null;
  stream.innerHTML = "";
  const projName = projectSel.options[projectSel.selectedIndex]?.textContent || "工作区";
  $("thread-title").textContent = `新会话 (${projName})`;
  $("turn-meta").textContent = "准备就绪";
  setBusy(false);
  itemNodes.clear();
  approvalNodes.clear();
});

// ---------- 知识编辑 ----------
// 这里改的是 knowledge.md，也就是每次开新会话时注入的那份。「保存」后
// 要开一个新会话才会生效，所以提示里把这一点说清楚。
const modal = $("knowledge-modal");
const kText = $("knowledge-text");

async function openKnowledge() {
  const res = await fetch("/api/knowledge").then((r) => r.json());
  kText.value = res.text ?? "";
  $("knowledge-hint").textContent = "保存后，开一个新会话生效。";
  modal.hidden = false;
  kText.focus();
}

async function saveKnowledge() {
  const btn = $("knowledge-save");
  btn.disabled = true;
  try {
    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: kText.value }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    $("knowledge-hint").textContent = "已保存。开一个新会话生效。";
    addCard("probe", "知识已更新", "新的知识会在下一个新会话里生效。");
  } catch (err) {
    $("knowledge-hint").textContent = "保存失败：" + err;
  }
  btn.disabled = false;
}

$("edit-knowledge").onclick = openKnowledge;
$("knowledge-close").onclick = () => (modal.hidden = true);
$("knowledge-save").onclick = saveKnowledge;
$("stop").onclick = stop;
modal.onclick = (e) => {
  if (e.target === modal) modal.hidden = true;
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});

connect();
loadThreads();
loadProjects();
loadModelPicker();

// ---------- 主题 ----------
// 深浅色只切一个 data-theme 属性，颜色全靠 CSS 变量。
// 选择记在 localStorage：这是纯界面偏好，没必要进服务端设置。
const THEME_KEY = "agent-lab-theme";
function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  const btn = $("theme-toggle");
  if (btn) {
    btn.textContent = next === "light" ? "☀" : "☾";
    btn.title = next === "light" ? "切到深色" : "切到浅色";
  }
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
}
// 首次打开跟随系统；用户手动选过之后以选择为准。
let savedTheme = null;
try {
  savedTheme = localStorage.getItem(THEME_KEY);
} catch {}
applyTheme(savedTheme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("theme-toggle").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
};

// ---------- 技能面板 ----------
const skillsModal = $("skills-modal");

function renderSkills(skills, errors) {
  const box = $("skill-list");
  box.innerHTML = "";
  for (const s of skills ?? []) {
    const row = document.createElement("div");
    row.className = "skill-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!s.enabled;
    // 用 name 写：路径可能被软链替换，name 更稳。
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const res = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: s.name, enabled: cb.checked }),
        }).then((r) => r.json());
        if (res.error) throw new Error(res.error);
        renderSkills(res.skills, []);
        $("skills-hint").textContent = "已保存。新会话生效。";
      } catch (err) {
        cb.checked = !cb.checked;
        cb.disabled = false;
        $("skills-hint").textContent = "切换失败：" + err;
      }
    };
    const meta = document.createElement("div");
    meta.className = "skill-meta";
    const name = document.createElement("div");
    name.className = "skill-name";
    name.textContent = s.name + (s.pluginId ? ` · ${s.pluginId}` : "");
    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = (s.interface?.shortDescription || s.description || "").slice(0, 160);
    meta.append(name, desc);
    const scope = document.createElement("span");
    scope.className = "skill-scope";
    scope.textContent = s.scope ?? "";
    row.append(cb, meta, scope);
    box.appendChild(row);
  }
  if (errors?.length) {
    const err = document.createElement("div");
    err.className = "skill-desc";
    err.textContent = "有技能加载失败：" + errors.map((e) => e.path || e.message).join(", ");
    box.appendChild(err);
  }
}

async function loadSkills() {
  const cwd = selectedProjectPath() || "";
  const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json());
  if (res.error) throw new Error(res.error);
  renderSkills(res.skills, res.errors);
}

$("open-skills").onclick = async () => {
  skillsModal.hidden = false;
  $("skills-hint").textContent = "正在读取技能清单…";
  try {
    await loadSkills();
    $("skills-hint").textContent = "勾选开关会在新会话生效；「加入技能」立即接入。";
  } catch (err) {
    $("skills-hint").textContent = "读取失败：" + err;
  }
};
$("skills-close").onclick = () => (skillsModal.hidden = true);
skillsModal.onclick = (e) => {
  if (e.target === skillsModal) skillsModal.hidden = true;
};

$("skill-link").onclick = async () => {
  const target = $("skill-path").value.trim();
  if (!target) return;
  $("skills-hint").textContent = "正在接入…";
  try {
    const res = await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkTo: target }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    $("skill-path").value = "";
    renderSkills(res.skills, []);
    $("skills-hint").textContent = `已接入 ${res.linked.name}。新会话生效。`;
  } catch (err) {
    $("skills-hint").textContent = "接入失败：" + err;
  }
};

// ---------- 新增工作区 ----------
// 读接口一律先看 HTTP 状态、再看内容类型。旧写法直接 r.json()，
// 一旦路由没命中就会把服务器返回的 "not found" 当成 JSON 去解析，
// 用户看到的是 `Unexpected token 'o'`，完全看不出真正错在哪（踩过）。
async function readJsonResponse(res, what) {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    const text = (await res.text()).slice(0, 120);
    throw new Error(`${what} 接口没有返回 JSON（HTTP ${res.status}）：${text || "空响应"}`);
  }
  const body = await res.json();
  if (!res.ok || body?.error) throw new Error(body?.error || `${what} 失败（HTTP ${res.status}）`);
  return body;
}

$("add-workspace").onclick = async () => {
  try {
    // 先弹系统目录选择器；用户取消就什么都不做。
    const pickRes = await fetch("/api/pick-directory", { method: "POST" });
    const picked = await readJsonResponse(pickRes, "目录选择");
    if (picked.canceled || !picked.path) return;
    const name = prompt("给这个工作区起个名字：", picked.path.split(/[\\/]/).filter(Boolean).pop() || picked.path);
    if (name === null) return; // 用户取消起名，就不要加
    const projRes = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: picked.path, name }),
    });
    await readJsonResponse(projRes, "新增工作区");
    await loadProjects();
    projectSel.value = picked.path;
    $("cwd").textContent = picked.path;
    addCard("probe", "工作区已加入", `${name || picked.path}\n开一个新会话就会在这里工作。`);
  } catch (err) {
    addCard("error", "加入工作区失败", String(err));
  }
};

// ---------- 模型设置面板 ----------
const modelsModal = $("models-modal");
let editingProviderId = null;

function providerFields(p) {
  $("provider-name").value = p?.name ?? "";
  $("provider-url").value = p?.baseUrl ?? "";
  $("provider-wire").value = p?.wireApi === "chat" ? "chat" : "responses";
  $("provider-key").value = "";
  $("provider-key").placeholder = p?.hasKey ? "已保存（留空不改）" : "粘贴上游 API Key";
}

function renderProviderSelect(s, selectId) {
  const sel = $("provider-select");
  sel.innerHTML = "";
  for (const p of s.providers ?? []) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name}${p.id === s.activeProvider ? " · 使用中" : ""}`;
    sel.appendChild(opt);
  }
  if (selectId) sel.value = selectId;
}

async function openModels() {
  const s = await fetchSettings();
  renderProviderSelect(s, s.activeProvider);
  editingProviderId = s.activeProvider;
  providerFields(s.providers.find((p) => p.id === editingProviderId));
  renderUpstream(s.providers.find((p) => p.id === editingProviderId)?.models ?? [], s.activeModel);
  $("models-hint").textContent = "改完点「保存并启用」。同 provider 内切模型立即生效，不用重启内核。";
  modelsModal.hidden = false;
}

function renderUpstream(models, activeModel) {
  const box = $("upstream-models");
  box.innerHTML = "";
  if (!models.length) {
    box.textContent = "还没有模型。点「从上游获取模型」或先保存。";
    return;
  }
  for (const m of models) {
    const b = document.createElement("button");
    b.className = "chip" + (m === activeModel ? " active" : "");
    b.textContent = m;
    b.onclick = async () => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeModel: m }),
      }).then((r) => r.json());
      if (res.error) { addCard("error", "切换模型失败", String(res.error)); return; }
      currentSettings.activeModel = res.activeModel;
      renderComposerControls();
      renderUpstream(models, res.activeModel);
      $("models-hint").textContent = `当前模型：${res.activeModel}`;
    };
    box.appendChild(b);
  }
}

$("open-models").onclick = openModels;
$("models-close").onclick = () => (modelsModal.hidden = true);
$("provider-select").onchange = () => {
  editingProviderId = $("provider-select").value;
  const p = currentSettings.providers.find((x) => x.id === editingProviderId);
  providerFields(p);
  renderUpstream(p?.models ?? [], currentSettings.activeModel);
};
$("provider-new").onclick = () => {
  editingProviderId = null;
  providerFields(null);
  renderUpstream([], null);
  $("models-hint").textContent = "填 Base URL 和 API Key 后点「从上游获取模型」，再点「保存并启用」。";
};

$("provider-fetch").onclick = async () => {
  const hint = $("models-hint");
  hint.textContent = "正在从上游获取模型…";
  try {
    const res = await fetch("/api/models/upstream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: $("provider-url").value.trim(),
        apiKey: $("provider-key").value.trim(),
        providerId: editingProviderId,
      }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    hint.textContent = `从 ${res.from} 拿到 ${res.models.length} 个模型。`;
    renderUpstream(res.models, currentSettings.activeModel);
  } catch (err) {
    hint.textContent = "拉取失败：" + err;
  }
};

$("provider-save").onclick = async () => {
  const hint = $("models-hint");
  hint.textContent = "保存中…";
  const provider = {
    id: editingProviderId || $("provider-name").value.trim(),
    name: $("provider-name").value.trim(),
    baseUrl: $("provider-url").value.trim(),
    wireApi: $("provider-wire").value,
    apiKey: $("provider-key").value.trim(),
    models: [...$("upstream-models").querySelectorAll(".chip")].map((c) => c.textContent),
    activate: true,
  };
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    editingProviderId = res.activeProvider;
    await loadModelPicker();
    // provider 换了之后模型元数据也可能变，重拉一次内核清单。
    kernelModelsLoaded = false;
    await fetchKernelModels();
    renderProviderSelect(currentSettings, res.activeProvider);
    hint.textContent = res.restarted ? "已保存并启用，内核已重启。" : "已保存并启用。";
  } catch (err) {
    hint.textContent = "保存失败：" + err;
  }
};

$("provider-delete").onclick = async () => {
  if (!editingProviderId) return;
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removeProvider: editingProviderId }),
  }).then((r) => r.json());
  if (res.error) { $("models-hint").textContent = "删除失败：" + res.error; return; }
  await openModels();
};

modelsModal.onclick = (e) => {
  if (e.target === modelsModal) modelsModal.hidden = true;
};

// ---------- 模型：侧边栏快捷切换 ----------
// 模型列表来自本机 settings（provider 的 models 字段），切一下就写回配置。
// 同 provider 内切换不需重启内核：下一轮 turn/start 会带上新模型。
// ---------- 模型与思考强度：输入框内菜单 ----------
// 模型列表来自本机 settings（provider 的 models 字段），切一下就写回配置。
// 同 provider 内切换不需重启内核：下一轮 turn/start 会带上新模型。
// 每个模型能选哪些思考强度来自内核 model/list 的元数据，不再硬编码，}
// 也就不会出现「模型根本不支持这个档位」的死选项。
const modelMenu = $("model-menu");
const effortMenu = $("effort-menu");
const modelBtn = $("model-btn");
const effortBtn = $("effort-btn");
let currentSettings = null;
let kernelModels = [];
let kernelModelsLoaded = false;

// 强度的显示名。内核返回的是 low/medium/high/...，这里给人话。
const EFFORT_LABELS = {
  none: "不思考",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极限",
};
const effortLabel = (e) => EFFORT_LABELS[e] ?? e;

async function fetchSettings() {
  const res = await fetch("/api/settings").then((r) => r.json());
  currentSettings = res;
  return res;
}

// 内核的模型元数据（含 supportedReasoningEfforts）只拉一次就缓存。
async function fetchKernelModels() {
  if (kernelModelsLoaded) return kernelModels;
  try {
    const res = await fetch("/api/models/kernel").then((r) => r.json());
    kernelModels = res.models ?? [];
    kernelModelsLoaded = true;
  } catch {
    kernelModels = [];
  }
  return kernelModels;
}

function modelMeta(id) {
  return kernelModels.find((m) => m.id === id || m.model === id) ?? null;
}

// 当前模型支持哪些强度。内核没给出元数据时退回一组常用档位，
// 而不是把强度选项整块藏起来——那会让人以为这个功能不存在。
function supportedEfforts(model) {
  const meta = modelMeta(model);
  const list = meta?.supportedReasoningEfforts ?? meta?.supported_reasoning_levels ?? [];
  const ids = list.map((x) => x.reasoningEffort ?? x.effort).filter(Boolean);
  return ids.length ? ids : ["low", "medium", "high"];
}

// 菜单项要带上内核给的说明（ChatGPT 也是这么写的），比只摆一个英文代号好认。
function effortOptions(model) {
  const meta = modelMeta(model);
  const list = meta?.supportedReasoningEfforts ?? meta?.supported_reasoning_levels ?? [];
  const opts = list
    .map((x) => ({ id: x.reasoningEffort ?? x.effort, description: x.description ?? "" }))
    .filter((x) => x.id);
  if (opts.length) return opts;
  return ["low", "medium", "high"].map((id) => ({ id, description: "" }));
}

function defaultEffort(model) {
  const meta = modelMeta(model);
  return meta?.defaultReasoningEffort ?? meta?.default_reasoning_level ?? "medium";
}

function closeMenus() {
  modelMenu.hidden = true;
  effortMenu.hidden = true;
  modelBtn.classList.remove("open");
  effortBtn.classList.remove("open");
}

function toggleMenu(menu, btn) {
  const willOpen = menu.hidden;
  closeMenus();
  if (willOpen) {
    menu.hidden = false;
    btn.classList.add("open");
  }
}

function currentProvider(s) {
  return (s?.providers ?? []).find((p) => p.id === s?.activeProvider) ?? s?.providers?.[0] ?? null;
}

function renderModelButton(s) {
  const model = s?.activeModel || "未选择模型";
  $("model-btn-label").textContent = model;
  modelBtn.title = (s?.activeHasKey === false ? "这个 provider 还没配密钥。\n" : "") + "当前模型：" + model;
}

function renderEffortButton(s) {
  const model = s?.activeModel;
  const effort = s?.reasoningEffort ?? defaultEffort(model);
  $("effort-btn-label").textContent = `思考强度 · ${effortLabel(effort)}`;
  effortBtn.title = "当前模型的思考强度：" + effortLabel(effort);
}

function renderModelMenu(s) {
  modelMenu.innerHTML = "";
  const provider = currentProvider(s);
  const models = provider?.models?.length ? provider.models : s?.activeModel ? [s.activeModel] : [];
  if (!models.length) {
    const hint = document.createElement("div");
    hint.className = "menu-title";
    hint.textContent = "还没有模型，先去「模型设置」拉一份。";
    modelMenu.appendChild(hint);
    return;
  }
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = provider?.name ? `来自 ${provider.name}` : "选择模型";
  modelMenu.appendChild(title);

  for (const m of models) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = m === s.activeModel ? "✓" : "";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = m;
    b.append(check, label);
    b.onclick = async () => {
      closeMenus();
      if (m === currentSettings.activeModel) return;
      await switchModel(m);
    };
    modelMenu.appendChild(b);
  }
}

function renderEffortMenu(s) {
  effortMenu.innerHTML = "";
  const model = s?.activeModel;
  const efforts = effortOptions(model);
  const active = s?.reasoningEffort ?? defaultEffort(model);
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = "思考强度";
  effortMenu.appendChild(title);

  for (const e of efforts) {
    const effortId = e.id;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = effortId === active ? "✓" : "";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = effortLabel(effortId);
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = e.description || effortId;
    b.append(check, label, sub);
    b.onclick = async () => {
      closeMenus();
      if (effortId === currentSettings.reasoningEffort) return;
      await switchEffort(effortId);
    };
    effortMenu.appendChild(b);
  }
}

function renderComposerControls() {
  if (!currentSettings) return;
  renderModelButton(currentSettings);
  renderEffortButton(currentSettings);
  renderModelMenu(currentSettings);
  renderEffortMenu(currentSettings);
}

async function switchModel(model) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeModel: model }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    currentSettings.activeModel = res.activeModel;
    // 换模型可能换掉可选强度集合。原来那一档如果新模型不支持，
    // 就落到新模型的默认档，避免设置里留着一个内核不认的值。
    const efforts = supportedEfforts(res.activeModel);
    if (!efforts.includes(currentSettings.reasoningEffort)) {
      currentSettings.reasoningEffort = defaultEffort(res.activeModel);
      await saveEffort(currentSettings.reasoningEffort);
    }
    renderComposerControls();
    addCard("probe", "模型已切换", `下一个轮次使用 ${res.activeModel}`);
  } catch (err) {
    addCard("error", "切换模型失败", String(err));
  }
}

async function saveEffort(effort) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reasoningEffort: effort }),
  }).then((r) => r.json());
  if (res.error) throw new Error(res.error);
  currentSettings.reasoningEffort = effort;
}

async function switchEffort(effort) {
  try {
    await saveEffort(effort);
    renderComposerControls();
    addCard("probe", "思考强度已调整", `下一个轮次使用「${effortLabel(effort)}」`);
  } catch (err) {
    addCard("error", "调整思考强度失败", String(err));
  }
}

modelBtn.onclick = (e) => {
  e.stopPropagation();
  toggleMenu(modelMenu, modelBtn);
};
effortBtn.onclick = (e) => {
  e.stopPropagation();
  toggleMenu(effortMenu, effortBtn);
};
modelMenu.onclick = (e) => e.stopPropagation();
effortMenu.onclick = (e) => e.stopPropagation();
document.addEventListener("click", closeMenus);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
});

async function loadModelPicker() {
  try {
    await fetchSettings();
    await fetchKernelModels();
    // 设置里存的强度如果当前模型不支持（换过模型、或手改过配置文件），
    // 界面要如实显示内核认得的那个值，而不是显示一个用不上的档位。
    const efforts = supportedEfforts(currentSettings.activeModel);
    if (currentSettings.reasoningEffort && !efforts.includes(currentSettings.reasoningEffort)) {
      currentSettings.reasoningEffort = defaultEffort(currentSettings.activeModel);
    }
    renderComposerControls();
  } catch {
    /* 拉不到就保持空 */
  }
}
