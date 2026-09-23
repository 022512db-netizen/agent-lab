#!/bin/bash
# macOS 上双击这个文件即可启动 Agent Lab（独立桌面窗口）。
#
# .command 是 macOS 认的可双击脚本后缀，双击会用终端跑它。
# 第一次用可能要赋执行权限：
#   chmod +x "启动 Agent Lab.command"
#
# 想看日志就保持这个终端窗口开着；关掉窗口不会杀掉 App（App 有自己的生命周期）。

cd "$(dirname "$0")" || exit 1

# 找不到 node 时给一句人话，而不是一串 command not found。
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。先装一个：brew install node"
  echo "装完再双击本文件。"
  read -r -p "按回车关闭…" _
  exit 1
fi

echo "Agent Lab 启动中…（关掉本窗口不影响 App 运行）"
node start.mjs
