# CLI 测试

> 路径相对 CLI 包根 `npm/`。

`bun test`: `cli` (build、install、配置、public 和图标、新工程、用错的参数)、`doctor` (假运行时 扮演有 / 没有 `acdev runtime doctor`、报 GPU 错误、
给不出报告、另一个契约级别、起不来的 acdev runtime; 工程的几项; 跑着的 `acdev dev` 里等批准的应用; `acdev dev` 在 acdev runtime 提前退出时的提示; `--fix`:
不问就修的 skill / `.gitignore` / 会话目录, 不在终端时跳过、`--yes` 才做的工程依赖, `--json`, 去重和拒绝; 重装运行时在 `dist` 里: 经 install.sh
装好后删掉 acdev runtime, `--fix` 跳过, `--fix --yes` 跑安装器装回来)、`templates` (自带模板和框架配置的第 1 级形态: 新建、check、
build 后 SDK 校验无错无警告)、`skills` (skill 的写法规则、和命令 / MCP 工具对得上、`acdev skills` 在临时 HOME 里装和删)、`imports` (`acde:` 导入:
分词, 第三方 / 系统应用、桌面页、服务、手写的包、框架应用; check 和 Bun / Vite 两种 build)、`launcher`、`runtime`、`listen`、`channel` (帧编解码与流量控制;
打好的 preload 在真的 node 上由测试扮演运行时, 用 `node:child_process` 的额外管道当 fd 3 / 4, 没有 node ≥ 22 就跳过这一半)、`node` (打好的后端在 Node 上跑; 要
`ACDEV_TEST_NODE` 或 PATH 上真的 node ≥ 22.3, 没有就跳过)、`dev` / `driver` / `mcp` / `e2e` (都用 `test/fixtures/dev/fake-acdert.ts` 这个有状态的假
acdev runtime (它听 `ACDE_DEV`) 跑真的 `acdev dev`; `FAKE_ACDERT_WAITS=1` 时它先不开窗口, `launch` 的提示被批准后才开, 用来测批准的命令、`webs` 的提示和 MCP 的 `answer`)、`dist` (打包、配对记录、本地托管 acdev 和替身 acdert 目录 (`runtimeMirror`: 各 triple 的假二进制、宿主包、`SHA256SUMS`), 跑 install.sh /
install.ps1 和 `bin/acdev`; 篡改、缺文件、没有本平台构建、没有配对记录时安装失败且旧安装不变). 给包管理器搭 PATH 用符号链接, 不用 `exec` 的 sh 脚本:
包了一层的 `node` 让 pnpm 不装 rolldown 的平台原生包.

在 Windows x64 原生终端运行 `bun test --timeout 30000`。临时目录须允许建立目录联接、命名管道和 Bun 的文件系统套接字。
分发测试使用本地 HTTP 服务和 `install.ps1 -NoModifyPath`，用含空格的安装、工程和输出路径验证 `acde.cmd new/check/build`。
它从安装目录定位安装器放进去的运行时和随包的 SDK。install.sh 的分发测试只在 macOS 和 Linux 上运行。开发会话测试使用替身运行时，真实启动和正常退出须单独用实际运行时验证。

Windows 跳过 `install.sh`、Unix 会话权限与 Unix 域套接字文件清理、Node.js 后端文件系统套接字场景。
应用后端的 Windows 运行时一侧见 `contract-with-libacde.md` 的「Windows 后端契约」（最初由 [acdert#4](http://gitea.dopamine/AC/acdert/issues/4) 跟踪）。Bun 预加载的新套接字请求、
Vite 构建及参数检查照常执行。没有 `lsof` 或 `/proc` 时，测试仍验证套接字 HTTP 响应，跳过对进程网络套接字的枚举。
未安装对应工具时，测试会跳过 npm、pnpm 或 Unix Node.js 后端的相关场景。
