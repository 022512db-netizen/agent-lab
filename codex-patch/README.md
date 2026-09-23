# 内核补丁：探针 + 循环刹车

Agent Lab 用 `codex app-server` 当内核。有两个功能必须改内核才能实现，
这里放的是改动的 patch——**不是**把整个 Codex 源码拷进来（那是 27G）。

## 这个 patch 改了什么

只改一个文件：`codex-rs/core/src/session/turn.rs`，加两样东西：

1. **探针**（实验 06–10、13、18 依赖它）
   每圈开始/结束时往 stderr 打一行：
   - `===== 循环第 N 圈开始：准备把上下文发给模型 =====`
   - `循环第 N 圈结束：模型想继续? ...；当前上下文 token = ...`

   有了它才能看见「一个 turn 内循环转了几圈、上下文涨到多少」。

2. **循环刹车**（实验 07 依赖它）
   一个 turn 最多转 N 圈，超过就强制停并给一句 warning。
   默认 20 圈，用环境变量 `AGENT_LAB_MAX_ITERATIONS` 覆盖
   （App 启动时传 60；真实编码任务 20 圈不够，见 README）。

两处都是纯增量，不改原有逻辑，用 `[AGENT-LAB]` 前缀标记，方便日后 rebase。

## 怎么用

```bash
# 1. 拿官方源码
git clone https://github.com/openai/codex.git
cd codex

# 2. 对齐到我们当时用的那个提交（可选，但最省事）
git checkout 75ec81c     # 见 UPSTREAM-COMMIT.txt

# 3. 打补丁
git apply /path/to/0001-agent-lab-probe-and-loop-brake.patch

# 4. 编译（Windows 见 env.sh；macOS 直接 cargo build）
source env.sh            # 仅 Windows GNU 工具链需要
cd codex-rs
cargo build --bin codex -j 4
cargo build -p codex-windows-sandbox -j 4   # Windows 沙箱 helper，只 Windows 需要
```

产物默认在 `codex-rs/target/<target>/debug/codex[.exe]`。
把路径设给 `CODEX_BIN`，或放进 PATH 让 Agent Lab 找到它。

## 不编译会怎样

**Agent Lab 照样能跑**——它找不到自编译内核就回退到系统装的 `codex`。
区别是：没有探针就看不清循环圈数和上下文轨迹，
而且实验 07/09/10/13/18 里依赖探针输出的判定会失败（它们会明确报 BLOCKED/FAIL，不会假装通过）。

`node verify-install.mjs` 会告诉你当前用的是哪份内核（自编译 or PATH）。

## 为什么不用子模块

Codex 源码 27G（含 target 目录），其中真正的源码改动只有 55 行。
用 patch 表达「我们改了哪几行」比拖一份完整 fork 更清楚，
也更容易跟随上游更新——上游变了，重新 `git apply` 一次就知道有没有冲突。
