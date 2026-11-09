# acde

acde 的开发者 CLI. 和 [acdert](https://github.com/dopame-org/acdert) 的关系像 wrangler 和 workerd: acdert 是运行时 (一个二进制,
跑桌面和应用, Dopame OS 的会话就是它), acde 建工程、构建、装包, `acde dev` 拉起 acdert. 运行时的一切 (清单、`acde:` 模块、后端怎么跑、
窗口模型、dev IPC 的 op) 以 acdert 的 AGENTS.md 为准 (并排检出在 `../acdert`), 这里只写工具.

- 说明都在本文件里 (没有 README). full agentic. TypeScript, 跑在开发者已有的 bun ≥ 1.4 或 Node.js ≥ 22.3 (`process.getBuiltinModule`) 上. 测试 `bun test`, 类型检查 `bun run typecheck`.
- 仓库脚本: `bun run acde <命令> [参数]` 从源码跑 CLI (即 `bun bin/acde.mjs`, 经 launcher 的 `run`, 退出码原样传回);
  `bun run test`、`bun run typecheck`、`bun run dist -- <参数>` (见「分发」). 要在别的目录当 `acde` 用时 `bun link` / `npm link`.
- 代码不写注释 (`//`, `/* */`, JSDoc 都不写), 要说明的写进本文件; 工具要读的指令 (`/// <reference>`、`@ts-expect-error`) 除外.
- 闭源: 代码是专有的 (`LICENSE`, package.json `"license": "UNLICENSED"`), 不发 npm 包, 仓库不公开.
- 日志和命令行输出只用英文.

## 命令

| 命令 | 做什么 |
| --- | --- |
| `acde new [目录] [--template T] [--id] [--label] [--backend] [--install] [--git] [--pm PM] [--yes]` | 新建工程 |
| `acde check [目录] [--platform P]` | 手写的包: `Manifest.check` 加入口文件; 有配置的工程: 查配置 (id、入口、图标、服务模块、框架) 再用 `Manifest.check` 判一遍; 都查 `acde:` 导入; `--platform` 见下 |
| `acde build [目录] [--out .acde]` | 先查 `acde:` 导入, 构建成 acdert 认的包; 产物清单再过一遍 `Manifest.check` |
| `acde install [目录] [--out]` | build 后装进 `$XDG_DATA_HOME/acde/packages/<id>` (先拷到 `<id>.new-<pid>` 再换; 手写的包: 指向工程的符号链接) |
| `acde dev [目录...] [--out] [--app ID] [--desktop ID\|目录] [--headless]` | 构建、起 acdert、改了就重新构建并 `reload` |
| `acde webs` / `eval` / `shot` / `inspect` / `query` / `act` / `console` / `network` / `screen` / `stop` (`--session <pid>`) | 看和操作跑着的 `acde dev` 里的页面; `stop` 结束它 |
| `acde permissions` / `allow` / `deny` / `revoke` (`--session <pid>`) | 看待答的批准提示和已有决定, 答提示, 撤销决定 (见「开发工具」的「批准」) |
| `acde mcp [--session <pid>]` | stdio 上的 MCP 服务 (`claude mcp add acde -- acde mcp`) |
| `acde test [目录\|文件...] [--headed] [-t 名字] [--desktop] [--timeout MS] [--bail] [--trace] [-u]` | e2e 测试, 只在 bun 上 |
| `acde skills [install\|remove\|path] [--agent ID,...] [--dir 目录] [--copy]` | 给编码 agent 的 skill: 看装在哪、装、删、打印它的目录 (见「Skill 与文档」) |

参数解析和用法文字在 `src/cli.ts` (`Cli.SPECS`、`USAGE`). `acde --version` (`-v`、`version`, acde#23) 第一行是 acde 版本号 (脚本可只取第一行),
再打 `sdk <版本> (contract level N)` (版本在打包时经 `define` 的 `ACDE_SDK_VERSION` 写进去, 从源码跑时读 `node_modules` 里的 SDK) 和找到的 acdert
(`requireAcdert` 的顺序) 的 `--version` 那一行加路径, 没找到或它没有契约级别时也说清. `acde --help` (`help`、`-h`) 把用法打到 stdout, 退出码 0;
任何命令后面的 `--help` / `-h` (`--` 之前) 和 `acde help <命令>` 只打那个命令的一段 (`Cli.usage`, 从 `USAGE` 里取; 开发会话的工具命令加 `--session`).
不带命令照旧把用法打到 stderr, 退出码 1; 未知命令、未知参数、缺值、参数个数不对只打一行 (说清哪里不对, 指向 `acde --help` 或 `acde <命令> --help`), 退出码 1.
其他常见全局选项: 颜色由 @clack/prompts (picocolors) 按 `NO_COLOR` / 非终端自动关掉, 不另加 `--no-color`; 输出本来就少, 暂不加 `--quiet` / `--verbose`.

`acde check --platform <windows|macos|linux>` (`AppPackage.platform`): 名字对到 SDK 的平台键 (`win32` / `darwin` / `linux`),
按 SDK 的 `RUNNING_MODES` 逐个取 `platformSupport(平台, 模式)` (没有这一行的模式跳过, 比如 Windows 没有 `session`). 每个应用声明了
(`capabilities` 里为真) 而该模式 `unsupported` 里有的能力: 不在 `optional` 里是错误 `<平台> (<模式>): app "<id>" requires <能力>, which this mode lacks`,
在 `optional` 里是 `note:`. 工程读配置 (应用或桌面的 `apps`), 手写的包读 `Manifest.app` 解析后的清单. 平台数据只来自 SDK, CLI 不存一份.
有错误时退出 1, 没有时打 `ok: <平台> (<模式>…): every required capability is there`.

**`acde:` 导入** (`src/imports.ts`, `AppPackage.imports`): `acde check` 和 `acde build` (构建前, Bun 和 Vite 一样) 对每个应用找它入口可达的
源码里对 `acde:` 的导入 (静态 `import` / `export … from`、字面量的动态 `import()`; `import type` 和注释不算), 交给 SDK 的
`Manifest.importRule(名字, 应用清单, {system})` 判: 不许时报 `<文件>:<行>: app "<id>": <SDK 的原因>` (原因里有缺的声明). 许了的再用去掉
`optional` 那些能力的清单判一次, 不许说明它只能经可选能力拿到, 报 `acde:<名字> is optional (…): reach it with load('<名字>') …`
(可选能力只经 `@dopame/acde-api` 的 `load()`, 它不是字面量导入, 不查). 规则只来自 SDK, CLI 不存一份.
- 谁的源码: 工程的应用从 `entry` (默认 `index.html`) 起; 框架应用 (没有单一入口) 是工程里除 `SKIPPED` 目录、e2e 文件、`.d.ts` 外的全部源码;
  桌面工程是 `apps` 各自的 `entry`, 都是系统应用 (`system: true`); 手写的包按 `assets` 把应用的 `entry` URL 换成文件, 有 `desktops` 的包是系统应用.
  桌面页 (`app` 为 null, 什么都许) 和桌面服务 (经 `ctx.import`, 按桌面清单的 `services` 授权) 不查;
  服务里的 `acde:` 导入由构建拒绝 (见「构建」).
- **服务的命名空间和运行时不一致** (实测 acdert 0.0.9, 规则在 SDK, acde 不改): 运行时按服务名授权, 应用写了 `clock` 就拿到这个服务 `api`
  的每个键 (`DesktopServices.start` 把每个键记到服务名上, `ServiceCalls.#allowed` 先把命名空间换成服务名再查 `app.services`), 所以
  `api: {clock, timer}` 时应用能 `import 'acde:timer'`. `Manifest.importRule` 只认名字: 不是系统模块又不在 `app.services` 里就拒绝, 原因是
  `acde:timer is a desktop service: list "timer" in the services of <应用>`; 照做的话应用要求一个不存在的服务, 运行时报
  `<应用> needs "timer" (service not running)`, 起不来. 命名空间只有服务跑起来才知道 (工厂函数的返回值), 静态规则判不了; skill 里写明这一点,
  并建议一个服务只给一个和服务同名的命名空间.
- 可达: HTML / `.vue` / `.svelte` / `.astro` 只看 `<script>` (和 astro 的 frontmatter), `src` 不带 `./` 的按相对路径; 跟相对路径和以 `/` 开头的
  (工程根, 手写的包按 `assets`), 补 `.ts` 等扩展名和 `index.*`, `.js` 可落到同名 `.ts`; 包名、别名 (tsconfig `paths`) 不跟.
- 词法是自带的小分词器 (字符串到行尾为止, 正则字面量按前一个记号猜), 不依赖 bun 或 Vite, 两个运行时上一样.

## 工程与工具目录

在应用工程目录运行 `acde check`、`acde build` 和 `acde dev`。从其他目录运行时，可传入工程路径。
`acde new` 在指定目录生成应用源码、配置和依赖声明。框架模板保留框架原有脚本，并追加 `acde:check`、`acde:build` 和 `acde:dev`
用于应用检查、构建和开发会话。
生成的工程只有这三个脚本，经工程自己的包管理器运行，`acde` 的退出码由包管理器传回。

开发流程（acde#3）：`acde new` 建工程 → `acde dev` 预览和调试（跑着时可用 `acde inspect` / `eval` / `console` / `network` / `shot`，
或 driver、MCP）→ `acde test` 端到端测试（每个测试自己起一个隔离的 acdert）→ `acde build` 构建，`acde install` 构建并装进本机桌面。
`acde new` 打完下一步提示后再打一行（交互时是 `Then` 一栏）列出后三步（`Creator.LATER`）。

不新增 `prod` / `start` / `preview` 命令或脚本：`acde dev` 和 `acde build` 用同一种构建（都压缩、`NODE_ENV` 是 `"production"`），
dev 只多了改动后自动重建刷新和调试接口；“装好后的样子”就是 `acde install` 之后从桌面打开。部署和发布不算启动。
也不生成 `test`：`acde test` 只在 bun 上运行，新工程没有 `*.e2e.ts`，这时运行会报错；写了端到端测试的工程自行添加 `acde test` 脚本。

`acde check` 读取工程配置和入口。普通工程的 `build` 和 `dev` 默认把运行时包写到工程的 `.acde/`。
显式的绝对 `--out` 直接指定产物目录。相对 `--out` 从被构建的工程目录解析，例如从父目录运行
`acde dev ./demo --out artifacts/demo` 时，输出位于 `./demo/artifacts/demo`。

安装后的可执行文件 `acde` 与运行时 `acdert` 在安装目录的 `bin/`，运行时的宿主文件在 `bin/app/`，模板在 `lib/acde/templates/`，
软件开发工具包（Software Development Kit, SDK）在 `lib/acde-api/`。应用工程可以保留自己使用的 `bin/`、`templates/` 和 `packages/`。

## bun 和 Node

同一份代码两边都跑, 判断用 `Runtime.bun` (`src/runtime.ts`); `Bun.*`、`bun:*`、宏只能出现在 bun 专属的路径上.

- 子进程一律 `Runtime.spawn` (`node:child_process`). Windows 的 `.cmd` / `.bat`: Node 不许不经 shell 起, `shell: true` 又只把参数拼起来
  不加引号 (Node 24+ 还报 DEP0190), 所以自己加好引号拼成一条命令行交给 shell.
- 按 PATH 找程序只有 `launcher.mjs` 的 `which` (Windows 上按 `PATHEXT`: `nodejs\npm` 是给 Git Bash 的 sh 脚本, 要 `npm.cmd`), 不用 `Bun.which`.
  按 import 条件从工程目录解析包用 `Runtime.resolve`, 不用 `Bun.resolveSync`.
- 打包: bun 上 `Bun.build`, Node 上工程自己的 Vite (见「构建」). `acde test` / `acde/test` 只在 bun 上.
- 后端 preload 的文本由 `Bundler.buildPreload` 在进程内 `Bun.build` `src/listen.ts` 得到 (target node、esm、只压缩语法). 从源码跑时
  (`Bundler.preload` 看 `import.meta.url` 是 `.ts`) 每次现打; 打 `cli.js` 等时 `scripts/dist.ts` 先打一次, 经 `define` 把
  `ACDE_LISTEN_JSON` 换成它的 JSON 字面量, `src/listen-bundle.ts` 用 `JSON.parse` 还原. 不用宏也不起子进程: 宏里不许调 `Bun.build`,
  起 `bun build` 子进程时父进程被杀会留下永不退出的子进程 (acde#12), Windows 上 bun 起子进程前几次还要等几秒. 只有 Node 时从源码跑出不了
  preload (发布的不受影响).

## acde new (`src/create.ts`, `src/pm.ts`)

- 在终端里 (stdin、stdout 都是 TTY, 没给 `--yes`) 用 @clack/prompts 问缺的 (`Creator.ask`): 目录 (默认 `my-app`, 非空或算不出 id 当场提示)、
  应用 / 桌面、模板、显示名、后端 (只有 html)、装依赖、`git init` (不在仓库里且有 git 才问; 没配 user.name / email 时跳过首次提交).
  Ctrl+C 退出码 0. 不在终端里什么都不问: 目录必填, 模板默认 html, 不装依赖、不建仓库.
- **运行时和包管理器**: 工程跑在 bun 或 Node 上, 由包管理器定 (bun → bun, npm / pnpm / yarn → Node). 新工程: `--pm`, 否则 `npm_config_user_agent`;
  在终端里问的时候按 PATH (`runtimes()`: ≥ 1.4 的 bun, 和 ≥ 22.3 的 node; 其实是 bun 的 `node` 软链接不算): 只有一个就用它, 两个都有问 `Run this project on` (Bun → bun, Node.js → npm,
  默认是跑 acde 的那个); 不在终端里是跑 acde 的运行时 (bun → bun, Node → npm; launcher 从 Node 起 bun 跑 `cli.ts` 时经 `ACDE_HOST_RUNTIME` 传原来的).
  建好写上 `packageManager: <pm>@<版本>` (已经有的不动). 已有工程 (`PackageManager.of`): lockfile, 再 `packageManager` 字段, 都没有是跑 acde 的那个.
  `acde dev` / `build` / `install` 跑在别的运行时上时 (`bin/acde` 两个都有时用 bun), `Cli.follow` 换到工程的运行时重新跑一遍 (`run(argv, exe)`, 带 `ACDE_FOLLOWED=1` 只换一次;
  只对打好的 `cli.js`, `cli.ts` 只能 bun 跑); 那个运行时不在 PATH 上就打一行, 接着在现在的上面跑.
  yarn 的工程写 `.yarnrc.yml` `nodeLinker: node-modules` (PnP 下 bun 和框架的构建找不到依赖).
- **package.json** (`Creator.lay` / `adopt`): 自带模板的脚本 `dev` / `build` / `check` 是 `acde <同名>`; 框架模板不动框架的脚本, 加 `acde:dev` /
  `acde:build` / `acde:check`. 脚本调 PATH 上全局装的 `acde`, 工程里没有 `acde` 依赖. 建好后的下一步提示 (`Creator.next`)
  给含空白的目录加双引号, Windows 上不转义反斜杠. devDependencies: `@dopame/acde-api` (`Creator.api`, `ACDE_API`
  可整个换掉); npm / pnpm / yarn 下自带模板另加 `vite: ^8` (`Creator.VITE`: Node 上用工程的 Vite 打包).
- `@dopame/acde-api` 的依赖写法 (acde#29): 全局装的 acde (`installed()`: 自己在 `lib/acde`, 旁边有 `lib/acde-api`) 写 pkgs 上那一版 SDK 的
  tarball 地址 `https://pkgs.dopame.ai/acdert/<版本>/acde-api-<版本>.tar.gz` (版本取随包 `lib/acde-api/package.json`, 即这个 acde 构建所用的
  SDK; `ACDERT_DIST` 设了时换成它, 本地镜像测试用). 换机器、CI 都装得上, lockfile 记下内容校验和; 不写本机绝对路径. npm 上的
  `@dopame/acde-api` 只有旧的 0.0.4, 不用版本号依赖, 等按版本发到 npm 后再换成 `^<版本>`. 检出跑的 acde: 相对路径 `file:` (先 realpath),
  指向 acde 自己 `file:` 依赖的 acdert 检出, 只供开发 acde 的人用; 他们 `bun link` / `npm link` 把 `bin/acde.mjs` 放上 PATH.
  `acde check` 见到工程的 `@dopame/acde-api` 是指向本机绝对路径的 `file:` (`AppPackage.localSdk`, 含盘符、`~`) 时打警告 (旧版 acde 建的工程),
  说明别处装不上并给出 tarball 地址的写法.
- 模板 (`STARTERS`): `html` (`templates/app`, `--backend` 再叠 `templates/backend`)、`desktop` (`templates/desktop`)、`react` / `vue` / `svelte` /
  `solid` / `preact` / `vanilla` (create-vite)、`next` / `nuxt` / `sveltekit` / `astro` (官方脚手架). 框架模板照 `npm create cloudflare`: 经工程的包管理器
  跑脚手架最新版 (`PackageManager.exec`: `bun x --bun` / `npx --yes` / `dlx`), stdin 关掉, 输出收着、失败时整段打出; 只有这一步带 `CI=1` (yarn 见到
  `CI` 不许新建 lockfile, 装依赖那步不能带). 再叠 `templates/framework/acde.config.jsonc` (没有 `entry`: 构建认框架), `.gitignore` 加 `.acde/`; 根上有 `index.html` 的 (Vite 系)
  把它的 `<title>` 换成显示名 (窗口标题先用 `document.title`), 别的框架的标题在组件里, 不改.
  加模板就是 `STARTERS` 加一项.
- 模板按第 1 级契约写 (`test/templates.test.ts`): 应用的配置 (`templates/app`、`templates/framework`) 列出 `capabilities`、`optional`、
  `services`、`requests`、`schemes` (空值加说明; `fs.roots` 只点名 SDK 的 `SHARED_PLACES`), 不预先声明要用户批准的能力, 新工程无界面也能启动;
  类型引用分层: 应用写 `@dopame/acde-api/app`, 桌面页写 `@dopame/acde-api/shell`; 桌面页经 `apps.open(id)` 打开应用 (第 1 级的 `acde:apps`
  没有 `launch`); 不用 `copyIn` (第 1 级由 `fs.copy` 取代).
- 模板的注释和默认文字用英文, 与 skill 一致 (acde#38); 有界面的模板 (`templates/app`、`templates/desktop`) 带最小的 i18n: 文案在 `src/locales/<语言>.js` (至少 en、zh, 键相同), `src/i18n.js` (两份相同) 按 `navigator.language` 精确标签→`Intl.Locale` 的基础语言→`en` 选表, 缺的键回落英文, 设 `<html lang>` 并填 `data-i18n`; 不用第三方库. `templates/` 里除 `locales/zh.js` 外不出现中日韩文字, 不写死 `lang="zh"` (测试检查). 框架模板的界面由各自脚手架生成, 不改.

## 构建 (`src/app.ts`, `src/package.ts`, `src/bundler.ts`, `src/frameworks.ts`)

acdert 只认包 (package.json 的 `acde` 字段, `PackageManifest`); `acde.config.jsonc` 只在构建时读, 变成 `.acde/package.json` 的清单.

- **工程** (`AppPackage`): 有 `acde.config.jsonc` / `.json` 的是 `Project` (字段见 SDK 的 `AcdeConfig` / `config.schema.json`; `"type"` 是 `app` 或
  `desktop`; 后端默认按 `BACKENDS` 找 `server.ts` 等, port 3000); 没有配置、package.json 的 `acde` 有 `apps` 的是手写的**包**; 都没有是默认 app
  (入口 `index.html`, id 由 `name` 经 `Project.idOf`, label 取 `displayName` / `productName`).
- **产物**: app 是 `web/` (URL `/app/<id>/`) 和 `backend/`; desktop 是 `desktop/` (`/desktop/<id>/`)、`services/<名>.js`、`apps/<id>/{web,backend}`.
  `Project.build` 会 `chdir` 进工程, 不能并行构建.
- 应用配置的 `optional` 和 `services` 非空时原样进清单 (运行时据 `optional` 决定缺了哪些能力仍可启动).
- **契约级别**: 产物清单写 `apiLevel`, 值是构建所用 SDK 的 `API_LEVEL` (`acde.config.jsonc` 不写它). 手写的包由 `Manifest.check` 查:
  没写、不是正整数或与 SDK 的级别不同都是错误 (第 0 级已移除, 运行时不再加载没写级别的包).
- **图标**: 图标名 (SDK 的 `ICON_NAMES`) 原样写进清单, 没给是 `app`; 像路径的 (`Project.isIconPath`: 含 `/`、`\` 或有扩展名) 是工程里的
  `.svg` / `.png` (查文件和内容), 复制进应用的 `web/` 叫 `icon.<ext>` (重名时 `icon-<hash8>.<ext>`), 清单写 `/app/<id>/icon.<ext>`.

**框架** (app 的 `framework`, 默认 `auto`, `Frameworks.LIST` 按依赖先认先得): 用框架自己的构建, 不改用户的配置; 没有 node_modules 先
`<pm> install`. 工具不经 `node_modules/.bin` (pnpm 那里是 sh 脚本): `PackageManager.bin` 读依赖的 `bin` 字段拿 JS 文件, bun 上 `bun --bun` 跑,
Node 上 `node` 跑. 配置写了 `entry` 时不认 Vite (html / desktop 模板带 vite 是为 acde 自己打包), 要框架构建就去掉 `entry` 或写 `"framework": "vite"`.

| 依赖 | 构建 | 产物 |
| --- | --- | --- |
| `next` | `next build`, `NEXT_PRIVATE_STANDALONE=1` | `.next/standalone` 是后端 (补 `.next/static`、`public`); `output: 'export'` 时 `out/` |
| `nuxt` | `nuxt build`, `NITRO_PRESET=node-server` | `.output/server/index.mjs` 后端, `.output/public` |
| `@sveltejs/kit` | `vite build` | `Server` 包成 `export default {fetch}` 照后端规则打; `client` |
| `astro` | `astro build` | `dist/`; 有 `dist/server/entry.mjs` 时是后端 |
| `@react-router/dev` / `@remix-run/dev` | `react-router build` / `remix vite:build` | 有 `build/server/index.js` 时 `createRequestHandler` 包成后端 |
| `@angular/core` + `@angular/cli` | `ng build --base-href /` | `dist/**/browser`; 有 `server/server.mjs` 时是后端 |
| `vite` | 进程内调工程的 vite `build()` (读它的 vite.config), 加 SDK 的 Vite 插件 | 静态页 |
| `react-scripts` | `react-scripts build` | `build/` |
| `build` 脚本 | bun 上 `bun --bun run build`, Node 上 `<pm> run build` | `dist` / `build` / `out` / `www` / `.output/public` 里第一个有 HTML 的 |

调 acde 自己的 `build` 脚本 (`acde`、`bunx acde`、`npx acde`) 不算, 否则 `acde build` 调自己. 后端渲染的应用清单 `entry` 是 `/app/<id>/`
(文档从后端取). 都不认 (或 `"framework": "none"`) 时 acde 自己打:

- `Bundler.for`: bun 上 `BunBundler`, Node 上 `ViteBundler` (`ACDE_BUNDLER=vite` 在 bun 上也用 Vite). `ViteBundler` 从工程往上找 `node_modules/vite`
  (不打进 acde, 没有就报 `add it with <pm> add -D vite`), `configFile: false` (规则和 bun 上一样), Vite 8 起 `rolldownOptions`, 之前 `rollupOptions`.
  两边文件名不同, 规则相同:
- HTML 入口: `base` 是 `/app/<id>/` (桌面页 `/desktop/<id>/`), `acde:*` 外部, `NODE_ENV` `"production"`, `import.meta.env` 照 Vite (bun 上 define
  成一样的, 带 `VITE_*`), 不注入 modulepreload, 子目录里的页面出成 `web/<文件名>`. 模块入口的应用: `<名字>.js`, 保留导出. 桌面服务: 单文件, 不压缩标识符.
- 桌面服务里对 `acde:` 的导入 (静态、动态都算; 包括依赖里的) 两边一样拒绝 (`ServiceImports`, 插件 `acde-service`): 构建失败、不留
  `services/<名>.js`, 报 `service <名>: <文件> imports acde:<模块>, …: a service gets shell modules from ctx.import('acde:<name>'), …`
  (文件相对工程, 排好序, 两边逐字相同). 依据是 acdert 的运行时: 服务在 Broker isolate 里经 `import(file URL)` 加载, 而 `acde:*` 只经
  `defineModule` 注入每个 web 的 isolate (`acde-host` 的 `worker.ts`), Broker isolate 没有, 静态导入在链接时就报 `is not given to`;
  服务只能经 `ctx.import('acde:<模块>')` 拿外壳模块 (桌面清单 `services` 项的 `modules` 授权). 所以不把 `acde:*` 设为外部.
  **配置写不出这条授权**: SDK 的 `DesktopConfig.services` 是 `Record<string, string>` (`config.schema.json` 同), 构建写进清单的是服务名的数组,
  所以从配置构建的服务只有 `ctx.inspect`, `ctx.import` 一律被拒 (实测 acdert 0.0.9); 只有手写的包能写 `{name, modules}`. 报错末尾因此加了
  `(acde.config.jsonc has no field for that list: only a handwritten package manifest grants them)`, 模板的注释和 skill 也照实写.
  要让配置能写, 得先改 SDK 的类型和 schema (比如值可以是 `{module, modules}`), acde 再把它写成清单的 `{name, modules}`; acde 不自己认 schema 之外的字段.
- `public/` (插件 `acde-public`): 复制进工程自己的应用的 `web/` 和桌面页的 `desktop/` (桌面里的应用不复制). 以 `/` 开头、落在 public 里的引用:
  HTML 里的照常打包; CSS 的 `url(/x)` 在工程自己的 HTML 入口应用里原样留着 (运行时应用目录也挂在 `/` 下), 别处照打包处理; 哪儿都没有时构建失败,
  说清哪个文件的哪个 URL、public 里缺什么 (`PublicError`).
- Bun 1.4 的毛病: 同一资源同时被 HTML 和 CSS 引用时 HTML 里的引用原样留下、文件不出; fixture 因此两边引用不同的文件.

**后端** (`Bundler.backend`): `backend/server.js` 是 ES 模块, target node (Vite 上 SSR `noExternal: true`), npm 包打进去, Node 内置模块和
`bun` / `bun:*` 留作 import. 入口是生成的一层 (`Bundler.wrapper`): `await import(用户入口)`, `export default` 它的默认导出, 默认导出有 `fetch` 且
有 `Symbol.for('acde.serve')` 时交给它. 旁边写 `{"type": "module"}` 的 `package.json` (免得 Node 打 `MODULE_TYPELESS_PACKAGE_JSON`) 和 preload
`acde-listen.js`. 框架的后端也在入口旁边放 preload.

**preload** (`src/listen.ts`):
- 没有 `import` / `export` (内置模块经 `process.getBuiltinModule`), 既是 CJS 也是 ESM: `"type": "commonjs"` 的包里 (Next standalone) 也能 `--import`.
- `Bun.serve` / `Bun.listen` / `net`、`http`、`https`、`tls`、`http2` 的 `listen(P)` 换成 `<sockets>/P.sock` (`src/sockets.ts`: `ACDE_APP_SOCKETS`, 或
  `$XDG_RUNTIME_DIR/acde/apps/<ACDE_APP_ID>`; P 没给时 `BUN_PORT` / `PORT` / `NODE_PORT` / 3000); 指定端口的 UDP bind、在现成 fd 上 listen 抛 `EACCES`.
- Windows 上的套接字模式 (bun 总是它, 见「Windows 后端契约」): 同样换成 `<ACDE_APP_SOCKETS>\P.sock`, `Bun.serve` 照原样 bind (AF_UNIX),
  `ACDE_APP_CHANNEL` 不看. 目录由运行时建好并设 ACL, 预加载只在缺目录时 `mkdir`, Windows 上不 `chmod`. 路径超过 107 字节 (AF_UNIX 的
  `sun_path` 上限) 时抛 `ENAMETOOLONG` 说清楚; Windows 上没有 `ACDE_APP_SOCKETS` 时要 `XDG_RUNTIME_DIR`, 不猜 `/run/user`.
  有 `ACDE_APP_CONTROL=fd` (且不是通道模式, `controlMode`) 时, 第一个换到套接字上的 server 起来后读 fd 3 的控制帧 (同一套
  `Decoder`; bun 上 `Bun.file(3).stream()`: bun 在 Windows 上 `net.Socket({fd: 3})` 读不到数据; Node 上 `net.Socket`), 只认流号 0 的
  SHUTDOWN, 别的帧忽略. 收到后对登记的每个 server 优雅停止 (`Bun.serve` / `Bun.listen` 的 `stop()` 等在途请求做完, `node:net` 系的
  `close()`), 都结束后 `exit(0)`. 应用自己停掉最后一个 server 时取消读取 (bun 上读着 fd 3 会让进程不退出), 再有 server 时重开.
  fd 3 打不开或读出错时 stderr 打一行, 之后不再读, 服务照常; 读到头不退出. unix 不变 (没有 `ACDE_APP_CONTROL`).
- Node 上 `export default {fetch}`: `acde.serve` 用 `node:http` 起服务, 请求换成 WHATWG `Request` (流式 body, 断开时 abort), `server` 只有
  `upgrade()` (false, 没有 WebSocket 升级)、`requestIP()` (null)、`port`、`hostname`; `Response` 流式写回; 抛错回 500.
- 开发时: `bun --preload <acde>/src/listen.ts server.ts`.
- **通道模式** (`src/channel.ts`, Windows 上的 Node; 帧和信用见下面「Windows 后端契约」): 只在 Node 上且 `ACDE_APP_CHANNEL=fd` 时
  (`channelMode`; bun 不看它, 照常走套接字). 这时 `listen(P)` 不真正监听: 把 server 登记到端口 P, 下一个 tick 发 `listening`,
  `address()` 给 P, `listening` 为真; `close()` 注销后照原型方法关 (回调不报 `ERR_SERVER_NOT_RUNNING`), `signal` 中止同样注销;
  同一端口第二次 listen 发 `EADDRINUSE`. 应用显式 `listen` 一个路径 (含命名管道 `\\.\pipe\…`) 照原样放行: 那是应用自己开的端点,
  不在契约范围内, 契约只管 `listen(P)` 的端口. 第一次登记时用 `net.Socket` 打开 fd 3 (读) 和 fd 4 (写): libuv 在 Windows 上把匿名管道的阻塞读
  放进系统线程池, unix 上是 epoll, 都不占 libuv 线程池 (`fs.read` 会一直占一个, `UV_THREADPOOL_SIZE=1` 时文件操作全卡住, 测试里有这条).
  没有登记的 server 也没有在途流时 fd 3 `unref`, 应用关掉 server 后进程照常退出. fd 3 读到头或出错 (运行时没了)、帧超过 64 KiB 时
  所有流按 RST 失败, stderr 打一行后 `exit(0)`.
- 每条流是一个 `ChannelSocket` (Duplex, `allowHalfOpen`), 经 `server.emit('connection')` 交给 server, HTTP 和 `upgrade` 都走它; 补了
  `setTimeout` (空闲计时)、`setNoDelay` / `setKeepAlive` / `ref` / `unref` (空操作)、`destroySoon`, `remoteAddress` 为 undefined (同 unix socket).
  写出的数据按对方信用切成至多 64 KiB 的 DATA, 信用用完就停, 收到 WINDOW 续发; `end()` 在数据发完后发 FIN. 收到的 DATA 交给 server
  读走 (`_read`) 后攒够 32 KiB 回一个 WINDOW; 超出给过的信用、FIN 之后再来 DATA 都回 RST 并让连接以错误结束. 对方 RST: 连接以
  `ECONNRESET` 出错, 不回帧. 带错误的 `destroy` 发 RST; 不带错误的 `destroy` (keep-alive 超时、`Connection: close` 之后) 补发 FIN,
  流号留到对方的 FIN 再了结, 这期间对方的 DATA 回 RST (像 TCP 关闭后收到数据). 不认识的类型忽略.
- **SHUTDOWN** (流号 0, 别的流号忽略, 只认第一个): 之后的 OPEN 回 RST `the backend is shutting down`; 对每个登记的 server 调
  `close()` (`http.Server` 的 `close` 顺带关掉空闲的 keep-alive 连接, 在途的回完响应后关); 没有登记的 server 也没有在途流时
  `end` fd 4 再 `exit(0)`. 应用别的句柄 (定时器、数据库连接) 不拦着退出.
- 构建出的 `acde-listen.js` 含 `acde-listen-channel/1` (`CHANNEL_MARK`, 也是 `Symbol.for('acde.listen')` 的值), 运行时据此判断支持通道.

## acde dev (`src/dev.ts`, `src/ipc.ts`, `src/sessions.ts`)

- 一个工程、没有 `--desktop`: 桌面工程起 `acdert desktop <id>`, 应用起 `acdert app <id>` (`--app` 挑). 几个工程或给了 `--desktop`: 都构建进
  各自的 `.acde` (不许 `--out` / `--app`), 起 `acdert desktop <D>`: `--desktop` 的值, 否则其中唯一的桌面工程, 否则 `dopame` (全局装的带着).
  `--desktop` 的值像路径 (含 `/`、`.` / `..`) 或当前目录下有同名工程时当作又一个工程 (要恰好一个桌面). 两个工程有同一 id 报错.
- 契约级别: 构建后、起 acdert 之前跑 `acdert --version`, 从 `(contract level N)` 取运行时级别 (没有这段的旧 acdert 算第 0 级;
  10 s 不退出就结束它, 同样算第 0 级). 有工程的 `apiLevel` 与它不同时报 `<名字>: needs level N, runtime is level M` 并退出 1,
  不起 acdert; 所有工程都没写 `apiLevel` (旧的手写包) 时不探测. 重新构建后级别变得不符算构建失败, 不发 `reload`.
- 环境: `ACDE_PATH` (所有构建结果加继承的; 不装)、`ACDE_DEV` (acdert 要听的地址)、`--headless` 时 `ACDE_HEADLESS=1`.
- `fs.watch` 每个工程, 跳过路径里任何一段在 `SKIPPED` (`src/paths.ts`, 含 `__screenshots__` / `__snapshots__`) 的、e2e 测试文件、只是目录的事件、`--out` 目录和嵌在里面的别的工程 (acde test 写基线时不能把应用重载掉); 150 ms 合并, 一次构建一个, 只重建改了的那个 (重读配置),
  给它的每个应用发 `reload {app}`, 它是在跑的桌面时再发 `reload`. 构建失败只打一行.
- acdert 退出 acde 跟着退出 (退出码跟它), acde 的连接断了 acdert 也退出. SIGINT 吞掉 (终端也发给了 acdert), SIGTERM / SIGHUP 转给 acdert.
- 会话目录 (`Sessions.dir`): `$XDG_RUNTIME_DIR/acde-dev`, 否则 `$TMPDIR/acde-dev-<uid>`; `prepare` 建成 0700 后 `lstat`, 是链接、不是目录、
  不是自己的就报错 (防 `/tmp` 里别人先放的链接). 会话文件 `<pid>.json` `{pid, endpoint, dirs, apps, desktop, headless, started}`: 起来后写、重建后重写、
  退出时删, 临时文件再 rename, 0600; 列的时候只认自己的普通文件, 删掉 pid 死了的. acde dev 被外部结束 (Windows 的 `taskkill /F`、
  任务管理器, 别处的 SIGKILL) 时来不及删, acdert 因连接断开跟着退出, 文件留到下一个工具列会话时删; pid 已被复用时连不上, 报 `is gone` 并删.
- dev IPC: **acdert 听, acde 不转发.** 地址 `DevClient.endpoint()`: unix 上 `<会话目录>/<pid>.sock` (acde 先 `prepare` 目录、删掉旧 socket;
  acdert 设 0600: 它能在页面里求值), Windows 上 `\\.\pipe\acde-dev-<pid>`. acde dev 起了 acdert 后每 50 ms 重试连接 (`DevClient.reach`; 10 s 还连不上
  就提示 acdert 太旧), 连上发 `{type: 'hello', role: 'dev'}` 再写会话文件, `reload` 走这条连接. 一行一个 JSON; 工具和 driver 各自直连 acdert 发
  `{type: 'request', id, op, ...}`, 唯一的超时在 `DevClient` (30 s). op 见 acdert AGENTS.md 的「acde dev」.

## 开发工具、driver、MCP、e2e

都用 `DevClient` 直连会话的 `endpoint`. 挑会话 (`Sessions.pick`): `--session`; 否则 `dirs` 包含当前目录的 (取最深的); 否则只有一个会话时用它; 否则报错并列出.
连不上 (`ECONNREFUSED` / `ENOENT`) 时删掉会话文件, 报 `acde dev <pid> is gone`.

- **命令** (`src/tools.ts`): `webs` (表格)、`eval <web> <代码|->` (JSON; web 是 web 名、应用 id 或 `desktop`)、`shot <web> [-o]` / `screen [-o]`
  (PNG 写文件, 打出路径)、`inspect` (`snapshot().text`; 给了 `--find` 时只打匹配的元素: acdert 回的 `trees` 里一个命中节点带着整棵子树 (运行时的 `find` 命中就停),
  所以 acde 按同样的规则 (名字或值含这段文字, 不分大小写) 在 `trees` 里重新找, 每个命中一行, 后面跟最近的有名字的祖先, 按窗口分组 (`Format.found`);
  一个都没有时 stderr 一行、退出码 1)、`query <选择器> [--window W] [--ref REF] [--limit N]` (driver 的 `query`, 即 op `query`: 按 CSS 选择器找元素,
  `inspect` 不列的 (`display: none`、滚出可见范围、没有角色名字的) 也给 ref; 输出是 `Format.matches`, 和 MCP 的 `query` 同一份: `N in <窗口>:` 加每个元素一行
  `- <节点> <标签>` (节点那段是 `Locator.line`, 和运行时 `inspect` 的一行逐字相同: 角色、名字、值、标题的 `[level=N]`、状态、ref; `inspect --find`
  和 Locator 的报错也用它, 只有这一份), 不可见的后面标 `[hidden]`, 运行时给节点带的 `transparent` / `invisible` 状态照旧在前面, 所以和 `inspect --all` 的标记一致;
  没有匹配打 `nothing in <窗口> matches "<选择器>"`, 两种都退出 0; `--limit` 是 1 到 3000 (`Tools.QUERY_LIMIT`, 运行时默认 600), 不用连会话先查)、
  `act <ref> <动作> [参数]` (动作只认 driver 的 `ACTIONS`, `ok: false` 退出码 1; 打的是 driver 的 `act` 的 `text`,
  关掉单应用会话唯一的窗口时就是那行「会话结束」, 退出码 0, 见 driver 的「关窗口结束会话」)、
  `stop` (挑会话同上, 连上发 `{type: "quit"}`, 等连接断、再等 acde dev 的 pid 退出, 各最多 10 s, 还在就 SIGTERM (Windows 上是强制结束,
  acdert 因连接断开跟着退出), 删会话文件, 打 `acde: stopped acde dev <pid>`; 连不上时删会话文件、报 `is gone`, 不按 pid 结束进程: pid 可能已被复用)、
  `console` / `network` (`--follow` 每 0.5 s 带 `next` 续读; `--since N` 从第 N 条起 (运行时的 `since` 含这一条), `--since reload` 从会话文件的
  `reloaded` 起: acde dev 每次重建后、发 `reload` 之前用自己的连接问 `console` / `network {limit: 1}` 的 `next` (最多等 2 s, 问不到沿用上一次),
  写进会话文件 `reloaded: {console, network}`. 运行时的记录不随页面重载清空, 也不标重载 (同一窗口重载后 web 名不变, 不能按 web 名分), 所以只认
  acde dev 发的重载, 页面自己的 `location.reload()` 不算; 还没重载过时是全部). 格式在 `src/driver/format.ts`. 出错 `acde: <原因>`, 退出码 1; 动作名、`--level` 这类不用连会话就能查的参数先查, 错误一行, 末尾指向 `acde <命令> --help`.
- **批准的命令** (`src/approvals.ts` `Approvals`, CLI 和 MCP 共用; 运行时一侧见 acdert AGENTS.md 的「批准」): 第 1 级下要批准的必需能力
  (`terminal`、`network`、`camera`、`microphone`、`launch`、`slots`、`fs.roots` 里的公共位置) 没答之前应用不开窗口, macOS / Linux 的宿主窗口和 headless
  没有对话框, 只能经 dev IPC 答. `acde permissions` 打两段 (`Format.permissions`): `pending:` 下每行 `<id>  <app>  <能力>  (<launch|request>)`,
  `decisions:` 下每行 `<app>  <能力>  <granted|denied>`, 空的一段是 `pending: none` / `decisions: none`. `acde allow` / `acde deny`
  `[<提示 id> | <app> <能力>] [--all]` (`Tools.wanted` 先查参数, 不用连会话: 一个参数必须是数字 id, `--all` 不能再带参数; `Approvals.pick` 挑提示):
  不带参数时只有一个待答就答它, 几个待答时一个都不答、列出来、退出 1 (不猜); 按 id 或按应用加能力点名; `--all` 全答. 每答一个打
  `allowed|denied <app> <能力> (prompt <id>)`. 没有待答的、点名的不在待答里 (已有决定时说 `it is already granted|denied (revoke takes that back)`) 退出 1.
  `acde revoke <app> <能力>` 是 driver 的 `revoke`, 打 `revoked <app> <能力>`, 没有那条决定时退出 1. `acde webs` 的表是空的时候 (单应用会话的应用在等批准)
  每个待答提示再打一行 `<app> waits for approval of <能力>: acde allow (or acde deny)` (`Approvals.waiting`, `Format.waiting`; MCP 的 `webs` / `start`
  同理, 后半句是 `the answer tool allows or denies it`); 桌面会话里 `webs` 总有桌面页, 不打这行, 看 `acde permissions`. 实测 (acdert 0.0.8 加当天的修复):
  单应用会话里拒绝必需能力后 acdert 记一行错误退出 1, 下次 `acde dev` 再问; 撤销必需能力后应用照常跑到下一次 reload, reload 时 acdert 退出 1;
  桌面里拒绝会留着, 应用不进列表.
- **driver** (`acde/driver`, `src/driver/`, 只用 `node:` 模块): `Acde.attach` / `Acde.launch` (用工程的运行时跑 `cliFile()` (`Acde.runtime`: 规则同
  `Cli.follow`, 没有就用 `process.execPath`), 带 `ACDE_FOLLOWED=1`: 会话文件按子进程 pid 找, `acde dev` 自己再换运行时的话登记的是孙进程, 永远等不到;
  输出进 `Logs`,
  等会话文件再等 `ready()`: 窗口表不空且每个 web 的窗口都在表里, 因为 acdert 先答 `webs`, 窗口稍后进表; 有待答的批准提示也算起来了
  (`acdert app` 的应用要批准时, 答之前没有窗口); 默认 120 s (等不到会话文件时报出这段时间里别的进程登记的会话); `close()` 时 SIGTERM, 10 s 后
  SIGKILL).
  **起不来** (`LaunchError`, 是 `Error`, `name` 仍是 `Error`: 0.0.8 的输出里是 `error:` / `Error:`; `phase` / `code` / `logs` 是 getter, bun 打错误时
  不把它们当自有属性列出来): 消息第一行是 0.0.8 的原文, 说停在哪一步的是加在后面的一行, 再后面是输出的最后 40 行; `logs` 是全部输出.
  `exited`: `acde dev exited (N) before it was ready:` (子进程退出后先等输出读完, 最多 `DRAIN_MS` 1 s, 再报, 所以最后几行不会丢);
  `session`: 限时内没有会话文件, 加一行 `no session yet: its build did not finish, or acdert did not start listening; last output:` (会话文件要等
  构建完、acdert 听上、acde dev 连上才写; 分不清是哪一步, 两种都说, 输出里看得出; 别的进程登记了会话时不说这句);
  `window`: 会话在、acdert 在答, 但 `ready()` 一直不成立也没有待答提示, 加一行
  `acdert runs and answers, but no window appeared (pages: N, windows: M) and no approval prompt waits; last output:`; 轮询中连接断了不直接抛
  `acdert closed the connection` (acdert 先退, acde dev 随后才退, 下一轮就是 `exited`), 到限时还没退出才说连接断了; `failed`: 其余的错 (连不上、
  acdert 不答), 消息不变, 原错误在 `cause`.
  失败和 `close()` 都经 `Acde.#stop`: SIGTERM, 10 s 后 SIGKILL, 等的是进程退出 (`Child.gone`, `exit` 事件) 而不是管道关闭 (`Child.exited`,
  `close` 事件): 构建卡住时 acde dev 被结束后它的构建子进程还拿着管道, 等 `close` 永远等不到, 测试只能由 bun 在限时加宽限期后杀掉, 什么都不留
  (实测过). 之后等输出读完 (最多 1 s) 再销毁两根管道. 等待用可取消的定时器: 原来 `close()` 里没取消的 10 s 定时器让只用 driver 的脚本在
  `close()` 之后还要等 10 s 才退出. 没解决的: acde dev 在构建中被结束时, 构建工具的子进程不随它结束 (没有进程组; `acde test` 里用进程组会让
  终端的 Ctrl+C 到不了 acde dev 和 acdert), 会留到它自己跑完.
  方法和 op 一一对应 (`chooseFolder` / `chooseFiles` / `chooseSaveFile` 都是 `choose`, 分别给 `folder` / `open` / `save`; 相对路径按当前目录解析;
  `route(url, 回应, {method, web, times})` 是 `route`, url 是 glob (同 acdert: `**` 任意, `*` 不含 `/`, `/` 开头比路径加查询) 或 RegExp, 回应
  `{status, statusText, headers, contentType, body (文字或字节, 转 base64), json}` 或 `{abort}`; `unroute(id?)`; `clipboard()` / `setClipboard(text)`). `evaluate` 返回 `NoInfer<T>` (否则 `expect(await w.evaluate(…))` 被推成 `Locator` 的重载).
  `waitForRequest(url, {method, web})` 先取 `network` 的 `next` 再轮询到匹配的请求结束 (`done`), `waitForConsole(文字或 RegExp, {level, web})` 同理; 要在触发之前调用.
  **批准** (acde#16, op `permissions` / `answer` / `revoke`, 类型来自 SDK 的 `PermissionPrompt` / `PermissionDecision` / `ApprovalCapability`):
  `permissions()` → `{pending, decisions}`; `waitForPrompt({app, capability, timeout})` 轮询到匹配的待答提示; `answer(提示或 id, allow)`;
  `allow(匹配)` / `deny(匹配)` 是等到再答, 回那个提示. `revoke(app, capability)` (capability 的类型是 `PermissionDecision['capability']`, 含用户选的文件夹 `fs.folder-<令牌>`) 是 op `revoke` (acdert#95), 回 `revoked`
  (有那条决定并删掉了才是 true), 桌面会话和 `acdert app` 都能用. 没人答的提示一直等, 不自动批准.
  **拖放** (op `drop`): `drop(文件, {web, x, y})` (相对路径按当前目录解析, x / y 页面坐标一起给, 默认页面中心, web 默认 desktop) →
  `{web, window, files}`; `AppWindow.drop(文件, {x, y})` 带上自己的 web. acdert 排进主线程就回答, 页面稍后才收到 `drop`, 要等页面上的效果
  (如 `evaluate` 轮询或 `expect`), 不能以回答为准. 页面拿到的: 普通文件进 `dataTransfer.files` (`File`), 每项 `getAsFileSystemHandle()` 是只读句柄
  (文件夹是目录句柄); 扩展期 `items` 前面还有 `text/uri-list` / `text/plain` 两项字符串.
  **关窗口结束会话** (命令行、MCP、driver 共用 `Acde.act` 这一处): 单应用会话 (`acdert app`, 会话文件 `desktop` 为 null) 里关掉应用的窗口,
  acdert 按设计随之退出, 不回答这个 `act` (实测 acdert 0.0.9: 日志 `ended (close), exit 0`, 连接直接断). `act(窗口 ref, 'close')` 发出时连接还在、
  等回答时连接断了 (`DevClient.ended`, 在 socket 的 `close` 事件里同步置位, 先于在途请求被拒)、会话是单应用的、不是自己 `close()` 断的, 就算成功:
  回 `{ok: true, ended: true, text: 'closed <ref>; acdert exited with it, so acde dev <pid> ended'}` (`Acde.endedBy`); `Acde.closed` 就是
  `DevClient.ended`. `AppWindow.close()` 见到 `ended` 不再等窗口消失; acdert 先回答再退出时 (等窗口消失的轮询中连接断了) 同样回这个结果.
  别的情况连接断了照旧报错 (`acdert closed the connection`), 不把崩溃当成功: 别的动作、元素 ref、桌面会话里的 `close` (那里关应用窗口不结束
  acdert, 桌面关不掉: `the desktop cannot be closed`)、`run` (整批的回答丢了, 说不出前面几步做了什么). 会话已断之后再 `act` 是
  `acde dev <pid> is no longer connected`.
  `AppWindow` 每次用到时在窗口表里重新找; `route` / `waitFor*` 带上它的 web. `Locator` 每次在最新语义树 (`limit: 3000, offscreen: true`) 上重新求、不缓存 ref; 动作要**恰好一个**匹配
  (多个报错, 不猜), click / fill / type / selectOption 还等不 `disabled`, `ok: false` 重试到超时再抛 `ActError`. `getByLabel` 是名字匹配的表单角色
  (textbox、combobox、checkbox …); `getByPlaceholder` / `getByTitle` / `getByAltText` 用 `query` 的 `attributes` 读回属性再比. `check` / `uncheck` /
  `setChecked` 状态不对才点, 点完等状态变过去; `dragTo(目标)` 每次重新找两边, 发 `act drag`. `expect` 重试到超时 (默认 5 s), 要一个元素的断言在零个
  或多个时一直等; `toHaveAttribute` 在父元素下 `query('*')` 带属性找回自己. 语义树的限制在 acdert: `opacity: 0` 算不可见, `getByText` 找的是无障碍名字,
  `<select>` 下拉框是 `combobox` (值是选中项, 打开时下面有 `option`), 列表框是 `listbox` (看得见的行是 `option`); 选值用 `selectOption`
  (走 `act select`, 不经弹出的列表), `click()` 走真的输入, 会打开下拉列表.
  CSS 找到的元素 (`locator`、`getByTestId`、`getByPlaceholder` …) 带 `visible`, 看不见的也算匹配 (和 Playwright 一样): `toBeVisible` /
  `toBeHidden` / `isVisible` / `waitFor({state})` 看 `visible`, 动作等元素看得见 (`Locator.line` 标 `[hidden]`); 语义树里的都算看得见.
  组合: `filter({hasText, hasNotText, has, hasNot})` (`has` / `hasNot` 是另一个 Locator, 在每个元素里面求, 它的 scope 不算)、`or(另一个)`
  (两边的并集, 按文档顺序)、`and(另一个)` (交集). `locator.evaluate(函数或源码, arg)`: 在页面里以 `(元素, arg)` 调用 (`eval` 带 `node`).
  断言还有 `toHaveClass` / `toHaveCSS(属性, 值)` (computed style) / `toHaveJSProperty` / `toBeEmpty` / `toBeEditable` / `toBeInViewport({ratio})`,
  都是在页面里求值再比, 同样重试.
  输入: `click` / `dblclick` / `hover` 收 `modifiers` (`Shift` / `Control` / `Alt` / `Meta` / `ControlOrMeta`), 变成 act 的 arg (`shift+ctrl`);
  `ControlOrMeta` 在所有宿主上都是 `Control` (acdert 对页面呈现统一的 Linux 环境, 编辑快捷键是 Ctrl).
  `AppWindow.mouse` (`move(x, y, {steps})` / `down` / `up` / `click(x, y, {button, clickCount, modifiers})` / `dblclick` / `wheel(dx, dy)`, 记着位置)
  和 `keyboard` (`down` / `up` / `press("Control+a")` / `type` (有键的按键, 别的走 `text`) / `insertText`) 用页面的 CSS 坐标, 发 `input`.
  `AppWindow.clock` (`clock.ts`): `install({time})` / `pauseAt` / `fastForward` / `runFor` / `resume` / `setFixedTime` / `setSystemTime` / `state`,
  时间是 ms、Date 或日期字符串, 时长是 ms 或 `"mm:ss"` / `"hh:mm:ss"` (语义见 acdert 的 `clock`). 对话框: `answerDialog({accept, text})`
  事先答复下一个, `waitForDialog({type})` (要在触发之前调用) / `dialogs()` 读 console 里的 `dialog` 条目. `addInitScript(code, {once})`
  (按应用 id 登记, 重开也在)、`reload()` (先在页面里放个记号, 等新页面没有它且 `readyState` 是 complete)、`resize(w, h)` (等 `innerWidth` /
  `innerHeight` 变过去)、`seedLocalStorage(键值)` (一次性的 init 脚本写进去再 reload; 不碰存储的文件格式).
- **截图** (`png.ts`, `screenshot.ts`): `Png` 只用 `node:zlib`: 解所有颜色类型、位深、tRNS、Adam7 (16 位按 /257 取整到 8 位), 编 RGBA (Sub 滤波); `diff` 照
  pixelmatch (YIQ 距离, 阈值默认 0.2, 抗锯齿的边不算, 差的画红). 窗口截图含窗框, 比例是 PNG 宽 / 窗口宽; 元素截图按 rect 减窗口原点乘比例裁;
  `mask` 涂品红. `toHaveScreenshot(名字?, {maxDiffPixels, maxDiffPixelRatio, threshold, mask, timeout})`: 连拍到两张一样才比, 不过就重拍到超时;
  没有基线就写 (`CI` 设了时报错), `Screenshots.context.update` 时重写; 不过时把 `-actual` / `-expected` / `-diff` 写进结果目录 (driver 单用时在基线旁).
  基线: acde test 里是测试文件旁的 `__screenshots__/<文件名>/<名字>-<平台>.png` (不给名字是 `<测试名>-<序号>`), 单用 driver 时名字要是 .png 路径.
- **trace** (`trace.ts`): `acde.trace` 记每个动作和断言 (Locator / AppWindow 的方法、`expect`、`open`、`route`、`choose*` …; 嵌套的只记最外层) 的
  标题、耗时、结果; `screenshots` 开着时每步之后拍整屏. `write(dir)` 写 `trace.txt`, 有截图时再写 `trace.html` (自带的查看页) 和 `trace/NNN.png`.
- **MCP** (`src/mcp.ts`, `@modelcontextprotocol/server`): 29 个工具建在 driver 上 (含 `route` / `unroute` / `clipboard`, `act` 的 drag / select,
  `input` (原始鼠标键盘)、`clock`、`dialog` (答复下一个并列出已有的)、`resize`, 这四个在 `src/mcppage.ts` 的 `PageTools.register`, 经
  `PageToolsHost` 用 `Mcp` 的会话和结果);
  `permissions` / `answer {allow, prompt? | app? + capability?}` / `revoke {app, capability}` 和命令行的批准命令共用 `Approvals`, `answer` / `revoke` 标成 destructive (`answer` 带 `allow: true` 时必须给 `app` 和 `capability`, 不认只给 id 或什么都不给: 批准替的是用户的回答, 而且决定是持久的, 所以批准了什么要写在这次调用里, 客户端问用户时看得见; 拒绝不要求)
  (它替用户做决定), `prompt` 和 `app` / `capability` 不能同时给; `query` 的输出是 `Format.matches`; `clipboard` 在有窗口的会话里碰的是用户的系统剪贴板, 要 `system: true` 才做, 标成 destructive / openWorld 让客户端先问) (`start` / `stop` / `logs` 是自己起 `acde dev` 的). stdout 只走协议.
  会话: 钉住的 (`--session`、`sessions {use}`), 否则 `start` 起的, 否则按工作目录挑 (每次调用前看 IPC 断没断). stdin 关闭或收到信号时停掉 `start`
  起的. 工具出错回 `isError`, 不抛协议错误. 正在用的会话断了之后的下一次调用说它停了: `start` 起的报
  `the acde dev started here (pid N) stopped; last output: …` (只报一次); 接上去的先等它的会话文件消失 (最多 `Mcp.DELISTED_MS` 2 s, 免得又挑中
  正在退出的那个), 再照常挑, 挑到别的会话 (比如用户重起的 `acde dev`) 就接着用, 挑不到时报 `acde dev N stopped; <挑会话的错误>`.
- **e2e** (`src/e2e/`): 文件 `*.e2e.{ts,tsx,js,mjs,mts}` (普通 `bun test` 匹配不到, 不会起 acdert), 从 `acde/test` 导入. 每个测试一个新 `acde dev`
  (`E2eRun`), 隔离: 临时 `HOME` 和 `XDG_*`、`ACDE_STORAGE` 空、`ACDE_SIZE=1280x800`、浅色、减少动画、不跑 autostart, 构建进 `.acde/test`. 失败时在
  `<results>/<文件>/<测试>/` 留 `error.txt`、`output.log`、`screen.png`、`snapshot.txt`、`console.txt`、`network.txt`、`trace.txt` (截图比对的
  `-actual` / `-expected` / `-diff` 也在这). `--trace` 每个测试都留 `trace.html`; `-u` / `--update-screenshots` 重写基线. `TestRunner` 每个文件一个
  `bun test` 子进程, 设置走 `ACDE_TEST_*` (`settings.ts`); 默认 headless、每个测试 60 s, 先清 `.acde/test-results`.
  **汇总** (最后两行): 先 `acde test: N tests ran: P passed, F failed[, S not run (skipped, todo, or not matched by -t)]`, 再是 0.0.8 原有的
  按文件数的一行 `acde test: N files, P passed, F failed…` (不动, 它数的是文件; 新的一行放在它前面, 原来的最后一行还是最后一行). 测试数取自
  bun 的 JUnit 报告: 每个文件的 `bun test` 加 `--reporter=junit --reporter-outfile <临时文件>` (实测 bun 1.4.4: 终端输出不变; 根元素
  `<testsuites tests failures skipped>`, `skipped` 含 skip、todo 和 `-t` 没选中的; 钩子失败算一个 `(unnamed)` 的失败用例), `TestRunner.tally`
  只读根元素的这三个属性: 跑了的 = tests − skipped, 通过 = 跑了的 − failures. 不解析 bun 给人看的输出. 文件加载就出错 (顶层抛错) 或进程被杀时
  bun 不写报告 (实测), 这样的文件不计数, 点名: `; not counted: <文件> (bun test left no report: the file did not load, or its run was killed)`.
  被 `-t` 整个跳过的文件不计.
  `-t`: 子进程把登记的、名字匹配 `-t` 的、真正跑了的测试写进 `ACDE_TEST_MARKS` 指的文件 (`E2e.mark`); 登记过测试却一个也没匹配、一个也没跑的文件
  算跳过 (bun 对这种文件退出码非 0), 不算失败; 所有文件都跳过时报 `no test matches -t` 并退出 1. 匹配按 JS 正则只看测试自己的名字, 正则无效当匹配
  (只会少算跳过; describe 名匹配时 bun 会跑, 有 `ran` 也不算跳过).
  启动 `acde dev` 的限时是测试限时减 3 s (至少一半, `E2eRun.startTimeout`), 起不来时报的是 `Acde.launch` 的原因和输出 (`LaunchError`, 见 driver),
  不是 bun 的超时; 这时没有会话可问, `keep` 留 `error.txt` 和 `output.log` (`LaunchError.logs` 里那个 `acde dev` 的全部输出, 和失败的测试一样最多
  `Logs.KEEP` 行).
  **测试限时由 acde 自己执行** (`E2eRun.within`): 测试体和从测试开始算的限时赛跑, 到点抛 `TimeoutError: the test did not finish within <ms> ms
  (its timeout: --timeout, or the one given to test())` (`TestTimeout`), 照常走 `keep` 留下失败现场, 再 `close()`; 交给 bun 的限时是测试限时加
  `GRACE_MS` (30 s), 留给保存和关会话. 原因 (在真的工程和 acdert 上复现过): bun 到点就放弃这个测试并杀掉它起的子进程 (`killed 1 dangling process`),
  文件里最后一个测试超时时进程随即退出, `catch` 里的 `keep` 来不及跑, `.acde/test-results` 什么都没有. `keep` 向 acdert 要截图、快照、console、network
  这几步合计最多 `KEEP_MS` (15 s, 每步 `E2eRun.within`), acdert 不答时写 `<文件>.error.txt` (`not saved: …`), 不把宽限期耗在 `DevClient` 的 30 s 上.
  **解析 `acde/test` / `acde/driver`**: 用户工程不依赖 acde, bun 的插件 (`onResolve`) 管不到静态 import、也不认 `NODE_PATH`, 所以每个工程在临时目录写一份
  tsconfig 给 `bun test --tsconfig-override` (`tsconfig.ts`): `extends` 工程最近的 tsconfig.json, `paths` 是它自己的 (顺着 `extends` 链取最近定义的
  `paths` 和 `baseUrl`, 换成绝对路径; 链上可以是相对路径、数组、包) 加上这两个模块, 指向跑测试的这个 acde (`packageRoot()`, 打包后也对),
  所以 CLI 和 driver 总是同一个版本. 编辑器里的类型还得工程自己装.

## 分发 (`install.sh`, `install.ps1`, `scripts/dist.ts`)

只有全局安装: 安装器把 acde 和与它配对的 acdert 一起装, 不经 npm, 不要 root, 不带也不下载 bun / Node. 下载地址 `ACDE_DIST` (默认
`https://pkgs.dopame.ai/acde`) 和 `ACDERT_DIST` (默认 `https://pkgs.dopame.ai/acdert`), 两个脚本开头各一处, 末尾的 `/` 去掉. 桶是 `dopame-pkgs`,
前缀 `acde/`, 由 CloudFront 经 `pkgs.dopame.ai` 提供: `acde/install.sh`、`acde/install.ps1`、`acde/install.md` (给 agent 读的安装步骤, 见
「Skill 与文档」)、`acde/latest`、`acde/latest.json`、`acde/<版本>/SHA256SUMS`、`acde/<版本>/acdert-version`、`acde/<版本>/acde-<版本>.tar.gz`
(一个通用包, 不分平台); 官网 `https://dopame.ai/install.*` 指向这里. 发布由 `.github/workflows/release.yml` 完成 (见下). 本地托管目录就是 dist.ts 的
`--out`: `install.sh`、`install.ps1`、`install.md`、`latest` (版本号)、`<版本>/SHA256SUMS`、`<版本>/acdert-version`、`<版本>/acde-<版本>.tar.gz`.

**运行时** (acde#20): 归档本身只含命令行工具、模板、SDK 和 LICENSE. `<版本>/acdert-version` 是配对记录 (一行 acdert 版本, 即构建这一版所用 SDK
的版本, 列在同目录 `SHA256SUMS` 里), 安装器 (含 `--version` / `-Version`) 按它从 `$ACDERT_DIST/<acdert 版本>/` 取 `SHA256SUMS`、
`acdert-<triple>[.exe]` 和 `acdert-host-<acdert 版本>.tar.gz`, 都按那份 `SHA256SUMS` 校验后才落位: 二进制放成 `bin/acdert[.exe]`, 宿主包解开后
的 `app/` 放成 `bin/app/` (acdert 找 `<自己>/app/dist`). 没有配对记录的版本 (如 0.0.7, 发布流程加它之前发的) 读 `$ACDE_DIST/latest.json`, 它的 `version` 正是要装的版本时用它的 `sdk` 并打一行说明, 否则拒绝. 全有或全无: 找不到配对、`SHA256SUMS` 里没有本平台的 triple (报出它列着的
平台)、下载或校验失败, 都在动安装目录之前失败, 之前装的版本和 `current` 照旧. 不用 `acdert/latest`. Dopame 桌面包不随 acde 安装.

装好后一个版本目录 (`versions/<版本>`; 归档里的顶层目录 `acde-<版本>/` 加上安装器放的两项) 是:

```
bin/acde            scripts/acde.sh 跑 lib/acde/dist/cli.js: bun ≥ 1.4 用 bun, 否则 node ≥ 22.3 用 node; 都不行时 bun 太旧提示更新 bun, 否则 node 太旧提示更新 node, 都没有提示装其中一个
bin/acde.exe        Windows 的启动器 (exe/, Rust, 无依赖, 静态 CRT): 选法和提示同 acde.cmd, 只在 PATH 里找 bun.exe / node.exe (不找当前目录); 把自己的原始命令行去掉程序名后原样交给运行时 (raw_arg, 不重新拆分和转义), 自己忽略 Ctrl+C 交给子进程处理, 透传退出码. PATHEXT 里 .EXE 在 .CMD 前, 所以 `acde` 先命中它; PowerShell 调 .cmd 时经 cmd 会丢掉参数里的双引号 (acde#33), 调 .exe 不会
bin/acde.cmd        Windows 的后备启动器 (直接 `acde.cmd …`; acde.exe 被安全软件拦下或缺失时用) 和 dist.ts 没给 --exe 时唯一的启动器: scripts/acde.cmd (CRLF), 同样的选法和提示; 按 `where bun.exe` / `node.exe` 的完整路径直接调 (yarn 4 跑脚本时 PATH 最前面是它的 `node.cmd` 包装, 不带 `call` 调 .cmd 不会回来, acde 一声不响地退出 0; `call` 又会把参数里的 % 再展开一次)
bin/acdert[.exe]    安装器放的 acdert (不在归档里)
bin/app/            安装器从 acdert-host 解出的 app/ 目录原样 (dist/broker.js、dist/web.js、brand/、greet/、package.json); acdert 找 <自己>/app/dist
LICENSE             专有 LICENSE, 归档顶层 (和 lib/acde/LICENSE 一样)
lib/acde/           package.json (exports, 与源码仓库不同: 指向 dist)、launcher.mjs (压缩和轻度混淆)、launcher.d.mts、LICENSE、templates/ (用户起步模板, 含 .ts 是正常的)、
                    skills/acde/ (SKILL.md 和 references/, 原样; `acde skills` 把它装给 agent)、
                    dist/cli.js、dist/driver/index.js、dist/e2e/index.js (acde/driver、acde/test) 和它们共用的 dist/chunk-*.js (压缩和轻度混淆)、dist/types/**/*.d.ts (声明)
lib/acde-api/       @dopame/acde-api 的构建产物 (压缩的 js、d.ts、package.json、config.schema.json; 没有 src/*.ts、test/)
```

- `bun scripts/dist.ts [--api <目录>] [--sdk <版本>] [--version] [--out .dist] [--exe <acde.exe>]` (`--exe` 放进 `bin/acde.exe`, 不是 `MZ` 开头的文件报错; 在 Windows 上 `cd exe && cargo build --release` 得到它; 发布必须带) (`--api` 默认 `../acdert/web/packages/acde-api/dist`,
  要先在 acdert 那边 `bun run build`; 没有 `package.json` 和 `src/index.js`, 或包名不是 `@dopame/acde-api`、版本不等于 `--sdk`
  (默认 `dist.ts` 的 `SDK_PIN`) 时报错. 发布时 `--api` 指向上面解包出的 `package/`). `--sdk` 也写进 `<版本>/acdert-version`. Windows 上打的归档
  没有 unix 的可执行位, 只供 Windows 和测试用 (`.gitattributes` 让 `skills/**`、`install.sh`、`install.md`、`scripts/acde.sh` 在 Windows 检出里也是 LF); 发布在 Linux 上打. 归档前检查 (`scripts/shipped.ts` 的 `shipLeaks()`):
  不许有 `lib/acde/src`、`lib/acde/test`、`lib/acde-api/test`、`.map`、`sourcesContent`、任何 `.js`/`.mjs`/`.d.ts` 里的 `sourceMappingURL`、
  模板之外的 `.ts` 源码, 也不许有符号链接、点文件、密钥和本机构建路径; 覆盖整个包 (acde#7). 有就不出包.
- **轻度混淆** (`javascript-obfuscator` 5.9.0, 精确钉住, 发版前至少两周): 在 `Bun.build` 的 `minify` 之后对 `dist/cli.js`、`dist/driver.js`、
  `dist/test.js`、`launcher.mjs` 做一遍: 标识符改名 (含顶层, `renameGlobals`) 和字符串数组 (base64). 不做控制流平坦化、死代码注入、自我防护
  或调试保护, 不出 sourcemap. 导出名不变 (只改本地绑定, 别名保留). 预加载 `acde-listen.js` 不混淆: `dist.ts` 把它的 JSON 文本 `define` 进去、
  `src/listen-bundle.ts` 用 `JSON.parse` 还原, 让它在 bundle 里是普通字符串字面量, `reservedStrings` 留下 `getBuiltinModule`. 预加载的源码
  是压缩后的普通 JS, 写进每个用户应用的后端目录 (混淆它没有保护价值, 它就跑在用户的应用里).
- **发布** (`.github/workflows/release.yml`, 只能手动运行 `workflow_dispatch`): 协作者的工作流为基础, 合入以下要求. 版本以提交里的 `package.json` 为准, 标签 `v<版本>` 是注释标签, 由工作流打在该提交上 (不手动打标签; 推标签不触发任何工作流). 一个通用包 `acde-<版本>.tar.gz`, 只含命令行工具、模板、SDK 和 LICENSE; acdert 由安装器按 `acdert-version` 从 `pkgs.dopame.ai/acdert/<版本>/` 另行下载 (见「运行时」), 工作流
不下载 acdert 二进制; Dopame 桌面不随 acde 发布.
  发版: 在 `Akira/develop` 改 `package.json` 的版本号并合入 `main`, 然后 `gh workflow run release.yml -R dopame-org/acde --ref main -f publish=true -f commit=<sha>`. `commit` 是 origin/main 上的提交 (完整或短 SHA), 正式发布必填. 预演: `gh workflow run release.yml -R dopame-org/acde --ref main` (可省略 `publish` 与 `commit`, 用运行分支的头; 任何分支都可以, 只构建、打包、跑 guard, 不打标签、不上传).
  作业顺序: `plan` 把 `commit` 解析为完整 SHA, 它必须是 origin/main 的祖先或等于 main 头 (否则失败); 正式发布只允许在 `main` 上运行; 远端 `v<版本>` 不存在或指向该 SHA 才继续 (指向别处则失败, 提示升版本), 指向该 SHA 时允许重跑. 之后所有作业都 checkout 这个 SHA, 输出打印完整 SHA. `pkgs` 从 `https://pkgs.dopame.ai/acdert/<版本>/` 取 SDK 归档, 先校验 `SHA256SUMS`, 解包 `package/` 放到 `../acdert/web/packages/acde-api` (那是 `file:` 依赖的 CI 位置, 不是 acdert 仓库), 核对放置的包名与版本, 再 `bun install --frozen-lockfile`, 跑 `dist.ts` (同时写配对记录 `<版本>/acdert-version`, 内容是这一版 SDK 对应的 acdert 版本, 列进 `SHA256SUMS`; 下一步核对它等于 `SDK_VERSION`), 写 `latest.json`, 解开归档检查 `bin/acde` 能起 CLI、`bin/acde.exe` 是 Windows 可执行文件. `exe` 作业在 `windows-2025` 上 `cargo build --release --locked --target x86_64-pc-windows-msvc` (`exe/.cargo/config.toml` 开静态 CRT), 产物交给 `pkgs` 的 `dist.ts --exe`; 只构建, 不跑测试. 选 Windows 作业而不是在 Linux 上交叉编译: MSVC 目标是 Windows 自己的工具链, 与 acdert 的 Windows 构建一致, 不用装 mingw 或 xwin 下载 MSVC 运行库; 只出 x64 (安装器只支持 x64, Windows on ARM 可以仿真运行 x64, acdert 也没有 arm64 Windows 构建). acde.exe 在通用包里, 由包的 `SHA256SUMS` 覆盖, 不单独发布. `guard` 用 `scripts/release-guard.ts` 核对产物恰好是允许清单、归档里有 `MZ` 开头的 `bin/acde.exe`, 并重新做泄漏检查 (拒绝 `.ts` 源码、`.map`、`sourceMappingURL` 等).
  上传顺序: `upload` (只有它和 `latest` 有 `id-token: write`) 上传版本目录的 `acde-<版本>.tar.gz`、`acdert-version` 与 `SHA256SUMS`, 逐一回读校验; 版本文件已存在且逐字节相同则跳过 (重跑), 不同则失败 (不覆盖), 所以上传失败不会留下标签. `tag` (只有它有 `contents: write`) 在上传通过后打注释标签 `v<版本>` 指向该 SHA 并推送; 标签已指向该 SHA 则跳过. `latest` 最后更新 `install.sh`、`install.ps1`、`install.md` (`text/markdown`)、`latest`, 最后才是 `latest.json`, 然后失效 CloudFront `E3ET3L14ALFOXX` 的具体路径. 上传全部用 AWS CLI 换取的凭据 (`aws sts assume-role-with-web-identity`, 先 mask, 从不打印, 不用 `set -x`), 按允许清单逐个 `aws s3 cp` (没有 sync、递归或通配). `concurrency: acde-release` 让发版排队且不取消进行中的运行.
  与协作者原有约定的差异 (逐条说明的取舍): (1) 协作者是一个作业里完成全部步骤并直接用 `aws-actions/configure-aws-credentials`; 我们拆成六个作业, 写权限只给打标签的作业, OIDC 权限只给上传与更新指针的作业, 凭据用 AWS CLI 换取 (角色 ARN、区域、存储路径不变). (2) 协作者的 `latest.json` 带 `acdert` 和 `dopame` 两个版本字段; 现在没有这两个依赖, 改为 `sdk`. (3) 协作者用 `aws s3 cp --recursive` 上传整个版本目录; 现在按允许清单逐个上传. (4) 协作者的归档按 acdert 的 triple 生成多个; 现在是一个通用归档. (5) 协作者的版本目录每次覆盖; 现在版本文件内容相同则跳过、不同则失败.
  `test/release/workflow.test.ts` 检查这些不变量 (作业关系与 `needs`、权限分配、SHA 固定、不下载 acdert 和桌面包、`acdert-version` 的写入核对与上传、上传先于标签、`latest.json` 最后、只允许 main 发布、commit 必填与祖先检查、幂等规则、遮蔽凭据、角色 ARN 与区域).
- 压缩: `dist/cli.js`、`dist/driver.js` (target node)、`dist/test.js` (target bun, `bun:test` 留作外部) 和根上的 `launcher.mjs` 都是 `Bun.build` 的
  `minify: true`, 不出 sourcemap. 打完去掉 shebang 和随之加的 `// @bun`: 带它 bun 不转译、按 latin1 读, 非 ASCII 乱码. `acde/launcher` 留作外部
  (`launcher.mjs` 在包根, `import.meta.url` 仍指对), 运行时按包的 `exports` 自引用. 归档可复现: 混淆固定 `seed`, 打包前把暂存树的时间戳统一为 2000-01-01, 先 `tar -cf` 再用 `zlib.gzipSync` 压 (gzip 头不写时间), 同一提交两次构建字节相同 (`dist.ts` 里的 `OBFUSCATION_SEED`、`pinTimes`). `*.d.ts` 由 TypeScript 从 `src/driver/index.ts` 和
  `src/e2e/index.ts` 生成到 `dist/types/`. 包根的 `package.json` 由 dist.ts 生成, `exports` 指向 dist (源码仓库的 package.json 不变).
- dist 测试 (`test/dist.test.ts`) 需要 acdert 的 acde-api 已构建: 它用 `../acdert/web/packages/acde-api/dist`.
- **install.sh** (sh / dash / `bash --posix`): 认 triple (Rosetta 里按 `sysctl.proc_translated` 换 aarch64; 有 `/lib/ld-musl-*` 是 musl; MSYS 叫去用
  install.ps1), 按 triple 选 `acdert-<triple>`; curl / wget 下载, shasum / sha256sum / openssl 校验, acde 和 acdert 都下载校验完、在暂存目录里
  拼好 (`bin/acdert`、`bin/app/`) 才动安装目录, 失败什么都不动. 解进 `$ACDE_INSTALL` (默认 `~/.acde`) 的临时目录再改名成
  `versions/<版本>`; `current` 原子换 (`mv -T` / `mv -h`, 退回 `ln -sfn`); `bin` → `current/bin` (相对链接). PATH 上没有且没给 `--no-modify-path` 时按
  `$SHELL` 往 zsh / bash (macOS 加 `.bash_profile`) / fish / `.profile` 的启动文件加一次. 这个终端的 PATH 上没有时, 输出的最后单独一行是
  这个终端里要敲的 `export PATH=…` (fish 是 `fish_add_path`): 装完在原来的终端里敲 `acde` 是 command not found, 人会漏看夹在中间的提示.
- **install.ps1** (Windows PowerShell 5.1 或 PowerShell 7.2+, 只有 x64): 出错 `throw` 不 `exit` (`irm | iex` 时 `exit` 关掉用户的终端); 参数也可走
  `ACDE_VERSION` / `ACDE_NO_MODIFY_PATH`; 用系统的 `tar.exe`. triple 按 `PROCESSOR_ARCHITECTURE` (WOW64 下看 `PROCESSOR_ARCHITEW6432`):
  `x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc`, 取 `acdert-<triple>.exe`; 同样先在临时目录拼好整个版本目录 (`bin\acdert.exe`、`bin\app`) 再换. 同版本已在时整体改名挪开 (`<版本>.old-<guid>`, 改名失败才报「还在运行」), 装好再删,
  删不掉留到下次 (`Remove-Item -Recurse` 遇到占用的文件连 `-ErrorAction Stop` 都不停). `current` 是 junction, 先建 `current.next` 再换. PATH 加
  `current\bin` (`bin` 不做成链接: `acde.cmd` 的 `%~dp0..` 按字面算), 写 `HKCU\Environment` 的 `Path` (`DoNotExpandEnvironmentNames` 读、写回
  `REG_EXPAND_SZ`, 原有的 `%…%` 不展开), 设用户级 `ACDE_INSTALL` (顺带广播 `WM_SETTINGCHANGE`), 当前会话也加上.
- **launcher** (`launcher.mjs`, 只用 `node:` 模块, 类型手写在 `launcher.d.mts`; 源码一律 `import … from 'acde/launcher'`): `bin/acde.mjs` (检出用) →
  `run`: `cliRuntime()` 跑 `cliFile()` (`dist/cli.js`, 否则 `src/cli.ts`, 这时 Node 上找 PATH 上的 bun), 环境 `cliEnv`; 信号同 `acde dev`. 全局装的
  `bin/acde` 不经它. `requireAcdert()`: `ACDERT` (设了找不到直接报错), 全局装时安装器放在旁边的
  `bin/acdert[.exe]` (`acdertBeside`, 同一版本目录), 最后 PATH; 检出跑的 acde 只认 `ACDERT` 和 PATH. 都没有时报错, 说出安装器该放的位置.
- musl 的 acdert 在 Alpine 上编 (`-C target-feature=-crt-static`, 动态链接 Alpine 的库).

## Skill 与文档 (`skills/acde/`, `scripts/skill.ts`, `src/skills.ts`, `src/agents.ts`, `install.md`)

对外的说明只有一份来源: `skills/acde/`, 一个 [Agent Skills](https://agentskills.io/specification) 格式的 skill. 它随安装包发给用户的编码 agent
(`acde skills install`), docs.dopame.ai 的英文页也由它生成 (www 仓库 `docs/scripts/skill-sync.ts`, 一个 reference 对一页:
`references/guide/files.md` → `/guide/files/`; 中文页在 www 里照英文翻译). 所以:

- 命令、参数、配置字段、清单、`acde:` 模块、测试 API、MCP 工具、对外可见的行为变了, **同一个提交里改 skill**. 不去改 www 里生成的英文页
  (那边的检查会拦). acdert 一侧的变化 (模块、平台差异、Web 兼容性) 也改在这里.
- skill 只写对外的用法 (怎么用、会看到什么), 不写实现; 实现和取舍写在本文件.
- skill 里引的输出要是工具真的打出来的, 按它出现的场合逐字引 (2026-11-11 对着 acdert 0.0.9 重跑过): 拒绝必需能力时单应用的 `acde dev`
  日志是 `acdert app <id>: <名字>: "<能力>" is denied by the user`, 桌面里触发提示的 `apps.open()` 以 `<名字>: "<能力>" is denied by the user`
  (403 `denied`) 拒绝, 之后再开是 `<名字> needs "<能力>" (denied by the user)` (404); `fs` 调用没批准的位置 (没问过或被拒) 的错误消息也是前一句.
  `inspect --find` 的窗口行是另一种格式 (`w1 notes "Notes":`, 桌面 `w0 desktop:`). `inspect --all` / `--find` 跳过的是窗口行标了
  `[minimized]` 的窗口: 实测宿主窗口会话里 `act w1 minimize` 后窗口 `state` 是 `minimized` 但 `hidden` 仍是 false, 运行时的 inspect 按 `hidden`
  标 `[minimized]`, 所以这样的窗口没标记、`--all` 照列; 桌面 `windows.hide()` 的窗口才有标记 (这是运行时的事, 文档照实写成「没标 `[minimized]` 的」).
  `acde check` 的错误里应用 id 有的带引号有的不带 (`app "notes":` / `app notes:`), 两种都出自 SDK (`Manifest.check` 带, `Manifest.app` 不带), 文档照实.
  **Windows 上的后端**: skill 现在写「能跑」, 依据是两边的源码和说明 (本文件「Windows 后端契约」、acdert AGENTS.md 同名一节和它的验收脚本
  `scripts/check-backends.sh`), 没有在 Windows 上重跑; `tools.md` 里 cmd 的引号写法 (`\"`) 也只是按 MSVC 的命令行规则写的, 没在 Windows 上试.

**结构**

```
skills/acde/SKILL.md                    入口: frontmatter (name、description) 加正文
skills/acde/references/<组>/<页>.md     组是 start / guide / reference; 路径就是文档的地址
```

- `SKILL.md` 的 `description` 决定 agent 什么时候载入它: 写「做什么」和「什么时候用」, 带上会出现的词 (acde、acdert、Dopame OS、
  `acde.config.jsonc`、`acde:` 模块). 正文是 agent 每次都读的, 只放: 先查环境 (acde、运行时)、和浏览器不一样的地方、工作循环 (建、跑、看、测)、
  规则, 最后一节 `## References` 列出全部 references. 这一节里的顺序就是文档侧栏里的顺序. 细节一律放 references, 按需读.
- 一个 reference 讲一件事, 单独读得懂 (agent 多半只读其中一个); 示例要是真能跑的命令和代码.

**写法规则** (`scripts/skill.ts` 的 `skillProblems()`; `bun scripts/skill.ts` 单独跑, `bun test` 和 `scripts/dist.ts` 都跑, 不过就不出包):

- `SKILL.md`: frontmatter 只有规范里的键 (`name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`), 每个值写在一行;
  `name` 是目录名 (小写字母、数字、单个连字符, ≤ 64); `description` 1 到 1024 字符; 全文 ≤ 500 行.
- reference: 英文; 路径 `references/<组>/<页>.md`, 两段都是小写连字符; 第一行 `# 标题` 加一个空行 (就是文档页的标题), 没有 frontmatter,
  没有第二个一级标题; 只用普通 Markdown: 代码之外没有 HTML / JSX 标签、`:::` 指令、MDX 的 import / export; LF, 末尾恰好一个换行.
- 链接: 指向 skill 里别的文件时写相对路径到 `.md` 文件 (reference 之间 `../guide/files.md#errors`, `SKILL.md` 里 `references/guide/files.md`),
  不写站点根路径 (`/guide/files/`), 不写 `https://docs.dopame.ai/…`; 目标文件要在, `#锚点` 要是目标里某个标题的 slug (GitHub 的算法:
  小写, 去掉标点, 空格换 `-`). 每个 reference 都要列在 `SKILL.md` 最后的 `## References` 一节里.
- 和代码对得上 (`test/skills.test.ts`): 用法文字里的每个命令和每个 `--参数` 都出现在 `references/reference/cli.md`; `src/mcp.ts` 注册的每个工具都出现在
  `references/guide/mcp.md`. 加命令、加参数、加工具而没写进 skill, 测试就红.

**`acde skills`** (`src/skills.ts`): 不带动作是 `status`, 另有 `install`、`remove`、`path`.

- skill 在哪: `Skills.SOURCE` 是 `cli` 上一级的 `skills/acde` (检出时是仓库里的, 安装后是 `lib/acde/skills/acde`). 链接的目标是 `Skills.stable()`:
  全局安装时换成经 `<安装根>/current/` 的路径, 所以升级 acde (换 `current`) 后装过的链接自动指向新版本的 skill.
- 装到哪 (`src/agents.ts` 的 `Agents.all()`): 一张表, 每行是 agent 的 id、名字、全局 skills 目录、「有这些目录之一就算装了这个 agent」的目录.
  表取自 [vercel-labs/skills](https://github.com/vercel-labs/skills) 的 `src/agents.ts` (MIT, 2026-11-10 的版本), 含它认的环境变量
  (`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME` 等). 第一行 `agents` 是 `~/.agents/skills` (Codex、Cline、Zed 等共用的约定目录), 总是装;
  其余只装检测到的. 同一个目录的几行并成一处. `--agent a,b`: 只装这些, 不管检测没检测到; `--dir D`: 只装进 `D/acde` (表里没有的 agent, 或工程自己的
  `.agents/skills`). 要支持新的 agent 就在表里加一行.
- 怎么装: 默认建链接 (Windows 上是 junction, 不要权限), `--copy` 拷贝 (拷贝不会跟着升级, 升级后重跑). 都是先做成 `acde.new-<pid>` 再换上去.
  目的地已有 `acde` 时: 是链接就换; 是目录且 `SKILL.md` 的 `name` 是 `acde` 才换 (旧的拷贝); 别的一律报错不动 (`not the acde skill`),
  一处不行就一处都不装.
- `status` 每处一行: `link` / `copy` 加 `current` (链接指向这份 skill; 拷贝逐文件字节相同) / `outdated` / `broken` (链接的目标没了),
  检测到 agent 但没装的写 `not installed`, 同名但不是这个 skill 的写 `another skill`. `remove` 只删认得出是 acde skill 的 (和断掉的链接).
- `install` 建 skills 目录时 (`mkdirSync` 递归, 返回建出的第一层) 把它新建的每一层记进 `<XDG_DATA_HOME 或 ~/.local/share>/acde/skills.json`
  (`{created: [绝对路径]}`); `remove` 删掉 skill 后从那一处往上, 只删记过且已空的目录, 删了就从记录里去掉. 用户原有的目录 (没记过的) 和
  里面还有别的东西的目录都不动. 记录放 acde 自己的数据目录, 不在 agent 的 skills 目录里留文件.

**`install.md`** (仓库根, 发布到 `https://pkgs.dopame.ai/acde/install.md`): 写给 agent 的安装步骤. 用户只要把一句话交给自己的 agent:
`Read https://pkgs.dopame.ai/acde/install.md and follow it to set up acde on this machine.` 步骤是: 查 Bun / Node.js、跑安装脚本、确认
`acde` 能跑、`acde skills install`、用 `acde --version` 看找到的运行时 (安装器已把配对的 acdert 装在 acde 旁边; 找不到先重跑安装器, 安装器在这台机器上用不了时才问用户, 同意了只照 skill `start/install.md` 的「Install the runtime by hand」从 pkgs 装, 不编、不找别的来路)、建一个工程 check 和 build 再 `acde dev --headless`
截图、汇报. 步骤放在这个文件里而不是 prompt 里, 改步骤不用改用户手里的那句话. 安装脚本的行为、`acde skills`、运行时怎么找变了, 这个文件一起改;
改完在临时 `HOME` 里照着走一遍 (`ACDE_DIST` 指向本地 `dist.ts --out` 的目录).

## 和 acdert 的契约

- 清单校验只有一份: `@dopame/acde-api/manifest` (acdert 的 `web/packages/acde-api`), acdert 的 Broker 和 acde 用同一段 (打进 `cli.js`). 检出的
  package.json 用 `file:../acdert/web/packages/acde-api`, 两个仓库要并排检出.
- **运行时还不是安全边界**: 第三方沙箱 (acdert#30) 做好之前, `acde install` 装的包和 `acde build` / `acde dev` 的开发构建都按开发者自己的
  代码对待: 构建执行工程的构建工具和依赖, 后端是有开发者全部权限的普通进程; 清单的 capabilities、批准和 `fs` 的根只管 `acde:` 模块给什么,
  不隔离进程. 只装、只跑信得过的代码.
- `acde check` 对有配置的工程也用 SDK 的 `Manifest.check` (按构建会写的 `apiLevel`): 配置换成临时清单 (入口、图标、资源不查, 那些由
  `Project.check` 管), 第 1 级的规则 (`fs.roots` 只许公共位置名、能力名、第三方应用的外壳模块、服务的保留名) 在构建前报出, 文字与构建时相同.
- 命令行 `acdert app <id>` / `acdert desktop <id|包目录>`; 环境 `ACDE_PATH`、`ACDE_DEV`、`ACDE_HEADLESS`、`ACDE_RUNTIME`; dev IPC 见上.
- 后端: acdert 在 PATH 上有 bun 时 `bun --preload <dir>/acde-listen.js <entry>`, 否则 `node --import <acde-listen.js 的 file: URL> <entry>` (Windows
  盘符路径不是合法的模块说明符). `acde dev` 给 acdert 设 `ACDE_RUNTIME` (`bun` / `node`, acde 自己跑在哪个上), `node` 时 acdert 先找 node. 没有 `acde-listen.js` 的旧包不起.
- **Windows 后端契约** (2026-11-09 定, 和 acdert AGENTS.md「网页应用」的「Windows 后端契约」是同一份, 两边一起发版; 预加载的通道模式
  和套接字模式已实现 (acde#4、#5, 见「preload」), 两种模式的优雅停止也已实现 (acde#6); 运行时一侧见 acdert#23、#24、#25).
  不变量: 后端运行期间没有 TCP 监听、没有命名管道, 套接字文件只有 SYSTEM 和当前用户能开; macOS / Linux 不变.
  - **两种模式**: node 走**通道模式**, 环境 `ACDE_APP_CHANNEL=fd`, 不设 `ACDE_APP_SOCKETS` (Node 在 Windows 上不能用文件系统 AF_UNIX);
    bun 走**套接字模式**, 环境 `ACDE_APP_SOCKETS=<本代目录>` 加 `ACDE_APP_CONTROL=fd`, 不设 `ACDE_APP_CHANNEL`. 其余变量同 unix.
    两种模式下运行时都经 CRT 的 `lpReserved2` 交给后端两根匿名管道: fd 3 (后端读) 和 fd 4 (后端写). 通道模式上面跑全部帧, 套接字模式只跑控制帧.
  - **通道帧** (大端): `type u8 | stream u32 | length u32 | payload`, 头 9 字节, payload 最多 64 KiB. OPEN 1 (运行时开流, payload 是 u16 的 `listen(P)`
    的 P)、DATA 2、FIN 3 (这一方向写完)、RST 4 (中止, payload 是 UTF-8 原因)、WINDOW 5 (payload u32, 给对方追加的信用字节数)、SHUTDOWN 6
    (流号 0, 无 payload, 请后端优雅退出). 流号由运行时分配、不复用; 每条流每个方向初始信用 256 KiB, 发 DATA 扣信用, 收方交出数据后发 WINDOW 补回.
    不认识的类型忽略; 不存在的流上的 DATA / FIN 回 RST; P 上没有登记 server 时预加载回 RST. 两端都在 FIN 排空后才算关闭, RST 只用于中止.
  - **预加载 (`acde-listen.js`)**: 通道模式把每个 OPEN 交给 `listen(P)` 登记的 server 当一条连接 (HTTP 和 WebSocket 升级都走它), 不真正监听;
    读 fd 3 用专用循环, 不长期占公共线程池. 套接字模式和 unix 一样把 `listen(P)` / `Bun.serve` 换成 `<ACDE_APP_SOCKETS>\<P>.sock`, 有
    `ACDE_APP_CONTROL=fd` 时读 fd 3 上的控制帧. 两种模式收到 SHUTDOWN 都停止接受新连接、让在途请求做完、关 server 后退出; 运行时等 3 秒后终止
    作业对象 (旧预加载不读控制帧, 就等满 3 秒). 预加载不改目录的 ACL. 支持通道的 `acde-listen.js` 含字符串 `acde-listen-channel/1`; 运行时起 node
    前查这个标记, 没有就不起, 打 warn `not started: acde-listen.js does not support the Windows channel (built by an older acde: acde build it again)`.
  - 套接字目录、作业对象、运行时一侧的连接与重试归 acdert, 见它的同一节.

## 测试

`bun test`: `cli` (build、install、配置、public 和图标、新工程、用错的参数)、`templates` (自带模板和框架配置的第 1 级形态: 新建、check、
build 后 SDK 校验无错无警告)、`skills` (skill 的写法规则、和命令 / MCP 工具对得上、`acde skills` 在临时 HOME 里装和删)、`imports` (`acde:` 导入:
分词, 第三方 / 系统应用、桌面页、服务、手写的包、框架应用; check 和 Bun / Vite 两种 build)、`launcher`、`runtime`、`listen`、`channel` (帧编解码与流量控制;
打好的 preload 在真的 node 上由测试扮演运行时, 用 `node:child_process` 的额外管道当 fd 3 / 4, 没有 node ≥ 22 就跳过这一半)、`node` (打好的后端在 Node 上跑; 要
`ACDE_TEST_NODE` 或 PATH 上真的 node ≥ 22.3, 没有就跳过)、`dev` / `driver` / `mcp` / `e2e` (都用 `test/fixtures/dev/fake-acdert.ts` 这个有状态的假
acdert (它听 `ACDE_DEV`) 跑真的 `acde dev`; `FAKE_ACDERT_WAITS=1` 时它先不开窗口, `launch` 的提示被批准后才开, 用来测批准的命令、`webs` 的提示和 MCP 的 `answer`)、`dist` (打包、配对记录、本地托管 acde 和替身 acdert 目录 (`runtimeMirror`: 各 triple 的假二进制、宿主包、`SHA256SUMS`), 跑 install.sh /
install.ps1 和 `bin/acde`; 篡改、缺文件、没有本平台构建、没有配对记录时安装失败且旧安装不变). 给包管理器搭 PATH 用符号链接, 不用 `exec` 的 sh 脚本:
包了一层的 `node` 让 pnpm 不装 rolldown 的平台原生包.

在 Windows x64 原生终端运行 `bun test --timeout 30000`。临时目录须允许建立目录联接、命名管道和 Bun 的文件系统套接字。
分发测试使用本地 HTTP 服务和 `install.ps1 -NoModifyPath`，用含空格的安装、工程和输出路径验证 `acde.cmd new/check/build`。
它从安装目录定位安装器放进去的运行时和随包的 SDK。install.sh 的分发测试只在 macOS 和 Linux 上运行。开发会话测试使用替身运行时，真实启动和正常退出须单独用实际运行时验证。

Windows 跳过 `install.sh`、Unix 会话权限与 Unix 域套接字文件清理、Node.js 后端文件系统套接字场景。
应用后端的 Windows 运行时一侧见「Windows 后端契约」（最初由 [acdert#4](https://github.com/dopame-org/acdert/issues/4) 跟踪）。Bun 预加载的新套接字请求、
Vite 构建及参数检查照常执行。没有 `lsof` 或 `/proc` 时，测试仍验证套接字 HTTP 响应，跳过对进程网络套接字的枚举。
未安装对应工具时，测试会跳过 npm、pnpm 或 Unix Node.js 后端的相关场景。

## 要做

1. 热重载: acdert 已认 `reload {hot: true}` (见它的「acde dev」, 那里提到的 acde `src/changes.ts` 还没有), acde 只发普通 `reload`; 框架用自己的 `build --watch`.
2. `acde.config.jsonc` 加 `compatibility_date`、environments、vars / secrets、服务名 ↔ capability 的显式 binding.
3. `acde types` (按 capabilities 生成 d.ts)、单元测试跑在 acdert 的 isolate 里、`acde deploy --to <主机>`、包签名和仓库之后 `acde publish`.
4. 分发: 发布流水线按 `release.yml` 建立 (见「分发」). 远端已有 `v0.0.5` 标签 (指向 `7ff42fc`), 它不是由新流程打的, 因此新流程不能再发布 `v0.0.5`, 要发更高的版本号. 首次正式发布前先用预演跑一遍.
5. 用户工程里 `acde/test` / `acde/driver` 的编辑器类型 (运行时 `acde test` 已替它解析): 发一个只有类型的包, 或 `acde new` 带上依赖.
6. e2e 在 CI 上跑 (要有 GPU 的 runner, 比如 GitHub 的 macOS runner).

## 协作规则

- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By. 做完就提交并推送.
- 汇报时分开写「已验证 / 未验证」.
