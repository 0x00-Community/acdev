<a id="top"></a>
<div align="center">

# acdev

### 用 web 写桌面应用, 跑在一个没有浏览器的桌面上.
**acde 应用的开发工具: 一个命令行包办新建、运行、调试、测试和安装, 外加一个跨平台调试运行时, 用自己的 V8 和自己的渲染器.**

[![License](https://img.shields.io/badge/License-AGPL--3.0--only-blue?style=for-the-badge)](LICENSE)
[![Rust](https://img.shields.io/badge/Runtime-Rust-orange?style=for-the-badge&logo=rust)](#-怎么搭起来的)
[![TypeScript](https://img.shields.io/badge/CLI-TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](#-命令)

[![Platforms](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-runtime-262D3A?style=flat-square)](#-怎么搭起来的)
[![MCP](https://img.shields.io/badge/MCP-built%20in-8A2BE2?style=flat-square)](#-为编码-agent-而做)
[![Frameworks](https://img.shields.io/badge/React%20%C2%B7%20Vue%20%C2%B7%20Svelte%20%C2%B7%20Next%20%C2%B7%20Astro-templates-F7DF1E?style=flat-square)](#-快速上手)

[🇺🇸 English](README.md) · **🇨🇳 简体中文**

</div>

---

## ⚡ acdev 是什么

acdev 之于 acde 应用, 就像 wrangler 之于 Cloudflare Workers. **acde 应用**就是带一份清单的 web 应用 (HTML、CSS、JavaScript,
框架随你挑), 在 Dopame OS 上作为真正的桌面应用运行. acdev 提供:

| 🧩 组成 | 💬 一句话 |
| --- | --- |
| 🛠️ **命令行 `acdev`** | `new` ➜ `dev` ➜ `test` ➜ `build` ➜ `install`: 从空目录一路到桌面上的应用 |
| 🖥️ **`acdev runtime`** | 跨平台调试运行时 (🐧 Linux · 🍎 macOS · 🪟 Windows): 原生窗口里跑你的应用, 改了自动重建刷新, 运行中随时查看 |
| 🧪 **`acdev vm`** | 用 QEMU/KVM 起一台 Dopame OS 客户机, 在真系统上试你的应用 |
| 🤖 **`acdev mcp`** | 经 MCP 把运行中的应用交给你的编码 agent |

### 🌊 一条龙

| 步骤 | 🎯 你运行 | ✨ 你得到 |
| :---: | --- | --- |
| 1️⃣ | `acdev new my-app --template react` | 从 12 个模板之一建好的工程, 带 `acde:check`、`acde:build`、`acde:dev` 三个脚本 |
| 2️⃣ | `acdev dev` | 应用在 `acdev runtime` 里跑起来, 每次保存自动重建并刷新 |
| 3️⃣ | `acdev eval` · `shot` · `console` · `network` | 在运行中的页面里看和动手, shell 或 agent 都行 |
| 4️⃣ | `acdev test` | 端到端测试, 每个测试自己一个隔离的运行时 |
| 5️⃣ | `acdev install` | 应用装进本机桌面, 和用户看到的一模一样 |

## 🔥 有什么不一样

| | |
| --- | --- |
| 🌐 **web 原样不动** | DOM、`window`、`fetch`、`localStorage`、事件、Web Audio、WebGPU 都照标准: 行为、签名、事件、错误. 还没做到的就是缺口, 绝不拿长得像的私有版本顶替. 不给标准对象加私有方法, 不加额外的全局: 只有 `window` 和 `globalThis`. |
| 🔌 **系统能力只有一个入口** | 系统能力来自 `acde:` 内置模块, 照 `node:fs` 的写法导入 (`import { fs } from 'acde:fs'`). 清单里的 capabilities 决定应用能导入哪些. |
| 🚀 **进程内注入, 不是 RPC** | `acde:` 模块直接注入页面所在的 V8 isolate, 像 workerd 注入 binding, 调用直接进 Rust 原生实现. `fs`、`terminal`、`network`、`office`、`picker` 已经是这样, 其余的正在迁过来. |
| 🧱 **没有 Chromium** | 页面由自研渲染器 (Blitz 的 fork) 排版和绘制, 页面 JavaScript 跑在运行时自己的 V8 里. 底下没有浏览器外壳. |
| 🎮 **GPU 优先** | 调试运行时每个平台只用一个 GPU 后端: Windows 用 DX12, macOS 用 Metal, Linux 用 Vulkan. |

## 🚀 快速上手

```sh
# 📦 安装 acdev (Linux / macOS)
curl -fsSL https://pkgs.dopame.ai/acdev/install.sh | sh
# 🪟 Windows (PowerShell)
irm https://pkgs.dopame.ai/acdev/install.ps1 | iex

# ✨ 新应用: html、desktop、react、vue、svelte、solid、preact、vanilla、next、nuxt、sveltekit 或 astro
acdev new my-app --template react          # 或者: bun create acde / npm create acde
cd my-app

# 🔁 在 acdev runtime 里运行: 每次改动自动重建并刷新
acdev dev

# ✅ 端到端测试, 每个测试一个隔离的运行时 (bun)
acdev test

# 📦 构建成包, 或者构建后装进本机桌面
acdev build
acdev install
```

🩺 这台机器缺什么? `acdev doctor` 检查 `acdev dev` 和 `acdev test` 需要的东西, 每一项都告诉你怎么修; `acdev doctor --fix`
修它能修的.

🏃 命令行跑在你已有的 bun (≥ 1.4) 或 Node.js (≥ 22.3) 上.

### 📋 环境要求

| | 用在 | 版本 |
| --- | --- | --- |
| 🥟 bun | 命令行、`acdev test` | ≥ 1.4 |
| 🟩 Node.js | 命令行 (代替 bun) | ≥ 22.3 |
| 🎮 GPU | `acdev runtime` | DX12 · Metal · Vulkan |
| 🐧 Linux + KVM + QEMU | `acdev vm` | x86_64 宿主 |

## 🧭 命令

| 命令 | 做什么 |
| --- | --- |
| ✨ `acdev new [目录]` | 从模板新建工程 (`--template`、`--backend`、`--install`、`--git`、`--pm`) |
| 🔍 `acdev check [目录]` | 检查清单、入口文件和每个 `acde:` 导入 |
| 📦 `acdev build [目录]` | 构建成运行时认的包, 再检查一遍产物的清单 |
| 💾 `acdev install` / `uninstall` | 装进本机桌面, 或者卸掉 (你同意的话连数据一起删) |
| 🔁 `acdev dev [目录...]` | 构建、起 acdev runtime, 改了就重建并刷新 (`--headless` 不开窗口) |
| ✅ `acdev test` | 端到端测试, 每个测试一个隔离的 acdev runtime (`--headed`、`-t`、`--trace`、`-u`) |
| 🩺 `acdev doctor` | 检查这台机器上 `dev` 和 `test` 需要的东西 (`--json`、`--fix`) |
| 🕹️ `acdev webs` · `eval` · `shot` · `inspect` · `query` · `act` · `console` · `network` · `screen` · `stop` | 查看和操作跑着的 `acdev dev` 里的页面, 或 `acdev vm` 里的会话 (`--session vm`) |
| 🔐 `acdev permissions` · `allow` · `deny` · `revoke` | 看待答的批准提示和已有决定, 回答它们, 撤销它们 |
| 🤖 `acdev mcp` | 给运行中会话的 stdio MCP 服务 |
| 🧠 `acdev skills` | 把 acdev 的 skill 装进你的编码 agent |
| 🧪 `acdev vm` | 在 Linux 宿主上用 QEMU 和 KVM 跑 Dopame OS 客户机 |

💡 `acdev --help` 列出全部命令; `acdev help <命令>` 显示选项、默认值和例子.

## 🤖 为编码 agent 而做

🦾 acdev 让 agent 能从头到尾开发一个应用, 而不只是改文件:

- 🔌 `acdev mcp` 把运行中的应用交给任何 MCP 客户端: `claude mcp add acdev -- acdev mcp`
- 💻 同样的工具也都是普通命令 (`acdev eval`、`acdev shot`、`acdev query`、`acdev act`、`acdev console` …), 有个 shell 就够
- 🧠 `acdev skills install` 把 acdev 的 skill 放到 agent 会去找的地方, agent 就懂这套流程和 `acde:` 模块

## 🧱 怎么搭起来的

| 部分 | 路径 | 是什么 |
| --- | --- | --- |
| 🛠️ 命令行 `acdev` | `npm/` | TypeScript: 工程、模板、打包、开发会话、端到端测试、driver 和 MCP、`acdev vm` |
| 🖥️ `acdev runtime` | `src/`、`crates/hostwin` | Rust: 宿主窗口, Windows 上是 Win32, macOS 和 Linux 上是 winit; 出帧、输入、输入法、剪贴板、文件对话框 |
| 📡 `acdevd` | `crates/devd` | 模拟器客户机里的设备守护进程, 以及宿主上到它的 vsock 中继, 只用 std |
| 🕵️ `acdev-agent` | `crates/agent` | 客户机里的 agent: 在会话的开发钩子上实现开发套接字的协议 |
| 🔧 `acdevtool` | `crates/tool` | 宿主小工具: stdin/stdout 到 Unix 套接字的中继, 以及 QEMU 客户机 D-Bus 显示的窗口 |
| 🌱 `create-acde` | `npm/create-acde` | `bun create acde` / `npm create acde`, 转去跑 `acdev new` 的薄壳 |

📚 运行时本体 (`acde:` 模块、渲染器、V8 嵌入) 是库 [libacde](https://github.com/0x00-Community/libacde), acdev 以 path 依赖链它.

### 🔧 从源码构建

- 📂 把 libacde 检出在本仓库旁边 (`../libacde`).
- 🦀 `cargo build` 构建 `acdev runtime`; `cd npm && bun install && bun run acdev -- --help` 从源码跑命令行.
- ⏳ libacde 依赖的几个 Rust crate 还没发到 crates.io. 发布之前, 从源码构建可能解析不全依赖; 上面的安装脚本装的是现成的构建.

🗺️ 接下来的计划 (Windows WHPX 和 macOS Hypervisor.framework 客户机、virtio-fs、vsock 上的设备守护进程) 见
[docs/roadmap.md](docs/roadmap.md) 和 [docs/vm.md](docs/vm.md).

## 📄 许可证

⚖️ [AGPL-3.0-only](LICENSE).

<div align="center">

**🖥️ 你熟悉的 web, 做成桌面应用.**

[⬆️ 回到顶部](#top) · [🇺🇸 English](README.md)

</div>
