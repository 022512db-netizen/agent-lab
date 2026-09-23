# 从源码编译 Codex 内核（Windows / 免装 Visual Studio）

## 为什么需要这一步

平时用 `codex` 命令跑的是官方预编译的二进制。只有从源码编译，
你才能给它加日志、打断点、改那个核心循环。这是从「用 agent」到「造 agent」的最后一道门。

## 这台机器的三个坑（都踩过了）

### 坑 1：没有 Visual Studio / MSVC

Rust 在 Windows 上默认用 MSVC 工具链，需要 VS Build Tools（约 2GB）。
这台机器没有，所以 `cargo build` 第一步就死在：

```
error: linker `link.exe` not found
note: you may need to install Visual Studio build tools with the "C++ build tools" workload
```

**解法：改用 GNU 工具链**，它不需要 VS，只用便携版 mingw（261MB）。

```bash
rustup toolchain install 1.95.0-x86_64-pc-windows-gnu --profile minimal
rustup target add x86_64-pc-windows-gnu
```

注意必须装 **GNU host 工具链**（`1.95.0-x86_64-pc-windows-gnu`），
不只是加 target。因为构建脚本（build script）本身也要编译成 exe，
如果 host 还是 MSVC，构建脚本依然会去找 `link.exe`。

### 坑 2：Git Bash 自带的 link.exe 会抢位

Git Bash 的 `/usr/bin/link.exe` 是 Unix 的 `link` 命令，
不是 MSVC 链接器。如果 PATH 顺序不对，Rust 会调到它，报：

```
link: extra operand ... Try 'link --help' for more information.
```

**解法：明确指定链接器，别让 Rust 自己猜。**

```bash
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
```

### 坑 3（最阴的）：仓库路径里有中文

`C:\新建文件夹\...` 里的中文会让 mingw 的链接器和 dlltool 读不了文件路径：

```
ld.exe: cannot find C:\新建文件夹\codex\...\libfs_extra-....rlib
dlltool.exe: Can't open def file: C:\�½��ļ���\...
```

中文在 GBK/UTF-8 之间被转码，路径就废了。

**解法：把源码放到纯 ASCII 路径下编译。**

```bash
mkdir -p /c/dev && cp -r /c/新建文件夹/codex /c/dev/codex
cd /c/dev/codex/codex-rs && cargo build --bin codex
```

源码本身放在哪都行，但**编译必须在纯 ASCII 路径**。

## 重要：别只编 --bin codex

`cargo build --bin codex` **只编主程序，不够**。Windows 沙箱还需要两个 helper 程序：

| 程序 | 干什么 |
|---|---|
| `codex-windows-sandbox-setup.exe` | 创建沙箱专用账户、配防火墙规则 |
| `codex-command-runner.exe` | 在沙箱身份降下来的进程里真正执行命令 |

官方安装包把它们放在 `resources/` 里。我们自己编时主程序里那段「找 helper」的代码
（`windows-sandbox-rs/src/helper_materialization.rs`）会先在 `codex.exe` 同目录找，
再找同级 `resources/`。两个 helper 都没编出来，就会变成：

> **一让它跑 shell 命令，沙箱就起不来。**

所以完整的编译是两条命令：

```bash
cargo build --bin codex -j 4                 # 主程序
cargo build -p codex-windows-sandbox -j 4    # 沙箱的两个 helper
```

helper 的产物会直接落在 `debug/`（和 `codex.exe` 同目录），放对了自动生效，不用拷。
细节和实测见 README「意外收获：把 Windows 沙箱也修好了」。

## 完整的编译命令

```bash
export PATH="$HOME/.cargo/bin:/c/tools/mingw64/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-gnu
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc
export CARGO_BUILD_TARGET=x86_64-pc-windows-gnu

cd /c/dev/codex/codex-rs
cargo build --bin codex
```

产物位置：

```
/c/dev/codex/codex-rs/target/x86_64-pc-windows-gnu/debug/codex.exe
```

规模参考：整个 workspace 有 **1000+ 个 crate** 要编译，第一次要跑十几分钟。

## 一个额外的坑：toolchain 混用会污染缓存

我最早先用 MSVC 试、又用 GNU 试，结果 `target/` 里混了两种元数据，
后面就报一堆莫名其妙的错：

```
error[E0786]: found invalid metadata files for crate `codex_core`
  = note: failed to mmap rmeta metadata
```

**解法：换 toolchain 之后一定要 `rm -rf target` 重新编。**

### 坑 4：并行编译会把内存吃穿（OOM）

改完代码重编时，cargo 默认按 CPU 核数起 rustc。这台机器 16 核、32 GB 内存，
同时跑一堆重型 crate 直接吃穿：

```
memory allocation of 2097152 bytes failed
```

**解法：加 `-j 4` 限制并行度。** 不是代码错，纯粹是资源问题。

### 坑 5：App 在跑的时候覆盖不了 codex.exe

```
error: failed to remove file `...\debug\codex.exe`
Caused by: 拒绝访问。 (os error 5)
```

Windows 不允许覆盖正在执行的 exe（重命名倒是允许）。
**解法：先停掉 App，或先把旧的 `codex.exe` 改名。**

## 已装好的东西

| 组件 | 位置 | 说明 |
|---|---|---|
| Rust 1.95.0 (MSVC host) | `~/.rustup/toolchains/1.95.0-x86_64-pc-windows-msvc` | 装了但编译用不上 |
| Rust 1.95.0 (GNU host) | `~/.rustup/toolchains/1.95.0-x86_64-pc-windows-gnu` | **实际用的这个** |
| mingw-w64 GCC 16.2.0 | `C:\tools\mingw64` | 便携版，提供链接器 |
| 编译用源码 | `C:\dev\codex` | 纯 ASCII 路径 |
| 原始源码 | `C:\新建文件夹\codex` | 保留，供阅读 |

环境脚本：`C:\dev\codex\env.sh`（如果丢了可以按上面重建）
