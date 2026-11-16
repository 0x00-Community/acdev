# acde doctor (`src/doctor.ts`)

> 路径相对 CLI 包根 `npm/`。

一条命令查完「`acde dev` 为什么起不来」的常见原因, 每项 `ok` / `warn` / `error` / `skip` 加一条 `fix`. 原则: **和 `acde dev` 用同一份逻辑, 不另写一套**,
所以 doctor 说的就是 dev 会遇到的:
- 找 acdert: launcher 的 `findAcdert()` (返回 `{path, from: 'ACDERT' | 'install' | 'PATH' | null, problem}`), `requireAcdert()` 就是它加上抛错,
  抛的消息末尾加 `(acde doctor checks the whole setup)`; doctor 直接显示 `problem` (不带这句).
- 探测 acdert: `DevSession.runtimeLevel` (`acdert --version`, 经 `Runtime.capture`: 带超时跑一个程序、收 stdout / stderr, 起不来时给出原因而不是抛错).
  它现在还回 `failed`: 起不来 (`EACCES`、`ENOENT`)、10 s 没退出、退出码不是 0 (加上 stderr 最后一行, Linux 缺动态库时就是动态链接器那句). `acde dev` 的契约
  级别检查在级别不符且 `failed` 时把原因写进错误.
- 会话目录: `Sessions.problem(dir)` (不是普通目录、不是自己的), `Sessions.prepare` 也用它; doctor 只看不建.
- 工程: `AppPackage.check()` (就是 `acde check`)、`AppPackage.platform(<本平台>)` (就是 `--platform`), 不另判.
- skill: `Skills.places` / `Skills.look` (就是 `acde skills` 的状态).

检查和顺序 (`Doctor.run`; JSON 的 id 在括号里): `acde` (版本、跑在哪个运行时上、在哪) → `PATH` (`path`: PATH 上第一个 `acde` realpath 后是否落在这个 acde
里: 全局装的是版本目录, 检出是仓库; 不在 PATH 上或是别的那个都是警告) → `Bun and Node.js` (`runtimes`: launcher 的 `runtimes()`, 只探测一次, 工程那项也用;
没有 Bun 是警告, 因为 `acde test` 和 bun 工程要它) → `acdert` (找到没有、从哪来、`--version` 起不起得来、有没有契约级别) → `contract level` (`contract`:
运行时级别和 SDK 的 `API_LEVEL` 不同是错误 (dev 会拒绝); 相同但 acdert 版本不是 SDK 的版本 (配对的那版) 是警告) → 运行时自检 (`runtime.<id>`, 见下) →
`acde dev sessions` (`sessions`: 会话目录有问题是错误; 列出在跑的; 每个会话连上去问 `permissions`, 3 s 不答是警告) 和每个待答提示一条 `approval` 警告
(应用答之前不开窗口, fix 说批准是用户的决定) → 工程 (见下) → `agent skill` (`skill`: 没装、`outdated` / `broken` 是警告) → `--online` 时 `latest release`
(`latest`: GET `$ACDE_DIST/latest` (默认 `https://pkgs.dopame.ai/acde`), 5 s; 比这个新是警告, fix 是重跑安装器; 取不到是警告).
有 `error` 退出 1. 输出 `Doctor.format`: 每项 `<状态补到 6 列> <标题>: <内容>`, 有 fix 时下一行 7 个空格加 `fix: …`, 最后一行
`acde doctor: N errors, M warnings` / `no errors, M warnings` / `everything acde needs is here`; `--json` 是 `{ok, checks: [{id, title, status, summary, fix?}]}`.

- **运行时自检**: acdert 的 `acdert doctor --json` (见 acdert AGENTS.md 的「命令」), 它的每项变成 `runtime.<id>`, 标题、状态、fix 照搬. 支不支持看
  `acdert --help` 的 stdout 里有没有以 `acdert doctor` 开头的一行, 不按版本号 (同一版本号的开发构建可能有也可能没有). 旧的 acdert 不认 `doctor`, 会把它当成
  会话参数起桌面, 所以不能盲调. 没有时是一条 `runtime` 警告 (版本号和 SDK 相同时 fix 是换一个更新的构建, 不同时是装配对的那版); 60 s 没结束、stdout 不是
  报告都是错误. acdert 没找到或起不来时这项和 `contract` 是 `skip`.
- **工程** (`Doctor.project`): 目录 (参数, 默认当前目录) 里有 `acde.config.jsonc` / `.json` 或 package.json 有 `acde` 字段才算工程; 不是时默认 `skip`,
  给了目录参数就是错误. `project` (`acde check` 的第一个错误或警告加剩几条, fix `acde check lists them`)、`platform` (缺必需能力是错误, 可选的写进内容)、
  `dependencies` (工程的包管理器对应的运行时不在 PATH 上是警告; 依赖没装是警告, 像 Node 解析一样往上找 `node_modules/<名字>/package.json`, 所以 workspace
  里提升到上层的也算装了; SDK 版本只报一次 (gitea acde#92): package.json 写的 (`Sdk.state`) 或装的 `@dopame/acde-api` 和这个 acde 构建所用的版本不同时,
  `dependencies` 报这一行 (排在依赖没装之前), fix 是 `Doctor.sdkFix` (`run acde sdk update`; `acde doctor <目录>` 给的不是当前目录时
  后面跟上它, 当前目录里的写相对路径、外面的写绝对路径, 含空白加双引号, 不然照抄去跑会改当前目录), 这时 `project` 去掉 `acde check` 里同一条 SDK 警告;
  运行时不在 PATH 上而轮不到这一行时, SDK 警告是 `project` 唯一一条就用同一个 fix; `PackageManager.of` 往上读到不是 JSON 的 package.json 时
  报 `<文件> is not valid JSON (…): acde reads it to tell which package manager the project uses`, `dependencies` 报这条错误,
  不崩. SDK 警告只在要写 `run <pm> install` 时才找包管理器 (`Sdk.warning` 收的是函数), 所以 `acde sdk` / `check` / `dev` 平时不碰它;
  `Cli.follow` (打好的 `cli.js` 换运行时) 遇到它打这一行加 `: going on with <现在的运行时>`, 接着跑)、`gitignore` (在 git 仓库里
  且 `git check-ignore -q .acde/` 不中是警告; 没有 git 或不在仓库里不出这项).
- **修法的文字** (`Doctor.acdertFix` / `pairFix` / `runFix` / `pathFix`): 全局装的 acde 一律是重跑安装器 (`curl -fsSL $ACDE_DIST/install.sh | sh`, Windows
  `irm …/install.ps1 | iex`), 检出的 acde 是编 acdert 再设 `ACDERT`; `ACDERT` 指错时是改它; macOS 上起不来且有 `com.apple.quarantine` 属性时是
  `xattr -d com.apple.quarantine <路径>`; stderr 有 `error while loading shared libraries` 时是装那个库. 不替用户下载或批准任何东西.
- **`acde dev` 指向 doctor**: 找不到 acdert 的错误末尾那句; acdert 在 dev IPC 连上之前就退出且退出码不是 0 (GPU 不可用、宿主文件缺失、动态库缺失都是这样)
  时打 `acde: acdert exited (<码>) before it was ready; acde doctor checks the runtime, the GPU and this setup`, 退出码跟 acdert.
- MCP 的 `doctor` 工具 (`{dir?, online?}`) 回同一份 `Doctor.format`, 只读, `openWorldHint` (`online` 时联网); 有错误也不是 `isError` (那是工具本身失败).
- **`--fix`** (用户 2026-11-11 定的范围: 直接修 acde 自己的、可撤销的; 下载 / 安装 / 结束进程的先问; 用户该做的决定一律不碰): 能修的检查带一个
  可序列化的 `repair` `{action, target, ask, does}` (和给人看的 `fix` 文字分开, 修的时候只看 `repair`, 不解析文字; 不该修的检查根本没有 `repair`,
  想修也修不了). `Doctor.repairs` 只取 `warn` / `error` 上的, 按 `action:target` 去重 (重装可能挂在 `acdert`、`contract`、`runtime.host` 几项上).
  `Doctor.fix` 逐个做: `ask` 的先问 (`--yes` 不问; 终端里 @clack 的 confirm, 默认否; 不在终端也没 `--yes` 时跳过并说 `pass --yes to allow it`),
  打 `fixing:` / `fixed:` / `failed: …: <原因>` / `skipped:`; 有修成的就再跑一遍检查, 退出码看第二遍. 动作 (`Doctor.apply`):
  - `skill` (不问): 子进程跑 `acde skills install` (`cliRuntime()` + `cliFile()`), 和用户敲的同一条路, 不在这里另装一份.
  - `gitignore` (不问): `Creator.ignoreBuild` (`acde new` 的框架模板也用它).
  - `sessions-dir` (不问): 只在它是链接或文件时 (别的用户的目录不修), 删掉再 `Sessions.prepare`.
  - `reinstall` (问): 全局装的 acde、`ACDERT` 没指定时, 挂在 acdert 找不到 / 起不来 (macOS 隔离的除外: 重装不解决, 那是用户的安全决定) / 没有契约级别、
    契约级别或版本不配对、`runtime.host` 错误、旧 acdert 版本也不对 这几处. 从 `$ACDE_DIST` 取 `install.sh` (Windows `install.ps1`) 存进临时目录,
    `sh <它> --version <这个 acde 的版本> --no-modify-path` (Windows `powershell -NoProfile -ExecutionPolicy Bypass -File <它> -Version … -NoModifyPath`),
    `ACDE_INSTALL` 设成这个 acde 的安装根. 只修当前版本, 不顺手升级; 不改 shell 启动文件. 下载、校验、原子替换都是安装器自己的, TS 里不另写一份.
  - `dependencies` (问): 工程包管理器的 `install` (`PackageManager.install`).
  - `stop` (问): 子进程跑 `acde stop --session <pid>`.
  子进程的输出: 文字模式直接给终端; `--json` 时 stdout 指到 fd 2, stdout 上只有最后的 JSON (`{ok, fixed: [{repair, result, said}], checks}`);
  MCP 收下来, 每个最多留最后 20 行. 时限: acde 子命令 60 s, 安装器和包管理器 15 min.
  MCP 的 `doctor_fix` (`{dir?}`, `dir` 要在工作目录里): 同一个 `Doctor.fix`, 只做不问的那几个; 问的那几个跳过并点名 (`the user runs acde doctor
  --fix in a terminal, or agrees to acde doctor --fix --yes`). 不给它 `allow` 参数: 同意要来自用户本人 (终端里的确认, 或宿主对那条 shell 命令的权限确认),
  不该是 agent 自己填的参数 (安全审查 2026-11-11 提出; MCP 的 elicitation 在 SDK 2.4 里已标为废弃、要换成 2026-07-28 协议的 `inputRequired`,
  没为这一个工具做两套). 不修的: 待答的批准、GPU 驱动和系统库、macOS 隔离、PATH 上别的 acde、工程的代码和配置
  (含 `@dopame/acde-api` 版本不对, 要改 package.json).
- 实测 (2026-11-11, 本仓库加 acdert 的 `acdert doctor`): macOS (M3 Pro, Metal) 源码跑和经 `install.sh` 从本地镜像装到临时 HOME 后跑 (PATH 前后两种);
  Linux .234 (Panther Lake, Mesa Vulkan) 经 SSH 无显示 (`display` 警告)、`WAYLAND_DISPLAY` 设了、`VK_DRIVER_FILES` 指向不存在的 ICD (`gpu` 错误);
  一个不可执行的 `ACDERT`、退出码 127 加动态库报错的、启动就退出的假 acdert. 没在 Windows 上跑.
