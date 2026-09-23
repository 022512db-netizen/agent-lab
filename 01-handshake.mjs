// 实验 01：用最小客户端和 codex app-server 握手
// 目的：亲眼看到 "UI 发请求 -> Codex 回事件" 这条链路是活的。
// 运行： node 01-handshake.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";

// 用 App 自己那份配置。不设的话内核会读全局 ~/.codex/config.toml，
// 而那份里的模型在当前本地中转上是挂的（请求直接 503）——实验会红在错误的地方。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HERE, "codex-home");

const server = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
  shell: true,
  // ...loadLocalEnv() 把 .env 里的密钥带进来（密钥已从配置文件挪走）
  env: { ...process.env, ...loadLocalEnv(), CODEX_HOME },
});

// app-server 用「一行一个 JSON」说 JSON-RPC
const send = (msg) => server.stdin.write(JSON.stringify(msg) + "\n");

const timeout = setTimeout(() => {
  console.error("\n[超时] 15 秒内没有收到响应");
  server.kill();
  process.exit(1);
}, 15000);

server.stdout.setEncoding("utf8");
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("[非 JSON]", line);
      continue;
    }

    // 有 id 的是「我方请求的回应」，没有 id 的是「服务端主动推的事件」
    if (msg.id !== undefined) {
      console.log("<< 响应 id=" + msg.id + ":", JSON.stringify(msg.result ?? msg.error));
      if (msg.id === 1) {
        // 握手成功，问一下服务端现在有哪些会话
        send({ jsonrpc: "2.0", id: 2, method: "thread/list", params: {} });
      }
      if (msg.id === 2) {
        clearTimeout(timeout);
        console.log("\n[OK] 握手完成，说明这条链路是通的。");
        server.kill();
        process.exit(0);
      }
    } else {
      console.log("<< 事件:", msg.method);
    }
  }
});

console.log(">> 发送 initialize");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "agent-lab", title: "Agent Lab", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  },
});
