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
| `acde new <目录> [--desktop] [--id ID] [--label 名字]` | 从 `templates/app` (普通网页 + `acde.config.jsonc`) 或 `templates/desktop` (一张桌面页) 建工程; devDependency `@dopame/acde-api` 指向 acde 装好的那份 (`file:<路径>`, `ACDE_API` 可以换成别的说明符) |
| `acde check [目录]` | 按 acdert 读清单的方式查 (`@dopame/acde-api/manifest` 的 `Manifest.check`) |
| `acde build [目录] [--out .acde]` | 构建成 acdert 认的包 (见下) |
| `acde install [目录]` | build 之后装进 `$XDG_DATA_HOME/acde/packages/<id>` (手写的包: 指向工程目录的符号链接) |
| `acde dev [目录] [--app ID]` | install 之后起 `acdert desktop <id>` (桌面工程) 或 `acdert app <id>` (应用); acdert 是 `ACDERT` 或 PATH 上的 `acdert` |

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

## 要做

1. `acde dev` 第一版 (现在): install 再起 acdert, 改了代码要重起.
2. P1 (Linux): acdert 有了宿主窗口后端和控制管道之后, `acde dev` 用框架自己的 `build --watch` 构建到 `.acde/`, acdert 按目录加载
   (不经 install); 构建完发 `reload <app>` (整页重载, 不做 HMR: 页面不能联网, dev server 的 WebSocket 连不上), 后端改了重起后端;
   acdert 回传的日志按应用打印 (`tail`). 验收: KDE 和 Dopame OS 上 `acde new` → `acde dev` → 改代码 → 1 秒内重载.
3. `acde.config.jsonc` 加 `compatibility_date` (运行时行为的版本), environments、vars / secrets、服务名 ↔ capability 的显式 binding.
4. `acde types` (按 capabilities 生成只含允许的 `acde:` 模块的 d.ts)、`acde test` (bun test 跑在 acdert 的 isolate 里, `acdert run`)、
   `acde deploy --to <主机>` (经 ssh 装到一台 Dopame OS 上), 包格式 + 签名 + 仓库之后 `acde publish`.
5. 分发: npm 包 `acde` + `npm create acde`, 依赖按平台分的 acdert 二进制包 (`@dopame/acdert-<os>-<arch>`), 或 `bun build --compile` 成单个可执行文件.

## 协作规则

- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By. 做完就提交并推送.
- 汇报时分开写「已验证 / 未验证」.
