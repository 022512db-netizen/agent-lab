#!/bin/bash
# 发版产物自检：两个平台的包都必须"解压/打开就能跑"，这里逐条验证。
#
#   bash build/verify-release.sh [版本号]
#
# 检查项：
#   1. 两个包文件存在且非空
#   2. macOS App 里内置 Node 可执行、桥脚本在、Info.plist 合法
#   3. macOS App 跑 --self-test 真的能拉起桥并应答（最接近"能运行"的证据）
#   4. Windows 包里 node.exe、桥脚本、双击入口齐全
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT="$(cd "$HERE/.." && pwd)"
DIST="$LAB_ROOT/dist"
VERSION="${1:-$(cd "$LAB_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo 0.1.0)}"
VERSION="${VERSION#v}"

MAC_APP="$DIST/Agent Lab.app"
MAC_ZIP="$DIST/AgentLab-macOS-${VERSION}-universal.zip"
WIN_ZIP="$DIST/AgentLab-Windows-${VERSION}-win64.zip"

fail=0
ok()   { echo "  [OK]   $1"; }
bad()  { echo "  [FAIL] $1"; fail=1; }
check(){ if [ -s "$1" ]; then ok "$2 ($(du -h "$1" | cut -f1))"; else bad "$2 —— 不存在或为空: $1"; fi; }

echo "==> 校验发版产物 v${VERSION}"

echo ""
echo "-- 产物文件 --"
check "$MAC_ZIP" "macOS 分发包"
check "$WIN_ZIP" "Windows 分发包"

echo ""
echo "-- macOS App 结构 --"
if [ -d "$MAC_APP" ]; then
  ok "App bundle 存在"
  [ -x "$MAC_APP/Contents/MacOS/AgentLab" ] && ok "可执行文件有执行位" || bad "可执行文件缺失/无执行位"
  [ -f "$MAC_APP/Contents/Info.plist" ] && ok "Info.plist 存在" || bad "Info.plist 缺失"
  plutil -lint "$MAC_APP/Contents/Info.plist" >/dev/null 2>&1 && ok "Info.plist 合法" || bad "Info.plist 不合法"

  for arch in arm64 x64; do
    n="$MAC_APP/Contents/Resources/runtime/node-$arch/bin/node"
    if [ -x "$n" ]; then ok "内置 Node ($arch) 可执行"; else bad "内置 Node ($arch) 缺失"; fi
  done
  [ -f "$MAC_APP/Contents/Resources/app/server.mjs" ] && ok "桥脚本已打包" || bad "桥脚本缺失"
  [ -f "$MAC_APP/Contents/Resources/app/public/index.html" ] && ok "前端已打包" || bad "前端缺失"
  [ -f "$MAC_APP/Contents/Resources/lib/settings.mjs" ] && ok "lib 已打包" || bad "lib 缺失"

  echo ""
  echo "-- macOS App 运行自检 --"
  # 这是"开箱能跑"的关键证据：App 自己用内置 Node 把桥拉起来并收到应答。
  if "$MAC_APP/Contents/MacOS/AgentLab" --self-test 2>&1 | tee /tmp/agentlab-selftest.log | grep -q "SELFTEST OK"; then
    ok "App 用内置 Node 拉起桥并收到应答"
  else
    bad "App 运行自检失败，输出如下："
    sed 's/^/       /' /tmp/agentlab-selftest.log
  fi
else
  bad "App bundle 不存在: $MAC_APP"
fi

echo ""
echo "-- Windows 包结构 --"
if [ -s "$WIN_ZIP" ]; then
  # 只看清单，不真解压（85MB 的 exe 没必要为校验落地）
  list="$(unzip -Z1 "$WIN_ZIP")"
  for want in \
    "AgentLab/runtime/node.exe" \
    "AgentLab/app/server.mjs" \
    "AgentLab/app/public/index.html" \
    "AgentLab/lib/settings.mjs" \
    "AgentLab/start-silent.vbs" \
    "AgentLab/Agent Lab.cmd" \
    "AgentLab/README-Windows.txt"
  do
    if echo "$list" | grep -qxF "$want"; then ok "包含 $want"; else bad "缺少 $want"; fi
  done
else
  bad "Windows 包不存在，跳过结构校验"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "==> 全部通过：两个平台的包都具备开箱运行所需的一切"
else
  echo "==> 存在失败项，发版产物不可用"
fi
exit "$fail"
