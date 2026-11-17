# CLI 命令、帮助、输出与退出码

> 路径相对 CLI 包根 `npm/`。

| 命令 | 做什么 |
| --- | --- |
| `acdev new [目录] [--template T] [--id] [--label] [--backend] [--install] [--git] [--pm PM] [--yes]` | 新建工程 |
| `acdev check [目录] [--platform P]` | 手写的包: `Manifest.check` 加入口文件; 有配置的工程: 查配置 (id、入口、图标、服务模块、框架) 再用 `Manifest.check` 判一遍; 都查 `acde:` 导入; `--platform` 见下 |
| `acdev build [目录] [--out .acde]` | 先查 `acde:` 导入, 构建成 acdert 认的包; 产物清单再过一遍 `Manifest.check` |
| `acdev install [目录] [--out]` | build 后装进 `$XDG_DATA_HOME/acde/packages/<id>` (先拷到 `<id>.new-<pid>` 再换; 手写的包: 指向工程的符号链接) |
| `acdev uninstall [id\|目录] [--yes] [--data\|--keep-data]` | `src/uninstall.ts` (acde#93: 应用数据 `Uninstall.data`: 包里每个应用的 `<数据>/acde/storage/app-<id>`、`<数据>/acde/apps/<id>` (后端的工作目录)、`<数据>/acde/files/<id>` (`acde:fs` 的 `private`)、`<状态>/acde/grants/<id>.json` (选过的文件夹)、旧的 `<配置>/acde/storage/app-<id>.json`, 桌面的 `storage/desktop-<id>` 和 `<配置>/acde/storage/<id>.json`; `ACDE_STORAGE` 换存储根, 空串时没有存储也没有旧文件. 只认合乎 `Project.ID` 的应用和桌面 id (包的 `package.json` 里 `../..` 这类 id 直接丢掉), 每条路径还要严格落在它的上级目录里才删. 共享文件里只去掉这些应用的条目 (`Uninstall.entries` / `forget`): `<配置>/acde/permissions.json` 的 `<id>:<能力>` (能力也得合乎 `Project.ID`) 和 `<状态>/acde/windows.json` 的 `<id>`, 写临时文件再改名, 不是 JSON 对象时不动并说一声. 运行时开着时它内存里的这两份会在下次写盘时写回, 所以卸载前先关掉用这些应用的会话. `--data` 删、`--keep-data` 留, 都不给时终端里问、`--yes` 留并打出路径; 两个都给是参数错, 退出码 1): 按 id (包目录下的目录名) 或来源工程找 (先找指向该工程的链接, 再按工程算出的 id 找拷贝); 链接只删链接; 先打要删什么再问 (`--yes` 不问, 非终端无 `--yes` 不删); 跑着的 `acdev dev` 的桌面或应用 id 和包重合、或它跑桌面而包里有应用时停下 (只看 `Sessions.list()`, 不经 acdev dev 起的 acdev runtime 查不到); 无参数列出已装的包 (跳过 `.new-<pid>` 残留); 退出码 1 在用、2 没装、3 没确认 (acde#85, 见下「退出码」) |
| `acdev dev [目录...] [--out] [--app ID] [--desktop ID\|目录] [--headless] [--verbose] [--force]` | 构建、起 acdev runtime、改了就重新构建并 `reload`; 一个工程只许一个, `--force` 照样再起 (见 `acde-dev.md`) |
| `acdev doctor [目录] [--json] [--online] [--fix [--yes]]` | 查这台机器上 `acdev dev` / `acdev test` 要的东西, 每项给出怎么修; `--fix` 修 acdev 能修的 (见 `acde-doctor.md`) |
| `acdev webs` / `eval` / `shot` / `inspect` / `query` / `act` / `console` / `network` / `screen` / `stop` (`--session <pid>`) | 看和操作跑着的 `acdev dev` 里的页面; `stop` 结束它 |
| `acdev permissions` / `allow` / `deny` / `revoke` (`--session <pid>`) | 看待答的批准提示和已有决定, 答提示, 撤销决定 (见 `devtools-driver-mcp.md` 的「批准的命令」) |
| `acdev mcp [--session <pid>]` | stdio 上的 MCP 服务 (`claude mcp add acdev -- acdev mcp`) |
| `acdev test [目录\|文件...] [--headed] [-t 名字] [--desktop] [--timeout MS] [--bail] [--trace] [-u]` | e2e 测试, 只在 bun 上 |
| `acdev skills [install\|remove\|path] [--agent ID,...] [--dir 目录] [--copy]` | 给编码 agent 的 skill: 看装在哪、装、删、打印它的目录 (见 `skills.md`) |

参数解析在 `src/cli.ts` (`Cli.SPECS`), 用法文字在 `src/help.ts` (`Help.commands`: 每个命令的分组、一行摘要、说明、选项和默认值、例子; acde#68). `acdev --version` (`-v`、`version`, acde#23) 第一行是 acdev 版本号 (脚本可只取第一行),
再打 `sdk <版本> (contract level N)` (版本在打包时经 `define` 的 `ACDEV_SDK_VERSION` 写进去, 从源码跑时读 `node_modules` 里的 SDK) 和找到的 acdev runtime
(`requireAcdert` 的顺序) 的 `--version` 那一行加路径, 没找到、起不来 (`acdev runtime does not run (<原因>): <路径>`) 或它没有契约级别时也说清.
版本号在 `src/versions.ts` (`Versions.acde()` / `Versions.sdk()`), `--version`、MCP 的 server 信息和 doctor 共用. `acdev --help` (`help`、`-h`) 把用法打到 stdout, 退出码 0;
`acdev --help` 是分组简表 (Project / Develop / Inspect a running session / Agents, 每命令一行对齐); 任何命令后面的 `--help` / `-h` (`--` 之前)
和 `acdev help <命令>` 打那个命令的完整说明、选项 (含默认值) 和例子 (`Help.command`; 开发会话的工具命令带 `--session`). 按终端宽度换行并保持缩进 (`Help.width`: stdout 的 `columns`, 40 到 100 列; 不是终端时 80 列). 选项说明和命令摘要同一写法: 大写开头、不加句号; 列举取值的写 `One of a, b, c`. `Help.terminal()` 只在 stdout 是终端时给宽度, `acdev new` 的 then 提示和 `acdev skills` 状态表 (第一列至少 16 宽) 用它折行; 不是终端时不折, 脚本照旧按行读.
要复制的命令、路径、网址不折断 (折在中间, 复制下来就成了两条命令, 比如 `curl -fsSL` 单独一行), 长了交给终端软换行 (复制时仍是一行):
`acdev doctor` (`Doctor.format`) 在终端里把 `title: summary` 折到终端宽度, 续行缩进 7 列; `fix:` 一行不折 (是命令). summary 里随处插着路径
(带空格的也有), 所以按 `Help.unbroken` 拆片段: 含 `/` 或 `\` 的词和它后面那个词粘成一片不拆, 带空格的路径因此整段留在一行, 长于一行时
由终端软换行 (acde#86 验收: 80 列终端里 doctor 原来有 195 列的行). 顶层的错误 (`Output.fail`) 第一行同样按 stderr 的宽度折, 续行缩进 6 列
(对齐 `acdev: ` 之后), 第二行起 (代码框、插入符) 原样; stderr 不是终端时不折. `Help.block` / `Help.wrap` 收文字 (按空白拆成词, `Help.words`) 或一组不可拆的片段, `acdev skills` 状态表的路径是一个片段,
带空格也不拆, 只折后面的 agent 名单. 宽度按终端列数算 (`Color.width`, 依赖 `string-width`: 按字素簇, 中日韩和全角字符 2 列, 组合符号和零宽字符
0 列, 颜色码不算); 只在空白处折, 中文之间不断开 (帮助是英文, 而路径里的中文也不能断). `--agent` 写错时只列 `Agents.COMMON` 几个, 其余写成 `and N more`.
颜色 (`src/color.ts`): 写到的那个流是终端才上色, `NO_COLOR` 非空不上色, `FORCE_COLOR` 强制上色 (`0`、`false` 视为关, 同 Node 和 chalk),
`TERM=dumb` 不上色. 上色的只有帮助、快速上手、标签 (`ok:` 绿、`warning:` 黄、`error:` 红、`note:`/`hint:` 暗)、`acdev doctor` 的状态词
(ok 绿、warn 黄、error 红、skip 暗), 以及结果行的前缀: `build`/`install` 成功的 `acde:` 绿, `acdev doctor:` 和 `acdev test:` 汇总按结果
绿/黄/红.
退出码与报错形状 (`src/output.ts` `Exit` / `Output.option`, acde#85): 0 做完 (空列表也算), 1 出错 (含包正被使用), 2 没做成但不算错
(`query` / `inspect --find` 没找到、`uninstall` 没装), 3 取消或没确认 (交互 `new` 按 Ctrl+C、`uninstall` 拒绝或非终端没 `--yes`). 选项值错一律
`acdev: <命令>: --<选项> <值>: <要什么> (acdev <命令> --help)` (`Output.option`; 不在 `cli.ts` 里查的也用它: `AppPackage.platformKey`
的 `check --platform`、`Agents.named` 的 `skills --agent`、`Project.build` 的 `--out`). `dev` 的 `--out is for one project` 在 `src/dev.ts`, 还是旧样子. "没找到" 和说明写 stderr, 带 `acde:`; `console` / `network` 没内容时 stderr 打
`acdev: no console entries` / `acdev: no requests` (给了 `--since` 加 ` in that range`, `--follow` 加 ` yet; waiting for new ones`), 退出 0.
stderr 输出 (`src/output.ts` `Output`, acde#83): `cli.ts` 一开始 `Output.install()` 把 `console.error` / `console.warn` 换成自己写 stderr
(`util.format` 后按行给开头的标签上色, 已带颜色码的行不动), 不再经运行时: Bun 在 stderr 是终端时会把 `console.error` 整行染红, Node
不会, 换掉后两边逐字节一样. 顶层的错误 (`Output.fail`) 是一行 `acdev: <消息>` (`acde:` 红), 去掉消息开头的 `Error: ` (acdev runtime 转来的错误
带着它); 调用栈只在 `ACDEV_DEBUG` 非空且不是 `0` 时接着打. acdev runtime 自己启动失败时 (acdert `web/packages/acde-host/src/main.ts`, acdert#207) 按同一条规则只打一行 `acdev: <message>`,
`ACDEV_DEBUG` 非空且不是 `0` 时才打整个调用栈; 这行经继承的 stderr 直接出去.
`acdev build`、`acdev install`、非交互 `acdev new` 的最后一行带耗时 (`(840 ms)`, 1 s 起 `(1.2 s)`; 交互式 `acdev new` 从答完问题算起, 写在结尾一行);
落在当前目录里的路径打相对路径 (`Cli.shown`, 先取真实路径再比, macOS 的 `/var` → `/private/var` 不算在外面), 外面的打绝对路径.
不带命令打三行快速上手 (版本、`acdev new my-app` → `cd my-app` → `acdev dev`、指向 `acdev --help`), 退出码 0; 未知命令、未知参数、缺值、参数个数不对只打一行 (说清哪里不对, 指向 `acdev --help` 或 `acdev <命令> --help`), 退出码 1.
其他常见全局选项: 颜色由 @clack/prompts (picocolors) 按 `NO_COLOR` / 非终端自动关掉, 不另加 `--no-color`; 输出本来就少, 暂不加 `--quiet` / `--verbose`.

`acdev check --platform <windows|macos|linux>` (`AppPackage.platform`): 名字对到 SDK 的平台键 (`win32` / `darwin` / `linux`),
按 SDK 的 `RUNNING_MODES` 逐个取 `platformSupport(平台, 模式)` (没有这一行的模式跳过, 比如 Windows 没有 `session`). 每个应用声明了
(`capabilities` 里为真) 而该模式 `unsupported` 里有的能力: 不在 `optional` 里是错误 `<平台> (<模式>): app "<id>" requires <能力>, which this mode lacks`,
在 `optional` 里是 `note:`. 工程读配置 (应用或桌面的 `apps`), 手写的包读 `Manifest.app` 解析后的清单. 平台数据只来自 SDK, CLI 不存一份.
有错误时退出 1, 没有时打 `ok: <平台> (<模式>…): every required capability is there`.

**`acde:` 导入** (`src/imports.ts`, `AppPackage.imports`): `acdev check` 和 `acdev build` (构建前, Bun 和 Vite 一样) 对每个应用找它入口可达的
源码里对 `acde:` 的导入 (静态 `import` / `export … from`、字面量的动态 `import()`; `import type` 和注释不算), 交给
`Manifest.importRule(名字, 应用清单, {system})` (`src/manifest/`, 原 SDK 的 `validate.ts`) 判: 不许时报 `<文件>:<行>: app "<id>": <原因>`
(原因里有缺的声明). 许了的再用去掉 `optional` 那些能力的清单判一次, 不许说明它只能经可选能力拿到: 静态导入报
`acde:<名字> is optional (…): import it dynamically, await import('acde:<名字>') …`, 动态 `import()` 放行 (平台没有时它 reject;
SDK 原来的 `load()` 随 2026-11-17 改成只有声明而去掉, 动态导入是它的替代).
- 谁的源码: 工程的应用从 `entry` (默认 `index.html`) 起; 框架应用 (没有单一入口) 是工程里除 `SKIPPED` 目录、e2e 文件、`.d.ts` 外的全部源码;
  桌面工程是 `apps` 各自的 `entry`, 都是系统应用 (`system: true`); 手写的包按 `assets` 把应用的 `entry` URL 换成文件, 有 `desktops` 的包是系统应用.
  桌面页 (`app` 为 null, 什么都许) 和桌面服务 (经 `ctx.import`, 按桌面清单的 `services` 授权) 不查;
  服务里的 `acde:` 导入由构建拒绝 (见 `acde-build.md`).
- **服务的命名空间** (规则在 SDK, 和运行时一致): 运行时按服务名授权, 应用写了 `clock` 就拿到这个服务 `api` 的每个键, 所以 `api: {clock, timer}`
  时应用能 `import 'acde:timer'`; 命名空间只有服务跑起来才知道 (工厂函数的返回值), 静态规则判不了. `Manifest.importRule` 对不是系统模块、
  又不在 `app.services` 里的名字: 应用列了别的服务就许, 结果的 `unverified` 带一句说明, `Imports.check` 把它收进 `notes`
  (`{errors, notes}`), `acdev check` (`Cli.report`) 和 `acdev build` (`AppPackage.#throw`, 所以 `dev` / `install` 的构建也打) 在 stderr 上打
  `note: <文件>:<行>: app "<id>": acde:timer resolves only if the service <应用> lists ("clock") provides the "timer" namespace`, 不算错误,
  退出码不变 (交互式 `acdev new` 用 `p.log.info`). 一个服务都没列的应用是错误 `acde:timer is not a system module; if a desktop service provides it,
  list that service's name in the services of <应用>` (拼错的模块名也是这一句). `AppPackage.check()` 返回 `Checked` (`Findings` 加 `notes`).
- 可达: HTML / `.vue` / `.svelte` / `.astro` 只看 `<script>` (和 astro 的 frontmatter), `src` 不带 `./` 的按相对路径; 跟相对路径和以 `/` 开头的
  (工程根, 手写的包按 `assets`), 补 `.ts` 等扩展名和 `index.*`, `.js` 可落到同名 `.ts`; 包名、别名 (tsconfig `paths`) 不跟.
- 词法是自带的小分词器 (字符串到行尾为止, 正则字面量按前一个记号猜), 不依赖 bun 或 Vite, 两个运行时上一样.
