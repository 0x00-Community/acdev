# acdebin-dbg

跨平台调试运行时 `acdebin-dbg` (Rust, 仓库根 `src/` 和 `crates/hostwin`) 和开发者 CLI `acde` (TypeScript, `npm/`) 的仓库. 闭源,
`publish = false`. 说明都在本文件、`CONTEXT.md` 和 `docs/` 里 (没有 README), 按下面的文件路由选读.

## 仓库规则

- **第一原则** (同 [acdert](http://gitea.dopamine/AC/acdert) 的 AGENTS.md): 不许在任何层次上魔改 web 接口. 运行时的一切 (清单、`acde:` 模块、
  窗口模型、dev IPC 的 op、后端怎么跑) 以 acdert 的 AGENTS.md 为准 (acdert 并排检出在 `../acdert`), 本仓库只写调试运行时和 CLI 自己的部分.
- full agentic.
- **代码不写注释** (Rust 和 TS 都是; `//`、`/* */`、JSDoc 都不写), 要说明的写进 `docs/` 的对应文件; 工具要读的指令 (`/// <reference>`、
  `@ts-expect-error`) 除外.
- CLI 的日志和命令行输出只用英文; 同一份 CLI 代码在 bun 和 Node 上都跑, `Bun.*`、`bun:*`、宏只能出现在 bun 专属的路径上
  (见 `docs/cli-overview.md` 的「bun 和 Node」).
- CLI 闭源: 代码是专有的 (`npm/LICENSE`, package.json `"license": "UNLICENSED"`), 仓库不公开; 发布时连运行时一起发到 npm (`@dopame/acde` 等, 见 `docs/release-distribution.md` 的「npm」).
- 格式化: Rust 用 `cargo fmt --all` (`rustfmt.toml`: `max_width = 160`).
- 命令、参数、配置字段、清单、`acde:` 模块、测试 API、MCP 工具、对外可见的行为变了, **同一个提交里改 skill** (`npm/skills/acde/`,
  见 `docs/skills.md`); skill 只写对外的用法, 实现和取舍写在 `docs/`.

## 提交与推送

- 仓库在内网 Gitea (`origin` = `ssh://git@gitea.dopamine:2333/AC/acdebin-dbg.git`). 不 force push, 不开分支、不开 worktree.
- 提交一律 `git commit -- <自己的路径>`, 英文 Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By; 提交前 `cargo fmt --all`、
  clippy 要过. 做完就提交并推送.
- 改 `crates/hostwin` 的提交先在这棵树编出来的 acdebin-dbg 上起一次 (`ACDE_HEADLESS=1` 也行), 写清已验证 / 未验证.
- 汇报时分开写「已验证 / 未验证」.

## Agent 规范

- **说明分层**：本文件只放每次都要读的定位、仓库规则和文件路由；细节写进 `docs/` 的主题文件，并在路由表里登记。一个意思只写在一处，改说明时保持这个分层。
- **领域词汇**：本仓术语以 `CONTEXT.md` 为准。动手前先读涉及的词条，代码命名、文档和提交说明都用表里的叫法；遇到新概念或叫法冲突，先确认再补进 `CONTEXT.md`。细则见 `docs/agents/domain.md`。
- **架构决定**：记在 `docs/adr/NNNN-<名称>.md`，只记难以逆转、缺背景会让人困惑、确实有取舍的决定。改动和已有决定冲突时先指出，不绕开。
- **任务跟踪**：本仓不用议题，任务与规划记在别处。细则见 `docs/agents/issue-tracker.md`。

## 文件路由

| 什么时候读 | 文件 |
| --- | --- |
| 弄清本仓库在三仓架构里的位置、`src/` 各文件做什么、`acde` 怎么找运行时 | `docs/architecture.md` |
| 碰到本仓库特有的词 (宿主窗口、单应用会话、契约级别、配对版本、认领、测试会话……) | `CONTEXT.md` |
| 在本地编译、运行 `acdebin-dbg`, 或让源码跑的 `acde dev` 用上它 | `docs/runtime-build.md` |
| 改宿主窗口、合成、出帧、GPU、输入、窗框、菜单、headless 或系统能力 (`crates/hostwin`) | `docs/hostwin.md` |
| 了解 CLI 的启动速度、仓库脚本、工程与安装目录, 或写要在 bun 和 Node 上都跑的代码 | `docs/cli-overview.md` |
| 加改 CLI 命令或参数, 改帮助、颜色、stderr 格式、退出码、`check --platform` 或 `acde:` 导入检查 | `docs/cli-commands.md` |
| 改 `acde new`、模板、包管理器选择、SDK 依赖写法或 `acde sdk` | `docs/acde-new.md` |
| 改 `acde build` / `install`: 工程与包、框架识别、打包器、`public/`、后端和 preload (含 Windows 通道模式) | `docs/acde-build.md` |
| 改 `acde doctor` 的检查项、修法文字或 `--fix` | `docs/acde-doctor.md` |
| 改 `acde dev`: 契约级别检查、stderr 过滤、监听重建、信号、一个工程一个会话、会话文件、dev IPC 连接 | `docs/acde-dev.md` |
| 改 `webs` / `eval` / `shot` / `inspect` / `act` 等会话命令、批准命令、devtools、driver、截图、trace、MCP 工具或 `acde test` | `docs/devtools-driver-mcp.md` |
| 发版, 改 `release.yml`、`npm/scripts/dist.ts`、`scripts/install.sh` / `install.ps1`、launcher 或安装目录布局 | `docs/release-distribution.md` |
| 改 `npm/skills/acde/`、`acde skills`、`scripts/install.md`, 或对外行为变了要同步文档 | `docs/skills.md` |
| 改 CLI 和 acdert 之间的东西: 清单校验、运行时命令行与环境变量、后端启动、Windows 后端契约 | `docs/contract-with-acdert.md` |
| 跑或加 CLI 的测试, 在 Windows 上跑 `bun test` | `docs/cli-tests.md` |
| 挑下一件 CLI 的事做, 或判断某个功能是不是已经计划过 | `docs/roadmap.md` |
| 想推翻三仓分法 | `docs/adr/0001-three-repos.md` |
| 想把命令行、运行时、宿主文件或 SDK 分开发版 | `docs/adr/0002-one-release-one-version.md` |
| 想在 Windows 上让后端开 TCP 端口或命名管道 | `docs/adr/0003-windows-backend-contract.md` |
| 想让 `acde doctor --fix` 或 MCP 的 `doctor_fix` 多修一类问题 | `docs/adr/0004-doctor-fix-scope.md` |
| 想换发布用的 runner 或存储 | `docs/adr/0005-release-infrastructure.md` |
| 理解或补充领域词汇、记录架构决定 | `docs/agents/domain.md` |
| 用 to-spec / to-tickets / wayfinder 等需要跟踪器的技能 | `docs/agents/issue-tracker.md` |

`docs/` 里 CLI 的文件路径相对 `npm/`, 运行时的相对仓库根, 每个文件开头注明.
