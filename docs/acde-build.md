# 构建 (`src/app.ts`, `src/package.ts`, `src/bundler.ts`, `src/frameworks.ts`)

> 路径相对 CLI 包根 `npm/`。

libacde 只认包 (package.json 的 `acde` 字段, `PackageManifest`); `acde.config.jsonc` 只在构建时读, 变成 `.acde/package.json` 的清单.

- **工程** (`AppPackage`): 有 `acde.config.jsonc` / `.json` 的是 `Project` (字段见 SDK 的 `AcdeConfig` / `config.schema.json`; `"type"` 是 `app` 或
  `desktop`; 后端默认按 `BACKENDS` 找 `server.ts` 等, port 3000); 没有配置、package.json 的 `acdev` 有 `apps` 的是手写的**包**; 都没有是默认 app
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
Node 上 `node` 跑. 配置写了 `entry` 时不认 Vite (html / desktop 模板带 vite 是为 acdev 自己打包), 要框架构建就去掉 `entry` 或写 `"framework": "vite"`.

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

调 acdev 自己的 `build` 脚本 (`acdev`、`bunx acdev`、`npx acdev`) 不算, 否则 `acdev build` 调自己. 后端渲染的应用清单 `entry` 是 `/app/<id>/`
(文档从后端取). 都不认 (或 `"framework": "none"`) 时 acdev 自己打:

- `Bundler.for`: bun 上 `BunBundler`, Node 上 `ViteBundler` (`ACDEV_BUNDLER=vite` 在 bun 上也用 Vite). `ViteBundler` 从工程往上找 `node_modules/vite`
  (不打进 acdev, 没有就报 `add it with <pm> add -D vite`), `configFile: false` (规则和 bun 上一样), Vite 8 起 `rolldownOptions`, 之前 `rollupOptions`.
  两边文件名不同, 规则相同:
- HTML 入口: `base` 是 `/app/<id>/` (桌面页 `/desktop/<id>/`), `acde:*` 外部, `NODE_ENV` `"production"`, `import.meta.env` 照 Vite (bun 上 define
  成一样的, 带 `VITE_*`), 不注入 modulepreload, 子目录里的页面出成 `web/<文件名>`. 模块入口的应用: `<名字>.js`, 保留导出. 桌面服务: 单文件, 不压缩标识符.
- 桌面服务里对 `acde:` 的导入 (静态、动态都算; 包括依赖里的) 两边一样拒绝 (`ServiceImports`, 插件 `acde-service`): 构建失败、不留
  `services/<名>.js`, 报 `service <名>: <文件> imports acde:<模块>, …: a service gets shell modules from ctx.import('acde:<name>'), …`
  (文件相对工程, 排好序, 两边逐字相同). 依据是 libacde 的运行时: 服务在 Broker isolate 里经 `import(file URL)` 加载, 而 `acde:*` 只经
  `defineModule` 注入每个 web 的 isolate (`acde-host` 的 `worker.ts`), Broker isolate 没有, 静态导入在链接时就报 `is not given to`;
  服务只能经 `ctx.import('acde:<模块>')` 拿外壳模块 (桌面清单 `services` 项的 `modules` 授权). 所以不把 `acde:*` 设为外部.
  **配置里的授权**: 桌面配置的 `services` 每项是模块文件, 或 `{ "module": 文件, "modules": [外壳模块] }` (SDK 的 `ServiceConfig`,
  `config.schema.json` 同). 怎么读只有一处: SDK 的 `Manifest.configServices(config.services)` 给出 `{name, module, modules}[]` 或一句错误
  (`modules` 用清单那条规则 `Manifest.desktopServices` 判, 文字相同; 没有 `module`、多出别的字段也是错误). `Project.check` 把错误报成
  `services in acde.config.jsonc: service "clock": …`, 再查每个模块文件在不在; `Project.build` 经 `Project.services` / `Project.grants`
  把有 `modules` 的写成桌面清单的 `{name, modules}`, 没有的照旧写服务名 (产物不变); `acdev check` 的临时清单 (`#configFindings`) 用同一份.
  服务里静态导入 `acde:*` 的报错末尾指向这个字段: `…, listed in its modules in acde.config.jsonc ("services": { "clock": { "module": "<file>",
  "modules": ["<name>"] } })`. 模板的注释和 skill 写的是同一个字段 (`test/templates.test.ts` 把注释里的例子交给 `Manifest.configServices`, 并对着 schema 的两种写法).
- `public/` (插件 `acde-public`): 复制进工程自己的应用的 `web/` 和桌面页的 `desktop/` (桌面里的应用不复制). 以 `/` 开头、落在 public 里的引用:
  HTML 里的照常打包; CSS 的 `url(/x)` 在工程自己的 HTML 入口应用里原样留着 (运行时应用目录也挂在 `/` 下), 别处照打包处理; 哪儿都没有时构建失败,
  说清哪个文件的哪个 URL、public 里缺什么 (`PublicError`).
- HTML 入口里内联 `<style>` 和 `style` 属性的 `url()` (acde#62): Vite 自己当 CSS 处理; Bun 不管它们, 构建后 `InlineStyles` (`src/inline-styles.ts`)
  改写产出的 HTML: 相对 URL 按入口所在目录找文件, 复制成 `<名字>-<hash8>.<ext>` 放进产物根目录, URL 换成 `<base><文件名>` (保留 `?`/`#` 后缀);
  `/x`、`#x`、带协议的 (`data:`、`https:` 等) 原样留着; 找不到文件时构建失败 (`<url> in an inline style in <入口>: there is no <路径>`).
  `style` 属性先解码字符引用 (数字的和 `&amp;` `&quot;` `&apos;` `&lt;` `&gt;`, acde#72) 再找 `url()`, 改了才编码回去 (`&` 和包住属性的那种引号),
  没改的属性原样留着; `<style>` 里是原始文本, 不解码.
- Bun 1.4 的毛病: 同一资源同时被 HTML 和 CSS 引用时 HTML 里的引用原样留下、文件不出; fixture 因此两边引用不同的文件.

**后端** (`Bundler.backend`): `backend/server.js` 是 ES 模块, target node (Vite 上 SSR `noExternal: true`), npm 包打进去, Node 内置模块和
`bun` / `bun:*` 留作 import. 入口是生成的一层 (`Bundler.wrapper`): `await import(用户入口)`, `export default` 它的默认导出, 默认导出有 `fetch` 且
有 `Symbol.for('acde.serve')` 时交给它. 旁边写 `{"type": "module"}` 的 `package.json` (免得 Node 打 `MODULE_TYPELESS_PACKAGE_JSON`) 和 preload
`acde-listen.js`. 框架的后端也在入口旁边放 preload.

**preload** (`src/listen.ts`):
- 没有 `import` / `export` (内置模块经 `process.getBuiltinModule`), 既是 CJS 也是 ESM: `"type": "commonjs"` 的包里 (Next standalone) 也能 `--import`.
- `Bun.serve` / `Bun.listen` / `net`、`http`、`https`、`tls`、`http2` 的 `listen(P)` 换成 `<sockets>/P.sock` (`src/sockets.ts`: `ACDE_APP_SOCKETS`, 或
  `$XDG_RUNTIME_DIR/acde/apps/<ACDE_APP_ID>`; P 没给时 `BUN_PORT` / `PORT` / `NODE_PORT` / 3000); 指定端口的 UDP bind、在现成 fd 上 listen 抛 `EACCES`.
- Windows 上的套接字模式 (bun 总是它, 见 `contract-with-libacde.md` 的「Windows 后端契约」): 同样换成 `<ACDE_APP_SOCKETS>\P.sock`, `Bun.serve` 照原样 bind (AF_UNIX),
  `ACDE_APP_CHANNEL` 不看. 目录由运行时建好并设 ACL, 预加载只在缺目录时 `mkdir`, Windows 上不 `chmod`. 路径超过 107 字节 (AF_UNIX 的
  `sun_path` 上限) 时抛 `ENAMETOOLONG` 说清楚; Windows 上没有 `ACDE_APP_SOCKETS` 时要 `XDG_RUNTIME_DIR`, 不猜 `/run/user`.
  有 `ACDE_APP_CONTROL=fd` (且不是通道模式, `controlMode`) 时, 第一个换到套接字上的 server 起来后读 fd 3 的控制帧 (同一套
  `Decoder`; bun 上 `Bun.file(3).stream()`: bun 在 Windows 上 `net.Socket({fd: 3})` 读不到数据; Node 上 `net.Socket`), 只认流号 0 的
  SHUTDOWN, 别的帧忽略. 收到后对登记的每个 server 优雅停止 (`Bun.serve` / `Bun.listen` 的 `stop()` 等在途请求做完, `node:net` 系的
  `close()`), 都结束后 `exit(0)`. 应用自己停掉最后一个 server 时取消读取 (bun 上读着 fd 3 会让进程不退出), 再有 server 时重开.
  fd 3 打不开或读出错时 stderr 打一行, 之后不再读, 服务照常; 读到头不退出. unix 不变 (没有 `ACDE_APP_CONTROL`).
- Node 上 `export default {fetch}`: `acde.serve` 用 `node:http` 起服务, 请求换成 WHATWG `Request` (流式 body, 断开时 abort), `server` 只有
  `upgrade()` (false, 没有 WebSocket 升级)、`requestIP()` (null)、`port`、`hostname`; `Response` 流式写回; 抛错回 500.
- 开发时: `bun --preload <acdev>/src/listen.ts server.ts`.
- **通道模式** (`src/channel.ts`, Windows 上的 Node; 帧和信用见 `contract-with-libacde.md` 的「Windows 后端契约」): 只在 Node 上且 `ACDE_APP_CHANNEL=fd` 时
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
