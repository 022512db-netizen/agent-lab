// Agent Lab 前端：对话 + 实时事件流
const $ = (id) => document.getElementById(id);
const stream = $("stream");
const input = $("input");

let threadId = null;
let currentTurn = null;

// ---------- 成本可见化 ----------
// 上下文里最贵的不是你说的话，是工具吐回来的东西。这里把每条工具
// 返回的体积量出来，并把内核报的累计用量显示在顶部。
// （数据本来就跟着事件到达，不需要改内核。）
let totalTokens = 0;
let toolBytes = 0;
let toolCalls = 0;

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

function renderCost() {
  const el = $("cost");
  if (!el) return;
  if (!totalTokens && !toolCalls) {
    el.textContent = "";
    return;
  }
  // 历史回放时拿不到 token 数（历史里没有），就别编一个 0 出来骗人。
  const tokenPart = totalTokens
    ? `累计 <b>${totalTokens.toLocaleString()}</b> token · `
    : "历史会话（token 用量未记录）· ";
  // innerHTML 里只插我们自己算出来的数字，没有外部文本。
  el.innerHTML = tokenPart + `工具返回 <b>${toolCalls}</b> 次 / <b>${human(toolBytes)}</b>`;
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

function addCard(kind, title, body) {
  const el = document.createElement("article");
  el.className = `card ${kind}`;
  el.innerHTML = `<div class="card-title"></div><div class="card-body"></div>`;
  el.querySelector(".card-title").textContent = title;
  el.querySelector(".card-body").textContent = body ?? "";
  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
  return el;
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
  const body = renderItemBody(item);
  if (body !== null) el.querySelector(".card-body").textContent = body;
  if (phase === "completed") countToolCost(item);
  stream.scrollTop = stream.scrollHeight;
}

// 一条工具调用到底往上下文里塞了多少东西？
// 参数和返回都算进去，因为两者都会原样进入下一圈的上下文。
const counted = new Set();

function resetCost() {
  totalTokens = 0;
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
      return { kind: "agent", title: "Codex" };
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
    case "commandExecution":
      return `${item.command ?? ""}\n${item.aggregatedOutput ?? ""}`.trim();
    case "mcpToolCall":
      return JSON.stringify(item.arguments ?? {}, null, 2);
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
      break;
    case "item/started":
      upsertItem(p.item, "started");
      break;
    case "item/completed":
      upsertItem(p.item, "completed");
      break;
    case "item/agentMessage/delta": {
      const el = p.itemId ? itemNodes.get(p.itemId) : null;
      if (el) {
        const body = el.querySelector(".card-body");
        body.textContent += p.delta ?? "";
        stream.scrollTop = stream.scrollHeight;
      }
      break;
    }
    case "turn/completed":
      currentTurn = null;
      // 内核把被停掉的轮次报成 interrupted，翻译一下，别让人去猜英文。
      const status = p.turn?.status;
      $("turn-meta").textContent =
        status === "completed" ? "完成" : status === "interrupted" ? "已停止" : status ?? "";
      setBusy(false);
      break;
    case "thread/tokenUsage/updated": {
      // 内核报的累计用量。这是真正在涨的那个数字，也是账单的来源。
      const t = p.tokenUsage?.total?.totalTokens;
      if (typeof t === "number") {
        totalTokens = Math.max(totalTokens, t);
        renderCost();
      }
      break;
    }
    case "warning":
      // 内核主动报警（比如碰到循环上限）。不显式处理就会被 default 默默丢掉，
      // 用户只看到「跑完了」，不知道为什么停。
      addCard("error", "内核警告", p.message ?? "");
      break;
    case "turn/failed":
      currentTurn = null;
      addCard("error", "失败", JSON.stringify(p).slice(0, 500));
      setBusy(false);
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
  es.onopen = () => $("status-dot").classList.add("ok");
  es.onerror = () => $("status-dot").classList.remove("ok");
}

// ---------- 动作 ----------
function setBusy(busy) {
  $("send").disabled = busy;
  $("send").textContent = busy ? "运行中…" : "发送";
  // 有轮次在跑的时候才能停。没东西可停，就别摆个按钮在那里。
  $("stop").hidden = !busy;
  $("stop").disabled = false;
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

async function startThread() {
  // 默认只读沙箱：agent 想动任何东西都要先问你。
  // 这是安全的默认值，也是理解审批机制的入口。
  // 工作目录跟着上面那个项目选择器走。指定了目录，内核才会在那里加载
  // 项目的 AGENTS.md、也才找得到 ok-cosmic.json——这是苍穹专家能不能
  // 真的干活的分界线（不选就只能在默认目录里讲概念）。
  const res = await rpc("thread/start", {
    cwd: selectedProjectPath(),
    model: null,
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
  threadId = res.thread.id;
  $("thread-title").textContent = "新会话";
  stream.innerHTML = "";
  itemNodes.clear();
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
  // 先把它画出来。内核也会回显一条，但那是网络一来一回之后的事；
  // 中间这段时间对话区是空的，看起来像没发出去（尤其是刚发就点停止的时候）。
  const empty = $("empty");
  if (empty) empty.remove();
  localUserEcho = addCard("user", "你", text);
  $("turn-meta").textContent = "启动中";

  try {
    const res = await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text, textElements: [] }],
    });
    // 请求本身就回了 turn id，不用等 turn/started 通知。否则刚点完发送就点停止，
    // 会因为 currentTurn 还是 null 而没反应。
    currentTurn = res.turn?.id ?? currentTurn;
  } catch (err) {
    addCard("error", "发送失败", String(err));
    setBusy(false);
  }
}

// 中断这一轮。内核的 turn/interrupt 只是把 cancellation_token 按下去，
// 循环里每一个 await 都挂在这颗 token 上，所以信号一到，模型请求和正在跑
// 的工具会一起被放弃。停止不代表撤销——已经写过的文件不会自己回去。
async function stop() {
  if (!threadId || !currentTurn) return;
  const btn = $("stop");
  btn.disabled = true;
  btn.textContent = "停止中…";
  try {
    // 必须报上内核认得的那一轮 turnId，否则内核会拒绝这个中断。
    await rpc("turn/interrupt", { threadId, turnId: currentTurn });
  } catch (err) {
    addCard("error", "停止失败", String(err));
    btn.disabled = false;
  }
  btn.textContent = "停止";
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
  stream.innerHTML = "";
  itemNodes.clear();
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
    if (typeof usage?.total === "number") {
      totalTokens = usage.total;
      renderCost();
    }
    for (const turn of turns) {
      for (const item of turn.items ?? []) {
        renderHistoryItem(item);
      }
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
  // 已经开过会话就提醒一句：换项目要点新会话，不然还是旧目录。
  if (threadId) addCard("probe", "换了项目", "开一个新会话才会在新目录里工作。");
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
