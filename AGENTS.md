# acdert

acdert 是 acde (Dopame 的桌面基座) 的通用运行时库: 内嵌 V8、自研 DOM 与排版绘制 (Blitz fork + acgpu / vello)、网页存储、媒体、WebGPU / WebGL 绑定和
`acde:` 系统模块, 拥有全部跨仓契约 (包清单、SDK `@dopame/acde-api`、`acde_*` 协议). 对外是一个 Rust 包 `acdert` (rlib + `libacdert.so` + `include/acdert.h`),
由前端 acdebin-dbg / acdebin-system 接上平台.

没有 README, 子目录不放 AGENTS.md.

> **第一原则: 不许在任何层次上魔改 web 接口.**
>
> - web 接口 (DOM、`window`、`fetch`、`localStorage`、事件、Web Audio、WebGPU …) 和浏览器**完全兼容**: 行为、签名、事件、错误都照标准.
>   不给标准对象加私有方法 / 字段 / 事件, 不改标准语义. 做不到的就是缺口, 记成「还没有」, 不拿长得像的私有版本顶替.
> - **全局只有两个**: `window` (web 兼容) 和 `globalThis` (node 兼容). 没有 `acde` 全局, 不往全局上挂非标准的东西.
> - 系统能力只有一个入口: `acde:` 内置模块, 照 `node:fs` 的写法导入 (`import { fs } from 'acde:fs'`、`import self from 'acde:window'` …;
>   类型在 SDK `@dopame/acde-api`). 清单的 capabilities 决定能导入哪些, 没开的导入直接失败. 「魔改」只许发生在 `acde:` 这一层.
> - **`acde:` 模块是进程内注入, 不是 RPC**: 像 workerd 的 binding, 直接注入页面所在的 V8 isolate, 调用直接进 Rust 原生实现, 不经 socket /
>   IPC / 别的进程代办.
> - 兼容的是标准接口, 不是 Chromium: 渲染器是自研的 (Blitz 的 fork, `vendor/blitz` 子模块, 没有 JS 引擎), 页面 JS 在 acdert 自己的 V8 里. 没有 devtools、
>   远程调试端口、浏览器外壳.
> - 现有的债 (不是先例, 新代码不许再加, 动到时往这个方向收): web 里除 fs / terminal / network / office / picker 以外的 `acde:` 模块
>   还是经 `rpc.ts` / `remote.ts` 调到 Broker (见 `docs/runtime/webs.md`「通信」); acde-dopame 还直接用 napi 导出.

## 协作规则

- 闭源 (用户定, 2026-11-08): 自己的代码是专有的 (根目录 `LICENSE`), package.json 写 `"license": "UNLICENSED"`, Cargo.toml 不写 `license`
  (都 `publish = false`), 仓库和 release 不公开. npm 上发的包见 `docs/dev/release.md` (用户定 2026-11-14: 二进制闭源, JS 可以公开一些). `vendor/` 和 src/napi 保留上游的许可证文件和版权行.
- Rust 和 TypeScript 代码不写注释, 要说明的写进 `docs/` 里对应的文件. 例外: 版权和许可证行 (src/napi 的 Deno 版权)、工具指令 (`/// <reference>`,
  `@ts-expect-error`)、`vendor/` 改动处的 `acrender:` (blitz fork 里) / `acde:` 标记. derive 要读的文字写成属性.
- 几个会话共用工作区和 git index: 只改自己负责的路径, 别人没提交的文件先等. 提交一律 `git commit -- <自己的路径>`, 推前 `git show --stat HEAD`
  和 `git log origin/main..HEAD` 看一眼. `git add` / `git rm` 之后立刻提交.
- 仓库在内网 Gitea (`origin` = `ssh://git@gitea.dopamine:2333/AC/acdert.git`, 网页 `http://gitea.dopamine/AC/acdert`), 只推这里 (用户定 2026-11-14:
  全部放内网, 不再双推 GitHub; GitHub 的 `dopame-org/acdert` 不再更新).
- 构建不从外网取东西 (2026-11-14): 依赖都从内网 Gitea 取 (blitz 子模块、rusty_v8 预编译库、CI 的 action), 见 `docs/dev/build-run.md`「构建不从外网取东西」.
- 不 force push, 不 amend / rebase 已推送的提交. 提交信息英文, Conventional Commits, 每行不超过 72 字符, 正文写原因和验证情况 (性能数字注明
  负载), 不加 Co-Authored-By.
- 改 `src/render`、`src/gpu`、`src/vello`、`src/webgl`、`vendor/blitz` 或 `web/` 的提交, 先在这棵树编出来的 acdert (或并排 acdebin-dbg) 上起一次, 提交信息里写验了
  什么、没验什么. 汇报时分开写「已验证 / 未验证」.
- 系统调用走 rustix, 不直接依赖 libc; rustix 没有的用专门的 crate (signal-hook、jiff). 按平台的代码用 `#[cfg]` / `cfg_select!`, 先用 std.
- 依赖版本只写主版本号 (`log = "0"`, `wgpu = "30"`), 用最新的; 例外是 `[patch.crates-io]` 换成 `vendor/` 的 crate 和配套的 (blitz-*、stylo*、
  parley、html5ever、cssparser) 用 `=` 钉住.
- `Cargo.lock` 不进 git (`.gitignore`): 依赖按 Cargo.toml 解析到最新. 改了依赖, 提交前 `cargo build --release -p acdert` 必须通过; clippy 要过.
  本地留下的 `Cargo.lock` 不会自己跟上: 拉取之后先 `cargo update` (或删掉它) 再编. workspace 的版本号一变, cargo 会重新解析这些 crate 的依赖,
  只写主版本号的 0.x 依赖 (`rand = "0"`、`sha2 = "0"`、`hmac = "0"`) 会落到旧锁里已有的老版本上, 只在 Linux 编的 `voice`、`office` 就编不过
  (`rand::rng` 找不到, `Hmac<Sha256>` 的 trait 对不上); macOS 和 Windows 不编这两个模块, 看不到这个错.
  `web/bun.lock` 进 git, 改依赖时放在同一个提交里.
- 诊断用 `log` 的宏, 不用 `eprintln!` (测试、命令行输出除外).
- Rust 代码提交前 `cargo fmt --all` (根目录 `rustfmt.toml`: 宽 160, `use_small_heuristics = "Max"`; `vendor/` 不在 workspace 里, 不碰).

## 文件路由

| 什么时候读 | 文件 |
| --- | --- |
| 第一次接手本仓库, 要弄清三个仓库的分工、两种跑法 (会话 / 宿主窗口) 或进程与线程 | `docs/runtime/architecture.md` |
| 找某个模块、目录或 `web/packages` 里的文件归谁, 新加文件前确认放哪 | `docs/runtime/layout.md` |
| 改说明或新增说明文档 | `docs/writing-docs.md` |
| 改 C 接口 (`src/ffi.rs`、`include/acdert.h`)、`Platform` 回调或 so 的导出表 | `docs/runtime/ffi.md` |
| 改窗口表、窗口模式与状态、焦点 / 模态 / grab、全局快捷键, 或 `protocol/` 里的 `acde_window` / `acde_shell` | `docs/runtime/window-model.md` |
| 改 acde dev 的 IPC、调试请求 (eval / shot / route / clock / input …)、dev 日志或热重载 | `docs/dev/dev-ipc.md` |
| 改 DevTools 端点、页面一侧的 CDP 域 (DOM / CSS / Network / Overlay)、断点或重载不断开 | `docs/dev/devtools.md` |
| 改包清单的 `acde` 字段、桌面服务、契约级别 `apiLevel`、选哪个桌面、交出会话或登录页 | `docs/runtime/packages.md` |
| 改 web 的出帧、窗框、钉住的面板、`acde:` 模块的注入 (层级、能力、批准)、沙箱或 web 的生命周期 | `docs/runtime/webs.md` |
| 改应用入口和脚本加载, 或某个浏览器接口 (表单控件、XML、通知、声音、视频、设备、摄像头和麦克风) | `docs/web/web-apps.md` |
| 改网页存储 (localStorage、IndexedDB、cookie、Cache API、`navigator.storage`) | `docs/web/storage.md` |
| 改应用后端的起停、代理变量、Windows 后端契约, 或 fetch / XHR / WebSocket 的路由 | `docs/web/backend.md` |
| 改 `acde:fs`、应用的根、拖放和打开请求的句柄、文件夹和文件选择器 | `docs/web/fs.md` |
| 改默认应用、文件类型判断、打开方式或 Windows 的文件关联 | `docs/web/default-apps.md` |
| 改 `acde:inspect` 的语义树、ref 和操作, 或原生窗口的 AT-SPI | `docs/web/inspect.md` |
| 改 `src/render` 的接口、canvas 2D、窗框绘制、模糊、GPU 设备或性能预算 | `docs/graphics/render-gpu.md` |
| 改 WebGL (`src/webgl`、acde-dom `webgl/`) 或 GLSL 前端 | `docs/graphics/webgl.md` |
| 构建本仓库、在 Windows 上编、升 v8 或改依赖镜像、设环境变量、跑 `acdert` 的命令和 doctor、看日志和 `perf::` 计时 | `docs/dev/build-run.md` |
| 写回归测试、跑或更新 WPT 期望、改 `.gitea/workflows/test.yml` | `docs/dev/testing.md` |
| 发版、改版本号、把 Rust 包发到 cargo 源 ac | `docs/dev/release.md` |
| 改 `vendor/blitz`, 或升 stylo / parley / html5ever / naga 这类钉住版本的依赖 | `docs/graphics/vendor.md` |
