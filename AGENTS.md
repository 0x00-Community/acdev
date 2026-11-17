| 改 SDK `@dopame/acde-api` (`npm/acde-api/`, 只有类型声明), 或在别的工程里引用它 | `docs/acde-api.md` |
# acdev

acdev (原 acdev runtime, 2026-11-17 并入 acdert 后改名) 是 acdev (Dopame 的桌面基座) 的开发仓库, 方向是多平台模拟器: 内部用各平台的硬件虚拟化
(Linux KVM、Windows WHPX、macOS Hypervisor.framework) 跑装着 Dopame OS 的虚拟机, 开发者工具内置其中 (用户定 2026-11-17). 现在仓库里有:

- `acdert/`: 运行时库 (原 AC/acdert, 连历史并入): 内嵌 V8、自研 DOM 与排版绘制 (Blitz fork + detour / vello)、网页存储、媒体、WebGPU / WebGL 绑定和
  `acde:` 系统模块, 拥有全部跨仓契约 (包清单、SDK `@dopame/acde-api`、`acde_*` 协议). 对外是 Rust 包 `acdert` (rlib + `libacdert.so` + `include/acdert.h`);
  虚拟机里的 acdebin-system 也链接它.
- 仓库根 `src/` 和 `crates/hostwin`: 跨平台调试运行时 `acdev runtime` (宿主窗口); 朝模拟器演进.
- `npm/`: 开发者命令行 `acdev` (TypeScript, 原 AC/acde-cli, 连历史并入), 跑在开发者已有的 bun ≥ 1.4 或 Node.js ≥ 22.3 上.

闭源. 说明都在本文件和 `docs/` 里: 没有 README, 子目录不放 AGENTS.md. 按下面的文件路由选读.

> **第一原则: 不许在任何层次上魔改 web 接口.**
>
> - web 接口 (DOM、`window`、`fetch`、`localStorage`、事件、Web Audio、WebGPU …) 和浏览器**完全兼容**: 行为、签名、事件、错误都照标准.
>   不给标准对象加私有方法 / 字段 / 事件, 不改标准语义. 做不到的就是缺口, 记成「还没有」, 不拿长得像的私有版本顶替.
> - **全局只有两个**: `window` (web 兼容) 和 `globalThis` (node 兼容). 没有 `acdev` 全局, 不往全局上挂非标准的东西.
> - 系统能力只有一个入口: `acde:` 内置模块, 照 `node:fs` 的写法导入 (`import { fs } from 'acde:fs'`、`import self from 'acde:window'` …;
>   类型在 SDK `@dopame/acde-api`). 清单的 capabilities 决定能导入哪些, 没开的导入直接失败. 「魔改」只许发生在 `acde:` 这一层.
> - **`acde:` 模块是进程内注入, 不是 RPC**: 像 workerd 的 binding, 直接注入页面所在的 V8 isolate, 调用直接进 Rust 原生实现, 不经 socket /
>   IPC / 别的进程代办.
> - 兼容的是标准接口, 不是 Chromium: 渲染器是自研的 (Blitz 的 fork, `acdert/vendor/blitz` 子模块, 没有 JS 引擎), 页面 JS 在 acdert 自己的 V8 里. 没有
>   Chromium 的浏览器外壳; 正式运行没有远程调试端口, 只在开发模式 (`ACDE_DEV`) 下在本机 `127.0.0.1` 开 CDP 端点 (见 `docs/dev/devtools.md`).
>   开发者工具内置进 acdev, 不依赖 Chrome (用户定 2026-11-17); 现在 `acdev devtools` 还借 Chrome / Edge 打开, 见 `docs/devtools-driver-mcp.md`.
> - 现有的债 (不是先例, 新代码不许再加, 动到时往这个方向收): web 里除 fs / terminal / network / office / picker 以外的 `acde:` 模块
>   还是经 `rpc.ts` / `remote.ts` 调到 Broker (见 `docs/runtime/webs.md`「通信」); acde-dopame 还直接用 napi 导出.

`acdert/web/` (acde-api、acde-dom、acde-host) 已于 acdert 91e7dd1e 删除 (CTO 决定). SDK 的替代品是 `npm/acde-api/` 的 `@dopame/acde-api`, 只有类型声明
(见 `docs/acde-api.md`); acde-dom、acde-host 不搬. `acdert` 仍编不过 (`acdert/src/host/mod.rs` 读 `web/` 里的 `level.js`), 发不了新版本;
命令行用的清单校验、契约级别和 Vite 插件搬进了 `npm/src/manifest/`、`npm/src/vite-plugin.ts`. 文档里其余指向 `web/` 的地方按删除前写.

## 代码约定

- 闭源 (用户定 2026-11-08): 自己的代码是专有的 (`acdert/LICENSE`、`npm/LICENSE`), package.json 写 `"license": "UNLICENSED"`, Cargo.toml 不写 `license`.
  `acdert` 只发到内网 cargo 源 ac (`publish = ["ac"]`, 见 `docs/dev/release.md`「cargo 源 ac」), 其余 Rust 包 `publish = false`; 仓库和 release 不公开.
  npm 上发的包见 `docs/release-distribution.md` (用户定 2026-11-14: 二进制闭源, JS 可以公开一些). `acdert/vendor/` 和 `acdert/src/napi` 保留上游的许可证文件和版权行.
- Rust 和 TypeScript 代码不写注释 (`//`、`/* */`、`///`、JSDoc 都不写), 要说明的写进 `docs/` 里对应的文件. 例外: 版权和许可证行 (`acdert/src/napi` 的
  Deno 版权)、工具指令 (`/// <reference>`, `@ts-expect-error`)、`acdert/vendor/` 改动处的 `acrender:` (blitz fork 里) / `acde:` 标记. derive 要读的文字写成属性.
- 命令行的日志和输出只用英文; 同一份命令行代码在 bun 和 Node 上都跑, `Bun.*`、`bun:*`、宏只能出现在 bun 专属的路径上 (见 `docs/cli-overview.md` 的「bun 和 Node」).
- 命令、参数、配置字段、清单、`acde:` 模块、测试 API、MCP 工具、对外可见的行为变了, **同一个提交里改 skill** (`npm/skills/acdev/`, 见 `docs/skills.md`);
  skill 只写对外的用法, 实现和取舍写在 `docs/`.
- 系统调用走 rustix, 不直接依赖 libc; rustix 没有的用专门的 crate (signal-hook、jiff). 按平台的代码用 `#[cfg]` / `cfg_select!`, 先用 std.
- 依赖版本 1.0 及以上只写主版本号 (`wgpu = "30"`), 0.x 写到次版本 (`log = "0.4"`), 用最新的; 例外是换成 `acdert/vendor/` 的 crate 和配套的 (blitz-*、stylo*、
  parley、html5ever、cssparser) 用 `=` 钉住.
- `Cargo.lock` 不进 git (`.gitignore`): 依赖按 Cargo.toml 解析到最新. 本地留下的 `Cargo.lock` 不会自己跟上: 拉取之后先 `cargo update` (或删掉它) 再编.
  0.x 写到次版本正是因为这个: 只写 `"0"` 时, workspace 的版本号一变, cargo 会重新解析这些 crate 的依赖, 它们会落到旧锁里已有的老版本上, 只在 Linux
  编的 `voice`、`office` 就编不过 (`rand::rng` 找不到, `Hmac<Sha256>` 的 trait 对不上); macOS 和 Windows 不编这两个模块, 看不到这个错.
- `npm/bun.lock` 进 git, 改依赖时放在同一个提交里.
- 诊断用 `log` 的宏, 不用 `eprintln!` (测试、命令行输出除外).
- 格式化: Rust 用 `cargo fmt --all` (根目录 `rustfmt.toml`: 宽 160, `use_small_heuristics = "Max"`; `acdert/vendor/` 不在 workspace 里, 不碰).
  Guard 的行宽同为 160 (`git config --local akira.guardMaxLineLength 160`, 全仓).
- 构建不从外网取东西 (2026-11-14): 依赖都从内网 Gitea 取 (blitz 子模块、rusty_v8 预编译库、CI 的 action), 见 `docs/dev/build-run.md`「构建不从外网取东西」.
  Cargo.toml / package.json 里的仓库地址写 gitea (`http://gitea.dopamine/AC/acdev`).

## 提交与推送

- 仓库在内网 Gitea (`origin` = `ssh://git@gitea.dopamine:2333/AC/acdev.git`, 网页 `http://gitea.dopamine/AC/acdev`), 只推这里 (用户定 2026-11-14:
  GitHub 不再更新).
- 远端只有 `main` (加发版和存档的 tag), 不推别的分支. 本地需要时在总仓 `.worktrees/acdev-<后缀>` 开工作树和本地分支 `Akira/<后缀>` (基于
  `origin/main`), 做完普通合并回 `main` 再推 `origin main` (用户定 2026-11-17). 不开工作树时几个会话共用工作区和 git index: 只改自己负责的路径,
  别人没提交的文件先等.
- 提交只经总仓的 Guard: `uv run <总仓>/.agents/skills/akira/scripts/guard.py commit -m '<信息>' <自己的路径...>` (它做暂存语法检查、行宽和提交格式,
  再按给的路径提交; 用户定 2026-11-17). 推前 `git show --stat HEAD` 和 `git log origin/main..HEAD` 看一眼. `git add` / `git rm` 之后立刻提交.
  做完就提交并推送.
- 不 force push, 不 amend / rebase 已推送的提交.
- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 正文写原因和验证情况 (性能数字注明负载), 不加 Co-Authored-By.
- 提交前: `cargo fmt --all`; 改了 `npm/` 时 `bun run typecheck` (在 `npm/`); 总仓的质量检查 `bun scripts/quality/check.ts <本仓库> origin/main`
  (在总仓跑, 结果须为 0 条); 提交时 Guard 的暂存检查.
- 构建、运行和测试按工程需要直接做 (命令行: `bun test`、`bun run typecheck`, 在 `npm/`; 运行时: 见 `docs/dev/testing.md`), 做了就在提交信息里写清
  已验证 / 未验证. 汇报时也分开写「已验证 / 未验证」.

## 文件路由

`docs/runtime/`、`docs/graphics/`、`docs/web/`、`docs/dev/` 是运行时库的文档, 代码路径相对 `acdert/`; 其余 `docs/*.md` 里命令行的路径相对 `npm/`,
调试运行时的相对仓库根, 每个文件开头注明.

| 什么时候读 | 文件 |
| --- | --- |
| 改说明或新增说明文档 | `docs/writing-docs.md` |
| 第一次接手运行时, 要弄清各仓的分工、两种跑法 (会话 / 宿主窗口) 或进程与线程 | `docs/runtime/architecture.md` |
| 找运行时的某个模块或目录归谁, 新加文件前确认放哪 | `docs/runtime/layout.md` |
| 改 C 接口 (`acdert/src/ffi.rs`、`acdert/include/acdert.h`)、`Platform` 回调或 so 的导出表 | `docs/runtime/ffi.md` |
| 改窗口表、窗口模式与状态、焦点 / 模态 / grab、全局快捷键, 或 `acdert/protocol/` 里的 `acde_window` / `acde_shell` | `docs/runtime/window-model.md` |
| 改包清单的 `acde` 字段、桌面服务、契约级别 `apiLevel`、选哪个桌面、交出会话或登录页 | `docs/runtime/packages.md` |
| 改 web 的出帧、窗框、钉住的面板、`acde:` 模块的注入 (层级、能力、批准)、沙箱或 web 的生命周期 | `docs/runtime/webs.md` |
| 改应用入口和脚本加载, 或某个浏览器接口 (表单控件、XML、通知、声音、视频、设备、摄像头和麦克风) | `docs/web/web-apps.md` |
| 改网页存储 (localStorage、IndexedDB、cookie、Cache API、`navigator.storage`) | `docs/web/storage.md` |
| 改应用后端的起停、代理变量、Windows 后端契约, 或 fetch / XHR / WebSocket 的路由 | `docs/web/backend.md` |
| 改 `acde:fs`、应用的根、拖放和打开请求的句柄、文件夹和文件选择器 | `docs/web/fs.md` |
| 改默认应用、文件类型判断、打开方式或 Windows 的文件关联 | `docs/web/default-apps.md` |
| 改 `acde:inspect` 的语义树、ref 和操作, 或原生窗口的 AT-SPI | `docs/web/inspect.md` |
| 改 `acdert/src/render` 的接口、canvas 2D、窗框绘制、模糊、GPU 设备或性能预算 | `docs/graphics/render-gpu.md` |
| 改 WebGL (`acdert/src/webgl`、acde-dom `webgl/`) 或 GLSL 前端 | `docs/graphics/webgl.md` |
| 改 `acdert/vendor/blitz`, 或升 stylo / parley / html5ever / naga 这类钉住版本的依赖 | `docs/graphics/vendor.md` |
| 构建运行时、在 Windows 上编、升 v8 或改依赖镜像、设环境变量、跑 `acdert` 的命令和 doctor、看日志和 `perf::` 计时 | `docs/dev/build-run.md` |
| 改 acdev dev 的 IPC、调试请求 (eval / shot / route / clock / input …)、dev 日志或热重载 (运行时一侧) | `docs/dev/dev-ipc.md` |
| 改 DevTools 端点、页面一侧的 CDP 域 (DOM / CSS / Network / Overlay)、断点或重载不断开 | `docs/dev/devtools.md` |
| 写运行时的回归测试、跑或更新 WPT 期望、改 `.github/workflows/test.yml` 或 `.github/actions/wpt-setup` | `docs/dev/testing.md` |
| 把 `acdert` 发到 cargo 源 ac, 或了解运行时怎么随 acdev 发版 | `docs/dev/release.md` |
| 改 `acdev vm` (`npm/src/vm/`): 在 QEMU 里起 Dopame OS 客户机 (KVM)、把文件送进客户机、串口日志、截图 | `docs/vm.md` |
| 弄清调试运行时在各仓架构里的位置、`src/` 各文件做什么、`acdev` 怎么找运行时 | `docs/architecture.md` |
| 在本地编译、运行 `acdev runtime`, 或让源码跑的 `acdev dev` 用上它 | `docs/runtime-build.md` |
| 改宿主窗口、合成、出帧、GPU、输入、窗框、菜单、headless 或系统能力 (`crates/hostwin`) | `docs/hostwin.md` |
| 改运行时自检 `acdev runtime doctor` (`src/doctor.rs`) 的检查项或输出 | `docs/doctor.md` |
| 了解命令行的启动速度、仓库脚本、工程与安装目录, 或写要在 bun 和 Node 上都跑的代码 | `docs/cli-overview.md` |
| 加改命令行的命令或参数, 改帮助、颜色、stderr 格式、退出码、`check --platform` 或 `acde:` 导入检查 | `docs/cli-commands.md` |
| 改 `acdev new`、模板、包管理器选择、SDK 依赖写法或 `acdev sdk` | `docs/acde-new.md` |
| 改 `acdev build` / `install`: 工程与包、框架识别、打包器、`public/`、后端和 preload (含 Windows 通道模式) | `docs/acde-build.md` |
| 改 `acdev doctor` 的检查项、修法文字或 `--fix` | `docs/acde-doctor.md` |
| 改 `acdev dev`: 契约级别检查、stderr 过滤、监听重建、热重载、信号、一个工程一个会话、会话文件、dev IPC 连接 | `docs/acde-dev.md` |
| 改 `webs` / `eval` / `shot` / `inspect` / `act` 等会话命令、批准命令、devtools、driver、截图、trace、MCP 工具或 `acdev test` | `docs/devtools-driver-mcp.md` |
| 发版, 改 `.github/workflows/release.yml`、`npm/scripts/dist.ts`、`scripts/install.sh` / `install.ps1`、launcher 或安装目录布局 | `docs/release-distribution.md` |
| 改 `npm/skills/acdev/`、`acdev skills`、`scripts/install.md`, 或对外行为变了要同步文档 | `docs/skills.md` |
| 改命令行和运行时之间的东西: 清单校验、运行时命令行与环境变量、后端启动、Windows 后端契约 | `docs/contract-with-acdert.md` |
| 跑或加命令行的测试, 在 Windows 上跑 `bun test` | `docs/cli-tests.md` |
| 挑下一件命令行的事做, 或判断某个功能是不是已经计划过 | `docs/roadmap.md` |
