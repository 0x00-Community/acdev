# acde

acde 的开发者 CLI. 和 [acdert](https://github.com/dopame-org/acdert) 的关系像 wrangler 和 workerd: acdert 是运行时 (一个二进制,
跑桌面和应用, Dopame OS 的会话就是它), acde 建工程、构建、装包, `acde dev` 拉起 acdert. 运行时的一切 (清单、`acde:` 模块、后端怎么跑、
窗口模型) 以 acdert 的 AGENTS.md 为准, 这里只写工具.

说明都在本文件里 (没有 README). full agentic. TypeScript, 跑在 bun 上 (开发者机器上不必有 bun, 见「分发」), 测试 `bun test`, 类型检查 `bun run typecheck`.
代码不写注释 (`//`, `/* */`, JSDoc 都不写), 要说明的写进本文件; 工具要读的指令 (`/// <reference>`、`@ts-expect-error`) 除外.

## 形态

开发者在任意系统上 (macOS / Windows / Linux, 包括 Dopame OS) 用 acde 建工程, `acde dev` 拉起 acdert 开一个**原生窗口**, 窗口里是
完整的桌面 (默认 Dopame, 工程自己是桌面时用它自己的), 开发者的应用从工程目录加载进去. 不是 WebUI, 不推流, 不开端口, 没有 devtools
(acdert 的第一原则). 宿主窗口和合成见 acdert AGENTS.md 的「运行时进程」.

| 命令 | 做什么 |
| --- | --- |
| `acde new [目录] [--template T] [--id ID] [--label 名字] [--backend] [--install] [--git] [--yes]` | 新建工程, 见下面「新建工程」 |
| `acde check [目录]` | 按 acdert 读清单的方式查 (`@dopame/acde-api/manifest` 的 `Manifest.check`) |
| `acde build [目录] [--out .acde]` | 构建成 acdert 认的包 (见下) |
| `acde install [目录]` | build 之后装进 `$XDG_DATA_HOME/acde/packages/<id>` (手写的包: 指向工程目录的符号链接) |
| `acde dev [目录...] [--out DIR] [--app ID] [--desktop ID\|目录]` | 构建, 起 acdert (一个工程: `acdert desktop <id>` (桌面工程) 或 `acdert app <id>`; 几个工程或给了 `--desktop`: 都放进一个桌面), 构建结果经 `ACDE_PATH` 给它 (不装); 盯着工程目录, 哪个改了就只重新构建它、发 `reload`; acdert 从哪儿来见「分发」. 见下面「acde dev」 |
| `acde webs` / `eval <web> <代码\|->` / `shot <web> [-o 文件]` / `inspect [--window W] [--find 文字] [--all]` / `act <ref> <动作> [参数]` (都可加 `--session <pid>`) | 看和操作一个正在跑的 `acde dev` 里的页面 (给 agent 和开发者用), 见下面「开发工具」 |

## 新建工程 (`acde new`, `npm create acde`)

一行命令, 用开发者已有的任何一个:

| 已有 | 新建 | 开发 |
| --- | --- | --- |
| bun | `bun create acde` | `bun run dev` |
| npm | `npm create acde@latest` | `npm run dev` |
| pnpm | `pnpm create acde` | `pnpm dev` |
| yarn | `yarn create acde` | `yarn dev` |
| deno | `deno init --npm acde` | `deno task dev` |

(框架模板的开发脚本叫 `acde:dev`, 见下.) 都解析到 `create-acde` 包, 它跑 `acde new`. 在终端里 (stdin 和 stdout 都是 TTY, 没给 `--yes`)
像 `npm create vite` 一样逐项问 (@clack/prompts, `src/create.ts` 的 `Creator.ask`), 命令行已给的不再问: 目录 (默认 `my-app`;
非空的、算不出 id 的当场提示; id 是目录名小写、非 `[a-z0-9-]` 换成 `-`)、做什么 (窗口应用 / 桌面)、模板 (应用才问)、显示名
(默认 id)、要不要后端 (只有 html 问)、装不装依赖、`git init` (不在 git 仓库里、有 git 才问; 再 `git add` + 首次提交, 没配
user.name / email 时提交跳过). Ctrl+C 退出码 0 (和 create-vite 一样, 包管理器不再报 "command failed"). 不在终端里时什么都不问:
目录必填, 模板默认 html, 不装依赖、不建仓库 (要就给 `--install` / `--git`). 做完打出下一步 (`cd`、装依赖、开发脚本).

**包管理器** (`src/pm.ts` `PackageManager`): 新工程用开发者跑命令的那个 —— 包管理器跑 `create-acde` 时都设
`npm_config_user_agent` (bun / npm / pnpm / yarn / deno 开头); 没有时 (全局装的 `acde` 直接跑) 看启动脚本跑在哪个运行时上
(`ACDE_HOST_RUNTIME`: node → npm, deno → deno, bun → bun); `--pm` 指定. 装依赖、脚手架的参数 (Next.js 的 `--use-<pm>`, Nuxt 的
`--packageManager`)、打出的下一步都按它; yarn 的工程另写 `.yarnrc.yml` 的 `nodeLinker: node-modules` (PnP 下 bun 找不到依赖,
框架的构建也不认). 已有的工程 (`acde build` 发现没有 node_modules 时) 按 lockfile 认 (`bun.lock`、`pnpm-lock.yaml`、`yarn.lock`、
`package-lock.json`、`deno.lock`), 再看 package.json 的 `packageManager`. 框架的命令 (`next`、`astro` …) 不经 `node_modules/.bin`
(pnpm 和 Deno 那里是 shell 脚本, bun 跑不了), 从依赖的 package.json 的 `bin` 找到 JS 文件, `bun --bun` 跑它.

**新工程的 package.json** (`AppPackage.wire` / `wiring`): 自带模板的 `scripts` 是 `dev` / `build` / `check` (`acde dev` …); 框架模板不动
框架自己的脚本, 加 `acde:dev` / `acde:build` / `acde:check`. devDependencies 是 `@dopame/acde-api` 和 `acde` 自己 (像 wrangler: 版本
跟着工程走, 脚本里的 `acde` 就是工程自己的那份, 不靠 PATH). `build` 脚本调的是 acde (`acde`、`bunx acde`、`npx acde`、`…/acde.mjs`)
时不算「有 build 脚本的工程」(否则 `acde build` 调自己).

- 发布出去的那份 acde (见「分发」): 两个都写 `^<版本>`.
- 没发布的 (从 git 检出跑的 acde): 工程里不写绝对路径 (挪了目录、换了机器还能用), 都相对工程目录 (两边先 realpath, macOS 的
  `/tmp` 是 `/private/tmp`), 指向这份检出: `@dopame/acde-api` 是 `file:<相对路径>` (acde 自己的 package.json 里 `file:` 指向的
  acdert 检出 `web/packages/acde-api`, 不是 acde 的 node_modules 里那份拷贝; `ACDE_API` 照旧能整个换掉). `acde` 按包管理器选能「链接
  到检出、还把 bin 接上」的写法 (都实测过, 见下面「验过」):

  | 包管理器 | `acde` | 为什么 |
  | --- | --- | --- |
  | bun | `link:acde`, `acde new` 时在检出里跑一次 `bun link` (登记到 bun 的全局链接表, `$BUN_INSTALL/install/global/node_modules/acde`, 幂等, 10 ms) | bun 的 `file:` 目录依赖是拷贝, 拷完按工程目录 (不是 acde 的目录) 解析 acde 自己的 `file:../acdert/…` 依赖, 失败; bun 的 `link:<路径>` 不是相对工程的路径, 是相对全局链接目录解析的 (深度碰巧够时才对), 不能用 |
  | npm | `file:<相对路径>` | npm 对工程外的目录依赖建符号链接、不装它的依赖 (检出自己有 node_modules); npm 不认 `link:` |
  | pnpm | `link:<相对路径>` | 符号链接, 改检出立刻生效; pnpm 的 `file:` 是把整个目录注入成一份拷贝 (旧了要重装) |
  | yarn (2+, `nodeLinker: node-modules`) | `portal:<相对路径>`, 另加 `resolutions` 把 `@dopame/acde-api` 定成工程的那条 `file:` | `link:` 不接 bin; `portal:` 接 bin, 但它要解析 acde 自己的依赖, acde 的 `@dopame/acde-api` (相对 acde 的 `file:`) 和工程的那份是两个 locator, 链接时冲突 (YN0071), `resolutions` 让两边是同一份. yarn 1 不支持 `portal:` (acde 本来也只按 yarn 2+ 做) |
  | deno | `file:<相对路径>`, 脚本写成 `deno run -A node_modules/acde/bin/acde.mjs <命令>` | deno 给本地目录依赖建了 `node_modules/acde` 链接, 但不建 `node_modules/.bin` (`links` 也一样), `deno task` 找不到 `acde` |

  验过 (macOS, 2026-11-06; PATH 里只有各包管理器和 node / bun, 没有全局的 `acde`): bun 1.4.0 (`bun test`: `BUN_INSTALL` 指向临时目录,
  `acde new --pm bun` 后 `bun install && bun run build`, PATH 里连 node 都没有; 另手动 React 模板 `bun run acde:build`)、npm 11.16 和
  pnpm 10.23 (`bun test`: 装依赖、`run build`, `node_modules/acde` 指到检出)、yarn 4.18.1 (手动: `yarn set version berry` 后
  `yarn install && yarn build`)、deno 2.7.12 (手动: html 模板 `deno install && deno task build`; React 模板的脚本对) 都构建出了包.
  bun 的 `file:` / `link:<路径>`、npm 的 `link:`、yarn 的 `link:` 和不加 `resolutions` 的 `portal:`、deno 的 `links` 也都试过, 都不行 (原因见表).

| 模板 | 怎么来 |
| --- | --- |
| `html` | 自带 `templates/app` (加 `--backend` 再叠 `templates/backend`: `server.ts` 和取 `/api/hello` 的页面) |
| `react` / `vue` / `svelte` / `solid` / `preact` / `vanilla` | `create-vite@latest --template <名>-ts --no-interactive --no-immediate` |
| `next` | `create-next-app@latest --yes --ts --app --use-<pm> --skip-install --disable-git --no-agent-feedback` (deno 用 `--use-npm`) |
| `nuxt` | `create-nuxt@latest --template minimal --no-install --no-gitInit --packageManager <pm>` |
| `sveltekit` | `sv@latest create --template minimal --types ts --no-add-ons --no-install` |
| `astro` | `create-astro@latest --template minimal --no-install --no-git --no-ai --yes --skip-houston` |
| `desktop` | 自带 `templates/desktop` |

框架模板照 `npm create cloudflare` 的做法: 用框架自己的脚手架 (`bun x --bun <包>@latest`, 用跑 acde 的那份 bun, 总是最新版;
不交互, stdin 关掉、只给这一步带 `CI=1` (yarn 见到 `CI` 不许新建 lockfile, 装依赖那步不能带), 输出收着, 失败时整段打出来), 然后
`AppPackage.adopt` 叠上 acde 的部分: `templates/framework/acde.config.jsonc` (没有 `entry`: 构建认框架)、上面的 package.json、
`.gitignore` 加 `.acde/`; 不动框架自己的文件. 加模板就是 `STARTERS` 加一项 (`scaffold(dir, pm)` 返回命令行; 没有 `scaffold` 的是
`templates/<kind>`).

验过 (macOS, 2026-11-05): 在 Ghostty 里跑 `acde new` 和 `npm create acde@latest`, 用 AppleScript 按键 (`send key` / `input text`)
并读屏 (`perform action "write_screen_file:copy,plain"`: 屏幕写进文件, 路径进剪贴板): React (装依赖 + git)、html + 后端、
非空目录的提示、Ctrl+C. 11 个模板 `--yes --install` 全部建好并 `acde build` 通过 (Next / Nuxt / SvelteKit 是后端渲染). 五种入口见「分发」.

另一种工程是手写的**包** (没有 `acde.config.*`, package.json 的 `acde` 有 `apps`): 不用构建, build 只校验, install 是符号链接.

## 分发 (npm, 任何包管理器)

只发 npm 一处: bun、npm、pnpm、yarn、deno 都从它装. 安装时不跑任何脚本 (pnpm 10+、npm 11、Deno 默认都不跑 postinstall), 二进制
照 esbuild / biome 的做法放进按平台分的包, 由 `os` / `cpu` / `libc` 字段让包管理器只装本机那一个.

| 包 | 内容 |
| --- | --- |
| `create-acde` | `packages/create-acde/index.mjs`: import `acde/launcher`, `run(['new', ...参数])` |
| `acde` | `bin/acde.mjs` → `launcher.mjs`; `src/cli.js` (`src/cli.ts` 连同 @clack/prompts、acde-api 打成一个文件: Deno 跑 `npm:` 包时没有 node_modules, 运行时不能再解析依赖) 和它按文件用的 `src/listen.ts`、`src/sockets.ts`、`templates/`. `dependencies` 只有 `@dopame/acde-api` (精确版本; 新工程的 devDependency 取它的版本). `optionalDependencies`: 每个编出来的平台的 `@dopame/acdert-<平台>` (精确版本) 和 Bun 官方的 `@oven/bun-<平台>` (8 个, 含 musl; 版本是打包那份 bun 的). `preferUnplugged`: yarn PnP 下解压到磁盘 (PnP 的 ESM 读不了 zip 里的 `.mjs`, bun 也要真文件) |
| `@dopame/acdert-<平台>` | `bin/acdert(.exe)` 和 `bin/app/dist/{broker,web}.js` (acdert 在自己旁边的 `app/dist` 找 host bundle); 平台: `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` (`libc: glibc`)、`linux-arm64-musl`、`linux-x64-musl` (`libc: musl`; Alpine 上编, 动态链接 Alpine 的库)、`win32-arm64`、`win32-x64` |
| `@dopame/acde-api` | acdert 仓库的 `web/packages/acde-api` 原样 |

启动脚本 `launcher.mjs` 只用 `node:` 模块, Node / Deno / Bun 都能跑:
- bun: 自己就跑在 bun 上用自己; 否则 `@oven/bun-<平台>` (经 `createRequire` 从 acde 的位置解析; 落在 zip 里的不算); 否则 PATH 上的
  `bun`; 都没有就下载 (见下).
- acdert (`requireAcdert`; `acde dev` 自己 (`src/cli.ts`) 也调它, 直接 `bun src/cli.ts dev` 时一样): `ACDERT` (设了但文件不在时
  直接报错, 不往下找; 不带路径分隔符的按 PATH 找); 否则 `@dopame/acdert-<平台>`; 否则 (只有没发布的仓库里的 acde) 旁边的 acdert
  检出 —— 两个仓库并排检出 (见「和 acdert 的契约」), `<acde>/../acdert/target/release/acdert`, 再 `.../debug/acdert` (Windows 加
  `.exe`; acdert 从 `<exe>/../../web/packages/acde-host/dist` 找 host bundle); 否则 PATH 上的 `acdert` (放在检出之后: 仓库里的
  acde 和旁边的 acdert 是一起改的, PATH 上的可能是旧的发布版). `dev` 才需要, 都没有就下载 (发布出去的那份); 再没有就报错, 列出找过的
  每个地方 (`ACDERT`、平台包、两个检出路径、PATH) 和怎么办 (`ACDERT=/path/to/acdert acde dev`、在旁边的检出里
  `cargo build --release -p acdert`、放进 PATH); 这个平台没有包时开头是「acdert has no build for <平台> yet」. 打包时 `src/cli.js`
  里对 `../launcher.mjs` 的 import 留作外部模块 (`scripts/pack.ts` 的插件; 打进去的话 `import.meta.url` 就成了 `src/cli.js` 的).
  验过 (macOS, 2026-11-06): `test/launcher.test.ts` 用假的 acde 目录试 release / debug / PATH 的先后、发布的那份不找检出、找不到时的
  报错、`ACDERT` 不存在; `bun scripts/pack.ts` 打出的 acde (没有 acdert 平台包) 在 PATH 里没有 acdert 时 `acde dev` 列出找过的地方.
- 下载 (可选依赖没装上: lockfile 是在别的平台上生成的、`--omit=optional`、yarn PnP): 从 `npm_config_registry` (默认
  registry.npmjs.org) 取那个版本的元数据, 下 tarball, 按 `dist.integrity` 校验, 自己解 tar (gzip + ustar, 带权限位), 放进缓存
  (`ACDE_CACHE_DIR`, 默认 macOS `~/Library/Caches/acde`、Linux `$XDG_CACHE_HOME/acde`、Windows `%LOCALAPPDATA%\acde\cache`) 的
  `<包>@<版本>/`, 打一行说明.
- 用那份 bun 跑 `src/cli.js` (没发布的仓库里是 `src/cli.ts`), PATH 最前面加上 bun 所在目录 (acdert 起应用后端用的就是 PATH 上的
  `bun`), 设 `ACDERT`、`ACDE_HOST_RUNTIME`; SIGINT 父进程只吞掉 (终端已经发给整个进程组), SIGTERM / SIGHUP 转给子进程; 退出码跟它.
- 「发布出去的那份」= package.json 有 `optionalDependencies` (只有打包脚本写): 这时新工程的依赖写 `^<版本>`; 仓库里的 acde 写相对
  路径链接到这份检出 (见「新工程的 package.json」).

打包: `bun scripts/pack.ts --acdert <平台>=<二进制> ... --host <acde-host dist> [--api <acde-api 目录>] [--version x.y.z]
[--bun-version] [--out .npm] [--publish <仓库>]`: 在 `.npm/` 出各包的 tgz (`bun pm pack`), `--publish` 时用 PATH 上的 npm 发
(仓库里已有那个版本的跳过). 发版走 acdert 仓库的 `.github/workflows/release.yml`: `v*` tag (或手动) 时六个平台各编一次 acdert
和 host bundle, 再检出 acde 打包并发 npm. 要两个 secret: `DOPAME_READ_TOKEN` (读私有的 acgpu、acde), `NPM_TOKEN`. 编不过的平台
(Windows 移植没做完之前的 win32) 不进 `optionalDependencies`, 其余照发.

注意: yarn 4.18 (`npmMinimalAgeGate`, 1440 分钟) 和 Deno 2.9 (`minimumDependencyAge`, 24 小时) 默认不装发布不到一天的版本;
首次发布后一天内这两条入口报「找不到 / 被隔离」, 之后每次发版它们晚一天拿到新版. 不绕开 (这是它们的供应链防护).
Linux 的 acdert 动态链接 libxkbcommon、gbm、libudev、libinput、fontconfig、OpenSSL 3、pipewire (普通桌面都有; libseat 是运行时
dlopen 的, 没有也能起). glibc / musl 由启动脚本判断: Node 的 `process.report` 有 `glibcVersionRuntime` 就按它, 拿不到 (Deno、Bun)
看 `/lib/ld-musl-*` 在不在.

验过 (macOS arm64, 2026-11-05, 本地 verdaccio 当仓库, 只发了 darwin-arm64; Node 26 / npm 11、pnpm 12、yarn 4.18、Deno 2.9、
Bun 1.4, 除 bun 那条外 PATH 里没有 bun): npm (html + 后端)、pnpm (React)、yarn (Vue)、Deno (Astro)、bun (Next.js, PATH 里没有
node) 各自建工程、装依赖、跑开发脚本, acdert 的窗口里页面都出来了 (html 的拿到了后端的回答, Next.js 是服务端渲染的); npm
`--omit=optional` 时 bun 和 acdert 都从仓库下载进缓存, 照样跑起来; `npm i -g acde` 后 `acde new` 认成 npm; `npm create acde@latest`
在 Ghostty 里交互和 Ctrl+C. Linux x86_64 glibc (CachyOS, 2026-11-05; geekom-1 编 acdert 并起 verdaccio, geekom-2 是没有 bun / node /
seatd 的机器, 外层显示是 `kwin_wayland --virtual`): 同样五条 (npm html + 后端、pnpm React、yarn Vue、Deno Astro、只有 bun 没有 node
的 Next.js) 和 `--omit=optional` 的下载都通过, 页面都在 acdert 的窗口里出来. 没验: 公网 npm (还没发), CI, Windows, macOS x64,
Linux arm64, yarn 1. musl (同日): acdert 在 Alpine edge 容器里编 (rustup 的 `x86_64-unknown-linux-musl`,
`-C target-feature=-crt-static`, rusty_v8 有 musl 的预编译库), 在另一个只有 Alpine 的 nodejs / npm 的容器里 (共享宿主的 Wayland socket 和
`/dev/dri`) `npm create acde` 装上的是 `bun-linux-x64-musl` 和 `acdert-linux-x64-musl`, React 和 html + 后端都在窗口里出来, 后端有回答.

## 和 acdert 的契约

- 包: acdert 只认包 (package.json 的 `acde` 字段, 类型 `@dopame/acde-api` 的 `PackageManifest`); `acde.config.jsonc` 只在这里读.
- 清单校验只有一份: `@dopame/acde-api/manifest` (acdert 仓库 `web/packages/acde-api/src/validate.ts`), Broker 读清单和 `acde check`
  用同一段. 还没上 npm: `package.json` 用 `file:../acdert/web/packages/acde-api`, 两个仓库要并排检出 (`~/Repos/acde`、`~/Repos/acdert`).
- 后端的 listen preload (`src/listen.ts`) 在这里, 构建时打成包里的 `backend/acde-listen.js`, acdert 起后端时 `--preload` 它.
- 命令行: `acdert app <id>` / `acdert desktop <id|包目录>`.

## 网页应用的工程

普通网页应用 (`index.html` + 任意框架 + 可选的后端) 不改代码就是 acde 的窗口应用. 页面由 acdert 的 V8 和 render 跑 (没有浏览器);
后端是 acdert 起的 bun 进程. 都不开端口: 后端的 listen 换成 unix socket, 往外连照常.

- **`acde.config.jsonc`** (照 wrangler.jsonc; 也认 `acde.config.json`; 类型 `AcdeConfig` 和 `config.schema.json` 在 SDK 里):
  工程根目录的这份配置声明工程是什么 —— `"type": "app"` 是一个窗口应用, `"type": "desktop"` 是一个桌面 (用户可以自己做桌面,
  不只是桌面上的应用). 公共字段 `name` / `version` (默认取 package.json), `public` (原样复制的静态目录, 默认 `public`).
  app: `id`、`label`、`icon`、`entry` (HTML, 默认 `index.html`; 或默认导出 `WindowApp` 的模块)、`capabilities`、`heapMb`、`size`、`multiple`、
  `frame`、`mimeTypes`、`backend` (`false` 不要; 默认找 `server.ts` 等, 见下). desktop: `id`、`label` (显示名)、`description`、
  `entry` (桌面页, 默认 `index.html`)、`heapMb`、`services` (服务名 → 模块, 打成 `services/<名>.js`, 跑在 Broker 里)、`apps`
  (桌面自带的窗口应用, 每个和 app 的字段一样, `id` / `entry` 必填). 这份配置只在构建时读: `acde build` (`src/app.ts`
  的 `Project`) 把它变成包的 package.json 清单 (运行时只认清单, 见「桌面包」). 产物: app 是 `web/` (`/app/<id>/`)、`backend/`;
  desktop 是 `desktop/` (`/desktop/<id>/`, 清单的 `entry` 是 `desktop/<页面>`)、`services/`、`apps/<id>/{web,backend}`.
  没有这份配置时, package.json 的 `acde` 简写 (`id`、`label`、`web`、`server`、`backend` …, 没有 `apps`) 当作 app 读; 两样都没有
  也行: id 取 package.json 的 `name`, label 取 `displayName` / `productName`.
- **图标** (app 和桌面里每个应用的 `icon`, 清单的规则见 acdert AGENTS.md 和 SDK 的 `Manifest.check`): 一个图标名 (SDK
  `@dopame/acde-api/manifest` 的 `ICON_NAMES`: `app`、`timer`、`chart` …; 不认识的名字由 `Manifest.check` 警告, acde 不另查), 或工程里的一张
  图 (相对工程目录的路径; 含 `/`、`\` 或以 `.<扩展名>` 结尾的就当路径). 是路径时 `acde check` 和 `acde build` 都查: 文件要在, 扩展名是
  `.svg` / `.png`, 内容也得是 (PNG 的文件头; SVG 是有 `<svg` 的文本), 不对就报 `icon "x" in acde.config.jsonc: <哪儿不对>`.
  `acde build` 把它复制进这个应用的 `web/` (桌面里的应用是 `apps/<id>/web/`, 框架构建的也一样) 叫 `icon.svg` / `icon.png` (那里已有同名的
  别的文件时用 `icon-<内容 hash 前 8 位>.<扩展名>`), 清单的 `icon` 写成同源的 URL `/app/<id>/icon.svg` (Dopame 桌面能读所有包的资源,
  用 `<img>` 画). 没给是 `app`; 名字原样写进清单. 模板的 `acde.config.jsonc` 默认 `"icon": "app"`.
  验过 (macOS, 2026-11-06, `bun test`): fixture `test/fixtures/app` 的 `"icon": "src/logo.svg"` 进了 `web/icon.svg`, 清单是
  `/app/hello-app/icon.svg`; 桌面工程里应用的 `art/cards.png` 进了 `apps/cards/web/icon.png`; 名字 `timer` 原样; 文件不在、`.txt`、
  假的 PNG、假的 SVG 在 check 和 build 都报错.
- **框架** (`src/frameworks.ts`, app 的 `framework`, 默认 `auto`): 按 package.json 的依赖认, 用框架自己的构建, 不改用户
  的配置文件; 没有 node_modules 时先用工程的包管理器装 (见「新建工程」); 构建工具一律 `bun --bun` 跑 (机器上可以没有 Node). 先认先得:
  | 依赖 | 怎么构建 | 产物 |
  | --- | --- | --- |
  | `next` | `next build`, 带 `NEXT_PRIVATE_STANDALONE=1` (配置里没写 `output` 时就是 standalone) | `.next/standalone` 是后端 (补上 `.next/static`、`public`); `output: 'export'` 时 `out/` 是静态页 |
  | `nuxt` | `nuxt build`, `NITRO_PRESET=node-server` | `.output` 是后端 (`server/index.mjs`), `.output/public` 是静态资源 |
  | `@sveltejs/kit` | `vite build` | 不管 adapter: `.svelte-kit/output/server` 的 `Server` 包一层 `export default {fetch}`, Bun.build 打成后端; `client` 是静态资源 |
  | `astro` | `astro build` | 默认 `dist/` 是静态页; 有 `dist/server/entry.mjs` (node adapter) 时它是后端, `dist/client` 是静态资源 |
  | `@react-router/dev` / `@remix-run/dev` | `react-router build` / `remix vite:build` | 有 `build/server/index.js` 时 `createRequestHandler` 包成后端, 否则 `build/client` 是静态页 |
  | `@angular/core` + `@angular/cli` | `ng build --base-href /` | `dist/**/browser/index.html`; 有 `server/server.mjs` 时它是后端 |
  | `vite` (React、Vue、Svelte、Solid、Preact …) | 进程内调工程自己的 vite 的 `build()`, 读它的 vite.config, 加上 `base: '/'`、`outDir` 和 SDK 的 Vite 插件 (`acde:*` 留作外部模块) | 静态页 |
  | `react-scripts` | `react-scripts build` | `build/` |
  | package.json 有 `build` 脚本 | `bun --bun run build` | `dist` / `build` / `out` / `www` / `.output/public` 里第一个有 HTML 的 |
  都不是 (或 `"framework": "none"`): acde 自己用 Bun.build 打 `entry` (上面「产物」). 静态页的清单 `entry` 是 `/app/<id>/<页面>.html`,
  `server.ts` 照旧是后端. 有后端渲染的, 清单 `entry` 是 `/app/<id>/` (以 `/` 结尾, 要有 `backend`): 窗口 web 的文档从后端取
  (见下面「清单」), 静态资源 (`_next/static` 这类) 放进 `web/` 由 render 直接读盘.
  验过 (macOS, 2026-11-02, 各框架官方模板的最新版): Vite + React、Vite + Vue 构建成静态页; Next.js 16、Nuxt 4、SvelteKit 3 构建成后端,
  bun 加 preload 起来后在 unix socket 上返回服务端渲染的 HTML, 不开 TCP 端口; Astro 7 构建成静态页. 还没在 acde 的窗口里打开过.
- **开发**: 工程根目录 `acde.config.jsonc` 写 `"type": "app"` (见上); 要类型就加 devDependency `@dopame/acde-api`.
  `acde build` 输出 `.acde/`: `web/` (HTML 入口打包, 所有 URL 在
  `/app/<id>/` 下), `backend/server.js` (有 `server.ts` / `server.js` 等时; target bun 打成一个模块, npm 包打进去,
  Bun 和 Node 自己的模块留作 import) 和它旁边的 `backend/acde-listen.js` (`src/listen.ts` 打包: 把 `Bun.serve` /
  `Bun.listen` / `export default {fetch}` / `net`、`http`、`https`、`tls`、`http2` 的 `listen(P)` 都换成
  `<sockets>/P.sock`), 清单 `package.json`; `acde install` 装进 `$XDG_DATA_HOME/acde/packages/<id>`; `acde dev`
  再 `acdert app <id>`. 开发时在 bun 下跑后端源码也用同一个 preload (`bun --preload <acde>/src/listen.ts server.ts`).
- **`public/`** (`Project.#public`, Bun.build 的插件 `acde-public`): `public` 目录 (配置的 `public`) 原样复制进工程自己的应用的
  `web/` 和桌面页的 `desktop/` (桌面里的应用不复制). 以 `/` 开头的引用落到 public 里时:
  - HTML 里的 (`<link rel="icon" href="/favicon.svg">`): 照常打包 (带 hash 的文件名, `/app/<id>/` 下).
  - CSS 的 `url(/fonts/x.woff2)` (像 Vite: public 里的文件按根路径引用): 工程自己的应用 (HTML 入口) 原样留着这个 URL —— 运行时
    应用目录也挂在 `/` 下 (acdert「网页应用」), public 已经复制进 `web/`; 桌面页、桌面里的应用和模块入口的应用不挂在 `/` 下,
    这时照打包处理 (Bun 1.4 把 CSS 引用的资源都内联成 `data:` URL).
  - 哪儿都没有 (public 里没有, 也不是磁盘上的绝对路径) 时构建失败, 说清楚是哪个文件里的哪个 URL、public 里缺哪个文件
    (`/fonts/x.woff2 in src/style.css: there is no public/fonts/x.woff2 (a URL starting with / is a file in public/)`).
  Bun 1.4.0 的毛病 (不是 acde 的): 同一个资源同时被 HTML (`<img src="./a.svg">`) 和 CSS (`url(./a.svg)`) 引用时, CSS 里内联了,
  HTML 里的引用原样留下、文件也不出, 运行时那张图是坏的; 测试的 fixture 因此让 HTML 和 CSS 引用不同的文件.
  验过 (macOS, 2026-11-06): fixture `test/fixtures/app` 的 `src/style.css` 用 `url('/fonts/fixture.woff2')`, 构建出的 CSS 里还是这个
  URL、`web/fonts/fixture.woff2` 在; 桌面工程里桌面页和它的应用引用 `url(/wall.svg)` 都打包了; 不存在的文件报上面的错 (`bun test`).

## acde dev (`src/dev.ts`)

- `acde dev [目录...] [--out DIR] [--app ID] [--desktop ID|目录]` (`DevSession`; 不给目录是 `.`, 同一个目录给两次算一个):
  - 一个工程、没有 `--desktop`: 和以前一样, 桌面工程起 `acdert desktop <它的 id>`, 应用起 `acdert app <id>` (`--app` 挑桌面工程里的
    哪个应用, 或几个应用里的哪个). `--out` 是构建目录 (相对工程目录, 默认 `.acde`).
  - 几个工程, 或给了 `--desktop`: 全部构建 (一个接一个: `Project` 构建时 `chdir` 进工程目录, 不能并行), `ACDE_PATH` 是所有构建结果
    (手写的包就是它自己的目录) 加上继承的 `ACDE_PATH`, 起 `acdert desktop <D>`. D 是 `--desktop` 的值; 没给就是这些工程里那个桌面工程
    的 id (有两个以上时报错, 要 `--desktop` 挑); 都不是桌面就是 `dopame` (acdert 发行时带着; 用仓库里的 acdert 时 Dopame 要在
    `ACDE_PATH` 里或装好, 或者 `--desktop <acde-dopame 的 packages/dopame>`). `--desktop` 的值是目录 (含 `/`, 或当前目录下有这个名字的
    工程 / 包) 时把它当成又一个工程 (构建、盯着), 跑它的那个桌面 (它没有或有好几个桌面时报错); 否则是桌面 id. 每个工程构建进自己的
    `<工程>/.acde`, `--out` 只在一个工程时能给; `--app` 只在一个工程时有意义 (几个时报错: 应用都在桌面里, 从桌面开). 两个工程里有同一个
    应用 id 或桌面 id 时报错.
- **会话目录** (`Sessions.dir`): `$XDG_RUNTIME_DIR/acde-dev` (设了且是绝对路径时; Linux 上它是每个用户自己的 0700 目录), 否则
  `$TMPDIR/acde-dev-<uid>` (macOS 的 `$TMPDIR` 本来就是每个用户的; Linux 上退到大家共用的 `/tmp`, 名字带 uid 免得和别人的撞).
  `Sessions.prepare` 建它 (0700) 后用 `lstat` 查: 是符号链接、不是目录、或不是自己的就报错不用 (别人在 `/tmp` 里先放一个指向别处的
  链接时, 不会顺着链接改那边的权限、往那边写); 权限松了收紧成 0700. `/tmp` 有粘滞位, 建好以后别人删不掉、换不掉它.
- IPC (`src/ipc.ts` 的 `DevServer`): acde 在 `ACDE_DEV` 上听 (unix 上 `<会话目录>/<pid>.sock`, Windows 上命名管道
  `\\.\pipe\acde-dev-<pid>`, 都是 `node:net` 的 server). 这条 IPC 能在页面里求值 (`eval`), 所以 socket 只给自己: 放在会话目录里,
  听上之后再 chmod 0600. 一行一个 JSON (读的时候只在新到的那块里找换行, 几 MB 的截图也不慢).
  连上来的每一方第一行是 `hello`, 带 `role`:
  - `runtime` (acdert hostwin 的 `acde-dev` 线程, `{"type":"hello","role":"runtime","pid"}`); 没有 `role` 的 `hello` 是改这个协议之前的
    acdert, 也算 runtime (`reload` / `quit` 照发), 但它不认 `request` (只在日志里打一行 warn), 所以工具的请求不转给它, 当场回错:
    「acdert (pid N) is older than the dev tools …」. 只要一个 runtime, 它连着时再来的 runtime 被关掉. 第一行不是 `hello` 的连接被关掉.
  - `tool` (`acde webs` 这些命令, `{"type":"hello","role":"tool"}`), 可以有很多个.
  acde → runtime: `{"type":"reload","app"?}`、`{"type":"quit"}`, 和转过去的请求. 工具发 `{"type":"request","id","op",...参数}`, acde 换一个
  自己发的 id (从 1 递增, 所以几个工具的 id 撞不上) 转给 runtime; runtime 回 `{"type":"response","id","ok","result"|"error"}`, acde 把 id
  换回来交给问的那个工具. 每个请求恰好一个回答: runtime 还没连上时请求先排着, 连上了再发; 30 s 没回答回 `ok:false`、
  `error` 以 `timed out` 开头 (说清楚是 acdert 没连上还是没回答哪个 op); runtime 断了, 已经发出去的回「acdert disconnected before answering」;
  acde dev 停的时候回「acde dev is stopping」; 晚到的回答 (超时以后) 丢掉; 工具断了, 它的请求作废. 工具发来的不是 `request` 的行 (带 id 时)
  回错. op 和它们的结果是 acdert 的事 (见 acdert AGENTS.md「运行时进程」的 dev IPC): `webs`、`eval {web, code}`、`shot {web}`、
  `snapshot {...}`、`act {ref, action, arg?}`、`run {steps}`.
- 会话文件 (`src/sessions.ts`): 每个 `acde dev` 在 IPC 起来后写 `<会话目录>/<pid>.json`
  `{"pid","endpoint","dirs":[工程目录 (realpath)],"apps":[应用 id],"desktop":桌面 id|null (调试窗口是 null),"started":毫秒}`, 每次重新构建
  后重写 (应用可能变了), 退出时 (acdert 退出、SIGTERM / SIGHUP 转给 acdert 之后、起 acdert 失败) 删掉. 先写临时文件再 rename (读的一方
  不会读到半个). 文件 0600; 列会话时只认会话目录里自己的普通文件 (`lstat`, 不跟链接). 写不了只打一行警告, dev 照跑.
- 盯着每个工程目录 (`fs.watch` recursive, 一个工程一个), 不看 `.acde`、`node_modules`、`.git` 和各框架的产物目录 (`dist`、`build`、`.next` …),
  也不看 `--out` 指到工程里面时的那个目录 (否则构建自己触发构建), 一个工程套在另一个里面时外面那个不管里面那个的改动. 每个工程 150 ms 内的
  改动合成一次; 要重新构建的工程排队, 一次构建一个; 构建中又改了, 构建完再来一次. 只重新构建改了的那个工程, 构建好了给它的每个应用发
  `reload`, 它就是正在跑的那个桌面时再给桌面发一个 (Broker 只重开开着的应用窗口). 构建失败只打一行 (几个工程时带工程名), 窗口不动.
- acdert 退出 acde 就退出 (退出码跟它); acde 退出 acdert 也退出 (连接断了). SIGINT 只吞掉 (终端也发给了 acdert), SIGTERM / SIGHUP 转给 acdert.
- 验过 (macOS): 模板应用改 `index.html`, 6 ms 构建完, 窗口在原位换成新页面. 2026-11-06, 用仓库里的 acdert (main, 还没有新的 dev IPC;
  `ACDERT` 没设, 是旁边检出里找到的): `acde dev . ../todo-pomodoro --desktop <acde-dopame>/packages/dopame` (在 Demo 的 `apps/notes` 里)
  起了 `acdert desktop dopame`, `ACDE_HOST_DUMP` 的桌面是 Dopame; 经 `ACDE_DEBUG_DIR` 和 acdert 的 `drive.sh launch` 在里面开了 notes 和
  todo-pomodoro 两个窗口; 在 todo-pomodoro 里新建再删一个文件, 只有它重新构建 (31 ms)、只有它的窗口重开; 会话文件对; `acde webs` /
  `eval` 0.03 s 内报「older than the dev tools」; SIGTERM 后 acdert 退出, 会话文件和 socket 都删了. 一个工程 (`todo-pomodoro`) 起的是
  `acdert app todo-pomodoro`, 窗口出来了. `bun test` (`test/dev.test.ts`): 假的 runtime / 工具 socket 测转发 (id 改写、各回各的、出错、
  先到的请求排队、超时、旧 acdert、runtime 断开、第二个 runtime、不是 hello / 不是 request、3 MB 的行), 会话文件 (写、列、死了的删、
  按目录挑), 和一个假的 acdert (`test/fixtures/dev/fake-acdert.ts`, 照 Contract A 回答) 跑真的 `acde dev`: 几个工程、桌面工程、`--desktop <目录>`、
  一个工程、旧 acdert、各种用错的参数, 以及经 CLI 的 `webs` / `eval` (含 stdin) / `shot` / `inspect` / `act` / `--session`.
  没验: 新的 acdert (runtime 那边的 op 还没合进来) 下真的 `webs` / `eval` / `shot` / `inspect` / `act`; Windows (命名管道、`.exe`).

## 开发工具 (`acde webs` / `eval` / `shot` / `inspect` / `act`, `src/tools.ts`)

给 agent (和开发者) 看、操作 `acde dev` 里跑着的页面, 不开端口, 经 `acde dev` 的 IPC (见上) 交给 acdert. 先挑会话: `--session <pid>` 指定;
否则会话目录里工程目录包含当前目录的那个 (几个都包含时取目录最深的; 还分不出就报错); 都不包含时只有一个会话就用它;
否则报错并列出所有会话 (pid、桌面或应用、目录、开始时间). 列会话时 pid 已经死了的文件 (`kill(pid, 0)`) 删掉; 连不上 socket
(`ECONNREFUSED` / `ENOENT`: pid 被别的进程重用了) 时删掉那个文件, 报「acde dev <pid> is gone」.

| 命令 | 请求 | 打出 |
| --- | --- | --- |
| `acde webs` | `webs` | 表格: NAME (`vault#1048576`, 桌面是 `desktop`)、KIND、APP、WINDOW、TITLE |
| `acde eval <web> <代码\|->` | `eval {web, code}` | 值的 JSON (缩进两格; `undefined` 是 `null`). `web` 是 web 名、应用 id (它的第一个 web) 或 `desktop`; `-` 从 stdin 读代码 (以 `--` 开头的代码放在 `--` 后面) |
| `acde shot <web> [-o 文件]` | `shot {web}` | 把 PNG (设备像素) 写进文件 (默认当前目录的 `<web>.png`, 名字里 `/\:*?"<>\|` 和空白换成 `-`), 打出绝对路径 |
| `acde inspect [--window W] [--find 文字] [--all]` | `snapshot {window?, find?, all?}` | `snapshot().text` (acdert「看和操作桌面」) |
| `acde act <ref> <动作> [参数]` | `act {ref, action, arg?}` | `act().text`; `ok` 是 false 时退出码 1 |

出错 (acdert 回 `ok:false`、超时、旧 acdert、没有会话) 打 `acde: <原因>`, 退出码 1. 客户端 (`DevClient`) 自己也等 35 s 兜底 (acde dev 没回答时).

## 要做

1. 原地重新加载 (不关窗口, 只重起 isolate), 前端框架用它自己的 `build --watch` 而不是每次整个构建.
2. `acde.config.jsonc` 加 `compatibility_date` (运行时行为的版本), environments、vars / secrets、服务名 ↔ capability 的显式 binding.
3. `acde types` (按 capabilities 生成只含允许的 `acde:` 模块的 d.ts)、`acde test` (bun test 跑在 acdert 的 isolate 里, `acdert run`)、
   `acde deploy --to <主机>` (经 ssh 装到一台 Dopame OS 上), 包格式 + 签名 + 仓库之后 `acde publish`.
4. 分发: 第一次发版 (见「分发」; 先在 npm 上建 `@dopame` 组织、占 `acde` / `create-acde`), Windows 移植之后 win32 的 acdert 才有.

## 协作规则

- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By. 做完就提交并推送.
- 汇报时分开写「已验证 / 未验证」.
