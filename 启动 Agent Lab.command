#!/bin/bash
# macOS 上双击这个文件即可启动 Agent Lab（独立桌面窗口）。
#
# .command 是 macOS 认的可双击脚本后缀，双击会用终端跑它。
# 第一次用可能要赋执行权限：
#   chmod +x "启动 Agent Lab.command"
#
# 想看日志就保持这个终端窗口开着；关掉窗口不会杀掉 App（App 有自己的生命周期）。

# 桌面快捷方式会软链到这个文件。双击时 $0 是链接本身，直接 dirname 会指到桌面，
# 于是找不到 start.mjs。先把链接解开，拿到仓库里这份真实文件的位置。
SELF="$0"
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
cd "$(dirname "$SELF")" || exit 1

# 双击 .command 跑的是非登录 shell，不会读 ~/.zshrc，PATH 里常常没有 node。
# 把常见安装位置补上，不依赖用户配没配过 PATH。
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 找不到 node 时给一句人话，而不是一串 command not found。
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。先装一个：brew install node"
  echo "装完再双击本文件。"
  read -r -p "按回车关闭…" _
  exit 1
fi

# 已经有服务在跑时不重复拉内核，只打开窗口（start.mjs 内部会判断）。
echo "Agent Lab 启动中…（关掉本窗口不影响 App 运行）"
node start.mjs
