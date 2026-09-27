#!/bin/bash
# 打 macOS 原生 App：Agent Lab.app（内含 Node 运行时 + 桥 + 前端）。
#
# 产物：dist/mac/Agent Lab.app         —— 双击就能跑，不需要用户装 Node
#       dist/AgentLab-macOS-<版本>.zip —— 分发用（zip 保留执行位和签名位）
#
# 用法： bash native/macos/build.sh [版本号]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT="$(cd "$HERE/../.." && pwd)"
DIST="$LAB_ROOT/dist"
STAGE="$DIST/_mac-stage"
BUILD_DIR="$DIST/_mac-build"

VERSION="${1:-$(cd "$LAB_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo 0.1.0)}"
VERSION="${VERSION#v}"
echo "==> 构建 Agent Lab $VERSION (macOS 原生 App)"

NODE_VERSION="22.20.0"
APP_NAME="Agent Lab"
APP="$STAGE/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
RUNTIME="$RES/runtime"

rm -rf "$STAGE" "$BUILD_DIR" "$DIST/$APP_NAME.app"
mkdir -p "$MACOS_DIR" "$RES" "$RUNTIME" "$BUILD_DIR"

# ---------- 1. 内置 Node 运行时 ----------
# 自带运行时的意义：用户机器上没装 Node 也能双击就跑。
# 两个架构都拉，arm64 是 Apple 芯片原生，x64 给 Intel Mac（或 Rosetta）用。
fetch_node() {
  local arch="$1" out="$2"
  local tarball="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  local url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  if [ -d "$out/bin" ]; then echo "    runtime ${arch} 已存在，跳过"; return; fi
  echo "==> 下载 Node ${NODE_VERSION} (${arch})"
  curl -fsSL "$url" -o "$BUILD_DIR/$tarball"
  mkdir -p "$out"
  # --strip-components=1 去掉最外层 node-vXX-darwin-arm64/ 目录
  tar -xzf "$BUILD_DIR/$tarball" -C "$out" --strip-components=1
  rm -f "$BUILD_DIR/$tarball"
}
# 只留 node 可执行文件：npm/npx/corepack 在运行时用不到，留着要多占 ~60MB。
trim_node() {
  local out="$1"
  mkdir -p "$out/bin"
  mv "$out/bin/node" "$out/bin/_node" 2>/dev/null || true
  [ -f "$out/bin/_node" ] && mv "$out/bin/_node" "$out/bin/node"
  # npm/npx/corepack 是符号链接；运行时只保留 node，链接也必须一起删。
  find "$out/bin" -maxdepth 1 -type l -delete 2>/dev/null || true
  find "$out/bin" -maxdepth 1 -type f ! -name node -delete 2>/dev/null || true
  rm -rf "$out/lib/node_modules" "$out/include" "$out/share" "$out/lib/dtrace" 2>/dev/null || true
}

if [ "${AGENTLAB_SKIP_RUNTIME:-0}" != "1" ]; then
  fetch_node arm64 "$RUNTIME/node-arm64"
  fetch_node x64   "$RUNTIME/node-x64"
  trim_node "$RUNTIME/node-arm64"
  trim_node "$RUNTIME/node-x64"
  chmod +x "$RUNTIME/node-arm64/bin/node" "$RUNTIME/node-x64/bin/node"
else
  echo "==> AGENTLAB_SKIP_RUNTIME=1，跳过运行时下载（仅本地联调用）"
fi

# ---------- 2. 编译 Swift 壳 ----------
# 同时编两个架构再 lipo 成通用二进制：Intel Mac 和 Apple 芯片都能原生跑。
echo "==> 编译 Swift 壳"
SRC="$HERE/AgentLab/main.swift"
swiftc -parse-as-library -O -target arm64-apple-macos12.0 -o "$BUILD_DIR/AgentLab-arm64" "$SRC"
swiftc -parse-as-library -O -target x86_64-apple-macos12.0 \
  -runtime-compatibility-version none -o "$BUILD_DIR/AgentLab-x64" "$SRC"
lipo -create -output "$MACOS_DIR/AgentLab" "$BUILD_DIR/AgentLab-arm64" "$BUILD_DIR/AgentLab-x64"
chmod +x "$MACOS_DIR/AgentLab"
rm -f "$BUILD_DIR/AgentLab-arm64" "$BUILD_DIR/AgentLab-x64"

# ---------- 3. 组装 App 资源 ----------
# Resources/app 是运行时根：server.mjs 会以它的上一级当作仓库根去找 lib/、mcp-*/
echo "==> 复制前端与桥"
mkdir -p "$RES/app"
cp -R "$LAB_ROOT/app/public" "$RES/app/public"
cp "$LAB_ROOT/app/server.mjs" "$RES/app/server.mjs"
mkdir -p "$RES/lib"
cp "$LAB_ROOT/lib"/*.mjs "$RES/lib/"
mkdir -p "$RES/mcp-my-knowledge" "$RES/mcp-web-search"
cp "$LAB_ROOT/mcp-my-knowledge"/*.mjs "$RES/mcp-my-knowledge/" 2>/dev/null || true
cp "$LAB_ROOT/mcp-web-search"/*.mjs "$RES/mcp-web-search/" 2>/dev/null || true
cp "$LAB_ROOT/start.mjs" "$RES/start.mjs" 2>/dev/null || true
[ -f "$LAB_ROOT/projects.json" ] && cp "$LAB_ROOT/projects.json" "$RES/projects.json"
[ -f "$LAB_ROOT/knowledge.md" ] && cp "$LAB_ROOT/knowledge.md" "$RES/knowledge.md"

# codex-home 里的 config.toml 与模型清单是配置（不是运行数据），要带上。
# config.toml 里没有明文密钥（走 env_key），所以可以随包分发。
mkdir -p "$RES/codex-home"
cp "$LAB_ROOT/codex-home/config.toml" "$RES/codex-home/" 2>/dev/null || true
[ -d "$LAB_ROOT/codex-home/model-catalogs" ] && cp -R "$LAB_ROOT/codex-home/model-catalogs" "$RES/codex-home/"

# ---------- 4. Info.plist / 图标 / 版本 ----------
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agent Lab</string>
  <key>CFBundleDisplayName</key><string>Agent Lab</string>
  <key>CFBundleIdentifier</key><string>com.agentlab.desktop</string>
  <key>CFBundleExecutable</key><string>AgentLab</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><true/>
</dict>
</plist>
PLIST

echo "==> 生成图标"
ICON_SRC="$HERE/AgentLab/icon.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$BUILD_DIR/AppIcon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  sips -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null 2>&1 || true
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null 2>&1 || true
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null 2>&1 || true
  sips -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null 2>&1 || true
  sips -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null 2>&1 || true
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null 2>&1 || true
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null 2>&1 || true
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null 2>&1 || true
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null 2>&1 || true
  iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns" 2>/dev/null || true
  [ -f "$RES/AppIcon.icns" ] && \
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$CONTENTS/Info.plist" 2>/dev/null || true
fi

# ---------- 5. 签名（有开发者证书就签，没有就用 ad-hoc）----------
# ad-hoc 签名能让 Gatekeeper 把它当「本地构建的 App」放行，
# 但跨机器分发仍会被 Gatekeeper 拦一下（右键打开即可）。
echo "==> 签名"
if [ -n "${AGENTLAB_CODESIGN_IDENTITY:-}" ]; then
  codesign --force --deep --options runtime \
    --sign "$AGENTLAB_CODESIGN_IDENTITY" "$APP"
else
  codesign --force --deep --sign - "$APP" 2>/dev/null || echo "    (ad-hoc 签名跳过)"
fi

# ---------- 6. 打包 ----------
mkdir -p "$DIST"
cp -R "$APP" "$DIST/"
rm -rf "$STAGE" "$BUILD_DIR"

ZIP="$DIST/AgentLab-macOS-${VERSION}-universal.zip"
rm -f "$ZIP"
(cd "$DIST" && zip -qry "$(basename "$ZIP")" "$APP_NAME.app")

echo ""
echo "==> 完成"
echo "  App:  $DIST/$APP_NAME.app"
echo "  Zip:  $ZIP"
du -sh "$DIST/$APP_NAME.app" | sed 's/^/  体积: /'
