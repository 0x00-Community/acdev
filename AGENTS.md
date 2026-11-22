# acdev

acdev (原 acdev runtime, 2026-11-17 并入 acdert 后改名) 是 acdev (Dopame 的桌面基座) 的开发仓库, 方向是多平台模拟器: 内部用各平台的硬件虚拟化
(Linux KVM、Windows WHPX、macOS Hypervisor.framework) 跑装着 Dopame OS 的虚拟机, 开发者工具内置其中 (用户定 2026-11-17). 现在仓库里有:

- 运行时库不在本仓库: [libacde](http://gitea.dopamine/AC/libacde) (原 AC/acdert, 2026-11-17 并进本仓库的 `acdert/`, 2026-11-18 连历史拆出),
  和本仓库并排检出 (`../libacde`), 以 path 依赖链它 (Rust 包 `libacde`, 代码里 `use acde::…`); 虚拟机里的 [acdes](http://gitea.dopamine/AC/acdes) 也这样链它. 跨仓契约
  (包清单与清单规则、SDK `@acde/api`、契约级别、`acde_*` 协议) 和运行时的文档都在 libacde, 见它的 AGENTS.md.
- 仓库根 `src/` 和 `crates/hostwin`: 跨平台调试运行时 `acdev runtime` (宿主窗口); 朝模拟器演进.
- `npm/`: 开发者命令行 `acdev` (TypeScript, 原 AC/acde-cli, 连历史并入), 跑在开发者已有的 bun ≥ 1.4 或 Node.js ≥ 22.3 上.

闭源. 说明都在本文件和 `docs/` 里: 没有 README, 子目录不放 AGENTS.md. 按下面的文件路由选读.

> **第一原则: 不许在任何层次上魔改 web 接口.**
>
> - web 接口 (DOM、`window`、`fetch`、`localStorage`、事件、Web Audio、WebGPU …) 和浏览器**完全兼容**: 行为、签名、事件、错误都照标准.
>   不给标准对象加私有方法 / 字段 / 事件, 不改标准语义. 做不到的就是缺口, 记成「还没有」, 不拿长得像的私有版本顶替.
> - **全局只有两个**: `window` (web 兼容) 和 `globalThis` (node 兼容). 没有 `acdev` 全局, 不往全局上挂非标准的东西.
> - 系统能力只有一个入口: `acde:` 内置模块, 照 `node:fs` 的写法导入 (`import { fs } from 'acde:fs'`、`import self from 'acde:window'` …;
>   类型在 SDK `@acde/api`). 清单的 capabilities 决定能导入哪些, 没开的导入直接失败. 「魔改」只许发生在 `acde:` 这一层.
> - **`acde:` 模块是进程内注入, 不是 RPC**: 像 workerd 的 binding, 直接注入页面所在的 V8 isolate, 调用直接进 Rust 原生实现, 不经 socket /
>   IPC / 别的进程代办.
> - 兼容的是标准接口, 不是 Chromium: 渲染器是自研的 (Blitz 的 fork, libacde 的 `vendor/blitz` 子模块, 没有 JS 引擎), 页面 JS 在运行时库自己的 V8 里. 没有
>   Chromium 的浏览器外壳; 正式运行没有远程调试端口, 只在开发模式 (`ACDE_DEV`) 下在本机 `127.0.0.1` 开 CDP 端点 (见 libacde 的 `docs/dev/devtools.md`).
>   开发者工具内置进 acdev, 不依赖 Chrome (用户定 2026-11-17); 现在 `acdev devtools` 还借 Chrome / Edge 打开, 见 `docs/devtools-driver-mcp.md`.
> - 现有的债 (不是先例, 新代码不许再加, 动到时往这个方向收): web 里除 fs / terminal / network / office / picker 以外的 `acde:` 模块
>   还是经 `rpc.ts` / `remote.ts` 调到 Broker (见 libacde 的 `docs/runtime/webs.md`「通信」); acde-dopame 还直接用 napi 导出.

SDK `@acde/api` (只有类型声明) 和契约级别 `api-level` 在 libacde 的 `acde-api/`, 命令行以 `file:../../libacde/acde-api` 引用 (见 libacde 的
`docs/acde-api.md`); 清单规则在 libacde 的 `manifest/` (运行时的页面一侧和命令行共用一份), `npm/src/manifest/` 只是转出它的薄壳; Vite 插件在
`npm/src/vite-plugin.ts`. 文档里其余指向 `web/` 的地方按删除前写.

`acde:` 模块接口的版本化标准、接口验证器和一致性测试在 [AC/acde-RFC](http://gitea.dopamine/AC/acde-RFC) (说明见 libacde 的 AGENTS.md); 宿主窗口运行时的
一致性用它的 `runner/` 验 (`acdev dev` 跑这个应用).

## 代码约定

- 闭源 (用户定 2026-11-08): 自己的代码是专有的 (`npm/LICENSE`), package.json 写 `"license": "UNLICENSED"`, Cargo.toml 不写 `license`.
  Rust 包 `publish = false`; 仓库和 release 不公开. npm 上发的包见 `docs/release-distribution.md` (用户定 2026-11-14: 二进制闭源, JS 可以公开一些).
- Rust 和 TypeScript 代码不写注释 (`//`、`/* */`、`///`、JSDoc 都不写), 要说明的写进 `docs/` 里对应的文件. 例外: 版权和许可证行、
  工具指令 (`/// <reference>`, `@ts-expect-error`). derive 要读的文字写成属性.
- 命令行的日志和输出只用英文; 同一份命令行代码在 bun 和 Node 上都跑, `Bun.*`、`bun:*`、宏只能出现在 bun 专属的路径上 (见 `docs/cli-overview.md` 的「bun 和 Node」).
- 命令、参数、配置字段、清单、`acde:` 模块、测试 API、MCP 工具、对外可见的行为变了, **同一个提交里改 skill** (`npm/skills/acdev/`, 见 `docs/skills.md`);
  skill 只写对外的用法, 实现和取舍写在 `docs/`.
- 系统调用走 rustix, 不直接依赖 libc; rustix 没有的用专门的 crate (signal-hook、jiff). 按平台的代码用 `#[cfg]` / `cfg_select!`, 先用 std.
- 依赖版本 1.0 及以上只写主版本号 (`wgpu = "30"`), 0.x 写到次版本 (`log = "0.4"`), 用最新的; 例外见 libacde 的 AGENTS.md (blitz fork 和配套的用 `=` 钉住).
- `Cargo.lock` 进 git (用户定 2026-11-18; 根上一份, `crates/devd`、`relay`、`viewer` 各一份): 依赖只在主动更新时变, CI 一律 `--locked`.
  更新依赖见 `docs/runtime-build.md`「依赖与 Cargo.lock」.
  0.x 写到次版本正是因为这个: 只写 `"0"` 时, workspace 的版本号一变, cargo 会重新解析这些 crate 的依赖, 它们会落到旧锁里已有的老版本上, 只在 Linux
  编的 `voice`、`office` 就编不过 (`rand::rng` 找不到, `Hmac<Sha256>` 的 trait 对不上); macOS 和 Windows 不编这两个模块, 看不到这个错.
- `npm/bun.lock` 进 git, 改依赖时放在同一个提交里.
- 诊断用 `log` 的宏, 不用 `eprintln!` (测试、命令行输出除外).
- 格式化: Rust 只格式化自己改的文件: `rustfmt --edition 2024 --config-path rustfmt.toml <文件...>`, 或加 `--check` 只看不改 (根目录
  `rustfmt.toml`: 宽 160, `use_small_heuristics = "Max"`). 不要不带参数跑 `cargo fmt` / `cargo fmt --all`: 路径依赖 (并排的 `../libacde`
  和它的 `vendor/blitz`) 会被一起改写 (2026-11-18 总仓检出里出过一次, 用户定).
- 构建不从外网取东西 (2026-11-14): 依赖都从内网 Gitea 取 (libacde 和它的 blitz 子模块、rusty_v8 预编译库、CI 的 action), 见 libacde 的 `docs/dev/build-run.md`「构建不从外网取东西」.
  Cargo.toml / package.json 里的仓库地址写 gitea (`http://gitea.dopamine/AC/acdev`).

## 提交与推送

- CI 与发版不在云端试错 (用户定 2026-11-18): 改 CI 工作流或准备发版前, 先读 `~/.agents/references/github-release.md`; 先在本机或执行机上
  复现 (本机用 `cargo xwin` 等把各平台构建与打包跑一遍, 执行机环境先登录核对或问用户), 全部通过后才动云端; 云端 CI 只用于本地通过后的一次
  不发布预演和正式发版, 失败就回本地修, 不连续重跑. 工作流是 `.github/workflows/` 的四个: `build.yaml` (推 main 就自动跑, 预演, 接着
  `test.yaml`)、`test.yaml`、`tag.yaml` (发版的唯一手动入口)、`release.yaml` (只被 `tag.yaml` 调, 传 R2), 见 `docs/release-distribution.md`.
  手动触发 CI (手动运行 `build.yaml` / `test.yaml`、跑 `tag.yaml` 发版) 只由测试 Agent 或主会话做, 开发 Agent 只改代码.
- 仓库在内网 Gitea (`origin` = `ssh://git@gitea.dopamine:2333/AC/acdev.git`, 网页 `http://gitea.dopamine/AC/acdev`), 只推这里 (用户定 2026-11-14:
  GitHub 不再更新).
- 远端只有 `main` (加发版和存档的 tag), 不推别的分支. 本地需要时在总仓 `.worktrees/acdev-<后缀>` 开工作树和本地分支 `Akira/<后缀>` (基于
  `origin/main`), 做完普通合并回 `main` 再推 `origin main` (用户定 2026-11-17). 不开工作树时几个会话共用工作区和 git index: 只改自己负责的路径,
  别人没提交的文件先等.
- 提交用 `git commit -- <自己的路径...>` (acde 的仓库不依赖 uv, 用户定 2026-11-19). 推前 `git show --stat HEAD` 和 `git log origin/main..HEAD` 看一眼. `git add` / `git rm` 之后立刻提交.
  做完就提交并推送.
- 不 force push, 不 amend / rebase 已推送的提交.
- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 正文写原因和验证情况 (性能数字注明负载), 不加 Co-Authored-By.
- 不在总仓的 acdev 检出 (`<总仓>/acdev`) 里改动或格式化任何文件, 改就开工作树 (用户定 2026-11-18): 那个检出是总仓记录的版本, 也给测试联调用.
- 提交前: 按上面的写法格式化自己改的文件; 改了 `npm/` 时 `bun run typecheck` (在 `npm/`); 总仓的质量检查 `bun scripts/quality/check.ts <本仓库> origin/main`
  (在总仓跑, 结果须为 0 条).
- 构建、运行和测试按工程需要直接做 (命令行: `bun test`、`bun run typecheck`, 在 `npm/`; 运行时: 见 libacde 的 `docs/dev/testing.md`), 做了就在提交信息里写清
  已验证 / 未验证. 汇报时也分开写「已验证 / 未验证」.

## 文件路由

运行时库的文档在 libacde 的 `docs/`. 这里 `docs/*.md` 里命令行的路径相对 `npm/`, 调试运行时的相对仓库根, 每个文件开头注明.

| 什么时候读 | 文件 |
| --- | --- |
| 改说明或新增说明文档 | `docs/writing-docs.md` |
| 改运行时库 (libacde: V8、DOM、渲染、`acde:` 模块、存储、网页接口、清单规则、SDK、`protocol/`、C 接口、WPT) 或要弄清各仓的分工 | libacde 的 `AGENTS.md` 和它的 `docs/` |
| 改客户机设备守护进程 acdevd (`crates/devd`): vsock、推送、运行、停止的协议 | `docs/devd.md` |
| 改 acdev 自己的客户机窗口 `acdevtool view` (`crates/tool`): QEMU 的 D-Bus 显示、画面、键鼠 | `docs/viewer.md` |
| 改 `acdev vm` (`npm/src/vm/`): 在 QEMU 里起 Dopame OS 客户机 (KVM)、把文件送进客户机、串口日志、截图 | `docs/vm.md` |
| 弄清调试运行时在各仓架构里的位置、`src/` 各文件做什么、`acdev` 怎么找运行时 | `docs/architecture.md` |
| 在本地编译、运行 `acdev runtime`, 或让源码跑的 `acdev dev` 用上它; 选编译配置 (`dev` / `guest` / `release`)、产物目录 `CARGO_TARGET_DIR` | `docs/runtime-build.md` |
| 改宿主窗口、合成、出帧、GPU、输入、窗框、菜单、headless 或系统能力 (`crates/hostwin`) | `docs/hostwin.md` |
| 改运行时自检 `acdev runtime doctor` (`src/doctor.rs`) 的检查项或输出 | `docs/doctor.md` |
| 了解命令行的启动速度、仓库脚本、工程与安装目录, 或写要在 bun 和 Node 上都跑的代码 | `docs/cli-overview.md` |
| 加改命令行的命令或参数, 改帮助、颜色、stderr 格式、退出码、`check --platform` 或 `acde:` 导入检查 | `docs/cli-commands.md` |
| 改 `acdev new`、模板、包管理器选择、SDK 依赖写法或 `acdev sdk` | `docs/acde-new.md` |
| 改 `acdev build` / `install`: 工程与包、框架识别、打包器、`public/`、后端和 preload (含 Windows 通道模式) | `docs/acde-build.md` |
| 改 `acdev doctor` 的检查项、修法文字或 `--fix` | `docs/acde-doctor.md` |
| 改 `acdev dev`: 契约级别检查、stderr 过滤、监听重建、热重载、信号、一个工程一个会话、会话文件、dev IPC 连接 | `docs/acde-dev.md` |
| 改 `webs` / `eval` / `shot` / `inspect` / `act` 等会话命令、批准命令、devtools、driver、截图、trace、MCP 工具或 `acdev test` | `docs/devtools-driver-mcp.md` |
| 发版, 改 `.github/workflows/` 的 `build.yaml` / `test.yaml` / `tag.yaml` / `release.yaml`、`npm/scripts/dist.ts`、`scripts/install.sh` / `install.ps1`、launcher 或安装目录布局 | `docs/release-distribution.md` |
| 改 `npm/skills/acdev/`、`acdev skills`、`scripts/install.md`, 或对外行为变了要同步文档 | `docs/skills.md` |
| 改命令行和运行时之间的东西: 清单校验、运行时命令行与环境变量、后端启动、Windows 后端契约 | `docs/contract-with-libacde.md` |
| 跑或加命令行的测试, 在 Windows 上跑 `bun test` | `docs/cli-tests.md` |
| 挑下一件命令行的事做, 或判断某个功能是不是已经计划过 | `docs/roadmap.md` |
