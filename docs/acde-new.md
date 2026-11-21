# acdev new (`src/create.ts`, `src/pm.ts`)

> 路径相对 CLI 包根 `npm/`。

- 在终端里 (stdin、stdout 都是 TTY, 没给 `--yes`) 用 @clack/prompts 问缺的 (`Creator.ask`): 目录 (默认 `my-app`, 非空或算不出 id 当场提示)、
  应用 / 桌面、模板、显示名、后端 (只有 html)、装依赖、`git init` (不在仓库里且有 git 才问; 没配 user.name / email 时跳过首次提交).
  Ctrl+C 退出码 3 (`Exit.DECLINED`, acde#85). 不在终端里什么都不问: 目录必填, 模板默认 html, 不装依赖、不建仓库.
- **运行时和包管理器**: 工程跑在 bun 或 Node 上, 由包管理器定 (bun → bun, npm / pnpm / yarn → Node). 新工程: `--pm`, 否则 `npm_config_user_agent`;
  在终端里问的时候按 PATH (`runtimes()`: ≥ 1.4 的 bun, 和 ≥ 22.3 的 node; 其实是 bun 的 `node` 软链接不算): 只有一个就用它, 两个都有问 `Run this project on` (Bun → bun, Node.js → npm,
  默认是跑 acdev 的那个); 不在终端里是跑 acdev 的运行时 (bun → bun, Node → npm; launcher 从 Node 起 bun 跑 `cli.ts` 时经 `ACDEV_HOST_RUNTIME` 传原来的).
  建好写上 `packageManager: <pm>@<版本>` (已经有的不动). 已有工程 (`PackageManager.of`): lockfile, 再 `packageManager` 字段, 都没有是跑 acdev 的那个.
  `acdev dev` / `build` / `install` 跑在别的运行时上时 (`bin/acdev` 两个都有时用 bun), `Cli.follow` 换到工程的运行时重新跑一遍 (`run(argv, exe)`, 带 `ACDEV_FOLLOWED=1` 只换一次;
  只对打好的 `cli.js`, `cli.ts` 只能 bun 跑); 那个运行时不在 PATH 上就打一行, 接着在现在的上面跑.
  yarn 的工程写 `.yarnrc.yml` `nodeLinker: node-modules` (PnP 下 bun 和框架的构建找不到依赖).
- **package.json** (`Creator.lay` / `adopt`): 自带模板的脚本 `dev` / `build` / `check` 是 `acdev <同名>`; 框架模板不动框架的脚本, 加 `acde:dev` /
  `acde:build` / `acde:check`. 脚本调 PATH 上全局装的 `acdev`, 工程里没有 `acdev` 依赖. 建好后的下一步提示 (`Creator.next`)
  给含空白的目录加双引号, Windows 上不转义反斜杠. devDependencies: `@acde/api` (`Creator.api`); npm / pnpm / yarn 下自带模板另加 `vite: ^8` (`Creator.VITE`: Node 上用工程的 Vite 打包).
- 框架脚手架的“save to test HMR”(acde#90, `Creator.reloading` / `readmeReloading`): `adopt` 最后遍历工程 (跳过 `SKIPPED` 目录). 页面源码里
  `save to test HMR` / `to test HMR` 改成 `(and) save to reload the page`, `HMR` 可以包在 `<code>` 里、和前文隔着换行 (create-vite 9 的写法:
  `and save to test <code>HMR</code>`; lit 模板拆成两行). `README.md` 里删掉标题行 (`**…**`) 提到 HMR 的整节 (svelte 的问答), 把
  `with HMR and` 改成 `with`、`HMR and ` 删掉 (react、svelte 的介绍句). acdev dev 每次保存跑同一种生产构建再整页重载, 没有 HMR, 组件状态会丢
  (表单值、滚动、焦点、选区由运行时恢复). 测试用 `test/fixtures/create-vite/<模板>/` 里 create-vite 9.3.4 原样的文件 (提到 HMR 的那些; 源码加了
  `.txt` 后缀, 免得被类型检查和格式检查当成本仓源码), 换新版 create-vite 时照着更新.
- `@acde/api` 的依赖写法 (用户 2026-11-17 定): 工程的依赖写成这个 acdev 自己那份 SDK 的本地路径 `file:<绝对路径>` (`Sdk.spec()`,
  `Sdk.dir()`): 检出跑的是 acdev 自己 `file:` 依赖的 SDK (并排检出的 `libacde/acde-api`), 全局装的是安装目录的 `current/lib/acde-api`; 设了
  `ACDEV_SDK` (一个 SDK 目录) 时用它. SDK 只有类型声明, 不发 npm、不再写 pkgs 上的 tarball 地址; 工程因此只在有 acdev 的机器上装得上.
  开发 acdev 的人 `bun link` / `npm link` 把 `bin/acdev.mjs` 放上 PATH.
  版本配对 (`src/sdk.ts`): `Sdk.state` 的版本取依赖指向的那份 SDK 的 `package.json` (`Sdk.path`; tarball 地址从文件名取, 别的写法读
  `node_modules` 里装的). 依赖不是这个 acdev 的那份 SDK 时 (别的路径、旧工程的 tarball 地址; 两边都解析软链后比, 全局装的 `current` 是软链, #109) `acdev check` 打警告、`acdev dev` 开始时打一行
  (`Sdk.warning`, `AppPackage.sdkWarning`): `package.json: @acde/api is <写法>, but this acdev's SDK is file:<路径>: run acdev sdk update`;
  路径对、版本和 `Sdk.paired()` 不同时报版本. `acdev sdk [dir]` 显示两边; `acdev sdk update [dir]` 把依赖 (原来在哪一节就改哪一节, 没有就加进
  devDependencies) 改成 `Sdk.spec()`, 按 `PackageManager.of` (锁文件或 `packageManager`) 重装. 版本对得上但 `node_modules` 里 (往上找)
  装的是别的版本时, 警告改成 `package.json names … but X is installed: run <pm> install` (`SdkState.installed`). 以前为 npm 12 拒绝网址依赖
  写的 `.npmrc` `allow-remote=root` 不再需要, 已去掉. `sdk update` 先做完会失败的 (读 package.json、`PackageManager.of`、找包管理器的程序: 不在 PATH 上报
  `<pm> is not on PATH, and this project installs with <pm>: nothing was changed`) 并记下 package.json、各锁文件和 `.npmrc`, 然后才写.
  workspace 成员的锁文件在根上: 记下的是工程目录、`PackageManager.of` 找到锁文件或 `packageManager` 的目录 (`PackageManager.at`) 和 npm 时
  `npm prefix` 给的目录 (npm 的 workspace 根) 这几处的文件; `.npmrc` 写在 `npm prefix` 那里 (npm 12.2.2 实测: 成员里的 `.npmrc` 报
  `ignoring workspace config` 不读). 往上找到的锁文件可能不属于这个工程 (外层不是 workspace), 所以写回只动内容变了的.
  之后任何失败 (安装起不来、退出码非 0、写文件抛错、SIGINT / SIGTERM / SIGHUP) 都写回 (gitea acde#89): 只动内容变了的, 新出现的删掉,
  每个文件单独恢复, 恢复不了的列在同一条报错里 (`could not be undone completely: could not put back <文件> (<原因>)`), 恢复了的照报
  `… was undone: package.json and <锁文件> are as before`. 收到信号时先停包管理器 (SIGINT 发 SIGTERM, SIGTERM / SIGHUP 原样转; Windows 上
  Ctrl+C 本来就到它, 不转), 等它退出再写回 (不然它还会写锁文件), 第二个信号 SIGKILL; 被打断退出码 3 (`Exit.DECLINED`), 别的失败 1.
  `node_modules` 不回滚; 安装真跑过时才提示重跑安装.
- 配置的 JSON Schema (`templates/config.schema.json`, 原 SDK 的 `config.schema.json`, 用户 2026-11-17 定随模板走): `lay` 和 `adopt` 把它拷进工程,
  名为 `acde.config.schema.json`, 模板配置的 `$schema` 指向它. 升级 acdev 后工程里的这份不会自己更新. 说明文字是英文 (同下「模板的注释」).
- 模板 (`STARTERS`): `html` (`templates/app`, `--backend` 再叠 `templates/backend`)、`desktop` (`templates/desktop`)、`react` / `vue` / `svelte` /
  `solid` / `preact` / `vanilla` (create-vite)、`next` / `nuxt` / `sveltekit` / `astro` (官方脚手架). 框架模板照 `npm create cloudflare`: 经工程的包管理器
  跑脚手架最新版 (`PackageManager.exec`: `bun x --bun` / `npx --yes` / `dlx`), stdin 关掉, 输出收着、失败时整段打出; 只有这一步带 `CI=1` (yarn 见到
  `CI` 不许新建 lockfile, 装依赖那步不能带). 再叠 `templates/framework/acde.config.jsonc` (没有 `entry`: 构建认框架), `.gitignore` 加 `.acde/`; 根上有 `index.html` 的 (Vite 系)
  把它的 `<title>` 换成显示名 (窗口标题先用 `document.title`), 别的框架的标题在组件里, 不改.
  加模板就是 `STARTERS` 加一项.
- 某一步失败 (`Creator.create`): 先一句话说结果, 再接命令的输出. 铺文件或脚手架失败时撤掉做了一半的工程 (目录是 acdev new 建的就删掉, 原本就有的
  空目录清空、保留 `.git`): `the <模板> project was not made (<dir> was removed): ...`; 装依赖失败时工程留着, 说怎么补:
  `the project is in <dir>, but its dependencies are not installed; once the cause below is fixed, run <pm> install there: ...`;
  `git init` 失败同样留着工程 (`... ready, but it is not a git repository yet: ...`).
- 模板按第 1 级契约写 (`test/templates.test.ts`): 应用的配置 (`templates/app`、`templates/framework`) 列出 `capabilities`、`optional`、
  `services`、`requests`、`schemes` (空值加说明; `fs.roots` 只点名 SDK 的 `SHARED_PLACES`), 声明即授予 (运行时没有批准步骤, acdert#146), 新工程无界面也能启动;
  类型引用分层: 应用写 `@acde/api/app`, 桌面页写 `@acde/api/shell`; 桌面页经 `apps.open(id)` 打开应用 (第 1 级的 `acde:apps`
  没有 `launch`); 不用 `copyIn` (第 1 级由 `fs.copy` 取代).
- 模板的注释和默认文字用英文, 与 skill 一致 (acde#38); 有界面的模板 (`templates/app`、`templates/desktop`) 带最小的 i18n: 文案在 `src/locales/<语言>.js` (至少 en、zh, 键相同), `src/i18n.js` (两份相同) 按 `navigator.language` 精确标签→`Intl.Locale` 的基础语言→`en` 选表, 缺的键回落英文, 设 `<html lang>` 并填 `data-i18n`; 不用第三方库. `templates/` 里除 `locales/zh.js` 外不出现中日韩文字, 不写死 `lang="zh"` (测试检查). 框架模板的界面由各自脚手架生成, 不改.
- **`bun create acde`** (`create-acde/`, 2026-11-22): `bun create acde` / `npm create acde` / `pnpm create acde` / `yarn create acde` 都去 npm 取
  `create-acde` 跑它的 bin, 所以发了一个公开的 npm 包 `create-acde` (只有 `index.mjs`, 不压缩不混淆, 没有依赖; Node ≥ 18 或 bun 都跑). 它不带 acdev:
  先找 acdev (PATH, 再 `$ACDEV_INSTALL/bin`, 默认 `~/.acdev/bin`; Windows 认 `acdev.cmd` / `.exe` / `.bat`), 找到就原样跑 `acdev new <参数…>`,
  退出码照传, 信号转给子进程. 不依赖 npm 上的 `@dopame/acdev`: 工程的 `@acde/api` 写成 acdev 自己那份 SDK 的 `file:` 路径, 从 bunx / npx 的缓存跑
  会指进缓存目录. 找不到时: 在终端里 (stdin、stdout 都是 TTY, 没给 `--yes` / `-y`) 问 `Install acdev now? (Y/n)`, 同意就跑官方安装器
  (`curl -fsSL $ACDEV_DIST/install.sh | sh`, Windows `irm …/install.ps1 | iex`, `ACDEV_DIST` 默认 `https://pkgs.dopame.ai/acdev`), 装好再找一次;
  不在终端里打出安装命令、退出码 1. 包管理器: create 命令设了 `npm_config_user_agent`, 子进程继承, `acdev new` 照它选 (见上「运行时和包管理器」).
  版本独立于 acdev (只在这个文件变了时发), 手动 `npm publish --access public` (在 `create-acde/`), 不在 cicd 的 npm 步骤里.
