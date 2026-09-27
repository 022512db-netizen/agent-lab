// 判断一条 shell 命令是不是「纯查询」。纯查询由桥自动放行，其余一律交给用户审批。
//
// 宁可误判成「需要审批」，也不能把会改东西的命令放过去，所以只认白名单：
// - 去掉内核外包的一层 `/bin/zsh -lc '...'`
// - 出现重定向、命令替换、后台执行、子 shell 等写法，直接算非查询
// - 按 | && || ; 拆开，每一段的程序和参数都必须在白名单里

const READ_ONLY = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "fgrep", "file", "stat",
  "du", "df", "tree", "which", "whoami", "date", "echo", "printf", "basename", "dirname",
  "realpath", "readlink", "sort", "uniq", "cut", "tr", "nl", "less", "more", "diff", "cmp",
  "jq", "column", "uname", "printenv", "true", "hostname", "id", "md5", "md5sum",
  "shasum", "sha256sum", "cd",
]);

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "grep",
  "describe", "shortlog", "cat-file", "reflog",
]);

const GIT_READ_ONLY_WITH_LIST_FLAG = new Set(["branch", "tag", "remote", "stash"]);

function unwrapShell(cmd) {
  const m = cmd.match(/^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!m) return cmd;
  let inner = m[1].trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

function tokenize(segment) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function segmentIsReadOnly(segment) {
  const [prog, ...args] = tokenize(segment.trim());
  if (!prog) return true;
  const name = prog.split("/").pop();
  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (GIT_READ_ONLY.has(sub)) return !args.includes("--output");
    if (GIT_READ_ONLY_WITH_LIST_FLAG.has(sub)) {
      const rest = args.slice(args.indexOf(sub) + 1);
      return rest.length === 0 || rest.every((a) => ["-a", "-r", "-v", "--list", "-l", "list"].includes(a));
    }
    return false;
  }
  if (name === "sed") return !args.some((a) => a.startsWith("-i") || a === "--in-place") && args.includes("-n");
  if (name === "find") return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)/.test(a));
  if (name === "sort") return !args.some((a) => a === "-o" || a.startsWith("--output"));
  if (name === "rg") return !args.some((a) => a === "--pre" || a.startsWith("--pre="));
  return READ_ONLY.has(name);
}

export function isReadOnlyCommand(command) {
  const raw = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  const cmd = unwrapShell(raw);
  if (!cmd.trim()) return false;
  // 引号里的内容不参与操作符判断，先抹掉再检查危险写法。
  const bare = cmd.replace(/'[^']*'|"(?:[^"\\$`]|\\.)*"/g, "''");
  if (/[<>`]|\$\(|(^|[^&])&($|[^&])|\n/.test(bare)) return false;
  const segments = bare.split(/\|\||&&|\||;/);
  // 用原始命令按同样位置切分，保证引号里的参数原样送进白名单检查。
  const rawSegments = splitKeepingQuotes(cmd);
  if (rawSegments.length !== segments.length) return false;
  return rawSegments.every(segmentIsReadOnly);
}

function splitKeepingQuotes(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|" || c === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}
