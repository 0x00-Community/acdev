# CLI 总览: 启动、仓库脚本、工程目录、bun 和 Node

> 路径相对 CLI 包根 `npm/`。

acdev 的开发者 CLI, 是 [acdev](http://gitea.dopamine/AC/acdev) 仓库的 `npm/` 子包 (原 gitea AC/acde-cli, 连历史并入).
和运行时的关系像 wrangler 和 workerd: 并排检出的 [libacde](http://gitea.dopamine/AC/libacde) 是运行时库 (原 AC/acdert), 二进制是仓库根上的 `acdev runtime`
(跨平台调试) 和 acdes (Dopame OS 的会话); acdev 建工程、构建、装包, `acdev dev` 拉起 acdev runtime. 运行时的一切 (清单、`acde:` 模块、后端怎么跑、
窗口模型、dev IPC 的 op) 以仓库根 `AGENTS.md` 的第一原则和 libacde 的 `docs/runtime/`、`docs/web/` 为准, 这里只写工具.

- 对外介绍见仓库根的 `README.md`, 开发说明在 `AGENTS.md` 和 `docs/` 里. TypeScript, 跑在开发者已有的 bun ≥ 1.4 或 Node.js ≥ 22.3 (`process.getBuiltinModule`) 上: 这是装好的 acdev (`dist/cli.js`) 的要求. 从检出直接跑源码 (`node bin/acdev.mjs`, PATH 上没有 bun 时 launcher 用 Node 跑 `src/cli.ts`) 要 Node.js ≥ 22.18, 它起默认擦除类型 (https://nodejs.org/en/blog/release/v22.18.0 「Type stripping is enabled by default」); 更早的 22.x 要 `--experimental-strip-types`. 只擦除类型时不支持要转译的写法 (构造函数参数属性、`enum`、`namespace`), 所以 `tsconfig.json` 开了 `erasableSyntaxOnly`, 这类写法类型检查就报错 (2026-11-18 acdev-test 在 Windows 上用 Node 22 直跑时撞上过). 测试 `bun test`, 类型检查 `bun run typecheck`.
- 启动快 (gitea acde#94): `src/cli.ts` 只静态导入轻模块 (`test/commands/launcher.test.ts` 核对清单), 其余在用到的命令里 `await import()`;
  `-v` 探 acdev runtime 用 `Runtime.level` (`DevSession.runtimeLevel` 转给它), 帮助用 `src/starters.ts` 和 `driver/types.ts` 的 `ACTIONS`.
  发布包的 cli.js 开 splitting (`chunk-<hash>.js`), 懒导入的模块才真的晚加载. `bun run startup [acdev 路径] [--max-version-ms N] [--max-help-ms N]`
  (`scripts/startup.ts`) 量 `acdev -v` 和 `acdev --help` 的中位数 (先跑一次热身), 超过上限退出 1.
- 仓库脚本: `bun run acdev <命令> [参数]` 从源码跑 CLI (即 `bun bin/acdev.mjs`, 经 launcher 的 `run`, 退出码原样传回);
  `bun run test`、`bun run typecheck`、`bun run dist -- <参数>` (见 `release-distribution.md`). 要在别的目录当 `acdev` 用时 `bun link` / `npm link`.

## 工程与工具目录

在应用工程目录运行 `acdev check`、`acdev build` 和 `acdev dev`。从其他目录运行时，可传入工程路径。
`acdev new` 在指定目录生成应用源码、配置和依赖声明。框架模板保留框架原有脚本，并追加 `acde:check`、`acde:build` 和 `acde:dev`
用于应用检查、构建和开发会话。
生成的工程只有这三个脚本，经工程自己的包管理器运行，`acdev` 的退出码由包管理器传回。

开发流程（acde#3）：`acdev new` 建工程 → `acdev dev` 预览和调试（跑着时可用 `acdev inspect` / `eval` / `console` / `network` / `shot`，
或 driver、MCP）→ `acdev test` 端到端测试（每个测试自己起一个隔离的 acdev runtime）→ `acdev build` 构建，`acdev install` 构建并装进本机桌面。
`acdev new` 打完下一步提示后再打 `acdev: then:` 和后三步，一步一行（交互时是 `Then` 一栏，`Creator.LATER`）；每步不超过 70 字符，这样 clack 的框不超过 80 列，终端更窄时按宽度折行（`Help.block`）。

不新增 `prod` / `start` / `preview` 命令或脚本：`acdev dev` 和 `acdev build` 用同一种构建（都压缩、`NODE_ENV` 是 `"production"`），
dev 只多了改动后自动重建刷新和调试接口；“装好后的样子”就是 `acdev install` 之后从桌面打开。部署和发布不算启动。
也不生成 `test`：`acdev test` 只在 bun 上运行，新工程没有 `*.e2e.ts`，这时 `acdev test` 说还没有测试、指向测试指南的「A first test」，退出码 0；写了端到端测试的工程自行添加 `acdev test` 脚本。

`acdev check` 读取工程配置和入口。普通工程的 `build` 和 `dev` 默认把运行时包写到工程的 `.acde/`。
显式的绝对 `--out` 直接指定产物目录。相对 `--out` 从被构建的工程目录解析，例如从父目录运行
`acdev dev ./demo --out artifacts/demo` 时，输出位于 `./demo/artifacts/demo`。构建前会清空 `--out`，所以它不能是工程目录或其上层
（`Project.build` 报 `acdev: <命令>: --out <绝对路径>: a directory that does not hold the project …`，命令取 `BuildOptions.command`，
`acdev dev` 不传时按 `dev` 选项算 `dev` 或 `build`）。

安装后的可执行文件 `acdev` 与运行时 `acdev runtime` 在安装目录的 `bin/`，运行时的宿主文件在 `libexec/app/`，模板在 `lib/acdev/templates/`，
软件开发工具包（Software Development Kit, SDK）在 `lib/acde-api/`。应用工程可以保留自己使用的 `bin/`、`templates/` 和 `packages/`。

## bun 和 Node

同一份代码两边都跑, 判断用 `Runtime.bun` (`src/runtime.ts`); `Bun.*`、`bun:*`、宏只能出现在 bun 专属的路径上.

- 子进程一律 `Runtime.spawn` (`node:child_process`). Windows 的 `.cmd` / `.bat`: Node 不许不经 shell 起, `shell: true` 又只把参数拼起来
  不加引号 (Node 24+ 还报 DEP0190), 所以自己加好引号拼成一条命令行交给 shell.
- 按 PATH 找程序只有 `launcher.mjs` 的 `which` (Windows 上按 `PATHEXT`: `nodejs\npm` 是给 Git Bash 的 sh 脚本, 要 `npm.cmd`), 不用 `Bun.which`.
  按 import 条件从工程目录解析包用 `Runtime.resolve`, 不用 `Bun.resolveSync`.
- 打包: bun 上 `Bun.build`, Node 上工程自己的 Vite (见 `acde-build.md`). `acdev test` / `acdev/test` 只在 bun 上.
- 后端 preload 的文本由 `Bundler.buildPreload` 在进程内 `Bun.build` `src/listen.ts` 得到 (target node、esm、只压缩语法). 从源码跑时
  (`Bundler.preload` 看 `import.meta.url` 是 `.ts`) 每次现打; 打 `cli.js` 等时 `scripts/dist.ts` 先打一次, 经 `define` 把
  `ACDEV_LISTEN_JSON` 换成它的 JSON 字面量, `src/listen-bundle.ts` 用 `JSON.parse` 还原. 不用宏也不起子进程: 宏里不许调 `Bun.build`,
  起 `bun build` 子进程时父进程被杀会留下永不退出的子进程 (acde#12), Windows 上 bun 起子进程前几次还要等几秒. 只有 Node 时从源码跑出不了
  preload (发布的不受影响).
