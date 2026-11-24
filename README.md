<a id="top"></a>
<div align="center">

# acdev

### Build desktop apps with the web. Run them on a desktop with no browser inside.
**The developer toolkit for acde apps: one CLI to create, run, debug, test and install, plus a cross-platform debug runtime built on its own V8 and its own renderer.**

[![License](https://img.shields.io/badge/License-AGPL--3.0--only-blue?style=for-the-badge)](LICENSE)
[![Rust](https://img.shields.io/badge/Runtime-Rust-orange?style=for-the-badge&logo=rust)](#-how-its-built)
[![TypeScript](https://img.shields.io/badge/CLI-TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](#-commands)

[![Platforms](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-runtime-262D3A?style=flat-square)](#-how-its-built)
[![MCP](https://img.shields.io/badge/MCP-built%20in-8A2BE2?style=flat-square)](#-made-for-coding-agents)
[![Frameworks](https://img.shields.io/badge/React%20%C2%B7%20Vue%20%C2%B7%20Svelte%20%C2%B7%20Next%20%C2%B7%20Astro-templates-F7DF1E?style=flat-square)](#-quick-start)

**🇺🇸 English** · [🇨🇳 简体中文](README.zh-CN.md)

</div>

---

## ⚡ What is acdev

acdev is to acde apps what wrangler is to Cloudflare Workers. An **acde app** is a web app (HTML, CSS, JavaScript, any
framework you like) packaged with a manifest, and it runs as a real desktop app on Dopame OS. acdev gives you:

| 🧩 Piece | 💬 In one line |
| --- | --- |
| 🛠️ **The `acdev` CLI** | `new` ➜ `dev` ➜ `test` ➜ `build` ➜ `install`: from an empty folder to an app on your desktop |
| 🖥️ **`acdev runtime`** | A cross-platform debug runtime (🐧 Linux · 🍎 macOS · 🪟 Windows): your app in a native window, rebuilt and reloaded on every change, inspectable while it runs |
| 🧪 **`acdev vm`** | Boots a Dopame OS guest under QEMU/KVM, so you try your app on the real system |
| 🤖 **`acdev mcp`** | Hands the running app to your coding agent over MCP |

### 🌊 The flow

| Step | 🎯 You run | ✨ You get |
| :---: | --- | --- |
| 1️⃣ | `acdev new my-app --template react` | A project from one of 12 templates, with `acde:check`, `acde:build` and `acde:dev` scripts |
| 2️⃣ | `acdev dev` | Your app live in `acdev runtime`, rebuilt and reloaded on every save |
| 3️⃣ | `acdev eval` · `shot` · `console` · `network` | Eyes and hands inside the running page, from a shell or an agent |
| 4️⃣ | `acdev test` | End-to-end tests, each one in its own isolated runtime |
| 5️⃣ | `acdev install` | The app on this machine's desktop, exactly as users will see it |

## 🔥 Why it's different

| | |
| --- | --- |
| 🌐 **The web, unmodified** | DOM, `window`, `fetch`, `localStorage`, events, Web Audio and WebGPU follow the standards: behavior, signatures, events, errors. Whatever isn't there yet is a gap, never a look-alike. No private methods on standard objects, no extra globals: only `window` and `globalThis`. |
| 🔌 **One door to the system** | System capabilities come from `acde:` built-in modules, imported like `node:fs` (`import { fs } from 'acde:fs'`). The manifest's capabilities decide which ones an app may import. |
| 🚀 **In-process, not RPC** | `acde:` modules are injected into the page's own V8 isolate, the way workerd injects bindings, so a call goes straight into native Rust. `fs`, `terminal`, `network`, `office` and `picker` already work this way; the rest are moving over. |
| 🧱 **No Chromium** | Pages are laid out and painted by a renderer of its own (a fork of Blitz), and page JavaScript runs in the runtime's own V8. There is no browser shell underneath. |
| 🎮 **GPU first** | The debug runtime draws with one GPU backend per platform: DX12 on Windows, Metal on macOS, Vulkan on Linux. |

## 🚀 Quick start

```sh
# 📦 install acdev (Linux / macOS)
curl -fsSL https://pkgs.dopame.ai/acdev/install.sh | sh
# 🪟 Windows (PowerShell)
irm https://pkgs.dopame.ai/acdev/install.ps1 | iex

# ✨ a new app: html, desktop, react, vue, svelte, solid, preact, vanilla, next, nuxt, sveltekit or astro
acdev new my-app --template react          # or: bun create acde / npm create acde
cd my-app

# 🔁 run it in acdev runtime: rebuilds and reloads on every change
acdev dev

# ✅ end-to-end tests, each in an isolated runtime (bun)
acdev test

# 📦 build the package, or build it and install it on this machine's desktop
acdev build
acdev install
```

🩺 Something missing on this machine? `acdev doctor` checks what `acdev dev` and `acdev test` need and tells you how to fix each
item; `acdev doctor --fix` fixes what it can.

🏃 The CLI runs on the bun (≥ 1.4) or Node.js (≥ 22.3) you already have.

### 📋 Requirements

| | Needed for | Version |
| --- | --- | --- |
| 🥟 bun | the CLI, `acdev test` | ≥ 1.4 |
| 🟩 Node.js | the CLI (instead of bun) | ≥ 22.3 |
| 🎮 GPU | `acdev runtime` | DX12 · Metal · Vulkan |
| 🐧 Linux + KVM + QEMU | `acdev vm` | x86_64 host |

## 🧭 Commands

| Command | What it does |
| --- | --- |
| ✨ `acdev new [dir]` | Create a project from a template (`--template`, `--backend`, `--install`, `--git`, `--pm`) |
| 🔍 `acdev check [dir]` | Check the manifest, the entry files and every `acde:` import |
| 📦 `acdev build [dir]` | Build a package the runtime accepts, then check the built manifest again |
| 💾 `acdev install` / `uninstall` | Install on this machine's desktop, or remove it (and, if you say so, its data) |
| 🔁 `acdev dev [dir...]` | Build, start acdev runtime, rebuild and reload on every change (`--headless` for no window) |
| ✅ `acdev test` | End-to-end tests, each one with an isolated acdev runtime (`--headed`, `-t`, `--trace`, `-u`) |
| 🩺 `acdev doctor` | Check this machine for what `dev` and `test` need (`--json`, `--fix`) |
| 🕹️ `acdev webs` · `eval` · `shot` · `inspect` · `query` · `act` · `console` · `network` · `screen` · `stop` | Look at and drive the pages of a running `acdev dev`, or of the session in `acdev vm` (`--session vm`) |
| 🔐 `acdev permissions` · `allow` · `deny` · `revoke` | See pending approval prompts and past decisions, answer them, take them back |
| 🤖 `acdev mcp` | An MCP server on stdio for the running session |
| 🧠 `acdev skills` | Install the acdev skill into your coding agents |
| 🧪 `acdev vm` | A Dopame OS guest under QEMU with KVM, on a Linux host |

💡 `acdev --help` lists them all; `acdev help <command>` shows the options, their defaults and examples.

## 🤖 Made for coding agents

🦾 acdev is built so an agent can develop an app end to end, not just edit files:

- 🔌 `acdev mcp` exposes the running app to any MCP client: `claude mcp add acdev -- acdev mcp`
- 💻 the same tools are plain commands too (`acdev eval`, `acdev shot`, `acdev query`, `acdev act`, `acdev console` …), so a shell is enough
- 🧠 `acdev skills install` puts the acdev skill where your agents look for it, so they know the workflow and the `acde:` modules

## 🧱 How it's built

| Part | Path | What it is |
| --- | --- | --- |
| 🛠️ `acdev` CLI | `npm/` | TypeScript: projects, templates, the bundler, dev sessions, the e2e test runner, the driver and MCP, `acdev vm` |
| 🖥️ `acdev runtime` | `src/`, `crates/hostwin` | Rust: the host window on Win32 (Windows) and winit (macOS, Linux), output, input, IME, clipboard and file dialogs |
| 📡 `acdevd` | `crates/devd` | The guest device daemon of the emulator and the host's vsock relay to it, only std |
| 🕵️ `acdev-agent` | `crates/agent` | The agent in the guest: the dev socket's protocol over the session's dev hooks |
| 🔧 `acdevtool` | `crates/tool` | A host helper: a stdin/stdout relay to a Unix socket, and the window of a QEMU guest's D-Bus display |
| 🌱 `create-acde` | `npm/create-acde` | `bun create acde` / `npm create acde`, a thin launcher for `acdev new` |

📚 The runtime itself (the `acde:` modules, the renderer and the V8 embedding) is the library
[libacde](https://github.com/0x00-Community/libacde), which acdev links as a path dependency.

### 🔧 Building from source

- 📂 Check out libacde beside this repository (`../libacde`).
- 🦀 `cargo build` builds `acdev runtime`; `cd npm && bun install && bun run acdev -- --help` runs the CLI from source.
- ⏳ A few Rust crates libacde depends on are not on crates.io yet. Until they are published, a build from source may not resolve
  every dependency; the installers above ship ready-made builds.

🗺️ The plan from here (Windows WHPX and macOS Hypervisor.framework guests, virtio-fs, a device daemon over vsock) is in
[docs/roadmap.md](docs/roadmap.md) and [docs/vm.md](docs/vm.md).

## 📄 License

⚖️ [AGPL-3.0-only](LICENSE).

<div align="center">

**🖥️ The web you know, as a desktop app.**

[⬆️ Back to top](#top) · [🇨🇳 简体中文](README.zh-CN.md)

</div>
