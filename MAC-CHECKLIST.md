# macOS 验证清单

目的：换到 Mac 上确认这个 App 能不能正常打开。
下面每一步都给「应该看到什么」——只有看到才算过，没看到就照排查走。

## 0. 拉代码

```bash
git clone https://github.com/022512db-netizen/agent-lab.git
cd agent-lab
```

## 1. 装前置（只装一次）

```bash
brew install node python        # node 必需；python 是苍穹技能脚本要用的
npm install -g @openai/codex    # 内核：先用官方版，探针以后再说
```

> 自编译内核（带探针）是可选的。不编译也能跑，App 会自动回退到上面装的这份。
> 想编就照 [codex-patch/README.md](codex-patch/README.md) 做。

## 2. 配密钥

```bash
cp .env.example .env
```

编辑 `.env`，把 `AGENT_LAB_API_KEY` 换成你的 token。

## 3. 一键自检 ← **主要就靠这一步**

```bash
node verify-install.mjs
```

**应该看到**：五层检查逐项 PASS，最后一行是
`[PASS] 安装完整，可以正常使用`，并且带一句「模型回话：...」。

任何 FAIL 都给了具体修法。常见两个：

- `找不到 python3 / python` → `brew install python`
- `缺 AGENT_LAB_API_KEY` → 第 2 步没做或没填值

## 4. 打开窗口 ← **要验证的核心**

```bash
chmod +x "启动 Agent Lab.command"   # 只需一次
open "启动 Agent Lab.command"
```

或者双击它。

**应该看到**：一个没有地址栏的独立窗口，标题 `Agent Lab`，左边是侧边栏
（新会话 / 编辑我的知识 / 项目下拉框），中间是输入框，底部有「发送」。

**如果窗口没弹**：终端里跑 `node start.mjs` 看报错。它同样会打印
`Agent Lab 启动中… 工作目录: ...` 和 `内核: ...` 两行，能直接看出卡在哪。

## 5. 换行符与执行权限（macOS 特有的两个坑）

这两条拉下来就该是对的，不对的话症状很典型：

| 现象 | 原因 | 修法 |
|---|---|---|
| 双击 .command 报 `bad interpreter: /bin/bash^M` | 文件被转成了 CRLF | 仓库里 `.gitattributes` 已钉死为 LF；确认拉下来的文件 `file "启动 Agent Lab.command"` 显示 `ASCII text` 而不是 `with CRLF` |
| 双击提示「无法打开，因为来自身份不明的开发者」 | 没执行权限 | `chmod +x "启动 Agent Lab.command"` |

## 6. 让它真的干活（可选，但强烈建议）

窗口里把项目下拉框切到 **sherp（苍穹工程）**，点 **新会话**，发一句：

```
用一句话说明你是谁
```

**应该看到**：模型回复末尾带 `[知识已生效]`——说明知识注入通了。

再试：

```
请按项目规则加载 load-memory 和 ok-cosmic，然后执行 Step 0 配置预检，把输出原样告诉我
```

**应该看到**：`errors=0 warnings=0`。看到这个就说明 Mac 上的苍穹专家链路完整可用。

> 注意：`projects.json` 里记的是 Windows 路径。Mac 上要么把路径改成 Mac 侧的
> 工程位置，要么先在 Mac 上放一份工程。路径不存在时下拉框会自动过滤掉它，
> 不给错误选项。

## 7. 跑一遍实验（可选）

```bash
node 29-layout-lock.mjs        # 秒级，纯读 CSS，不连内核
node 03-knowledge-check.mjs    # 知识注入（需要 App 起着）
```

## 已知的 Mac 未验证点

下面这些代码写了平台分支，但**从没在真机跑过**。哪个出问题就修哪个：

- 用 Chromium 系浏览器开 `--app=` 窗口（Chrome / Edge / Brave / Chromium 都列了候选）
- macOS 沙箱行为（Windows 上踩过 `workspace-write` 静默降级成只读，Mac 侧没验）
- 首次运行时的目录创建与技能软链（Windows 用 junction，Mac 用 `dir` 软链）
- 项目里 `AGENTS.md` → `~/.codex/skills/` 的技能发现链路

## 出问题怎么反馈

把这三样贴回来就够定位：

1. `node verify-install.mjs` 的完整输出
2. `node start.mjs` 的终端输出
3. 状态：窗口没弹 / 弹了但空白 / 弹了但模型不回话
