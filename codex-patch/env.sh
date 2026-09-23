#!/usr/bin/env bash
# 编译 Codex 内核的环境准备。
# 这台机器没有 Visual Studio，所以走 Rust 自带的 GNU 工具链 + 便携版 mingw。
# 用法： source env.sh  然后就能 cargo build
export PATH="$HOME/.cargo/bin:/c/tools/mingw64/bin:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc
export CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++
export AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
export CARGO_BUILD_TARGET=x86_64-pc-windows-gnu
echo "环境就绪：$(rustc --version)"
echo "链接器：$(x86_64-w64-mingw32-gcc --version | head -1)"
