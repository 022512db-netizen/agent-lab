#!/bin/bash
# 打 Windows 分发包：自包含目录 + 双击入口，内含 Node，用户不需要预先装任何东西。
#
# 产物：dist/AgentLab-Windows-<版本>.zip
#       解压后在 AgentLab 目录里双击 start-silent.vbs（或 Agent Lab.cmd 看日志）即可运行。
#
# 为什么是 zip 而不是 exe 安装包：这台机器是 macOS，产不出可信的 Windows
# 安装器（Inno Setup / WiX 都跑不起来），也不该伪造一个。zip 解压即用
# 在 Windows 上是被普遍接受的形态，同时把「做成 exe 安装器」留作后续项。
#
# 用法： bash native/windows/build.sh [版本号]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT="$(cd "$HERE/../.." && pwd)"
DIST="$LAB_ROOT/dist"
STAGE="$DIST/_win-stage"
VERSION="${1:-$(cd "$LAB_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo 0.1.0)}"
VERSION="${VERSION#v}"
NODE_VERSION="22.20.0"

echo "==> 构建 Agent Lab $VERSION (Windows 自包含包)"
rm -rf "$STAGE"
mkdir -p "$STAGE/AgentLab/runtime" "$STAGE/AgentLab/app/public" "$STAGE/AgentLab/lib"

# ---------- 1. 内置 Node ----------
# Windows 上分发单个 node.exe 最省事：官方的 win-x64 zip 里 exe 在根目录，
# 它自带全部依赖，不需要额外的 dll 目录。
if [ "${AGENTLAB_SKIP_RUNTIME:-0}" != "1" ]; then
  echo "==> 下载 Node ${NODE_VERSION} (win-x64)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip" \
    -o "$DIST/_win-node.zip"
  cd "$DIST"
  unzip -oq "_win-node.zip" "node.exe" -d "$STAGE/AgentLab/runtime" 2>/dev/null || {
    # 有些版本的 zip 里带一层目录，兜底：全解开再找
    mkdir -p "$DIST/_win-node-full"
    unzip -oq "_win-node.zip" -d "$DIST/_win-node-full"
    find "$DIST/_win-node-full" -name node.exe -exec cp {} "$STAGE/AgentLab/runtime/node.exe" \;
    rm -rf "$DIST/_win-node-full"
  }
  rm -f "$DIST/_win-node.zip"
  cd "$LAB_ROOT"
else
  echo "==> AGENTLAB_SKIP_RUNTIME=1，跳过运行时"
fi

# ---------- 2. 桥与前端 ----------
cp -R "$LAB_ROOT/app/public/"* "$STAGE/AgentLab/app/public/"
cp "$LAB_ROOT/app/server.mjs" "$STAGE/AgentLab/app/server.mjs"
cp "$LAB_ROOT/lib/"*.mjs "$STAGE/AgentLab/lib/"
mkdir -p "$STAGE/AgentLab/mcp-my-knowledge" "$STAGE/AgentLab/mcp-web-search"
cp "$LAB_ROOT/mcp-my-knowledge/"*.mjs "$STAGE/AgentLab/mcp-my-knowledge/" 2>/dev/null || true
cp "$LAB_ROOT/mcp-web-search/"*.mjs "$STAGE/AgentLab/mcp-web-search/" 2>/dev/null || true
cp "$LAB_ROOT/start.mjs" "$STAGE/AgentLab/start.mjs" 2>/dev/null || true
[ -f "$LAB_ROOT/projects.json" ] && cp "$LAB_ROOT/projects.json" "$STAGE/AgentLab/projects.json"
[ -f "$LAB_ROOT/knowledge.md" ] && cp "$LAB_ROOT/knowledge.md" "$STAGE/AgentLab/knowledge.md"
mkdir -p "$STAGE/AgentLab/codex-home"
cp "$LAB_ROOT/codex-home/config.toml" "$STAGE/AgentLab/codex-home/" 2>/dev/null || true
[ -d "$LAB_ROOT/codex-home/model-catalogs" ] && cp -R "$LAB_ROOT/codex-home/model-catalogs" "$STAGE/AgentLab/codex-home/"

# ---------- 3. 双击入口 ----------
# 入口全部只用 ASCII：这个仓库的路径带非 ASCII 字符，历史教训是
# GBK 代码页下非 ASCII 字节会吃掉换行，把下一行真实代码变成注释。
cat > "$STAGE/AgentLab/start-silent.vbs" <<'VBS'
' Start Agent Lab in the background: no console window, logs to launch.log.
' ASCII-only on purpose: the system script host reads this file with the legacy
' codepage, and non-ASCII bytes here can eat a newline and turn the next real
' line into a comment.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

' Set the working directory through COM, NOT on the command line.
' Paths with non-ASCII characters get mangled by the GBK codepage when passed
' through "cmd /c cd /d <path>". shell.CurrentDirectory goes through COM
' (Unicode), so the path survives.
shell.CurrentDirectory = here

' Prefer the bundled Node; fall back to whatever the user already installed.
bundled = here & "\runtime\node.exe"
If fso.FileExists(bundled) Then
  node = """" & bundled & """"
Else
  node = "node"
End If

cmd = "cmd /c " & node & " app\server.mjs > launch.log 2>&1"
' 0 = hidden window, False = do not wait for it to finish.
shell.Run cmd, 0, False

' Give the bridge a moment, then open the default browser at the local URL.
WScript.Sleep 2500
shell.Run "http://127.0.0.1:8787/", 1, False
VBS

cat > "$STAGE/Agent Lab.cmd" <<'CMD'
@echo off
REM Agent Lab - Windows launcher (console window stays open, shows the log).
REM ASCII-only on purpose: non-ASCII bytes in a .cmd file are read through the
REM legacy codepage and get mangled.
setlocal
set "here=%~dp0"
set "node=%here%runtime\node.exe"
if not exist "%node%" set "node=node"
pushd "%here%"
echo Starting Agent Lab... (keep this window open to see the log)
echo Open http://127.0.0.1:8787/ in your browser when ready.
"%node%" app\server.mjs
popd
endlocal
CMD

# README 放进 AgentLab/ 里：以前放在 zip 根目录，解压后和主目录分家，
# 用户往往只看到 AgentLab 文件夹就不知道还有说明。
cat > "$STAGE/AgentLab/README-Windows.txt" <<'TXT'
Agent Lab for Windows
=====================

1. Unzip this folder anywhere you like.
2. Double-click "start-silent.vbs" inside the AgentLab folder.
   - It starts the local bridge in the background (log: launch.log)
   - Then opens http://127.0.0.1:8787/ in your default browser.
   - A Node runtime is bundled, so you do NOT need to install Node yourself.
3. To watch the log live instead, double-click "Agent Lab.cmd" in the same folder and keep the
   window open. Ctrl+C in that window stops the app.

Notes
-----
- Nothing is written outside this folder except a config dir under your user
  profile (%USERPROFILE%\.codex or the bundled codex-home) and the vault
  directory your knowledge base uses.
- To stop the background app: close the browser window and end "node.exe" for
  this folder in Task Manager, or just log off / reboot.
- The model provider needs an API key. Set it in the app UI, or put it in a
  .env file next to start-silent.vbs (inside the AgentLab folder):
      AGENT_LAB_API_KEY=sk-your-key
TXT

# ---------- 4. 打包 ----------
mkdir -p "$DIST"
ZIP="$DIST/AgentLab-Windows-${VERSION}-win64.zip"
rm -f "$ZIP"
# zip 必须生成在 stage 之外：早先把它生成在 stage 里，紧接着的 rm -rf "$STAGE"
# 会把刚打好的包一起删掉（表现为"完成了"但文件不存在）。
# 入口 .cmd 也放进 AgentLab/ 里，避免根目录散着一个带空格的文件名。
mv "$STAGE/Agent Lab.cmd" "$STAGE/AgentLab/Agent Lab.cmd"
(cd "$STAGE" && zip -qr "$ZIP" AgentLab)
rm -rf "$STAGE"

echo ""
echo "==> 完成"
echo "  Zip: $ZIP"
ls -lh "$ZIP" | awk '{print "  体积: " $5}'
