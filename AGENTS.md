# acde

acde 的开发者 CLI. 和 [acdert](https://github.com/dopame-org/acdert) 的关系像 wrangler 和 workerd: acdert 是运行时 (一个二进制,
跑桌面和应用, Dopame OS 的会话就是它), acde 建工程、构建、装包, `acde dev` 拉起 acdert. 运行时的一切 (清单、`acde:` 模块、后端怎么跑、
窗口模型) 以 acdert 的 AGENTS.md 为准, 这里只写工具.

说明都在本文件里 (没有 README). full agentic. TypeScript, 跑在开发者已有的 bun 或 Node.js (≥ 22) 上 (见「分发」), 测试 `bun test`, 类型检查 `bun run typecheck`.
代码不写注释 (`//`, `/* */`, JSDoc 都不写), 要说明的写进本文件; 工具要读的指令 (`/// <reference>`、`@ts-expect-error`) 除外.

## 形态

开发者在任意系统上 (macOS / Windows / Linux, 包括 Dopame OS) 用 acde 建工程, `acde dev` 拉起 acdert 开一个**原生窗口**, 窗口里是
完整的桌面 (默认 Dopame, 工程自己是桌面时用它自己的), 开发者的应用从工程目录加载进去. 不是 WebUI, 不推流, 不开端口, 没有 devtools
(acdert 的第一原则). 宿主窗口和合成见 acdert AGENTS.md 的「运行时进程」.

| 命令 | 做什么 |
| --- | --- |
| `acde new [目录] [--template T] [--id ID] [--label 名字] [--backend] [--install] [--git] [--pm PM] [--yes]` | 新建工程 (PM: bun / npm / pnpm / yarn), 见下面「新建工程」 |
| `acde check [目录]` | 按 acdert 读清单的方式查 (`@dopame/acde-api/manifest` 的 `Manifest.check`) |
| `acde build [目录] [--out .acde]` | 构建成 acdert 认的包 (见下) |
| `acde install [目录]` | build 之后装进 `$XDG_DATA_HOME/acde/packages/<id>` (手写的包: 指向工程目录的符号链接) |
| `acde dev [目录...] [--out DIR] [--app ID] [--desktop ID\|目录] [--headless]` | 构建, 起 acdert (`--headless`: 不开宿主窗口) (一个工程: `acdert desktop <id>` (桌面工程) 或 `acdert app <id>`; 几个工程或给了 `--desktop`: 都放进一个桌面), 构建结果经 `ACDE_PATH` 给它 (不装); 盯着工程目录, 哪个改了就只重新构建它、发 `reload`; acdert 从哪儿来见「分发」. 见下面「acde dev」 |
| `acde webs` / `eval <web> <代码\|->` / `shot <web> [-o 文件]` / `inspect [--window W] [--find 文字] [--all] [--offscreen]` / `act <ref> <动作> [参数]` / `console` / `network` / `screen [-o 文件]` (都可加 `--session <pid>`) | 看和操作一个正在跑的 `acde dev` 里的页面 (给 agent 和开发者用), 见下面「开发工具」 |
| `acde mcp [--session <pid>]` | stdio 上的 MCP 服务, 同一套工具加上自己起 `acde dev` (`start` / `stop` / `logs`), 给 agent 用 (`claude mcp add acde -- acde mcp`), 见下面「MCP」 |
| `acde test [目录\|文件...] [--headed] [-t 名字] [--desktop ID\|目录] [--timeout MS] [--bail]` | 跑 e2e 测试 (`*.e2e.ts`, 从 `acde/test` 导入): 每个测试一个新的、隔离的 `acde dev` (默认 headless), 失败的留下截图、语义树、console、网络和输出, 见下面「e2e 测试」 |
| `import { Acde, expect } from 'acde/driver'` | 测试和脚本用的 driver: 起或连上 `acde dev`, 按角色 / 文字找控件、自动等待、断言, 见下面「driver」 |

## 新建工程 (`acde new`)

装好 acde (见「分发」) 之后 `acde new [目录]`, 开发用开发者自己的包管理器跑工程的脚本:

| 包管理器 | 开发 | 构建 |
| --- | --- | --- |
| bun | `bun run dev` | `bun run build` |
| npm | `npm run dev` | `npm run build` |
| pnpm | `pnpm dev` | `pnpm build` |
| yarn | `yarn dev` | `yarn build` |

(框架模板的脚本叫 `acde:dev` / `acde:build` / `acde:check`, 见下.) 没有 `npm create acde` / `create-acde` 了: acde 不上 npm, 入口只有全局装的
`acde`. 在终端里 (stdin 和 stdout 都是 TTY, 没给 `--yes`) 像 `npm create vite` 一样逐项问 (@clack/prompts, `src/create.ts` 的 `Creator.ask`),
命令行已给的不再问: 目录 (默认 `my-app`; 非空的、算不出 id 的当场提示; id 是目录名小写、非 `[a-z0-9-]` 换成 `-`)、做什么 (窗口应用 /
桌面)、模板 (应用才问)、显示名 (默认 id)、要不要后端 (只有 html 问)、装不装依赖、`git init` (不在 git 仓库里、有 git 才问; 再
`git add` + 首次提交, 没配 user.name / email 时提交跳过). Ctrl+C 退出码 0. 不在终端里时什么都不问: 目录必填, 模板默认 html, 不装依赖、
不建仓库 (要就给 `--install` / `--git`). 做完打出下一步 (`cd`、装依赖、开发脚本). 子进程一律经 `node:child_process` 起 (Node 上也能跑).

**包管理器** (`src/pm.ts` `PackageManager`): 只认 bun、npm、pnpm、yarn (Deno 不支持). 新工程用哪个: `--pm` 指定; 否则
`npm_config_user_agent` (从包管理器的脚本里跑 `acde new` 时有, bun / npm / pnpm / yarn 开头); 否则 acde 跑在哪个运行时上: bun → bun,
Node → npm (`bin/acde` 有 bun 就用 bun, 所以机器上有 bun 时默认是 bun; launcher 从 Node 起 bun 跑检出的 `cli.ts` 时用
`ACDE_HOST_RUNTIME=node` 把原来的运行时传下去). 装依赖、脚手架、打出的下一步都按它; yarn 的工程另写 `.yarnrc.yml` 的
`nodeLinker: node-modules` (PnP 下 bun 找不到依赖, 框架的构建也不认). 已有的工程 (`acde build` 发现没有 node_modules 时) 按 lockfile 认
(`bun.lock`、`pnpm-lock.yaml`、`yarn.lock`、`package-lock.json`), 再看 package.json 的 `packageManager`. 框架的命令 (`next`、`astro` …)
不经 `node_modules/.bin` (pnpm 那里是 shell 脚本), `PackageManager.bin` 往上找 `node_modules/<依赖>/package.json` 的 `bin` 拿到 JS 文件.
`PackageManager.which` 按 PATH 找程序 (不用 `Bun.which`).

**新工程的 package.json** (`AppPackage.wire` / `wiring`): 自带模板的 `scripts` 是 `dev` / `build` / `check` (`acde dev` …); 框架模板不动
框架自己的脚本, 加 `acde:dev` / `acde:build` / `acde:check`. 脚本里的 `acde` 是 PATH 上的那个 (像 cargo 子命令, 不是工程的依赖; 工程里没有
`acde` 依赖). devDependencies 只有 `@dopame/acde-api` (`ACDE_API` 照旧能整个换掉), 用 npm / pnpm / yarn 时自带的 html 和桌面模板另加
`vite` (`AppPackage.VITE`, 只写大版本 `^8`): Node 上 acde 用工程自己的 Vite 构建它们 (bun 上用 Bun.build, 不加). `build` 脚本调的是
acde (`acde`、`bunx acde`、`npx acde`、`…/acde.mjs`) 时不算「有 build 脚本的工程」(否则 `acde build` 调自己).

- 全局装的 acde (`launcher.mjs` 的 `installed()`: 自己在 `lib/acde`, 旁边有 `lib/acde-api`): `@dopame/acde-api` 是
  `file:<$ACDE_INSTALL>/current/lib/acde-api`, 绝对路径 (acde-api 没上 npm, 没有版本号可写; 走 `current` 而不是某个版本的目录, 升级 acde
  以后重新装依赖就是新的). npm 给它建符号链接, bun 和 pnpm 是拷一份. 挪了 `$ACDE_INSTALL` 或换了机器要改这一行. 上了 npm 以后改成版本号.
- 从 git 检出跑的 acde: `@dopame/acde-api` 是 `file:<相对路径>` (两边先 realpath, macOS 的 `/tmp` 是 `/private/tmp`), 指向 acde 自己的
  package.json 里 `file:` 指的 acdert 检出 `web/packages/acde-api` (不是 node_modules 里那份拷贝). 脚本照样调 PATH 上的 `acde`: 开发 acde
  的人把检出放上 PATH (在检出里 `bun link` 或 `npm link`, 都按 package.json 的 `bin` 接上 `bin/acde.mjs`; 或者自己建个指向它的链接).
  以前按包管理器往工程里写 `acde` 依赖 (`link:` / `file:` / `portal:` 外加 `bun link`、yarn 的 `resolutions`) 的那套删了.
- e2e 测试 `import … from 'acde/test'` 在工程里没有 `acde` 依赖时解析不到, 要 `acde test` 替它解析 (见「要做」).

验过 (macOS arm64, 2026-11-08, `bun test`): 检出的 acde `new --pm bun` 后 PATH 上只有 bun 和指向 `bin/acde.mjs` 的 `acde`, `bun install &&
bun run build` 出包; pnpm 12 (node 是 bun) 同样装依赖、`pnpm run build` (这时 html 模板有 vite, acde 用 Vite 构建); 四种包管理器 × 两种
自带模板的 vite 有无; `npm_config_user_agent` / 运行时选包管理器, `--pm deno` 报错. 全局装的见「分发」的验过.
测试里给包管理器搭 PATH 要用符号链接, 不能用 `exec` 的 sh 脚本: node 是 bun 的链接时, 包了一层的 `node` 让 pnpm 12 不装 rolldown 的平台
原生包 (`@rolldown/binding-darwin-arm64`), vite 8 报「Cannot find native binding」.

| 模板 | 怎么来 |
| --- | --- |
| `html` | 自带 `templates/app` (加 `--backend` 再叠 `templates/backend`: `server.ts` 和取 `/api/hello` 的页面) |
| `react` / `vue` / `svelte` / `solid` / `preact` / `vanilla` | `create-vite@latest --template <名>-ts --no-interactive --no-immediate` |
| `next` | `create-next-app@latest --yes --ts --app --use-<pm> --skip-install --disable-git --no-agent-feedback` |
| `nuxt` | `create-nuxt@latest --template minimal --no-install --no-gitInit --packageManager <pm>` |
| `sveltekit` | `sv@latest create --template minimal --types ts --no-add-ons --no-install` |
| `astro` | `create-astro@latest --template minimal --no-install --no-git --no-ai --yes --skip-houston` |
| `desktop` | 自带 `templates/desktop` |

框架模板照 `npm create cloudflare` 的做法: 用框架自己的脚手架, 经工程的包管理器跑 (`PackageManager.exec`: bun 是 `bun x --bun <包>@latest`,
npm 是 `npx --yes`, pnpm / yarn 是 `dlx`; 总是最新版; 不交互, stdin 关掉、只给这一步带 `CI=1` (yarn 见到 `CI` 不许新建 lockfile, 装依赖那步
不能带), 输出收着, 失败时整段打出来), 然后 `AppPackage.adopt` 叠上 acde 的部分: `templates/framework/acde.config.jsonc` (没有 `entry`:
构建认框架)、上面的 package.json、`.gitignore` 加 `.acde/`; 不动框架自己的文件. 加模板就是 `STARTERS` 加一项 (`scaffold(dir, pm)` 返回
命令行; 没有 `scaffold` 的是 `templates/<kind>`).

验过 (macOS, 2026-11-05, 那时脚手架都经 `bun x --bun`): 在 Ghostty 里跑 `acde new`, 用 AppleScript 按键 (`send key` / `input text`) 并读屏
(`perform action "write_screen_file:copy,plain"`: 屏幕写进文件, 路径进剪贴板): React (装依赖 + git)、html + 后端、非空目录的提示、Ctrl+C.
11 个模板 `--yes --install` 全部建好并 `acde build` 通过 (Next / Nuxt / SvelteKit 是后端渲染). 没验: npm / pnpm / yarn 的 `exec` / `dlx`
跑框架脚手架 (yarn 的 `dlx` 带着 `CI=1` 可能不让建 lockfile).

另一种工程是手写的**包** (没有 `acde.config.*`, package.json 的 `acde` 有 `apps`): 不用构建, build 只校验, install 是符号链接.

## 分发 (`install.sh`)

只做一件事: 全局装 acde 和 acdert, 不经 npm, 不要 root. acdert 只管运行时; 构建用开发者机器上已有的 bun 或 Node.js (≥ 22) 和他们的包管理器,
acde 不带也不下载 bun.

```sh
curl -fsSL http://localhost:8787/install.sh | sh
curl -fsSL http://localhost:8787/install.sh | sh -s -- --version 0.0.3 --no-modify-path
sh install.sh [--version X.Y.Z] [--no-modify-path]
```

下载的地方是 `ACDE_DIST` (默认 `http://localhost:8787`: 还没有域名、R2 和 GitHub 下载, 现在只在本机托管着测; 默认值是 `install.sh`
开头的一个变量, 换成正式域名改那一行). 托管的目录 (`scripts/dist.ts` 的 `--out` 就是它, 原样放上去):

```
install.sh
latest                                  最新的版本号, 一行
<版本>/SHA256SUMS                       每行 `<sha256>  <文件名>`
<版本>/acde-<版本>-<triple>.tar.gz      triple: aarch64 / x86_64 的 -apple-darwin、-unknown-linux-gnu、-unknown-linux-musl
```

tarball 里是一个目录 `acde-<版本>-<triple>/`, 就是一个版本的安装根:

```
bin/acde            POSIX sh: 有 bun 就 `bun lib/acde/src/cli.js`, 否则 node (先查大版本 ≥ 22, 不够就报错), 都没有就报错叫装 Bun 或 Node.js
bin/acdert          运行时
bin/app/dist/       acde-host 的 bundle (broker.js、web.js; acdert 在自己旁边的 app/dist 找, acdert `web.rs` 的 app_dir)
lib/acde/           package.json (name acde、exports)、launcher.mjs、src/cli.js、src/listen.ts、src/sockets.ts、templates/,
                    和 driver / e2e 的源码 (src/driver/、src/e2e/、src/ipc.ts、src/sessions.ts、src/configs.ts, 只在 bun 上跑)
lib/acde-api/       acdert 仓库的 web/packages/acde-api 原样 (不带 test/)
```

`src/cli.js` 是 `src/cli.ts` 连同 @clack/prompts、MCP SDK、acde-api 打成的一个文件 (Bun.build, target node; `acde/launcher` 留作外部模块:
打进去的话 `import.meta.url` 就成了 cli.js 的; 运行时 bun 和 Node 都按 lib/acde/package.json 的 `exports` 自引用). 打完去掉开头的
`#!/usr/bin/env bun` 和 Bun.build 因它加上的 `// @bun`: 带 `// @bun` 的文件 bun 不再转译, 按 latin1 读, 里面的中文 (`acde dev` 的提示)
出来是乱码.

**install.sh** (仓库根目录, POSIX sh; sh、dash、`bash --posix` 都跑): `uname` 定 triple (macOS 上 Rosetta 里的 x86_64 shell 按
`sysctl.proc_translated` 换成 aarch64; Linux 有 `/lib/ld-musl-*` 是 musl), 别的系统 / CPU 直接报错; 没给 `--version` 取 `latest`; curl (没有就 wget)
下 `SHA256SUMS` 和 tarball, 用 shasum / sha256sum / openssl 校验 (这个版本没有这个 triple、下不下来、校验不过都报错退出, 什么都不动);
解进 `$ACDE_INSTALL` (默认 `~/.acde`) 下的临时目录再改名成 `versions/<版本>` (已有的同版本先挪开, 最后删掉); `current` → `versions/<版本>`
先建新链接再 `mv -T` (GNU) / `mv -h` (macOS) 原子地换上, 都不行退回 `ln -sfn`; `bin` → `current/bin` (相对链接, 安装目录能整个挪). PATH 上
没有 `$ACDE_INSTALL/bin`、也没给 `--no-modify-path` 时, 按 `$SHELL` 往一个启动文件里加一次 (已有同一行就不加): zsh 是 `${ZDOTDIR:-$HOME}/.zshrc`,
bash 是 `~/.bashrc` (macOS 再加 `~/.bash_profile`), fish 是 `~/.config/fish/conf.d/acde.fish` (`fish_add_path -g`), 别的是 `~/.profile`;
写的是 `# acde` 加 `export PATH="$HOME/.acde/bin:$PATH"` (在 `$HOME` 下时写成 `$HOME/…`). 最后打出装了什么、要不要开新终端、机器上有没有
bun / Node 22+, 和下一步 `acde new my-app`. 旧版本留在 `versions/` 里 (要删手动删).

**launcher** (`launcher.mjs`, 只用 `node:` 模块; 类型是手写的 `launcher.d.mts`): 源码一律按包名自引用 `import … from 'acde/launcher'`.
- `bin/acde.mjs` (检出里 `bun link` / `npm link` 接上的 `acde`) → `run(args)`: Node 低于 22 报错; 用 `cliRuntime()` 跑 `cliFile()`
  (有 `src/cli.js` 用它, 否则 `src/cli.ts`; bun 上就是这份 bun, Node 上跑 cli.js 用这份 node, 只有 cli.ts 时用 PATH 上的 bun, 没有就 node),
  环境是 `cliEnv(exe)` (PATH 前加运行时所在目录、`ACDE_HOST_RUNTIME`) 加上找到的 `ACDERT`; SIGINT 父进程只吞掉, SIGTERM / SIGHUP 转给子进程,
  退出码跟它. 全局装的不经它: `bin/acde` 直接跑 cli.js.
- acdert (`requireAcdert`; `acde dev` 自己 (`src/cli.ts`) 调它): `ACDERT` (设了但文件不在时直接报错, 不往下找; 不带路径分隔符的按 PATH 找);
  否则 (只有检出) 旁边的 acdert 检出 `<acde>/../acdert/target/release/acdert`, 再 `.../debug/acdert` (两个仓库并排检出, acdert 从
  `<exe>/../../web/packages/acde-host/dist` 找 host bundle; 放在 PATH 之前: 检出的 acde 和旁边的 acdert 是一起改的); 否则 (只有全局装的)
  自己这个版本的 `bin/acdert`; 否则 `$ACDE_INSTALL/bin/acdert` (默认 `~/.acde`; 和上一个是同一个文件时不重复列); 否则 PATH 上的 `acdert`.
  都没有就报错, 列出找过的每个地方和怎么办 (`ACDERT=/path/to/acdert acde dev`、在旁边的检出里 `cargo build --release -p acdert`, 全局装的是
  「重新装一次 acde」、放进 PATH). `findAcdert(false)` 是不报错的版本.
- 给 driver 和 `acde test` 的: `cliFile()` / `cliRuntime()` / `cliEnv(exe, env)`, 和 `findBun()` (bun 上是自己, 否则 PATH 上的 bun, 没有就报错;
  只给还要 bun 的地方).

**打包**: `bun scripts/dist.ts --acdert <二进制> --host <acde-host dist> [--api <acde-api 目录>] --triple <rust triple> [--version x.y.z] [--out .dist]`
(`--api` 默认旁边检出的; Windows 的 triple 拒绝: install.sh 是 sh) 出 `<out>/<版本>/acde-<版本>-<triple>.tar.gz`, 往 `<out>/<版本>/SHA256SUMS`
里加 (或换掉同名的) 一行, 写 `<out>/latest`, 再把 `install.sh` 拷进 `<out>`. macOS 上 tar 带 `--no-xattrs --no-mac-metadata` 和
`COPYFILE_DISABLE=1` (不出 `._` 文件). 发版流程 (acdert 仓库的 `.github/workflows/release.yml`, 原来是发 npm) 要改成各平台跑一次 dist.ts、
把 `<out>` 合起来传到托管的地方; 还没改.

Linux 的 acdert 动态链接 libxkbcommon、gbm、libudev、libinput、fontconfig、OpenSSL 3、pipewire (普通桌面都有; libseat 是运行时
dlopen 的, 没有也能起). musl 的 acdert 在 Alpine 上编 (rustup 的 `x86_64-unknown-linux-musl`, `-C target-feature=-crt-static`, 动态链接
Alpine 的库, rusty_v8 有 musl 的预编译库).

验过 (macOS arm64, 2026-11-08, 本机托管): `bun test` 的 `test/dist.test.ts` (假的 acdert 和 host bundle, `Bun.serve` 托管): tarball 的布局、
SHA256SUMS、latest、拒绝 Windows triple; install.sh 装最新、`--version` 换回旧的、PATH 上已有时不改启动文件; `--no-modify-path`、
`ACDE_INSTALL`、bash (macOS 两个文件)、fish; 没有的版本、不认识的参数、校验不过 (不动 `current`); `bin/acde` 有 bun 用 bun、只有 node 24 用 node、
node 20 和都没有时的报错; 装好的 launcher 找到自己旁边的 acdert. 手动: 用真的 acdert (release) 和 host bundle 打 0.0.3、0.0.4,
`python3 -m http.server 8787` 托管, `HOME` 指到临时目录 (`ACDE_INSTALL` 没设), `curl -fsSL http://localhost:8787/install.sh | sh` 装上 0.0.3
(`.zshrc` 加了一行), 再 `| dash` 装 0.0.4 (`current` 换过去, `.zshrc` 没再加), 另一个 HOME 里 `bash --posix install.sh --version 0.0.3
--no-modify-path` (没有启动文件被改); 装好的 `acde` (bun) 打出用法, `acde new my-app --yes --pm bun` 后 `bun install && bun run build` 出包,
`acde dev --headless` 用装好的 acdert 起来 (`acde webs` 列出桌面和 my-app). Node 24 (PATH 里没有 bun): `bin/acde` 选了 node, 用法照打,
`acde new --pm npm --yes` 写出的 package.json 对 (`file:` 到 `current/lib/acde-api`、`vite: ^8`), `npm install` 给 acde-api 建了符号链接;
之后 `acde new` / `acde build` 在 Node 上停在 `Bun is not defined` (`src/app.ts` 还在用 `Bun.JSONC` / `Bun.build`, CLI 搬到 Node 的那部分还没合进来).
没验: Linux (glibc / musl)、macOS x64、wget、真的域名; yarn.

## 和 acdert 的契约

- 包: acdert 只认包 (package.json 的 `acde` 字段, 类型 `@dopame/acde-api` 的 `PackageManifest`); `acde.config.jsonc` 只在这里读.
- 清单校验只有一份: `@dopame/acde-api/manifest` (acdert 仓库 `web/packages/acde-api/src/validate.ts`), Broker 读清单和 `acde check`
  用同一段 (打进 `src/cli.js`). 没上 npm: 检出的 `package.json` 用 `file:../acdert/web/packages/acde-api`, 两个仓库要并排检出 (`~/Repos/acde`、
  `~/Repos/acdert`); 全局装的带一份在 `lib/acde-api`, 新工程指向它 (见「新建工程」).
- acdert 从哪儿来: 见「分发」的 launcher; 全局装的 acdert 和 host bundle 在同一个 `bin/` 里 (acdert 找 `<自己>/app/dist/broker.js`).
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

- `acde dev [目录...] [--out DIR] [--app ID] [--desktop ID|目录] [--headless]` (`DevSession`; 不给目录是 `.`, 同一个目录给两次算一个;
  `--headless` 给 acdert 设 `ACDE_HEADLESS=1`: 不开宿主窗口, 页面、输入、截图都照常, 见 acdert AGENTS.md「宿主窗口」):
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
  `snapshot {...}`、`act {ref, action, arg?}`、`run {steps}`、`open {name}`、`query {...}`、`console {...}`、`network {...}`、`screen {path}`、`emulate {...}`.
- 会话文件 (`src/sessions.ts`): 每个 `acde dev` 在 IPC 起来后写 `<会话目录>/<pid>.json`
  `{"pid","endpoint","dirs":[工程目录 (realpath)],"apps":[应用 id],"desktop":桌面 id|null (调试窗口是 null),"headless":布尔,"started":毫秒}`, 每次重新构建
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

给 agent (和开发者) 看、操作 `acde dev` 里跑着的页面, 不开端口, 经 `acde dev` 的 IPC (见上) 交给 acdert; 都是 driver 的 `Acde.attach` 和它的
底层操作 (见「driver」). 先挑会话: `--session <pid>` 指定;
否则会话目录里工程目录包含当前目录的那个 (几个都包含时取目录最深的; 还分不出就报错); 都不包含时只有一个会话就用它;
否则报错并列出所有会话 (pid、桌面或应用、目录、开始时间). 列会话时 pid 已经死了的文件 (`kill(pid, 0)`) 删掉; 连不上 socket
(`ECONNREFUSED` / `ENOENT`: pid 被别的进程重用了) 时删掉那个文件, 报「acde dev <pid> is gone」.

| 命令 | 请求 | 打出 |
| --- | --- | --- |
| `acde webs` | `webs` | 表格: NAME (`vault#1048576`, 桌面是 `desktop`)、KIND、APP、WINDOW、TITLE |
| `acde eval <web> <代码\|->` | `eval {web, code}` | 值的 JSON (缩进两格; `undefined` 是 `null`). `web` 是 web 名、应用 id (它的第一个 web) 或 `desktop`; `-` 从 stdin 读代码 (以 `--` 开头的代码放在 `--` 后面) |
| `acde shot <web> [-o 文件]` | `shot {web}` | 把 PNG (设备像素) 写进文件 (默认当前目录的 `<web>.png`, 名字里 `/\:*?"<>\|` 和空白换成 `-`), 打出绝对路径 |
| `acde inspect [--window W] [--find 文字] [--all] [--offscreen]` | `snapshot {window?, find?, all?, offscreen?}` | `snapshot().text` (acdert「看和操作桌面」) |
| `acde act <ref> <动作> [参数]` | `act {ref, action, arg?}` | `act().text`; `ok` 是 false 时退出码 1 |
| `acde console [--web W] [--level L] [--follow]` | `console {web?, level?, since?}` | 一行一条 `<seq> <level\|ERROR\|REJECT> <web>  <文字>`; L 是 log / info / warn / error / debug / errors; `--follow` 每 0.5 秒接着读 (带上次的 `next`), 到 Ctrl+C |
| `acde network [--web W] [--failed] [--follow]` | `network {web?, failed?, since?}` | 一行一个请求 `<seq> <方法> <状态\|ERR\|...> <URL>  (<kind> <字节> <ms>; <错误>) <web>` |
| `acde screen [-o 文件]` | `screen {path}` | 整个屏幕 (所有窗口合成) 的 PNG 写进文件 (默认 `./screen.png`), 打出绝对路径 |

出错 (acdert 回 `ok:false`、超时、旧 acdert、没有会话) 打 `acde: <原因>`, 退出码 1. 客户端 (`DevClient`) 自己也等 35 s 兜底 (acde dev 没回答时).

## driver (`acde/driver`, `src/driver/`)

给 e2e 测试、脚本和 `acde mcp` 用的库, 只经 `acde dev` 的 IPC (和开发工具同一条, 作为 `tool` 连上), 不开端口. 只在 bun 上跑.

- **`Acde`** (`acde.ts`): `Acde.attach({session?, cwd?, env?, timeout?})` 按「开发工具」的规则挑会话 (`env` 里的 `XDG_RUNTIME_DIR` /
  `TMPDIR` 决定会话目录); `Acde.launch({dirs?, desktop?, app?, out?, cwd?, env?, headless?, timeout?, startTimeout?})` 自己起 `acde dev` (bun 直接跑
  `cliFile()`, 输出接进 `logs`, 等会话文件出现 (pid 是子进程的) 再等 `ready()`: 窗口表不空、`webs` 里每个页面的窗口都在窗口表里 (acdert 先回答
  `webs`, 窗口过一会儿才进窗口表, 只等 `webs` 的话紧接着的 snapshot 是空的); 子进程先退出时报错并带上它最后的输出; 默认等
  120 s). 底层操作和 op 一一对应: `webs()`、`evaluate(web, code)`、`screenshot(web, {path?})` (`{png: Buffer, width, height, path}`)、
  `snapshot(options)`、`windows()` (`snapshot {tree: false}`)、`act(ref, action, arg?)`、`run(steps)`、`query({selector, window?, ref?, limit?})`、
  `console({web?, since?, limit?, level?})` / `network({web?, since?, limit?, failed?})` (`{entries, next, dropped}`, 条目见 acdert 的 dev IPC)、
  `screen({path?})` (整屏; 不给 path 时写进临时目录读回再删, `path` 是 null)、`emulate({colorScheme?, reducedMotion?})`、`chooseFolder(路径 | null)`
  (相对路径按当前目录; 事先答复下一次选文件夹, null 是取消); `evaluate` 的返回类型是 `NoInfer<T>` (不然 `expect(await w.evaluate(…))` 会按
  `expect` 的第一个重载被推成 `Locator`); `open(name)` 发 `open`, 再等一个新窗口
  (同 app 的优先, 否则有焦点的) 出来, 回它的 `AppWindow`, 失败抛 `ActError`. `close()` 断开; launch 的还 SIGTERM `acde dev` (10 秒后 SIGKILL).
  `timeout` (默认 5000 ms) 是下面所有等待的默认值. `closed` 在 IPC 断了以后为 true.
- **`AppWindow`** (`window.ts`, `acde.window('ledger' | 'w3' | {ref?, id?, app?, title?})`、`acde.desktop`): 每次用到时按条件在窗口表里找
  (找不到就等到超时, 找到好几个报错让人按 ref / id 挑), 所以重新加载换了窗口也跟得上. `getByRole` / `getByText` / `locator(css)` / `getByTestId(id)`、
  `snapshot()`、`evaluate`、`screenshot`、`console()` / `network()` (只要这个窗口的页面)、`press(keys)`、`focus` / `minimize` / `restore`、
  `close()` (等它真的没了)、`waitFor({state: 'open' | 'closed'})`.
- **`Locator`** (`locator.ts`): 一串查询, 每次都在窗口最新的语义树 (`snapshot {window, limit: 3000, offscreen: true}` 的 `trees`: 滚到可见范围外的
  也在, 动作时 acdert 先 `scrollIntoView`) 上重新求, 不缓存 ref. 求值是异步的 (`Locator.match(source, queries)`, `Source` 是语义树加两个回调:
  `children(node)` 取一个元素下面的子树, `query(selector, within)` 问 acdert 的 `query`), 测试里换成假的 `Source`.
  `getByRole(role, {name?, exact?, checked?, disabled?, selected?, expanded?, pressed?, focused?, level?})`: 角色相等; 名字默认是忽略大小写的
  子串 (空白合并), `exact` 时全等, 也可以是 RegExp. `getByText(text, {exact?})`: 名字含这段文字的元素里最里面的那些 (祖先和它都含时只要它).
  `locator(css)`: 第一步在整个窗口、之后在前一步每个结果下面问 acdert 的 `query`, 只要 `visible` 的; `getByTestId(id)` 是
  `locator('[data-testid="id"]')`. CSS 找到的元素不一定在语义树里 (没有角色的 div), 在它下面再按角色 / 文字找时用 `snapshot {ref}` 取它的子树.
  链起来的查询在前一步结果的后代里找; `filter({hasText?, hasNotText?})` 看元素自己和后代的名字 / 值; `nth(i)` (负数从后数) / `first()` /
  `last()`. 结果按文档顺序、不重复. 元素的「文字」(`text()`、`toHaveText`、`toContainText`) 是它的名字, 没有名字的容器 (`status`、`timer`、
  `generic` …) 是下面各元素的名字连起来 (有名字的元素不再往下拆). 动作 (`click({button?, clickCount?})`、`dblclick`、`hover`、`fill` (settext)、`type`、`press`、`focus`、
  `scroll(dy)`) 先等**恰好一个**元素匹配 (多个时报错并列出前 10 个: 严格, 不猜), click / fill / type 还等它没有 `disabled`, 再 `act`;
  `act` 回 `ok: false` (被挡住、没有可点的点) 时重试到超时, 最后抛 `ActError` (带 acdert 的原话). 读: `count()`、`isVisible()`、`all()`、
  `node()`、`ref()`、`name()`、`value()`、`states()`、`waitFor({state: 'visible' | 'hidden'})`.
- **`expect`** (`expect.ts`): `expect(locator)` 的 `toBeVisible` / `toBeHidden` / `toHaveCount` / `toHaveText` (字符串是全等,
  RegExp 照它) / `toContainText` / `toHaveValue` / `toHaveState(s)` / `toBeChecked` / `toBeDisabled` / `toBeEnabled` / `toBeFocused`,
  `expect(window)` 的 `toBeOpen` / `toHaveTitle`; 都有 `.not`, 都重试到超时 (`{timeout}`), 失败抛 `AssertionError`
  「expected <locator> to <什么> within N ms; saw <最后看到的>」. 要一个元素的断言在零个或好几个时既不算过也不算不过, 一直等.
- **`Logs`** (`logs.ts`): launch 的 `acde dev` (和它起的 acdert, stdio 接在它上面) 的 stdout / stderr, 一行一条, 编号递增, 留最后 5000 行.
  `tail(n, {grep?})`、`since(seq, {grep?, limit?})` (回 `next` 和 `dropped`). 页面的 `console.*` 和页面错误就在这里 (acdert 的日志行).
- 限制 (在 acdert 那边): 透明 (`opacity: 0`) 的元素算不可见 (比如悬停才显示的按钮, 先 `hover` 它的行); `getByText` 找的是语义树里的名字,
  不是 DOM 文字: 有 `aria-label` 的按钮里的文字不单独出现 (照无障碍树的规则; ledger 的明细按钮 `修改：交通 42.50` 里的备注找不到),
  这种要按角色和名字找, 或 `evaluate` 读 DOM.
- 验过 (macOS arm64, 2026-11-06, acdert main 重新编的 release + 加了 `open` 的 host bundle, 临时的 `XDG_*` 和空的 `ACDE_STORAGE`):
  `Acde.launch` 起 Demo 的 ledger (`acdert app ledger`, 约 1.5 s 就绪), 按角色填金额、选「交通」、写备注、提交, 等到明细里的
  `修改：交通 42.50`, 截图 (2000x1424) 里是这一笔和提示; 严格匹配 (18 个按钮) 和断言超时的报错原话; `close()` 后会话文件删了.
  `--desktop <acde-dopame>/packages/dopame` 带 ledger 和 todo-pomodoro: `open` 开出 w1 / w2, 关掉 w2 后 `not.toBeOpen`, 页面里的
  `console.log` / `console.error` 出现在 `logs`. MCP: 经 stdio 客户端在 ledger 目录里 `start` → `snapshot {find}` → `act settext` →
  `eval` → `wait_for` → `screenshot` (image) → `logs` → `stop`; Demo 里 `bunx acde mcp` 列出 12 个工具, `import 'acde/driver'` 能用;
  `bun scripts/pack.ts` 打出的包装进别的工程后 `acde/driver` 和 `acde mcp` 都能用. 没验: Linux、Windows (命名管道); 原生窗口 (AT-SPI).
- 验过 (同日晚些, acdert 加了 headless / query / console / network / screen / emulate 之后): `Acde.launch({headless: true})` 起 ledger
  (屏幕 1280x800, 约 2.8 s 就绪, 没有窗口出来, 日志有「不显示 (ACDE_HEADLESS)」); `locator('input.num')` 填金额连记 14 笔, 屏幕上的语义树
  只有 5 笔, `getByRole(…)` 数出 14 笔, 点滚出去的第 1 笔: acdert 先滚过去再点, 表单变成「修改这一笔」、金额 1.00; 页面的
  `console.log` / `warn` 和 `setTimeout` 里抛的 TypeError 进了 `console()`, `fetch` 本地文件 (200, 400 B)、缺的文件和别的主机 (两种原因不同)
  进了 `network()`; `emulate` 深色 + 减少动画后 `matchMedia` 两个都变 true, 整屏截图是深色的 ledger 摆在桌面中间, 回到 system 都变回去.
  MCP (经 stdio 客户端) `start {headless}` → `query input.num` → `act settext` → `eval` (console.error + fetch 缺的文件) → `console {level:
  errors}` / `network {failed}` 各一条 → `emulate` → `screenshot {target: screen}` (1440x900) → `stop`; 同一个会话上 `acde console` /
  `network` / `screen` 也对.

## MCP (`acde mcp`, `src/mcp.ts`)

`@modelcontextprotocol/server` 的 `McpServer` 跑在 stdio 上 (打进 `src/cli.js`), 工具都建在 driver 上. stdout 只走协议: 自己起的
`acde dev` 的输出进 `Logs`, 不往终端写. 用哪个会话: `--session` 或 `sessions {use}` 钉住的; 否则 `start` 起的; 否则和开发工具一样按工作目录挑
(每次调用前看 IPC 断了没有, 断了重新挑). 客户端断开 (stdin 关闭) 或 SIGINT / SIGTERM / SIGHUP 时停掉 `start` 起的 `acde dev`.
工具出错回 `isError` 和原因, 不抛协议错误. 服务的 `instructions` 说明怎么用 (snapshot → act → 需要像素时 screenshot).

| 工具 | 做什么 |
| --- | --- |
| `sessions {use?}` | 列会话 (`*` 是正在用的, `[started here]` 是 `start` 起的); `use` 钉住一个 pid |
| `start {dirs?, desktop?, app?, headless?}` / `stop` | 在工作目录里 `Acde.launch` / 停掉它; 已经起了一个时 `start` 报错 |
| `webs` | 开发工具的表格 |
| `snapshot {window?, ref?, find?, all?, diff?, limit?, offscreen?}` | `snapshot().text` |
| `query {selector, window?, ref?, limit?}` | `Acde.query`, 一行一个元素 `- <role> "<名字>" … [ref] <tag>` (不可见的加 `[hidden]`), 多于 limit 的说还有几个 |
| `console {web?, level?, since?, limit?}` / `network {web?, failed?, since?, limit?}` | 第一行 `next: <n>`, 下面是和 `acde console` / `acde network` 一样的行 |
| `emulate {colorScheme?: light \| dark \| system, reducedMotion?: reduce \| no-preference \| system}` | `Acde.emulate` (system 是 null) |
| `choose_folder {path? \| cancel?}` | `Acde.chooseFolder`: 事先答复页面下一次的选文件夹 (headless 时页面要选文件夹必须先答复) |
| `act {ref, action, arg?}` / `run {steps}` | `act().text` / `run().text`, `ok: false` 时是 `isError`; action 是 acde-api 的 `InspectAction` |
| `open {app}` | `Acde.open`, 回新窗口的 ref、标题和它的 snapshot |
| `screenshot {target?, path?}` | image 内容 (PNG, 设备像素) 加一行尺寸; target 是 screen (整屏)、窗口 ref、web 名、应用 id 或 desktop, 默认有焦点的窗口; `path` 相对工作目录 |
| `eval {code, target?}` | 值的 JSON; target 同上 |
| `wait_for {text, gone?, window?, timeout_ms?}` | 轮询 `snapshot {find}` 直到出现 (或 `gone` 时直到没有), 默认 5000 ms |
| `logs {tail?, since?, grep?}` | `start` 起的会话的原始输出 (页面的 console 和请求用上面的 `console` / `network`) (默认最后 100 行; `grep` 是忽略大小写的正则), 第一行 `next: <n>` 给下次的 `since`; 别处起的会话报错说输出在那个终端里 |

测试 (`test/driver.test.ts`、`test/mcp.test.ts`): `test/fixtures/dev/fake-acdert.ts` 现在是个有状态的小应用 (输入框、`Add` 在输入框空时
`disabled`、点了 300 ms 后才出现的列表项和复选框 (同时记一条 console 和一个 POST)、`open beta` 开第二个窗口、`run`、几个固定的 CSS 选择器、
`snapshot {ref}`、`screen`、`emulate`、记下 `ACDE_HEADLESS`), 经真的 `acde dev` 跑: `Locator.match` 的规则 (含 CSS 和它下面的子树); driver 的
launch / attach、填写、自动等待、严格匹配的报错、filter / nth、断言的超时和原话、open / close、截图写文件、logs、关掉后会话文件删了、
起不来时带输出的报错; MCP 用 `@modelcontextprotocol/client` 经 stdio 调每个工具 (参数校验、没有会话、`start` 两次、`--session` 连别处的会话、
客户端断开后 `start` 起的 `acde dev` 停了).

## e2e 测试 (`acde test`, `acde/test`, `src/e2e/`)

测试文件叫 `*.e2e.ts` (也认 `.tsx` / `.js` / `.mjs` / `.mts`; bun 默认的 `*.test.ts` 匹配不到它, 工程里普通的 `bun test` 不会起 acdert),
用 bun test 的写法, 从 `acde/test` 导入:

```ts
import { expect, test } from 'acde/test'

test('记一笔', async ({ app, acde, home }) => {
  await app!.getByRole('textbox', { name: '金额' }).fill('42.5')
  await expect(app!.getByRole('button', { name: '修改：餐饮 42.50' })).toBeVisible()
})
```

- **`test(name, body, timeout?)`** (`index.ts` `E2eRun`): 包一层 bun 的 `test` (`test.only` / `skip` / `todo` / `if` 一样), 每个测试自己起一个
  `acde dev` (`Acde.launch`), 跑完关掉, 测试之间什么都不共享. 隔离: 新的临时目录当 `HOME` 和 `XDG_CONFIG_HOME` / `DATA` / `STATE` / `CACHE`
  (测试完删掉), `ACDE_STORAGE` 为空, `ACDE_SIZE=1280x800`, 浅色, 减少动画, 不跑 autostart; 一个工程时构建进 `<工程>/.acde/test` (和开着的
  `acde dev` 的 `.acde` 不打架). 给 body 的: `acde` (`Acde`)、`app` (应用工程是它的窗口, 桌面工程是 null, 用 `acde.open`)、`home` (隔离的
  HOME, 测试自己放文件用)、`settings`. `expect` 认 `Locator` / `AppWindow` (driver 的, 会重试), 别的值交给 bun 的 `expect`; driver 的东西都从这里
  再导出, 还有 `describe` / `beforeAll` / `afterAll` / `beforeEach` / `afterEach`.
- **失败时** (body 抛错、断言不过、起不来): 在 `<results>/<文件>/<测试名>/` 留下 `error.txt`、`output.log` (acde dev 和 acdert 的输出)、`screen.png`
  (整屏)、`snapshot.txt` (所有窗口, 含滚出去的)、`console.txt`、`network.txt` (哪一样拿不到就写 `<名字>.error.txt`), 把「saved … in <目录>」接在
  错误信息后面. 名字里的 `/\:*?"<>|` 和空白换成 `-`; 同名的测试加 `-2` …
- **`acde test`** (`runner.ts` `TestRunner`): 参数是工程目录 (往下找 `*.e2e.*`, 不看 node_modules、.acde、构建产物) 或测试文件 (它所属的工程是往上
  第一个有 `acde.config.*` 的目录), 默认当前目录. 每个文件一个 `bun test <文件> --timeout <ms>` 子进程 (cwd 是工程, bun 是跑 acde 的那个, 环境加
  `cliEnv`), 设置经环境变量传过去 (`settings.ts` `E2e`: `ACDE_TEST_DIRS` / `DESKTOP` / `HEADLESS` / `RESULTS` / `FILE` / `TIMEOUT`); 直接
  `bun test x.e2e.ts` 时按当前目录找工程、headless、结果放 `<工程>/.acde/test-results`. 开始前清掉每个工程的 `.acde/test-results`. 默认
  headless (`--headed` 开窗口), 每个测试 60 s (`--timeout`), `-t` 是 bun 的 `--test-name-pattern`, `--desktop` 让每个测试在那个桌面里跑, `--bail`
  第一个失败的文件后停. 最后一行 `acde test: N files, P passed, F failed: …`, 有失败时说现场在哪, 退出码 1.
- 测试 (`test/e2e.test.ts`): 测试替身上两个文件 (一个过、一个故意不过) 经真的 `acde test` 跑: 只跑 `*.e2e.ts`、每个测试一个 headless 的
  `acde dev` (四个都是不同的隔离目录, 环境变量对)、构建进 `.acde/test`、失败的留下六个文件和原话、`--headed`、`-t`、单个文件、`--bail`、用错时的说明.
- 验过 (macOS arm64, 2026-11-06, 真的 acdert, headless): Demo 四个应用的 8 个测试 (`bun run e2e`) 连跑两遍都过, 每遍约 12 s; 记账 (`status`
  提示条的文字来自子元素)、番茄待办 (`timer` 倒计时在走)、笔记 (搜索、删除再撤销)、文库 (`chooseFolder` 预先答复选文件夹, 打开库、跟双链、
  后退、按标签搜; 取消时停在选库页); `--headed` 和 `-t` 也对. 第一次跑时两个失败都靠留下的 `screen.png` / `snapshot.txt` 找到原因 (提示条
  已经消失; `timer` 没有名字). 打包后装进一个新工程, `bunx acde test` 跑一个计数器页面的测试 (`getByTestId`、console) 过了.

## 要做

1. 原地重新加载 (不关窗口, 只重起 isolate), 前端框架用它自己的 `build --watch` 而不是每次整个构建.
2. `acde.config.jsonc` 加 `compatibility_date` (运行时行为的版本), environments、vars / secrets、服务名 ↔ capability 的显式 binding.
3. `acde types` (按 capabilities 生成只含允许的 `acde:` 模块的 d.ts)、单元测试跑在 acdert 的 isolate 里 (`acdert run`; e2e 已经有了, 见上)、
   e2e 的截图比对 (要容差: 不同 GPU 的光栅化有差别)、
   `acde deploy --to <主机>` (经 ssh 装到一台 Dopame OS 上), 包格式 + 签名 + 仓库之后 `acde publish`.
4. 分发: 正式的托管 (域名、R2 或 GitHub release) 和改 acdert 的发版流程 (见「分发」); Windows 的安装 (没有 sh, 要另一个安装脚本), Windows 移植之后 win32 的 acdert 才有; `acde test` 替没有 `acde` 依赖的工程解析 `acde/test` / `acde/driver` (比如把 `lib/` 放进 `NODE_PATH`).

## 协作规则

- 提交信息英文, Conventional Commits, 每行不超过 72 字符, 不加 Co-Authored-By. 做完就提交并推送.
- 汇报时分开写「已验证 / 未验证」.
