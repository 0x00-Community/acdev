# CLI 测试

> 路径相对 CLI 包根 `npm/`。

`test/` 按主题分目录，每个目录直接放的文件不超过 8 个；`helpers.ts` 和 `fixtures/` 留在根上：
- `build/`：构建、安装与检查（`cli`、`node`、`imports`、`errors`、`asset-urls`、`inline-styles`、`check`、`templates`）；
- `commands/`：命令行的用法、输出与工具（`usage`、`output`、`doctor`、`uninstall`、`skills`、`mcp`、`devtools`、`launcher`）；
- `dev/`：开发会话与通信（`dev`、`channel`、`listen`、`watch`、`changes`、`runtime`、`e2e`）；
- `session/`：对替身运行时跑真的 `acdev dev`（`build`：构建、监视与重载、日志；`tools`：会话文件、命令行工具、DevTools、批准与用错的参数；`standin.ts` 是两者共用的起会话函数）；
- `driver/`：驱动与截图（`driver`、`png`、`call`、`confirms`、`place`）；
- `emulator/`：不起客户机的模拟器与准备（`gl`、`guesthw`、`kernelpkgs`）；
- `release/`：打包与发布（`dist`、`pkgs`、`guard`、`workflow`）；
- `vm/`、`host/`：见下文。

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

## 对真实运行时的端到端测试 (`bun run test:host`, acdev-single-app 工作项 10 起)

上面的测试都用假运行时, 测不出运行时一侧的缺口 (2026-11-16 删 `web/` 后 `acdev dev --app` 的调试通道就没人回答, 假运行时照样全过).
`test/host/` 经命令行驱动真实的 acdev 运行时: 把 `test/fixtures/host/hello` (带 `server.ts` 后端的示例应用) 拷到临时目录, 起
`acdev dev <目录> --app hello-backend --headless --force`, 再用 `acdev webs`、`acdev eval`、`acdev console` 检查. 只在
`ACDEV_HOST_E2E=1` 且 `ACDEV_RUNTIME` 指向真的运行时 (比如 `target/debug/acdev`, 要和并排的 libacde 同一版本) 时跑, 否则跳过;
`bun run test:host` 设好前一个. 数据、配置和缓存放进临时目录, 运行时目录 (`XDG_RUNTIME_DIR`) 在 unix 上是 `/tmp/acdev-run-*` (`helpers.ts` 的 `runtimeDir`: macOS 的临时目录很长, 放在它下面时后端的 socket 路径超过 `sun_path` 的 104 字节, 后端起不来); 设 `ACDEV_HOST_KEEP=1` 时测完不删它, 打印路径, 里面的 `dev.out.log`、`dev.err.log` 是 `acdev dev` 的输出, 查失败用. 每个用例默认最多 60 秒. 在 Linux、macOS 宿主上跑; Windows 由用户安排人测.
应用后端 (工作项 13) 的用例: 页面拿到 `backend says hi`; 改 `server.ts` 后重新构建、重载, 后端换了进程 (pid 变了) 且答新内容;
页面请求 `/api/crash` 让后端以 3 退出, `acdev dev` 的 stderr 里有后端自己的输出和 `[hello-backend#backend] stopped (exit 3); starting it again`,
之后后端以新进程回来. 这几条放在 `route` 用例之前 (那条会把 `/api/hello` 换成假回应).
