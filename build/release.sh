#!/bin/bash
# 一条命令产出两个平台的发版包。
#
#   bash build/release.sh [版本号]
#
# 产物：
#   dist/Agent Lab.app                         —— macOS 原生 App（可直接拖进 Applications）
#   dist/AgentLab-macOS-<版本>-universal.zip    —— macOS 分发包（含内置 Node，解压即用）
#   dist/AgentLab-Windows-<版本>-win64.zip      —— Windows 分发包（含内置 node.exe，解压即用）
#
# 两个平台都自带 Node 运行时，用户机器上装没装 Node 都能跑。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${1:-$(cd "$LAB_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo 0.1.0)}"
VERSION="${VERSION#v}"

echo "=========================================="
echo " Agent Lab 发版构建 v${VERSION}"
echo "=========================================="
echo ""

echo "----- [1/3] macOS 原生 App -----"
bash "$LAB_ROOT/native/macos/build.sh" "$VERSION"

echo ""
echo "----- [2/3] Windows 自包含包 -----"
bash "$LAB_ROOT/native/windows/build.sh" "$VERSION"

echo ""
echo "----- [3/3] 校验产物 -----"
bash "$HERE/verify-release.sh" "$VERSION"

echo ""
echo "=========================================="
echo " 发版产物就绪（dist/）"
echo "=========================================="
