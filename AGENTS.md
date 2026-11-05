# acde

acde 的开发者 CLI. 和 [acdert](https://github.com/dopame-org/acdert) 的关系像 wrangler 和 workerd: acdert 是运行时 (一个二进制,
跑桌面和应用, Dopame OS 的会话就是它), acde 建工程、构建、装包, `acde dev` 拉起 acdert. 运行时的一切 (清单、`acde:` 模块、后端怎么跑、
窗口模型) 以 acdert 的 AGENTS.md 为准, 这里只写工具.

说明都在本文件里 (没有 README). full agentic. TypeScript, 跑在 bun 上 (没有 Node), 测试 `bun test`, 类型检查 `bun run typecheck`.
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
| `acde dev [目录] [--app ID]` | 构建, 起 `acdert desktop <id>` (桌面工程) 或 `acdert app <id>` (应用), 构建结果经 `ACDE_PATH` 给它 (不装); 盯着工程目录, 改了就重新构建、发 `reload`; acdert 是 `ACDERT` 或 PATH 上的 `acdert` |

## 新建工程 (`acde new`, `bun create acde`)

一行命令: `bun create acde` (或 `npm create acde`、`pnpm create acde`; 都解析到 `create-acde` 包) 或 `acde new`. 在终端里
(stdin 和 stdout 都是 TTY, 没给 `--yes`) 像 `npm create vite` 一样逐项问 (@clack/prompts, `src/create.ts` 的 `Creator.ask`),
命令行已给的不再问: 目录 (默认 `my-app`; 非空的、算不出 id 的当场提示; id 是目录名小写、非 `[a-z0-9-]` 换成 `-`)、做什么
(窗口应用 / 桌面)、模板 (应用才问)、显示名 (默认 id)、要不要后端 (只有 html 问)、`bun install`、`git init` (不在 git 仓库里、
有 git 才问; 再 `git add` + 首次提交, 没配 user.name / email 时提交跳过). Ctrl+C 退出码 130. 不在终端里时什么都不问: 目录必填,
模板默认 html, 不装依赖、不建仓库 (要就给 `--install` / `--git`). 做完打出下一步 (`cd`、`bun install`、`acde dev`).

| 模板 | 怎么来 |
| --- | --- |
| `html` | 自带 `templates/app` (加 `--backend` 再叠 `templates/backend`: `server.ts` 和取 `/api/hello` 的页面) |
| `react` / `vue` / `svelte` / `solid` / `preact` / `vanilla` | `create-vite@latest --template <名>-ts --no-interactive --no-immediate` |
| `next` | `create-next-app@latest --yes --ts --app --use-bun --skip-install --disable-git --no-agent-feedback` |
| `nuxt` | `create-nuxt@latest --template minimal --no-install --no-gitInit --packageManager bun` |
| `sveltekit` | `sv@latest create --template minimal --types ts --no-add-ons --no-install` |
| `astro` | `create-astro@latest --template minimal --no-install --no-git --no-ai --yes --skip-houston` |
| `desktop` | 自带 `templates/desktop` |

框架模板照 `npm create cloudflare` 的做法: 用框架自己的脚手架 (`bun x --bun <包>@latest`, 总是最新版; 不交互, stdin 关掉、
带 `CI=1`, 输出收着, 失败时整段打出来), 然后 `AppPackage.adopt` 叠上 acde 的部分: `templates/framework/acde.config.jsonc`
(没有 `entry`: 构建认框架)、devDependency `@dopame/acde-api`、`.gitignore` 加 `.acde/`; 不动框架自己的文件和脚本.
加模板就是 `STARTERS` 加一项 (`scaffold` 返回命令行; 没有 `scaffold` 的是 `templates/<kind>`).

`create-acde` (`packages/create-acde/index.mjs`): Node 和 Bun 都能跑的几行 JS, 找到 Bun (没有就说去 https://bun.sh 装, 退出 1)
和依赖的 `acde` 包 (找不到用同仓库的 `src/cli.ts`), `bun cli.ts new <参数>`. 还没上 npm: `acde` 包现在是 `private`, 依赖的
`@dopame/acde-api` 也没上 npm, 要一起发 (见「要做」).

验过 (macOS, 2026-11-05): 在 Ghostty 里跑 `acde new`, 用 AppleScript 按键 (`send key` / `input text`) 并读屏
(`perform action "write_screen_file:copy,plain"`: 屏幕写进文件, 路径进剪贴板): React (装依赖 + git)、html + 后端 (不装依赖)、
非空目录的提示、Ctrl+C. 11 个模板 `--yes --install` 全部建好并 `acde build` 通过 (Next / Nuxt / SvelteKit 是后端渲染);
html + 后端的模板在 `acde dev` 里打开, 页面拿到了后端 `/api/hello` 的回答. 没验: 没装 Bun 时 `create-acde` 的提示
(本机的 node 就是 bun), Windows / Linux.

另一种工程是手写的**包** (没有 `acde.config.*`, package.json 的 `acde` 有 `apps`): 不用构建, build 只校验, install 是符号链接.

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
- **框架** (`src/frameworks.ts`, app 的 `framework`, 默认 `auto`): 按 package.json 的依赖认, 用框架自己的构建, 不改用户
  的配置文件; 没有 node_modules 时先 `bun install`; 构建工具一律 `bun --bun` 跑 (机器上没有 Node). 先认先得:
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

## acde dev (`src/dev.ts`)

- IPC: acde 在 `ACDE_DEV` 上听 (unix 上 `$TMPDIR/acde-dev-<pid>.sock`, Windows 上命名管道 `\\.\pipe\acde-dev-<pid>`, 都是
  `node:net` 的 server), acdert 连上来; 协议见 acdert AGENTS.md 的「运行时进程」. acdert 的日志就在 acde 的终端里 (继承 stderr).
- 盯着工程目录 (`fs.watch` recursive), 不看 `.acde`、`node_modules`、`.git` 和各框架的产物目录 (`dist`、`build`、`.next` …);
  150 ms 内的改动合成一次; 构建中又改了, 构建完再来一次. 构建好了给每个应用发 `reload`, 有桌面再给桌面发一个 (Broker 只重开
  开着的应用窗口). 构建失败只打一行, 窗口不动.
- acdert 退出 acde 就退出 (退出码跟它); acde 退出 acdert 也退出 (连接断了).
- 验过 (macOS): 模板应用改 `index.html`, 6 ms 构建完, 窗口在原位换成新页面.

## 要做

1. 原地重新加载 (不关窗口, 只重起 isolate), 前端框架用它自己的 `build --watch` 而不是每次整个构建.
2. `acde.config.jsonc` 加 `compatibility_date` (运行时行为的版本), environments、vars / secrets、服务名 ↔ capability 的显式 binding.
3. `acde types` (按 capabilities 生成只含允许的 `acde:` 模块的 d.ts)、`acde test` (bun test 跑在 acdert 的 isolate 里, `acdert run`)、
   `acde deploy --to <主机>` (经 ssh 装到一台 Dopame OS 上), 包格式 + 签名 + 仓库之后 `acde publish`.
4. 分发: npm 包 `acde`、`create-acde` (已写, 见「新建工程」) 和 `@dopame/acde-api` 发上去, 依赖按平台分的 acdert 二进制包 (`@dopame/acdert-<os>-<arch>`), 或 `bun build --compile` 成单个可执行文件.

## 协作规则

- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By. 做完就提交并推送.
- 汇报时分开写「已验证 / 未验证」.
