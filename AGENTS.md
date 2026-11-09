# acde

acde 的开发者 CLI. 和 [acdert](https://github.com/dopame-org/acdert) 的关系像 wrangler 和 workerd: acdert 是运行时 (一个二进制,
跑桌面和应用, Dopame OS 的会话就是它), acde 建工程、构建、装包, `acde dev` 拉起 acdert. 运行时的一切 (清单、`acde:` 模块、后端怎么跑、
窗口模型、dev IPC 的 op) 以 acdert 的 AGENTS.md 为准 (并排检出在 `../acdert`), 这里只写工具.

- 说明都在本文件里 (没有 README). full agentic. TypeScript, 跑在开发者已有的 bun 或 Node.js ≥ 22.3 上. 测试 `bun test`, 类型检查 `bun run typecheck`.
- 代码不写注释 (`//`, `/* */`, JSDoc 都不写), 要说明的写进本文件; 工具要读的指令 (`/// <reference>`、`@ts-expect-error`) 除外.
- 闭源: 代码是专有的 (`LICENSE`, package.json `"license": "UNLICENSED"`), 不发 npm 包, 仓库不公开.
- 日志和命令行输出只用英文.

## 命令

| 命令 | 做什么 |
| --- | --- |
| `acde new [目录] [--template T] [--id] [--label] [--backend] [--install] [--git] [--pm PM] [--yes]` | 新建工程 |
| `acde check [目录]` | 手写的包: `Manifest.check` 加入口文件; 有配置的工程: 查配置 (id、入口、图标、服务模块、框架) |
| `acde build [目录] [--out .acde]` | 构建成 acdert 认的包; 产物清单再过一遍 `Manifest.check` |
| `acde install [目录] [--out]` | build 后装进 `$XDG_DATA_HOME/acde/packages/<id>` (先拷到 `<id>.new-<pid>` 再换; 手写的包: 指向工程的符号链接) |
| `acde dev [目录...] [--out] [--app ID] [--desktop ID\|目录] [--headless]` | 构建、起 acdert、改了就重新构建并 `reload` |
| `acde webs` / `eval` / `shot` / `inspect` / `act` / `console` / `network` / `screen` (`--session <pid>`) | 看和操作跑着的 `acde dev` 里的页面 |
| `acde mcp [--session <pid>]` | stdio 上的 MCP 服务 (`claude mcp add acde -- acde mcp`) |
| `acde test [目录\|文件...] [--headed] [-t 名字] [--desktop] [--timeout MS] [--bail]` | e2e 测试, 只在 bun 上 |

参数解析和用法文字在 `src/cli.ts` (`Cli.SPECS`、`USAGE`).

## 工程与工具目录

在应用工程目录运行 `acde check`、`acde build` 和 `acde dev`。从其他目录运行时，可传入工程路径。
`acde new` 在指定目录生成应用源码、配置和依赖声明。框架模板保留框架原有脚本，并追加 `acde:check`、`acde:build` 和 `acde:dev`
用于应用检查、构建和开发会话。

`acde check` 读取工程配置和入口。普通工程的 `build` 和 `dev` 默认把运行时包写到工程的 `.acde/`。
显式的绝对 `--out` 直接指定产物目录。相对 `--out` 从被构建的工程目录解析，例如从父目录运行
`acde dev ./demo --out artifacts/demo` 时，输出位于 `./demo/artifacts/demo`。

分发包的可执行文件在安装目录的 `bin/`，模板在 `lib/acde/templates/`，随包桌面在 `bin/app/packages/`，
软件开发工具包（Software Development Kit, SDK）在 `lib/acde-api/`。应用工程可以保留自己使用的 `bin/`、`templates/` 和 `packages/`。

## bun 和 Node

同一份代码两边都跑, 判断用 `Runtime.bun` (`src/runtime.ts`); `Bun.*`、`bun:*`、宏只能出现在 bun 专属的路径上.

- 子进程一律 `Runtime.spawn` (`node:child_process`). Windows 的 `.cmd` / `.bat`: Node 不许不经 shell 起, `shell: true` 又只把参数拼起来
  不加引号 (Node 24+ 还报 DEP0190), 所以自己加好引号拼成一条命令行交给 shell.
- 按 PATH 找程序只有 `launcher.mjs` 的 `which` (Windows 上按 `PATHEXT`: `nodejs\npm` 是给 Git Bash 的 sh 脚本, 要 `npm.cmd`), 不用 `Bun.which`.
  按 import 条件从工程目录解析包用 `Runtime.resolve`, 不用 `Bun.resolveSync`.
- 打包: bun 上 `Bun.build`, Node 上工程自己的 Vite (见「构建」). `acde test` / `acde/test` 只在 bun 上.
- 后端 preload 的文本 (`src/listen-bundle.ts`) 是 Bun 宏 (`src/listen-macro.ts`, `bun build src/listen.ts`) 打 `cli.js` 时内联的; 从源码跑时
  bun 第一次 import 时跑宏, 只有 Node 时从源码跑出不了 preload (发布的不受影响).

## acde new (`src/create.ts`, `src/pm.ts`)

- 在终端里 (stdin、stdout 都是 TTY, 没给 `--yes`) 用 @clack/prompts 问缺的 (`Creator.ask`): 目录 (默认 `my-app`, 非空或算不出 id 当场提示)、
  应用 / 桌面、模板、显示名、后端 (只有 html)、装依赖、`git init` (不在仓库里且有 git 才问; 没配 user.name / email 时跳过首次提交).
  Ctrl+C 退出码 0. 不在终端里什么都不问: 目录必填, 模板默认 html, 不装依赖、不建仓库.
- **运行时和包管理器**: 工程跑在 bun 或 Node 上, 由包管理器定 (bun → bun, npm / pnpm / yarn → Node). 新工程: `--pm`, 否则 `npm_config_user_agent`;
  在终端里问的时候按 PATH (`runtimes()`: bun, 和 ≥ 22.3 的 node; 其实是 bun 的 `node` 软链接不算): 只有一个就用它, 两个都有问 `Run this project on` (Bun → bun, Node.js → npm,
  默认是跑 acde 的那个); 不在终端里是跑 acde 的运行时 (bun → bun, Node → npm; launcher 从 Node 起 bun 跑 `cli.ts` 时经 `ACDE_HOST_RUNTIME` 传原来的).
  建好写上 `packageManager: <pm>@<版本>` (已经有的不动). 已有工程 (`PackageManager.of`): lockfile, 再 `packageManager` 字段, 都没有是跑 acde 的那个.
  `acde dev` / `build` / `install` 跑在别的运行时上时 (`bin/acde` 两个都有时用 bun), `Cli.follow` 换到工程的运行时重新跑一遍 (`run(argv, exe)`, 带 `ACDE_FOLLOWED=1` 只换一次;
  只对打好的 `cli.js`, `cli.ts` 只能 bun 跑); 那个运行时不在 PATH 上就打一行, 接着在现在的上面跑.
  yarn 的工程写 `.yarnrc.yml` `nodeLinker: node-modules` (PnP 下 bun 和框架的构建找不到依赖).
- **package.json** (`Creator.lay` / `adopt`): 自带模板的脚本 `dev` / `build` / `check` 是 `acde <同名>`; 框架模板不动框架的脚本, 加 `acde:dev` /
  `acde:build` / `acde:check`. 脚本调 PATH 上全局装的 `acde`, 工程里没有 `acde` 依赖. devDependencies: `@dopame/acde-api` (`Creator.api`, `ACDE_API`
  可整个换掉); npm / pnpm / yarn 下自带模板另加 `vite: ^8` (`Creator.VITE`: Node 上用工程的 Vite 打包).
- `@dopame/acde-api` 是 `file:` 依赖 (没上 npm). 全局装的 acde (`installed()`: 自己在 `lib/acde`, 旁边有 `lib/acde-api`): 绝对路径
  `file:<$ACDE_INSTALL>/current/lib/acde-api` (走 `current`, 升级后重装依赖就是新的; `current` 不是跑着的版本时用自己版本的). 检出跑的 acde:
  相对路径 (先 realpath), 指向 acde 自己 `file:` 依赖的 acdert 检出; 开发 acde 的人 `bun link` / `npm link` 把 `bin/acde.mjs` 放上 PATH.
- 模板 (`STARTERS`): `html` (`templates/app`, `--backend` 再叠 `templates/backend`)、`desktop` (`templates/desktop`)、`react` / `vue` / `svelte` /
  `solid` / `preact` / `vanilla` (create-vite)、`next` / `nuxt` / `sveltekit` / `astro` (官方脚手架). 框架模板照 `npm create cloudflare`: 经工程的包管理器
  跑脚手架最新版 (`PackageManager.exec`: `bun x --bun` / `npx --yes` / `dlx`), stdin 关掉, 输出收着、失败时整段打出; 只有这一步带 `CI=1` (yarn 见到
  `CI` 不许新建 lockfile, 装依赖那步不能带). 再叠 `templates/framework/acde.config.jsonc` (没有 `entry`: 构建认框架), `.gitignore` 加 `.acde/`.
  加模板就是 `STARTERS` 加一项.

## 构建 (`src/app.ts`, `src/package.ts`, `src/bundler.ts`, `src/frameworks.ts`)

acdert 只认包 (package.json 的 `acde` 字段, `PackageManifest`); `acde.config.jsonc` 只在构建时读, 变成 `.acde/package.json` 的清单.

- **工程** (`AppPackage`): 有 `acde.config.jsonc` / `.json` 的是 `Project` (字段见 SDK 的 `AcdeConfig` / `config.schema.json`; `"type"` 是 `app` 或
  `desktop`; 后端默认按 `BACKENDS` 找 `server.ts` 等, port 3000); 没有配置、package.json 的 `acde` 有 `apps` 的是手写的**包**; 都没有是默认 app
  (入口 `index.html`, id 由 `name` 经 `Project.idOf`, label 取 `displayName` / `productName`).
- **产物**: app 是 `web/` (URL `/app/<id>/`) 和 `backend/`; desktop 是 `desktop/` (`/desktop/<id>/`)、`services/<名>.js`、`apps/<id>/{web,backend}`.
  `Project.build` 会 `chdir` 进工程, 不能并行构建.
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
- Node 上 `export default {fetch}`: `acde.serve` 用 `node:http` 起服务, 请求换成 WHATWG `Request` (流式 body, 断开时 abort), `server` 只有
  `upgrade()` (false, 没有 WebSocket 升级)、`requestIP()` (null)、`port`、`hostname`; `Response` 流式写回; 抛错回 500.
- 开发时: `bun --preload <acde>/src/listen.ts server.ts`.

## acde dev (`src/dev.ts`, `src/ipc.ts`, `src/sessions.ts`)

- 一个工程、没有 `--desktop`: 桌面工程起 `acdert desktop <id>`, 应用起 `acdert app <id>` (`--app` 挑). 几个工程或给了 `--desktop`: 都构建进
  各自的 `.acde` (不许 `--out` / `--app`), 起 `acdert desktop <D>`: `--desktop` 的值, 否则其中唯一的桌面工程, 否则 `dopame` (全局装的带着).
  `--desktop` 的值像路径 (含 `/`、`.` / `..`) 或当前目录下有同名工程时当作又一个工程 (要恰好一个桌面). 两个工程有同一 id 报错.
- 环境: `ACDE_PATH` (所有构建结果加继承的; 不装)、`ACDE_DEV` (acdert 要听的地址)、`--headless` 时 `ACDE_HEADLESS=1`.
- `fs.watch` 每个工程, 跳过 `SKIPPED` (`src/paths.ts`)、`--out` 目录和嵌在里面的别的工程; 150 ms 合并, 一次构建一个, 只重建改了的那个 (重读配置),
  给它的每个应用发 `reload {app}`, 它是在跑的桌面时再发 `reload`. 构建失败只打一行.
- acdert 退出 acde 跟着退出 (退出码跟它), acde 的连接断了 acdert 也退出. SIGINT 吞掉 (终端也发给了 acdert), SIGTERM / SIGHUP 转给 acdert.
- 会话目录 (`Sessions.dir`): `$XDG_RUNTIME_DIR/acde-dev`, 否则 `$TMPDIR/acde-dev-<uid>`; `prepare` 建成 0700 后 `lstat`, 是链接、不是目录、
  不是自己的就报错 (防 `/tmp` 里别人先放的链接). 会话文件 `<pid>.json` `{pid, endpoint, dirs, apps, desktop, headless, started}`: 起来后写、重建后重写、
  退出时删, 临时文件再 rename, 0600; 列的时候只认自己的普通文件, 删掉 pid 死了的.
- dev IPC: **acdert 听, acde 不转发.** 地址 `DevClient.endpoint()`: unix 上 `<会话目录>/<pid>.sock` (acde 先 `prepare` 目录、删掉旧 socket;
  acdert 设 0600: 它能在页面里求值), Windows 上 `\\.\pipe\acde-dev-<pid>`. acde dev 起了 acdert 后每 50 ms 重试连接 (`DevClient.reach`; 10 s 还连不上
  就提示 acdert 太旧), 连上发 `{type: 'hello', role: 'dev'}` 再写会话文件, `reload` 走这条连接. 一行一个 JSON; 工具和 driver 各自直连 acdert 发
  `{type: 'request', id, op, ...}`, 唯一的超时在 `DevClient` (30 s). op 见 acdert AGENTS.md 的「acde dev」.

## 开发工具、driver、MCP、e2e

都用 `DevClient` 直连会话的 `endpoint`. 挑会话 (`Sessions.pick`): `--session`; 否则 `dirs` 包含当前目录的 (取最深的); 否则只有一个会话时用它; 否则报错并列出.
连不上 (`ECONNREFUSED` / `ENOENT`) 时删掉会话文件, 报 `acde dev <pid> is gone`.

- **命令** (`src/tools.ts`): `webs` (表格)、`eval <web> <代码|->` (JSON; web 是 web 名、应用 id 或 `desktop`)、`shot <web> [-o]` / `screen [-o]`
  (PNG 写文件, 打出路径)、`inspect` (`snapshot().text`)、`act <ref> <动作> [参数]` (动作只认 driver 的 `ACTIONS`, `ok: false` 退出码 1)、
  `console` / `network` (`--follow` 每 0.5 s 带 `next` 续读). 格式在 `src/driver/format.ts`. 出错 `acde: <原因>`, 退出码 1.
- **driver** (`acde/driver`, `src/driver/`, 只用 `node:` 模块): `Acde.attach` / `Acde.launch` (用 `process.execPath` 跑 `cliFile()`, 输出进 `Logs`,
  等会话文件再等 `ready()`: 窗口表不空且每个 web 的窗口都在表里, 因为 acdert 先答 `webs`, 窗口稍后进表; 默认 120 s; `close()` 时 SIGTERM, 10 s 后
  SIGKILL). 方法和 op 一一对应 (`chooseFolder` 是 `choose`). `evaluate` 返回 `NoInfer<T>` (否则 `expect(await w.evaluate(…))` 被推成 `Locator` 的重载).
  `AppWindow` 每次用到时在窗口表里重新找. `Locator` 每次在最新语义树 (`limit: 3000, offscreen: true`) 上重新求、不缓存 ref; 动作要**恰好一个**匹配
  (多个报错, 不猜), click / fill / type 还等不 `disabled`, `ok: false` 重试到超时再抛 `ActError`. `expect` 重试到超时 (默认 5 s), 要一个元素的断言在零个
  或多个时一直等. 语义树的限制在 acdert: `opacity: 0` 算不可见, `getByText` 找的是无障碍名字.
- **MCP** (`src/mcp.ts`, `@modelcontextprotocol/server`): 17 个工具建在 driver 上 (`start` / `stop` / `logs` 是自己起 `acde dev` 的). stdout 只走协议.
  会话: 钉住的 (`--session`、`sessions {use}`), 否则 `start` 起的, 否则按工作目录挑 (每次调用前看 IPC 断没断). stdin 关闭或收到信号时停掉 `start`
  起的. 工具出错回 `isError`, 不抛协议错误.
- **e2e** (`src/e2e/`): 文件 `*.e2e.{ts,tsx,js,mjs,mts}` (普通 `bun test` 匹配不到, 不会起 acdert), 从 `acde/test` 导入. 每个测试一个新 `acde dev`
  (`E2eRun`), 隔离: 临时 `HOME` 和 `XDG_*`、`ACDE_STORAGE` 空、`ACDE_SIZE=1280x800`、浅色、减少动画、不跑 autostart, 构建进 `.acde/test`. 失败时在
  `<results>/<文件>/<测试>/` 留 `error.txt`、`output.log`、`screen.png`、`snapshot.txt`、`console.txt`、`network.txt`. `TestRunner` 每个文件一个
  `bun test` 子进程, 设置走 `ACDE_TEST_*` (`settings.ts`); 默认 headless、每个测试 60 s, 先清 `.acde/test-results`.

## 分发 (`install.sh`, `install.ps1`, `scripts/dist.ts`)

只有全局安装: acde 和 acdert 一起装, 不经 npm, 不要 root, 不带也不下载 bun / Node. 下载地址 `ACDE_DIST` (默认 `http://localhost:8787`, 两个脚本开头
各一处; 还没有正式托管). 托管目录就是 dist.ts 的 `--out`: `install.sh`、`install.ps1`、`latest` (版本号)、`<版本>/SHA256SUMS`、
`<版本>/acde-<版本>-<triple>.tar.gz` (`{aarch64,x86_64}-{apple-darwin,unknown-linux-gnu,unknown-linux-musl}`、`x86_64-pc-windows-msvc`).

tarball 里一个目录就是一个版本的安装根:

```
bin/acde            scripts/acde.sh: 有 bun 用 bun 跑 lib/acde/src/cli.js, 否则 node (≥ 22.3)
bin/acde.cmd        Windows 代替 bin/acde: scripts/acde.cmd (CRLF), 同样的选法, node 要 ≥ 22.3; 按 `where bun.exe` / `node.exe` 的完整路径直接调 (yarn 4 跑脚本时 PATH 最前面是它的 `node.cmd` 包装, 不带 `call` 调 .cmd 不会回来, acde 一声不响地退出 0; `call` 又会把参数里的 % 再展开一次)
bin/acdert[.exe]
bin/app/dist/       acde-host 的 bundle (broker.js、web.js; acdert 找 <自己>/app/dist)
bin/app/packages/   Dopame 桌面包 (不带 .map); acde-host 在 broker.js 上一级的 packages/ 找自带的桌面
lib/acde/           package.json (exports)、launcher.mjs、templates/、src/cli.js、CARRIED 的源码、src/driver/、src/e2e/
lib/acde-api/       acdert 的 web/packages/acde-api (不带 test/)
```

- `bun scripts/dist.ts --acdert <二进制> --host <acde-host dist> --triple <triple> [--api] [--desktop] [--version] [--out .dist]` (`--api` 默认
  `../acdert/web/packages/acde-api`, `--desktop` 默认 `../acde-dopame/packages/dopame`, 先在那边 `bun run build`). macOS 上 tar 带 `--no-xattrs
  --no-mac-metadata` 和 `COPYFILE_DISABLE=1` (不出 `._`).
- `cli.js` 是 `cli.ts` 连同依赖 `Bun.build` 成的一个文件 (target node). `acde/launcher` 留作外部 (打进去 `import.meta.url` 就成了 cli.js 的), 运行时按
  `exports` 自引用. 打完去掉 shebang 和随之加的 `// @bun`: 带它 bun 不转译、按 latin1 读, 非 ASCII 乱码. driver / e2e 是 TS 源码, 它们 import 的
  `src/*.ts` 要列进 `CARRIED`.
- **install.sh** (sh / dash / `bash --posix`): 认 triple (Rosetta 里按 `sysctl.proc_translated` 换 aarch64; 有 `/lib/ld-musl-*` 是 musl; MSYS 叫去用
  install.ps1); curl / wget 下载, shasum / sha256sum / openssl 校验, 失败什么都不动. 解进 `$ACDE_INSTALL` (默认 `~/.acde`) 的临时目录再改名成
  `versions/<版本>`; `current` 原子换 (`mv -T` / `mv -h`, 退回 `ln -sfn`); `bin` → `current/bin` (相对链接). PATH 上没有且没给 `--no-modify-path` 时按
  `$SHELL` 往 zsh / bash (macOS 加 `.bash_profile`) / fish / `.profile` 的启动文件加一次.
- **install.ps1** (Windows PowerShell 5.1 或 PowerShell 7.2+, 只有 x64): 出错 `throw` 不 `exit` (`irm | iex` 时 `exit` 关掉用户的终端); 参数也可走
  `ACDE_VERSION` / `ACDE_NO_MODIFY_PATH`; 用系统的 `tar.exe`. 同版本已在时整体改名挪开 (`<版本>.old-<guid>`, 改名失败才报「还在运行」), 装好再删,
  删不掉留到下次 (`Remove-Item -Recurse` 遇到占用的文件连 `-ErrorAction Stop` 都不停). `current` 是 junction, 先建 `current.next` 再换. PATH 加
  `current\bin` (`bin` 不做成链接: `acde.cmd` 的 `%~dp0..` 按字面算), 写 `HKCU\Environment` 的 `Path` (`DoNotExpandEnvironmentNames` 读、写回
  `REG_EXPAND_SZ`, 原有的 `%…%` 不展开), 设用户级 `ACDE_INSTALL` (顺带广播 `WM_SETTINGCHANGE`), 当前会话也加上.
- **launcher** (`launcher.mjs`, 只用 `node:` 模块, 类型手写在 `launcher.d.mts`; 源码一律 `import … from 'acde/launcher'`): `bin/acde.mjs` (检出用) →
  `run`: `cliRuntime()` 跑 `cliFile()` (`src/cli.js`, 否则 `cli.ts`, 这时 Node 上找 PATH 上的 bun), 环境 `cliEnv`; 信号同 `acde dev`. 全局装的
  `bin/acde` 不经它. `requireAcdert()`: `ACDERT` (设了找不到直接报错), 检出时旁边的 `../acdert/target/{release,debug}/acdert` (先于 PATH: 两个仓库一起改),
  全局装时自己版本的 `bin/acdert` 再 `$ACDE_INSTALL` 的, 最后 PATH; 都没有就列出找过的地方.
- musl 的 acdert 在 Alpine 上编 (`-C target-feature=-crt-static`, 动态链接 Alpine 的库).

## 和 acdert 的契约

- 清单校验只有一份: `@dopame/acde-api/manifest` (acdert 的 `web/packages/acde-api`), acdert 的 Broker 和 acde 用同一段 (打进 `cli.js`). 检出的
  package.json 用 `file:../acdert/web/packages/acde-api`, 两个仓库要并排检出.
- 命令行 `acdert app <id>` / `acdert desktop <id|包目录>`; 环境 `ACDE_PATH`、`ACDE_DEV`、`ACDE_HEADLESS`、`ACDE_RUNTIME`; dev IPC 见上.
- 后端: acdert 在 PATH 上有 bun 时 `bun --preload <dir>/acde-listen.js <entry>`, 否则 `node --import <acde-listen.js 的 file: URL> <entry>` (Windows
  盘符路径不是合法的模块说明符). `acde dev` 给 acdert 设 `ACDE_RUNTIME` (`bun` / `node`, acde 自己跑在哪个上), `node` 时 acdert 先找 node. 没有 `acde-listen.js` 的旧包不起.

## 测试

`bun test`: `cli` (build、install、配置、public 和图标、新工程、用错的参数)、`launcher`、`runtime`、`listen`、`node` (打好的后端在 Node 上跑; 要
`ACDE_TEST_NODE` 或 PATH 上真的 node ≥ 22.3, 没有就跳过)、`dev` / `driver` / `mcp` / `e2e` (都用 `test/fixtures/dev/fake-acdert.ts` 这个有状态的假
acdert (它听 `ACDE_DEV`) 跑真的 `acde dev`)、`dist` (假 acdert 打包、本地托管、跑 install.sh 和 `bin/acde`). 给包管理器搭 PATH 用符号链接, 不用 `exec` 的 sh 脚本:
包了一层的 `node` 让 pnpm 不装 rolldown 的平台原生包.

在 Windows x64 原生终端运行 `bun test --timeout 30000`。临时目录须允许建立目录联接、命名管道和 Bun 的文件系统套接字。
分发测试使用本地 HTTP 服务和 `install.ps1 -NoModifyPath`，用含空格的安装、工程和输出路径验证 `acde.cmd new/check/build`。
它从解包后的安装目录定位随包的运行时和 SDK。开发会话测试使用替身运行时，真实启动和正常退出须单独用实际运行时验证。

Windows 跳过 `install.sh`、Unix 会话权限与 Unix 域套接字文件清理、Node.js 后端文件系统套接字场景。
应用后端的 Windows 运行时支持由 [acdert#4](https://github.com/dopame-org/acdert/issues/4) 跟踪。Bun 预加载的新套接字请求、
Vite 构建及参数检查照常执行。没有 `lsof` 或 `/proc` 时，测试仍验证套接字 HTTP 响应，跳过对进程网络套接字的枚举。
未安装对应工具时，测试会跳过 npm、pnpm 或 Unix Node.js 后端的相关场景。

## 要做

1. 热重载: acdert 已认 `reload {hot: true}` (见它的「acde dev」, 那里提到的 acde `src/changes.ts` 还没有), acde 只发普通 `reload`; 框架用自己的 `build --watch`.
2. `acde.config.jsonc` 加 `compatibility_date`、environments、vars / secrets、服务名 ↔ capability 的显式 binding.
3. `acde types` (按 capabilities 生成 d.ts)、单元测试跑在 acdert 的 isolate 里、e2e 截图比对、`acde deploy --to <主机>`、包签名和仓库之后 `acde publish`.
4. 分发: 正式托管 (域名、R2 或 GitHub release); acdert 的发版流程改成各平台跑 dist.ts 再合起来上传; Windows ARM64.
5. 用户工程没有 `acde` 依赖, `import 'acde/test'` / `'acde/driver'` 解析不到: 要 `acde test` 替它解析 (比如把安装的 `lib/` 放进解析路径).

## 协作规则

- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By. 做完就提交并推送.
- 汇报时分开写「已验证 / 未验证」.
