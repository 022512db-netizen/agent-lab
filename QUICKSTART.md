# 五分钟上手 Agent Lab

这份是**使用者视角**的快速上手。想理解 agent 为什么这样工作、每个能力是怎么被验证出来的，
去看 [README.md](README.md)——那里面是完整的探索记录和 28 个实验。

## 1. 启动

**Windows**：双击 `启动 Agent Lab.bat`，会弹出一个独立桌面窗口（无地址栏）。
**macOS**：双击 `启动 Agent Lab.command`（首次需 `chmod +x "启动 Agent Lab.command"`）。
**任意系统（终端）**：`node start.mjs`

启动需要两样东西：

- **Node.js**（macOS: `brew install node`）
- **Codex 内核**：优先用自编译的（带探针和循环刹车），没有就回退到系统装的 `codex`
  （macOS: `npm install -g @openai/codex`，或用 `CODEX_BIN` 指向任意一份）

## 2. 配置模型和密钥

**源码运行**：

```bash
cp .env.example .env
# 然后编辑 .env，把 AGENT_LAB_API_KEY 的值换成你的 token
```

**安装版**：不需要改 App 包。点左栏「模型设置」，填 Base URL 和 API Key 后
「保存并启用」。新版会把密钥写到用户数据目录的 `.env`，并自动重启内核：

- macOS：`~/Library/Application Support/AgentLab/.env`
- Windows：`%APPDATA%\AgentLab\.env`

设置、项目清单和 `codex-home/` 也都在这个用户数据目录中，升级 App 不会覆盖。

模型默认是 `xiaomi/mimo-v2.6-flash`（走本地中转）。换模型改
`codex-home/config.toml` 里的 `model =`，**同时**在
`codex-home/model-catalogs/relay-mu96ubev.json` 里补一条同名元数据
（缺了不会报错，只会静默用错误的上下文窗口，README 有专章讲这个坑）。
先确认中转有这个名字：`curl http://127.0.0.1:57321/v1/models`。
中转列表里有的模型不一定在目录里（实测 27 个列表、15 条目录），缺了要一起补。

也可以在窗口里改：左栏「模型设置」→ 填名称、Base URL、API Key →
点「从上游获取模型」→ 在下拉里选一个 → 「保存并启用」。
切换模型不用重开会话，下一句话就用新的。密钥只写进用户数据目录的 `.env`，
provider 和模型选择写进 `agent-lab.settings.json`（两者都不进版本库）。

## 3. 选项目，开始干活

窗口左上角有个**项目选择下拉框**。它决定新会话开在哪个目录——
苍穹专家技能（`ok-cosmic` / `load-memory`）靠工作目录向上找 `ok-cosmic.json`，
所以想让它真的写代码，选「sherp（苍穹工程）」，然后点**新会话**。

左栏「新增工作区…」会弹系统目录选择器，选中的目录直接写进 `projects.json`，
不用再手改文件（路径不存在的会被自动过滤，所以同一份清单在两个系统上都能用）。

界面能力一览：

- **对话**：Enter 发送，Shift+Enter 换行
- **输入框内切模型**：composer 右侧的模型胶囊直接换，下一条消息就用新的，不用重开会话
- **思考强度**：模型胶囊旁边的「思考强度」胶囊，档位按当前模型从内核元数据里取
  （例如 低/中/高/极高；换模型时如果原档位新模型不支持，自动落到新模型默认档），
  下一条消息生效，选择写进 `agent-lab.settings.json`
- **模型设置**：新增/编辑 provider，点「从上游获取模型」拉模型名，
  填的密钥写进本机 `.env`，provider 与模型选择写进 `agent-lab.settings.json`
- **技能**：列出内核实际发现的技能，可勾选开关；也能用「加入技能」把外部目录接进来
  （目录里要有带 YAML frontmatter 的 `SKILL.md`，后端会先校验，缺了直接报错）
- **主题**：标题栏右侧 ◐ 切深色 / 浅色，选择记在本机浏览器
- **审批**：agent 要动文件/跑命令时窗口会弹卡片，你决定放行还是拒绝
- **成本可见**：顶部实时显示累计 token、工具返回次数和体积
- **知识编辑**：左栏「编辑我的知识」直接改 `knowledge.md`，开新会话生效
- **历史会话**：左栏点击可恢复，能接着聊

## 4. 验证它真的能用（可选但推荐）

先跑一键自检（18 项：文件、密钥、配置、内核、Python、运行态）：

```bash
node verify-install.mjs
```

哪个 FAIL 就修哪个，它会给出具体修法。然后可再跑单项实验，红绿代表真实链路：

```bash
node 03-knowledge-check.mjs   # 知识注入生效
node 08-app-e2e.mjs           # 界面 -> 桥 -> 内核，端到端
node 26-cosmic-project.mjs    # 会话能开进真实苍穹工程
node 28-cosmic-generate.mjs   # agent 真写一个苍穹插件并过规范检查
```

每个实验开头有注释说明它验什么、为什么。完整清单见 README 的实验表格。

## 常见问题

**模型一句话都不回？**
先确认三件事，按顺序：模型在本地中转上活着吗（直接 curl 一下）；
`.env` 里密钥填了吗；`codex-home/` 配置在吗。这三个的失败表现都是「沉默」，
README「换模型」和「别人也能跑起来」两节有详细排查路径。

**agent 说「找不到 ok-cosmic.json」？**
会话工作目录不对。换项目要点**新会话**——已开始会话的工作目录是定住的。

**想换知识库 / 换浏览器 / 换端口？**
都是环境变量：`AGENT_KNOWLEDGE_DIR`、`AGENT_LAB_BROWSER`、`PORT`。
完整列表见 README「启动」一节。
