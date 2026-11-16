# acdebin-dbg

跨平台调试运行时 `acdebin-dbg` 和开发者 CLI `acde` 的仓库. 这里只收本仓库特有的词; 运行时的词 (清单、`acde:` 模块、窗口模型、Broker)
以 acdert 的 AGENTS.md 为准.

## Language

### 运行时与窗口

**调试运行时**:
本仓库产出的二进制 `acdebin-dbg`: 在 Linux / Windows / macOS 的别人桌面里开宿主原生窗口, 跑一个应用或一个桌面.
_Avoid_: 用 acde 指它 (acde 是 CLI)

**acdert**:
通用运行时库, 拥有清单、`acde:` 模块、窗口模型和 dev IPC 的全部契约; 本仓库把它当 path 依赖. CLI 的代码和文档沿用这个名字称呼它找到的
运行时二进制 (`ACDERT`、`findAcdert`), 现在找到的通常是 `acdebin-dbg`.

**acde**:
开发者 CLI (`npm/`), 建工程、构建、装包, `acde dev` 拉起调试运行时. 和运行时的关系像 wrangler 和 workerd.

**宿主窗口**:
调试运行时开的**一个**宿主原生窗口, 里面按窗口表合成桌面、应用窗口和面板 (`crates/hostwin`, 调试模式的「合成器」).
_Avoid_: 会话 (那是 acdebin-system 的 Wayland 会话)

**窗口表**:
hostwin `shell.rs` 的 `State` / `Entry`: 宿主窗口里每个窗口的 rect、层序、父子、模态和状态.

**单应用会话**:
`acdebin-dbg app <id>` 只跑一个应用, 主窗口铺满宿主窗口 (独立应用); 和 `desktop <id|包目录>` 的完整桌面相对.

**headless**:
`ACDE_HEADLESS=1`: 不开宿主窗口, 屏幕是 `ACDE_SIZE` 乘 `ACDE_SCALE`, 页面照常出帧, 仍然要 GPU.

**宿主文件**:
acdert `acde-host` 的构建产物 `app/` (Broker 和页面的 JS), 发布为 `acde-host-<版本>.tar.gz`, 装在 `bin/app/`; 调试运行时找 `<自己>/app/dist`.

### 工程与包

**包**:
acdert 唯一认的产物: package.json 的 `acde` 字段 (`PackageManifest`), `acde build` 写在 `.acde/`.

**工程**:
有 `acde.config.jsonc` / `.json` 的目录 (`Project`); 配置只在构建时读, 变成包的清单.

**手写的包**:
没有配置、package.json 的 `acde` 里直接写了 `apps` 的目录; `acde install` 装它时只放一个指向工程的符号链接.

**契约级别**:
运行时和 SDK 约定的整数级别: 清单的 `apiLevel`、SDK 的 `API_LEVEL`、`acdert --version` 的 `(contract level N)`; 不同时 `acde dev` 拒绝起.

**SDK**:
`@dopame/acde-api` (源码在 acdert 的 `web/packages/acde-api`), 只以 tarball 发在 pkgs 上; 工程依赖写配对版本的 tarball 地址.

**配对版本**:
和这个 acde 同一次发布的 SDK 版本 (`Sdk.paired()`); 工程装的版本和它不同时 `acde check` / `acde dev` / `acde doctor` 提醒.

**preload**:
构建时放在后端入口旁边的 `acde-listen.js` (`src/listen.ts`): 把后端的每个 `listen(P)` 换成 unix socket, 或 Windows 上的通道.

**通道模式 / 套接字模式**:
Windows 上应用后端的两种接法: Node 走通道模式 (fd 3 / fd 4 上的帧), bun 走套接字模式 (`<ACDE_APP_SOCKETS>\<P>.sock`).

### 开发会话

**开发会话**:
一个 `acde dev` 进程和它起的调试运行时; 会话目录里记成 `<pid>.json` 会话文件, 工具按目录或 `--session <pid>` 挑它.

**测试会话**:
`acde test` 起的开发会话 (`ACDE_TEST_SESSION=1`, 会话文件 `test: true`), 只有 `--session <pid>` 到得了.

**认领**:
会话目录里每个工程一个 `<sha256 前 16 位>.claim`, 保证一个工程只有一个 `acde dev` (`--force` 不认领).

**dev IPC**:
调试运行时听、acde 和各工具直连的一行一个 JSON 的连接 (unix socket 或命名管道); acde 不转发. op 以 acdert 的「acde dev」为准.

**批准**:
第 1 级下要用户批准的必需能力: 待答的提示和已有决定, 由 `acde permissions` / `allow` / `deny` / `revoke` 和 MCP 处理.
