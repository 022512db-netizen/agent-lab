#!/usr/bin/env node
// 我的联网搜索工具服务（MCP）。
//
// 为什么需要它：Codex 内核自带一个「托管搜索」工具，名字就叫 web_search。
// 但托管的意思是「由模型服务方提供搜索结果」，而 Agent Lab 用的是本地中转，
// 那里没有这个端点（实测 /v1/alpha/search 返回 404）。于是模型一调就得到：
//   unsupported custom tool call: web_search
// 结果就是：模型想联网，但一个字都查不到。
//
// 解法分两步（这才是根因，不是补个提示词）：
//   1) 配置里把托管搜索关掉（web_search = "disabled"），别再向模型许诺一个兑现不了的工具；
//   2) 就是本文件：自己实现一个真能用的搜索工具，走 MCP 插座接进去。
//
// 后端为什么这么选：先试了 Bing 的 RSS 输出（format=rss），结果**根本不能用**——
// 实测搜「openai codex github」返回的是波兰门户网站 wp.pl 的首页（多次复现），
// 和查询毫无关系。搜索工具返回错东西比报错更危险：模型会拿它当事实。
//
// 所以改成两个 HTML 后端叠加：Brave 优先（实测第一条就是目标仓库，准），
// 但它会限流（连续请求就给 429），429 时自动退到 Bing 的 HTML 结果。
// 单个后端都有脾气，这就是为什么要留第二个。
// 零依赖，只用 Node 标准库。
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// 工具返回的体积直接决定成本：它会被塞进下一圈上下文，而整个上下文每转一圈
// 都要重发一次。知识库那次实测（一次回 40 KB 导致多转四圈）是同一课，
// 所以这里从一开始就卡死返回体积。
const MAX_RESULTS = 8;
const SNIPPET_CHARS = 280;
const TOTAL_CHARS = 4000;

// 外部搜索地址可以用环境变量换掉（比如换成自己的 SearXNG）。
const BRAVE_URL = process.env.MY_SEARCH_URL ?? "https://search.brave.com/search";
const BING_URL = "https://www.bing.com/search";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const TOOLS = [
  {
    name: "web_search",
    description:
      "联网搜索，返回相关网页的标题、链接和摘要。当问题涉及最新版本、时效性信息、或知识库里没有的公开资料时用它。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，越具体越好" },
        limit: { type: "number", description: `最多返回几条，默认 ${MAX_RESULTS}` },
      },
      required: ["query"],
    },
    // 只是读公开网页，不动本地任何东西，所以声明只读：内核就不会弹审批。
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// ---------- HTML 解析 ----------
// 不引 HTML 解析库：只取三样东西（链接、标题、摘要），正则够用且没有依赖。
// 但实体解码不能省，搜索结果里 &amp; &#39; 到处都是。
export function decodeEntities(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // 必须最后做，否则 &amp;lt; 会被解成 <
}

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// Brave 的每条结果是一个 <div class="snippet ..." data-type="web"> 块，
// 块里依次是：结果链接（带 title 属性的锚）、标题、摘要。
export function parseBrave(html) {
  const blocks = String(html).split(/<div class="snippet [^"]*"[^>]*data-type="web"/i).slice(1);
  const out = [];
  for (const block of blocks) {
    // 取块内第一个「像正文链接」的 https 链接。Brave 会给 favicon、内链等，
    // 所以优先用 data-type 块里第一个指向外部站点的锚。
    const hrefs = [...block.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
      .map((m) => decodeEntities(m[1]))
      .filter((u) => !/^https?:\/\/(www\.)?(search\.)?brave\.com/i.test(u));
    const url = hrefs[0];
    if (!url) continue;

    const titleAttr = block.match(/class="[^"]*search-snippet-title[^"]*"[^>]*title="([^"]*)"/i);
    const title = titleAttr ? decodeEntities(titleAttr[1]).trim() : "";

    // 摘要在 generic-snippet 里，剥掉标签就是正文。
    const snipMatch = block.match(/class="[^"]*generic-snippet[^"]*"[\s\S]*?<div class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]).replace(/^\d+\s*(days?|hours?|months?|years?)\s*ago\s*-\s*/i, "") : "";

    if (title) out.push({ title, url, snippet });
  }
  return out;
}

// Bing 的每条结果是一个 <li class="b_algo"> 块。它的链接是 bing.com/ck/a 跳转，
// 真实地址藏在 u=a1<base64url> 参数里，所以要解出来，不能把跳转链接给模型。
export function parseBing(html) {
  const blocks = String(html).split(/<li class="b_algo"/i).slice(1);
  const out = [];
  for (const block of blocks) {
    const href = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/i)?.[1] ?? "";
    let url = decodeEntities(href);
    const b64 = url.match(/[?&]u=a1([^&"]+)/i);
    if (b64) {
      try {
        let s = b64[1].replace(/-/g, "+").replace(/_/g, "/");
        while (s.length % 4) s += "=";
        url = Buffer.from(s, "base64").toString("utf8");
      } catch {
        /* 解不出来就退回原链接 */
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;

    const title = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    // 摘要在 b_caption 的段落里，可能夹着日期 span。
    const cap = block.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({
      title: title ? stripTags(title[1]) : "",
      url,
      snippet: cap ? stripTags(cap[1]) : "",
    });
  }
  return out.filter((r) => r.title);
}

// ---------- 搜索实现 ----------
// 一个后端取一次页面。返回 { html } 或 { err }，不抛异常——
// 上层要拿失败原因决定要不要换下一个后端。
async function fetchBackend(url, q) {
  // 注意：Bing 不能带 setlang/cc 这类参数，实测带了之后它会返回一批跟查询
  // 完全无关的填充内容（搜 codex 回「美国独立日」），而且不加参数时是稳定的。
  const target = url + "?q=" + encodeURIComponent(q);
  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { err: "HTTP " + res.status };
    return { html: await res.text() };
  } catch (err) {
    return { err: err?.message ?? String(err) };
  }
}

// 备用通道：用系统自带的 curl 再试一次。
//
// 为什么需要这个（2026-09-23 实测挖出来的）：
// 同一时刻、同一个 URL、同样的 UA，`curl` 拿到 200 和完整页面，
// 而 Node 的 fetch 拿到 429——试过换各种请求头（裸请求、完整 Chrome 安全头）都还是 429。
// 差别不在请求头，在两个客户端底层 TLS/HTTP 连接不同，被对方按指纹区分了。
// 这不是「偶尔限流」，是个稳定复现的客户端差异，所以加这条退路。
//
// 两个系统都自带 curl（Windows 10+ / macOS），所以不引入任何依赖。
// 失败时静默返回错误，让上层照旧换下一个后端。
const runFile = promisify(execFile);
async function fetchViaCurl(target) {
  try {
    const { stdout } = await runFile(
      "curl",
      ["-s", "-L", "--max-time", "25", "-A", UA, "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8", target],
      // 页面可能有几百 KB；给足缓冲，否则 execFile 会因为超过上限报错。
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
    );
    return stdout && stdout.length > 500 ? { html: stdout } : { err: "curl 返回内容为空" };
  } catch (err) {
    return { err: "curl: " + (err?.message ?? String(err)).slice(0, 120) };
  }
}

// 相关性闸门。
// 这个函数拦的是一类特别隐蔽的失败：后端**返回了 200 和一堆结果**，但内容跟
// 查询毫无关系。实测踩到两回：
//   - Bing 的 RSS 输出把「openai codex github」答成波兰门户 wp.pl 的首页；
//   - 不带会话去请求 Bing 的 HTML，它会把结果换成一堆填充内容（搜的是 codex，
//     回来的是「美国独立日」「iPhone 18 Pro」）。
// 这种时候报错反而是对的：模型拿垃圾当事实，比让它知道「这次没查到」危险得多。
// 判据有两道：
//   1. 单条结果：查询里的词至少有一个出现在它的标题/网址/摘要里；
//   2. 整批结果：至少三分之一能对上——这条是为了堵一个真实漏洞。
//      第一版只写了「有任何一条对上就放行」，结果 8 条里混进 1 条沾边的，
//      整批 7 条垃圾就一起被当成结果送出去了，测试随即变红。
// 过不了闸门的结果会被丢掉，只剩对得上的那些。
// ponytail: 粗糙的关键词重叠，够拦住「完全无关」；要做排序质量再上真正的相关性模型。
function relevantScore(result, terms) {
  const hay = (result.title + " " + result.url + " " + result.snippet).toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits;
}

function filterRelevant(results, query) {
  const terms = keywordTerms(query);
  if (!terms.length) return results; // 无法判断就不拦
  // 单条结果的最低命中数。这一条是 2026-09-23 补的，因为踩到一个真实后果：
  // 查询「github.com/openai/codex latest releases」时，GitHub 的**首页**和**登录页**
  // 也能凑出 2 分（`github` + 域名后缀 `com`），于是被判成相关一同返回。
  // 模型拿到这些泛泛结果，以为「快找到了」，就换个词再搜——实测一轮里连搜了 19 次，
  // 最后既没收尾也没给出来源。这不是模型笨，是工具把噪声当成了有效结果。
  // 所以除了「整批不能全是垃圾」，还得要求**单条**也得够格。
  // 词多的时候要求命中 2 个，单个词的查询放宽到 1（否则正常查询反而被一刀切死）。
  const minHits = terms.length >= 3 ? 2 : 1;
  const scored = results
    .map((r) => ({ result: r, score: relevantScore(r, terms) }))
    .filter((x) => x.score >= minHits);
  // 能对上的太少 = 后端给的是填充内容，整批不可信。
  //
  // 判据改过两版，都是被真实数据打出来的：
  //   - 第一版「有任何一条对上就放行」：8 条里混进 1 条沾边的，另外 7 条垃圾一起送出去；
  //   - 第二版加了比例门槛（占三分之一）：又变得太严，正常搜索也常被误杀。
  //
  // 最后用绝对条数，因为「填充内容」和「正常结果」的差别不在于比例，
  // 而在于**能不能对上**：填充内容是一整批地不相关（实测 10 条里 0 条带查询词），
  // 正常结果则是一批里对得上的不少。所以门槛就定成「至少两条承重」。
  //
  // 只有两三批结果时要求一条，避免小样本被误杀。
  const minNeeded = results.length >= 4 ? 2 : 1;
  if (scored.length < minNeeded) return [];
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.result);
}

// 这些词对「定位到具体页面」没帮助，但几乎每条结果里都有，
// 留着会把闸门变成摆设：查 `github.com/openai/codex` 时，`com` 这个域名后缀
// 就能让 GitHub 首页得 2 分、被判成相关。实测就是这么污染了结果。
// 只滤纯基础设施词，不滤 github/openai/codex 这类真正带定位信息的词。
const STOPWORDS = new Set(["com", "www", "http", "https", "html", "the", "and", "latest", "releases"]);

function keywordTerms(query) {
  const isCjk = (t) => /[\u4e00-\u9fff]/.test(t);
  return String(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => (isCjk(t) ? t.length >= 2 : t.length >= 3));
}

function looksRelevant(results, query) {
  return filterRelevant(results, query).length > 0;
}

// ---------- 限流 ----------
// 这是这个文件里最实际的一段。实测结论：
//   - Brave 结果准（第一条就是目标仓库），但连着请求几次就给 429；
//   - Bing 的 HTML 会时不时返回完全无关的填充内容（搜 codex 回星座运势、iPhone 广告）。
// 所以策略是：Brave 当主力，但**排队 + 限速**，别把它惹毛；
// 真被限流了就冷一会儿，这段时间退回 Bing，并且靠下面的相关性闸门把垃圾挡掉。
//
// ponytail: 进程内的简单串行队列，重启就忘；要跨进程/多实例再上外部状态。
// 间隔和冷却时长都是实测调出来的：间隔太短（试过 3 秒）连着几次就 429；
// 冷却 60 秒又太保守、白等，实测约 30 秒就恢复了。
const MIN_INTERVAL_MS = Number(process.env.MY_SEARCH_MIN_INTERVAL_MS ?? 8000);
const COOLDOWN_MS = Number(process.env.MY_SEARCH_COOLDOWN_MS ?? 30_000);

let braveBlockedUntil = 0;
let braveChain = Promise.resolve(); // 把并发请求串成一条队，避免并发触发限流
let braveLastAt = 0;

// 排队跑一个 Brave 请求：同一时刻只有一个在飞，且两次之间至少隔 MIN_INTERVAL_MS。
function braveThrottled(fn) {
  const run = braveChain.then(async () => {
    const wait = braveLastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      braveLastAt = Date.now();
    }
  });
  // 链上不能让失败把后面全废掉，所以吞掉异常继续排队。
  braveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function search({ query = "", limit = MAX_RESULTS } = {}) {
  const q = String(query).trim();
  if (!q) return "请提供搜索关键词。";

  const count = Math.max(1, Math.min(Number(limit) || MAX_RESULTS, MAX_RESULTS));
  // 后端依次试。这不是「容错装饰」：Brave 有限流，429 是常态，
  // 第二个后端是设计的一部分。
  const attempts = [
    { name: "brave", url: BRAVE_URL, parse: parseBrave },
    { name: "bing", url: BING_URL, parse: parseBing },
  ];

  const failures = [];
  let results = [];
  for (const attempt of attempts) {
    // 刚从 429 里出来的后端，冷静期内不再去惹它。
    if (attempt.name === "brave" && Date.now() < braveBlockedUntil) {
      failures.push("brave: 刚被限流，冷静中");
      continue;
    }
    // Brave 要排队限速，Bing 不用（它不靠频率，靠运气）。
    const got = attempt.name === "brave"
      ? await braveThrottled(() => fetchBackend(attempt.url, q))
      : await fetchBackend(attempt.url, q);
    // 先走正常通道；被挡时再用系统 curl 重试同一个后端。
    // 实测（2026-09-23）：同一时刻同一 URL，curl 拿到 200、Node fetch 拿到 429，
    // 换遍请求头都没用——差在客户端底层连接，不在这条请求上。
    // fetch 被挡时，先用 curl 再试一次同一个后端——实测这是能过的那条路。
    // 只有失败才走退路，正常情况不额外起进程；curl 也没成才算这个后端失败。
    let page = got;
    if (page.err) {
      page = await fetchViaCurl(attempt.url + "?q=" + encodeURIComponent(q));
    }
    if (page.err) {
      // 记住这次限流，接下来一分钟直接跳过它。
      if (attempt.name === "brave" && /429/.test(got.err)) {
        braveBlockedUntil = Date.now() + COOLDOWN_MS;
      }
      failures.push(attempt.name + ": " + page.err);
      continue;
    }
    const parsed = attempt.parse(page.html);
    if (!parsed.length) {
      failures.push(attempt.name + ": 页面里解析不到结果");
      continue;
    }
    // 过相关性闸门。这一条拦的就是「返回 200 但内容完全无关」那种：
    // 宁可报「没查到」，也不把垃圾当成事实交给模型。
    // 注意收的是**过滤后**的结果，不是原始那批——原始批次里往往混着垃圾。
    const relevant = filterRelevant(parsed, q);
    if (!relevant.length) {
      failures.push(attempt.name + ": 结果与查询不相关（像是后端的填充内容）");
      continue;
    }
    results = relevant;
    break;
  }

  if (!results.length) {
    // 把两个后端的具体原因都说出来。含糊的失败会让模型换关键词反复重试，那是最贵的路径。
    return "搜索失败（两个后端都没成）：" + failures.join("；") + "。这是站点或网络的问题，不是关键词的问题；不要再换关键词，直接告诉用户这次没连上。";
  }

  const lines = [];
  let used = 0;
  for (const [i, r] of results.slice(0, count).entries()) {
    const snippet = r.snippet.length > SNIPPET_CHARS ? r.snippet.slice(0, SNIPPET_CHARS) + "…" : r.snippet;
    const entry = `${i + 1}. ${r.title}\n   ${r.url}${snippet ? `\n   ${snippet}` : ""}`;
    if (used + entry.length > TOTAL_CHARS) break;
    lines.push(entry);
    used += entry.length;
  }

  return `搜索「${q}」的结果（来自公开网页，引用时请带上链接）：\n\n${lines.join("\n\n")}`;
}

// ---------- 自检：解析器是这个文件里唯一有分支的逻辑，必须能单独跑 ----------
if (process.argv.includes("--selftest")) {
  const sample = `
    <html><body>
    <div class="snippet svelte-abc" data-pos="0" data-type="web" data-keynav="true">
      <a href="https://github.com/openai/codex/" class="l1">
        <div class="site-name-content"><cite class="snippet-url">github.com › openai › codex</cite></div>
        <div class="title search-snippet-title line-clamp-1" title="GitHub - openai/codex: Lightweight &amp; fast">GitHub - openai/codex: Lightweight &amp; fast</div>
      </a>
      <div class="generic-snippet"><div class="content desktop-default-regular"><span class="t-secondary">3 days ago -</span>
        <strong>Lightweight coding agent</strong> that runs in your terminal.</div></div>
    </div>
    <div class="snippet svelte-abc" data-pos="1" data-type="web" data-keynav="true">
      <a href="https://example.com/b?x=1&amp;y=2" class="l1">
        <div class="title search-snippet-title" title="Second &#39;result&#39;">Second &#39;result&#39;</div>
      </a>
    </div>
    <div class="snippet svelte-abc" data-pos="2" data-type="web">
      <a href="https://search.brave.com/internal">Brave 自己的内链，应被丢掉</a>
      <div class="title search-snippet-title" title="内链">内链</div>
    </div>
    <div class="snippet svelte-abc" data-pos="3" data-type="web">
      <div class="title search-snippet-title" title="没有链接，应被丢掉">没有链接</div>
    </div>
    </body></html>`;
  const got = parseBrave(sample);
  const checks = [
    [got.length === 2, `只留外部结果（得到 ${got.length} 条，应为 2）`],
    [got[0].title === "GitHub - openai/codex: Lightweight & fast", `解码标题里的 &amp;（${got[0].title}）`],
    [got[0].url === "https://github.com/openai/codex/", `取到正文链接（${got[0].url}）`],
    [/Lightweight coding agent/.test(got[0].snippet), `摘要剥掉标签、去掉相对时间（${got[0].snippet}）`],
    [got[1].url === "https://example.com/b?x=1&y=2", `解码 URL 里的 &amp;（${got[1].url}）`],
    [got[1].title === "Second 'result'", `解码 &#39;（${got[1].title}）`],
  ];

  // Bing 是备选后端，它把真实地址藏在 ck/a 跳转链接的 u=a1<base64> 参数里。
  // 这一组专门盯这个解码：解不出来就会把 bing.com/ck/a?.... 这种跳转地址
  // 喂给模型，模型引用出来是一串乱码参数，等于没引用。
  const bingSample = `
    <ol id="b_results">
      <li class="b_algo" data-id iid=SERP.5320><div class="b_tpcn"><a class="tilk" aria-label="github.com" href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL29wZW5haS9jb2RleA&amp;ntb=1"><cite>github.com</cite></a></div>
        <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL29wZW5haS9jb2RleA&amp;ntb=1">GitHub - <strong>openai/codex</strong></a></h2>
        <div class="b_caption"><p class="b_lineclamp2"><span class="news_dt">3 days ago</span>&nbsp;&#0183;&#32;Lightweight coding agent for your terminal.</p></div></li>
      <li class="b_algo" data-id iid=SERP.5321>
        <h2><a href="https://example.com/plain">普通链接</a></h2>
        <div class="b_caption"><p>摘要 &amp; 更多。</p></div></li>
    </ol>`;
  const bing = parseBing(bingSample);
  checks.push(
    [bing.length === 2, "Bing: 解析出 " + bing.length + " 条，应为 2"],
    [bing[0]?.url === "https://github.com/openai/codex", "Bing: 把跳转链接还原成真实地址（" + bing[0]?.url + "）"],
    [bing[0]?.title === "GitHub - openai/codex", "Bing: 标题剥掉标签（" + bing[0]?.title + "）"],
    [/Lightweight coding agent/.test(bing[0]?.snippet ?? ""), "Bing: 取到摘要（" + bing[0]?.snippet + "）"],
    [bing[1]?.url === "https://example.com/plain", "Bing: 非跳转链接原样保留（" + bing[1]?.url + "）"],
  );

  // 相关性闸门也要能单独验：这是防止「把垃圾当事实」的那道闸。
  // 它坏了比搜索挂掉更危险——挂了模型知道没查到，坏了模型会把垃圾当真。
  const junk = [
    { title: "Free Daily Horoscopes", url: "https://astrologyanswers.com/", snippet: "Read your sign's horoscope today." },
    { title: "Speed Test by MyBroadband", url: "https://mybroadband.co.za/", snippet: "Rain 5G speed test." },
    { title: "iPhone 18 Pro", url: "https://apple.com/tw/", snippet: "Latest iPhone." },
    { title: "Wirtualna Polska", url: "https://wp.pl/", snippet: "Polish portal." },
  ];
  checks.push(
    [filterRelevant(junk, "openai codex github").length === 0, "整批无关结果被闸门拦下（一条都不放）"],
    [
      filterRelevant(
        [...junk, { title: "GitHub - openai/codex", url: "https://github.com/openai/codex", snippet: "Lightweight coding agent." }],
        "openai codex github",
      ).length === 0,
      "一堆里只混进一条真结果时，整批仍按填内容丢掉（宁可说没查到）",
    ],
    [
      // 但正常检索中「一部分对得上」是常态，这种要把对得上的留下。
      filterRelevant(
        [
          ...junk,
          { title: "GitHub - openai/codex", url: "https://github.com/openai/codex", snippet: "Lightweight coding agent." },
          { title: "openai/codex releases", url: "https://github.com/openai/codex/releases", snippet: "Release notes for codex." },
        ],
        "openai codex github",
      ).length === 2,
      "一部分对得上时，只留对得上的那些",
    ],
    [
      filterRelevant(
        [{ title: "Codex CLI 安装", url: "https://example.com/codex", snippet: "npm install codex" }],
        "codex",
      ).length === 1,
      "单个词的查询仍能正常通过（闸门不做成一刀切）",
    ],
    [
      // 这条是 2026-09-23 补的，样本就是当时真实拿到的返回：
      // 查「github.com/openai/codex latest releases」时，GitHub 首页/登录页/中文教程
      // 都能凑够命中数（靠 `github` + 域名后缀 `com`），于是一起送给了模型。
      // 模型拿到这种「看着相关但没信息」的结果，只能换个词再搜——实测连搜 19 次。
      // 现在单条至少命中 2 个词、且滤掉 com/www 这类基础设施词，这几条就该被挡。
      filterRelevant(
        [
          { title: "GitHub · Change is constant.", url: "https://github.com/", snippet: "GitHub keeps you ahead." },
          { title: "Sign in to GitHub", url: "https://github.com/login", snippet: "GitHub is where people build software." },
          { title: "GitHub 教程", url: "https://zhuanlan.zhihu.com/p/369486197", snippet: "GitHub 是一个平台" },
        ],
        "github.com/openai/codex latest releases",
      ).length === 0,
      "只沾到 github/com 的结果不再冒充相关结果",
    ],
    [
      // 反方向：真正指向那个仓库的结果必须留下（别把闸门收得太死）。
      filterRelevant(
        [
          { title: "GitHub · Change is constant.", url: "https://github.com/", snippet: "GitHub keeps you ahead." },
          { title: "Releases · openai/codex", url: "https://github.com/openai/codex/releases", snippet: "Release notes for codex." },
        ],
        "github.com/openai/codex latest releases",
      ).length === 1,
      "同一批里真正指向那个仓库的结果仍然留下（不过度过滤）",
    ],
    [
      // 中文查询的回归：停用词和「单条最低命中 2 个」改完之后，
      // 要确保中文查询没被误伤。中文按二字滑窗切词，这里三个词里命中两个就应通过。
      filterRelevant(
        [
          { title: "苍穹插件开发规范", url: "https://example.com/cosmic", snippet: "金蝶云苍穹 插件开发 命名约定" },
          { title: "无关页面", url: "https://example.com/x", snippet: "今天天气不错。" },
        ],
        "金蝶云苍穹 插件开发 规范",
      ).length === 1,
      "中文查询仍能正常命中（停用词过滤不误伤中文）",
    ],
  );

  let failed = 0;
  for (const [ok, msg] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? "解析器自检通过" : `${failed} 项未通过`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------- MCP 协议实现（和 knowledge 服务同一套最小实现） ----------
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
          serverInfo: { name: "my-web-search", version: "0.1.0" },
        });
        break;
      case "tools/list":
        reply({ tools: TOOLS });
        break;
      case "tools/call": {
        const { name, arguments: args } = msg.params ?? {};
        if (name !== "web_search") throw new Error(`未知工具: ${name}`);
        reply({ content: [{ type: "text", text: await search(args ?? {}) }], isError: false });
        break;
      }
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
