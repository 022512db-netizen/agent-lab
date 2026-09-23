#!/usr/bin/env bash
# 实验 06：跑「自己编译的 Codex」，亲眼看核心循环在转。
#
# 前面五个实验都是在外面观察。这个不一样：
# 我们改了 codex-rs/core/src/session/turn.rs，在循环里插了一行打印，
# 重新编译，然后用这个二进制跑一次任务 —— 循环的每一圈都会自己报数。
#
# 这就是「进入内核」：不再是推测，而是你自己埋的点在说话。

set -e

CODEX_EXE="/c/dev/codex/codex-rs/target/x86_64-pc-windows-gnu/debug/codex.exe"
export PATH="$HOME/.cargo/bin:/c/tools/mingw64/bin:$PATH"

if [ ! -f "$CODEX_EXE" ]; then
  echo "找不到自编译的 codex.exe，先按 agent-lab/BUILD-RUST.md 编译。"
  exit 1
fi

echo "用的是：$CODEX_EXE"
"$CODEX_EXE" --version
echo
echo "=== 让它做一件需要「想 -> 做 -> 再想」的事 ==="
echo "=== 注意看 [AGENT-LAB] 那几行，那就是循环在转 ==="
echo

mkdir -p /tmp/loop-demo && cd /tmp/loop-demo
rm -f loop.txt

# 这个任务是两步：先写文件，再读回来确认。必然要转多圈。
"$CODEX_EXE" exec \
  --skip-git-repo-check \
  --sandbox workspace-write \
  "建一个 loop.txt 写入 loop-ok，然后用 cat 确认内容，做完就停" 2>&1 \
  | grep -E "\[AGENT-LAB\]|loop-ok|error" | head -40
