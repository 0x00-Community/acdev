# 发版与分发

> CLI 相关路径相对 `npm/`, 安装器在仓库根 `scripts/`。

CI 是 `.github/workflows/` 里的四个工作流 (2026-11-22 起, 四个仓库同一套标准; 以前的 `cicd.yaml` 和 `test.yml` 拆进这四个, 说明在下文「分发」的「发布」):
`build.yaml` (每次推 main 和手动: 构建、打包、guard, 产物在 .127, 接着跑 `test.yaml`)、`test.yaml` (测某次构建在 .127 上的产物, 不编)、
`tag.yaml` (发版的唯一手动入口: 发版构建 → 测试 → 标签 → `release.yaml`)、`release.yaml` (只被 `tag.yaml` 调: 把那次运行的产物传到 R2).
一次发布、一个版本号, 把四个平台的
`acdevrt-<triple>` (运行时)、`acdevtools-<triple>` (宿主小工具 `acdevtool`)、客户机守护进程 `acdev-guest-<版本>.tar.gz` (两个架构的 acdevd)、SDK `acde-api-<版本>.tar.gz`、`acdev` 命令行和安装器一起放进
`pkgs.dopame.ai/acdev/<版本>/`, 同一版本也发到 npm (`@dopame/acdev`、`@dopame/acdev-<os>-<cpu>`, 见「npm」; 不在 `release.yaml` 里, 是 `tag.yaml` 最后的作业 `npm`), 标签 `v<版本>`
打在本仓库. 版本号不用先提交: 用输入 `version`, 没有时若这个提交已有 `v*` 标签就用它 (重跑 `tag.yaml` 接着发同一版), 否则取 pkgs 的 `latest.json`、npm 上两个包和 `v*` 标签里最高的版本加一个
补丁号; 各作业用 `scripts/set-version.sh <版本> acdev` 把它写进本仓库和旁边 libacde 的 `Cargo.toml` 的 `[workspace.package]`
(crates/hostwin 跟本仓库的走, 运行时库跟 libacde 的走)、`npm/package.json` 和 SDK 的 `libacde/acde-api/package.json` (不提交).
运行时库是并排检出的 libacde (`build.yaml` 里锚点 `&libacde` 那一步, `build` 和 `pkgs` 用: 经令牌克隆, 带子模块 `vendor/blitz`; `plan` 读一次 libacde 的 main, 输出 `libacde`,
`build` 和 `pkgs` 都检出这一个提交; 这个提交记进 `run.json`, `test.yaml` 检出同一个),
页面资源和启动器已嵌进 acdev 二进制, 不再有 `acde-host` 包和 `libexec/app` (2026-11-18 起; 原 AC/acdert 已归档).

## 构建耗时与并行 (build.yaml)

- 改前 (2026-11-18 之前, 运行 2258): 总共 30 分 41 秒; `build` 四个目标各 9～14 分钟 (并行), `host` 1 分多, `pkgs` 2 分.
- 改后的做法: 去掉 `host` (页面资源已嵌进二进制) 和克隆 AC/acdert 的步骤; `build` 在 cargo 之前 `bun install` libacde/js 并设 `ACDEV_BUN`:
  libacde 的 build.rs 在宿主 Linux 上用 bun 把 libacde/js 打包进二进制, 三个交叉目标也用 Linux 版 bun; acdevtool 在同一格里接着编 (共用交叉工具),
  acdevd 在 `guest` 里和矩阵同时编, `pkgs` 只等两边. 各格把自己的产物直接传到 .127 (见「产物机 .127」), `pkgs` 用 nc + tar 取回;
  分离的调试信息在 `build-<triple>/symbols/`, `pkgs` 只拷要发的归档, 不会把它发出去; npm 包和命令行归档仍只打一次.
  缓存: 不用 rust-cache (2026-11-18 去掉: 宿主模式下每个作业的工作目录 `~/.cache/act/<随机>/` 都不同, rust-cache 交给缓存服务的是绝对路径,
  缓存的版本按路径算, 永远对不上, 每次 "No cache found" 却还存 1.1G; RUSTFLAGS 的 `--remap-path-prefix` 也带着这个路径, 就算恢复了 cargo 也全部重编).
  跨运行留下的是执行机自己家目录里的: cargo 的下载 (`~/.cargo`), cargo-xwin 的 MSVC CRT 和 SDK (`~/.cache/cargo-xwin-atl`), zig 的缓存
  (`~/.cache/zig`); target 每次从头编. 不用 sccache (它会关掉增量编译, runner 上也没装).
- 改后的耗时: 待试编后补.
- TLS 的加密底层是 ring, 不是 aws-lc (用户定, 2026-11-18): aws-lc-sys 在 Windows x86_64 上要 NASM (或 `AWS_LC_SYS_PREBUILT_NASM=1`),
  每个平台都多编一个大 C 库. ring 也要 C 编译器 (交叉作业的 clang、`zig cc`), Windows 的汇编是它预生成好的, 不要 NASM. 所以交叉作业的 apt
  只装 `clang lld llvm python3 xz-utils`; 以前的 `nasm` 随 aws-lc 去掉, `perl`、`make` 是编 vendored OpenSSL 时留下的, 依赖里早已没有 OpenSSL.

## 分发 (仓库根 `scripts/install.sh`, `scripts/install.ps1`, `npm/scripts/dist.ts`)

两种装法: 安装器 (下面说的这一种) 把 acdev 和同一次发布的调试运行时 acdev runtime 一起装, 不经 npm, 不要 root, 不带也不下载 bun / Node. 下载地址 `ACDEV_DIST`
(默认 `Pkgs.ACDEV`), 两个脚本开头各一处, 末尾的 `/` 去掉. 地址只有一处: `src/pkgs.ts` 的 `Pkgs.BASE`
(`https://pkgs.dopame.ai`: Cloudflare R2 的桶 `pkgs`, 由一个 Worker 只读地提供, 路径就是对象的键, 照各对象存的 Content-Type / Cache-Control 回, 支持 Range 和 If-None-Match; 没有 CloudFront, 不用失效, 但 Cloudflare 边缘会照对象的 Cache-Control 缓存. 2026-11-22 起, 之前是 S3 `dopame-pkgs` 经 CloudFront, 旧内容已原样拷进 R2 的 `acdev/`), `Doctor.DIST`、`Sdk.DIST`、测试都引用它; 脚本不能 import,
`scripts/dist.ts` 打包前用 `Pkgs.scriptProblems` 对两个脚本的默认值, 不一致就失败 (`test/release/pkgs.test.ts` 也查). 前缀 `acdev/` (以前 S3 桶里只有它和 `iso/`; 以前的 `acde/`、`acdert/`、`acde-dopame/` 连同旧版本 2026-11-18 删掉, 用户定): `acdev/install.sh`、
`acdev/install.ps1`、`acdev/install.md` (给 agent 读的安装步骤, 见 `skills.md`)、`acdev/latest`、`acdev/latest.json`, 和版本目录 `acdev/<版本>/`:
`SHA256SUMS` (下面每个文件一行)、`acdev-<版本>.tar.gz` (命令行, 一个通用包)、`acde-api-<版本>.tar.gz` (SDK, `package/` 布局, 只有类型
声明, 工程的 `@acde/api` 指向它)、`acdevrt-<triple>.tar.zst` (Linux, `zstd -3`; macOS `.tar.xz`, Windows `.tar.gz`, 见下文「压缩格式」; 里面只有 `acdev[.exe]`)、
`acdev-guest-<版本>.tar.gz` (`acdevd-x86_64`、`acdevd-aarch64`: 装进客户机的设备守护进程; `acdev-agent-x86_64`、`acdev-agent-aarch64`: 客户机代理, 见 `docs/agent.md`; 都是静态 musl, 和宿主平台无关)、
`acdevtools-<triple>.tar.zst` (格式同 `acdevrt`, 里面只有 `acdevtool[.exe]`, 每个平台都有). `acdevtool` 是 `crates/tool` 的一个程序, 两个子命令:
`relay SOCKET` (Windows 上命令行经它连 QMP 和客户机代理的 Unix 套接字) 和 `view` (客户机窗口, 见 `viewer.md`; 只在 unix 上编进去, 命令行目前只在 Linux 上用). 官网 `https://dopame.ai/install.*` 指向这里. 发布由仓库根 `.github/workflows/tag.yaml` 和它调的 `release.yaml` 完成 (见下). 本地托管目录就是
dist.ts 的 `--out`: `install.sh`、`install.ps1`、`install.md`、`latest` (版本号) 和上面的版本目录.

**运行时**: 命令行、调试运行时、页面资源和 SDK 是同一次发布, 同一个版本号 (用户定, 2026-11-14), 都在 `acdev/<版本>/` 里, 由同一份 `SHA256SUMS`
校验. 安装器 (含 `--version` / `-Version`) 取 `acdev-<版本>.tar.gz`、`acdevrt-<triple>` (按 SHA256SUMS 里列的: `.tar.zst`, 否则 `.tar.xz`; Windows `.tar.gz`), 再取 SHA256SUMS 里
列着的 `acdev-guest-<版本>.tar.gz`、`acdevtools-<triple>` (和旧版本才有的 `acde-host-<版本>.tar.gz`), 都校验后才落位: 运行时放成
`libexec/acdev[.exe]`, guest 和 tools 包里的程序原样放进 `libexec/` (`libexec/acdevd-x86_64`、`libexec/acdevd-aarch64`、`libexec/acdevtool[.exe]`), 旧版本的 `app/` 放成 `libexec/app/`. 命令行找它们: `crateBinary` (`npm/src/vm/binary.ts`) 先看环境变量 (`ACDEV_DEVD`、
`ACDEVTOOL`), 再看安装目录的 `libexec/<名字>` (launcher 的 `libexecBeside`; acdevd 按客户机架构取 `acdevd-<x86_64|aarch64>`),
再看检出的构建产物. 0.0.9 及更早的版本是
命令行和 acdert 分开发的 (版本目录里有 `acdert-version`), 现在的安装器不装它们, 提示去掉 `--version` 装最新的. 没有这个平台的构建 (报出有哪些
平台)、下载或校验失败, 都在动安装目录之前失败, 之前装的版本和 `current` 照旧. Dopame 桌面包不随 acdev 安装.

装好后一个版本目录 (`versions/<版本>`; 归档里的顶层目录 `acdev-<版本>/` 加上安装器放的两项) 是:

```
bin/acdev            bin/acdev.sh 跑 lib/acdev/dist/cli.js: bun ≥ 1.4 用 bun, 否则 node ≥ 22.3 用 node; 都不行时 bun 太旧提示更新 bun, 否则 node 太旧提示更新 node, 都没有提示装其中一个
bin/acdev.cmd        Windows 的启动器: bin/acdev.cmd (CRLF), 同样的选法和提示; PowerShell 调 .cmd 时经 cmd 会丢掉参数里的双引号 (acde#33); 按 `where bun.exe` / `node.exe` 的完整路径直接调 (yarn 4 跑脚本时 PATH 最前面是它的 `node.cmd` 包装, 不带 `call` 调 .cmd 不会回来, acdev 一声不响地退出 0; `call` 又会把参数里的 % 再展开一次); 跑 CLI 的那一行写成 `endlocal & goto #_undefined_# 2>nul || title %COMSPEC% & "<bun 或 node>" cli.js %*` (npm cmd-shim、yarn 的做法, deno#9873): goto 一个不存在的标签结束批处理, 已经解析好的这一行接着在命令行上下文里跑, 按 Ctrl-C 不再问 "Terminate batch job (Y/N)?" (原来答 n 也照样退出, 因为 Ctrl-C 已经停了 node), 退出码照样传回调用方 (这一行必须是文件里最后执行的), 屏幕上可能剩一对 ^C
libexec/acdev[.exe]  安装器放的调试运行时 (不在 acdev 归档里)
libexec/acdevd-x86_64, libexec/acdevd-aarch64   客户机的设备守护进程 (acdev-guest 包)
libexec/acdev-agent-x86_64, libexec/acdev-agent-aarch64   客户机代理 (acdev-guest 包, provision 装进 acdev-guest-tools)
libexec/acdevtool[.exe]   宿主小工具: relay 和 view (acdevtools 包)
lib/runtime-cache   两个启动器记下的选择 (gitea acde#94: 每次起 bun/node 探版本在 Windows 上要 1 s 以上): 第一行是 PATH 上 bun 和 node 的
                    路径 (acde.cmd 再加 %~t 和 %~z), 第二行 (acde.cmd 用 * 隔开) 是选中的运行时. 键对得上、
                    选中的文件还在 (sh 另要求 bun/node 都不比缓存新, -nt) 就直接起它, 否则照旧探测再写; 写不进去不报错. 只在探测通过时写
LICENSE             专有 LICENSE, 归档顶层 (和 lib/acdev/LICENSE 一样)
lib/acdev/           package.json (exports, 与源码仓库不同: 指向 dist)、launcher.mjs (压缩和轻度混淆)、launcher.d.mts、LICENSE、templates/ (用户起步模板, 含 .ts 是正常的)、
                    skills/acdev/ (SKILL.md 和 references/, 原样; `acdev skills` 把它装给 agent)、
                    dist/cli.js、dist/driver/index.js、dist/e2e/index.js (acdev/driver、acdev/test) 和它们共用的 dist/chunk-*.js (压缩和轻度混淆)、dist/types/**/*.d.ts (声明)
lib/acde-api/       @acde/api 的构建产物 (压缩的 js、d.ts、package.json、config.schema.json; 没有 src/*.ts、test/)
```

- `bun scripts/dist.ts [--api <目录>] [--sdk <版本>] [--version] [--out .dist] [--runtime <目录>]` (`--api` 默认
  `../../libacde/acde-api` (并排检出的 libacde 的 SDK); 现在对不上: 新的 SDK 只有类型声明, 没有下面要求的 `src/index.js`, 见 libacde 的 `docs/acde-api.md`; 没有 `package.json` 和 `src/index.js`, 或包名不是
  `@acde/api`、给了 `--sdk` 而版本不等时报错). 它把 `--api` 打成 `acde-api-<SDK 版本>.tar.gz`, 把 `--runtime` 目录里的文件 (发布时是各平台的
  `acdevrt-<triple>`、`acdevtools-<triple>` 和 `acdev-guest-<版本>` 包) 拷进版本目录, 最后按版本目录里的全部文件写 `SHA256SUMS`. Windows 上打的归档
  没有 unix 的可执行位, 只供 Windows 和测试用 (`.gitattributes` 让 `skills/**`、`bin/acdev.sh` 和仓库根 `scripts/` 的 `install.sh`、`install.md` 在 Windows 检出里也是 LF); 发布在 Linux 上打. 归档前检查 (`scripts/shipped.ts` 的 `shipLeaks()`):
  不许有 `lib/acdev/src`、`lib/acdev/test`、`lib/acde-api/test`、`.map`、`sourcesContent`、任何 `.js`/`.mjs`/`.d.ts` 里的 `sourceMappingURL`、
  模板之外的 `.ts` 源码, 也不许有符号链接、点文件、密钥和本机构建路径; 覆盖整个包 (acde#7). 有就不出包.
- **轻度混淆** (`javascript-obfuscator` 5.9.0, 精确钉住, 发版前至少两周): 在 `Bun.build` 的 `minify` 之后对 `dist/cli.js`、`dist/driver.js`、
  `dist/test.js`、`launcher.mjs` 做一遍: 标识符改名 (含顶层, `renameGlobals`) 和字符串数组 (base64). 不做控制流平坦化、死代码注入、自我防护
  或调试保护, 不出 sourcemap. 导出名不变 (只改本地绑定, 别名保留). 预加载 `acde-listen.js` 不混淆: `dist.ts` 把它的 JSON 文本 `define` 进去、
  `src/listen-bundle.ts` 用 `JSON.parse` 还原, 让它在 bundle 里是普通字符串字面量, `reservedStrings` 留下 `getBuiltinModule`. 预加载的源码
  是压缩后的普通 JS, 写进每个用户应用的后端目录 (混淆它没有保护价值, 它就跑在用户的应用里).
- **构建、测试与发布** (`.github/workflows/` 的 `build.yaml`、`test.yaml`、`tag.yaml`、`release.yaml`): 版本由 `build.yaml` 的 `plan` 定 (见上文开头), 不以提交里的 `package.json` 为准; 标签 `v<版本>` 是注释标签, 由 `tag.yaml` 打在它运行的提交上. 命令行、四个平台的 acdev runtime、页面资源和 SDK 一起发 (见「运行时」); Dopame 桌面不随 acdev 发布.
  - `build.yaml`: 每次推 `main` (没有 `paths` 过滤) 和手动 (`workflow_dispatch`, 输入 `test` 默认勾上、`version`、`skip_targets`) 都跑, 是预演: 只构建、打包、跑 guard, 不打标签、不上传; 被 `tag.yaml` 调用 (`workflow_call`, 输入 `test`、`version`) 时是发版构建. 区分只看事件: 被调用的工作流里 `github.event_name` 是 `workflow_call`, `plan` 据此输出 `release` (`true` / `false`); 发版构建不认 `skip_targets` (四个平台都编), 只允许在 `main` 上 (`GITHUB_REF` 是 `refs/heads/main`, 提交是 origin/main 的祖先), `v<版本>` (plan 的检出带全部历史和标签, 用 `git rev-parse` 查, 不调 forge 的 API) 不存在或指向这个提交才继续, 指向别处时失败 (「bump the version」). 一律构建 `github.sha` (以前的 `commit` 输入去掉了: 要发哪个提交, 就在哪个提交上跑 `tag.yaml`). 输出 `version` (`plan` 的版本). 最后的作业 `test` (`needs: pkgs`) 用 `uses: ./.github/workflows/test.yaml` 测这次运行 (`run: ${{ github.run_number }}`, `secrets: inherit`): 推送时总跑, 手动时除非不勾 `test`, 被调用时看输入 `test`. 手动输入从 `github.event.inputs.<名字>` 读 (这台 Gitea 手动运行时 `inputs.*` 停在默认值), 被调用时读 `inputs.*`.
  - `test.yaml`: 手动 (输入 `run`, 空的时候取 .127 的 `acdev/latest`, 即最近一次过了 guard 的构建; `wpt` 选 `gate` / `full` / `baseline`; `workers`) 或被 `build.yaml` 调用 (输入 `run`, 只跑 `gate`). 作业 `pick` 定下运行号, 读 .127 上那次的 `run.json` (提交、libacde、版本), 其余作业都 `needs` 它. 不编: 运行时是那次 `build-x86_64-unknown-linux-gnu/acdevrt-x86_64-unknown-linux-gnu.tar.zst` 解出的 `acdev` (dist 配置, `ACDEV_RUNTIME`); acdev 检出到那次的提交, 只为 `npm/` 的命令行和 `acdev/driver` (`bun link`, WPT 脚本和 acde-demo 用它, TS 源码, 不是构建产物); libacde 检出到那次的提交, 只为 `scripts/wpt` 和命令行引用的 SDK、清单规则 (不拉 `vendor/blitz`). 跳过了 Linux 那格的构建没法测, `pick` 之后的作业报错. `demo` 克隆的 acde-demo 是它的 main, 不随运行固定. 旧的 `run.json` 没有 `libacde`, 那样的运行要重编才能测.
  - `tag.yaml` (发版的唯一手动入口, 只有可选输入 `version`): `build` 调 `build.yaml` (`test: true`, 所以测试必须过), `tag` 打标签并推 (只有它有 `contents: write`; 标签已指向同一提交是重跑, 继续; 指向别处则失败), `release` 调 `release.yaml` (`run` 是本次运行号, `version`, `tag`), 最后 `npm` (见下). 被调用的工作流和调用方是同一次运行 (同一个 `github.run_number`), 所以 .127 上的 `<run 号>/` 对 build、test、release 是同一个目录. 用作业令牌推的标签不触发别的工作流, 发布由 `tag.yaml` 直接调.
  - `release.yaml` (只有 `workflow_call`, 不能手动跑): 只把运行 `run` 的产物从 .127 传到 R2, 不打标签、不发 npm、不写别的主机.
  发版: 在 Gitea 上手动跑 `tag.yaml` (要发的提交是运行分支 main 的头; 可填 `version`). 预演: 推 main 或手动跑 `build.yaml`. 推标签 `v*` 不再触发任何工作流 (以前的 `cicd.yaml` 把它当正式发布).
  所有作业都直接跑在执行机上, 不用容器 (2026-11-18 起: ci-debian 执行机没有 Docker; 执行机自带的 node 20、npm 9 够 `node -p` 和 npm 那几步用, CLI 的冒烟测试走 bun; 工具链都由 `scripts/runner-setup.sh` 预装, 作业什么都不装, 见「执行机的工具链」), 不用 Ubuntu 的环境; `runs-on` 一律 `x86_64-debian` (`build` 的 Apple silicon 那一格除外, 在 `aarch64-debian`: aarch64 的 ci-debian 执行机共有的标签, 现在只有 .210; `release.yaml` 的 `pacman` 在 `x86_64-arch`) (三台 ci-debian 执行机 .110、.234、.243 共有的标签, 谁空谁接; 2026-11-18 起, 之前的 `debian12` 已不存在), GitHub 上也是: 不用任何 Ubuntu runner (用户定, 2026-11-13);
  `build.yaml` 的作业: `plan` 之后所有作业都 checkout `github.sha`. `skip_targets` 定下要编的平台, 跳过的平台的 `build` 那一格在作业级 `if` 上跳过.
  `build` (每个平台一格: Linux 原生, Windows 用 cargo-xwin, macOS 用 cargo-zigbuild 和 MacOSX15.5 SDK; 都在 x86_64-debian 执行机上, 只有 `aarch64-apple-darwin` 在 `aarch64-debian` 执行机上 (现在只有 .210; 以后加的 aarch64 ci-debian 执行机自动纳入; 用户定, 2026-11-18), 那里 cargo-zigbuild 取 aarch64 gnu 版、zig 取 aarch64-linux 版, 按 `uname -m` 选) 拉 libacde 和它的 `vendor/blitz`, `cargo build --profile dist -p acdev` (ac 源用 `ACKERNEL_TOKEN`), 再在 `crates/tool` 里用同一套交叉工具 `cargo build --release` 编 `acdevtool`, 打成各只有一个文件的 `acdevrt-<triple>` 和 `acdevtools-<triple>` (固定时间和属主), 分离的调试信息放在同一个产物的 `symbols/` 里 (都传到 .127 的 `<run 号>/build-<triple>/`, 不发布). `guest` 和 `build` 并行, 拉 libacde (同 `build`, 代理以 path 依赖它的 `acde-wire`、`acde-scene`), 在 `crates/devd` 和 `crates/agent` 里编两个架构的 acdevd 与 acdev-agent (静态 musl, 各自 `.cargo/config.toml` 的 rust-lld) 打成 `acdev-guest-<版本>.tar.gz` (传到 `<run 号>/guest/`). `pkgs` 用 nc + tar 从 .127 取回这次要发的 `build-*` 和 `guest`, 只取其中的归档 (不要调试信息), 用 libacde 的 `acde-api` 作 SDK 跑 `dist.ts --runtime` 把它们放进版本目录, 写 `latest.json`, 解开 CLI 归档检查 `bin/acdev` 能起 (`--help`) 并对一个最小的手写应用跑通 `acdev check` (`--help` 不加载清单规则那部分代码; 858bcef0 之前漏定义 `ACDEV_MIN_API_LEVEL`, 归档里的命令一跑就找 `lib/acdev/acde-api/min-api-level`, 只跑 `--help` 看不出), 把整个发布目录传到 `<run 号>/acdev-release/` (加 `run.json`: 版本、提交、libacde、`release`、运行号), 再用仓库根的 `scripts/release-guard.ts` 核对产物恰好是允许清单 (每个平台的 `acdevrt` 和 `acdevtools` 都在、各只有那一个程序) 并重新做泄漏检查, 过了才把 .127 上的 `latest` 指到这次运行. 之后是 `test`.
  `release.yaml` 的 `r2`: 从 .127 取回 `<run>/acdev-release`, 核对 `latest` 是输入的版本、`latest.json` 的 `tag` 是输入的标签, 先 `sha256sum -c`, 再按 `SHA256SUMS` 列的文件逐个传到 R2 的 `acdev/<版本>/<文件>` (名字只许 `[A-Za-z0-9._-]`; 没有 sync、递归或通配; `public, max-age=31536000, immutable`), 最后是 `SHA256SUMS`, 逐一回读校验; 已存在且逐字节相同则跳过 (重跑), 不同则失败 (不覆盖). 再更新 `install.sh`、`install.ps1`、`install.md` (`text/markdown`)、`latest`, 最后才是 `latest.json` (这几个 `public, max-age=0, must-revalidate`). 标签在上传之前就已推送 (`tag.yaml` 的顺序: 标签 → 上传); 上传失败时在同一个提交上重跑 `tag.yaml`: `plan` 取这个提交上的 `v*` 标签作版本, 各作业复用产物 (见下), 标签已指向同一提交而继续, R2 上已有的文件逐字节相同而跳过. 没有 CDN 要失效: Worker 照对象自己的 Cache-Control 回, 版本目录里的文件从不覆盖, 指针每次都回源确认.
  R2 走它的 S3 接口: curl `--aws-sigv4 'aws:amz:auto:s3'` (同 AC/os 的 `scripts/r2.sh`), 端点 `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/pkgs`; 一次 PUT 传整个文件 (上限 5 GB), 读用 GET 看状态码 (200 在, 404 不在, 其他失败). `the R2 helpers` 那一步把这几个函数写进 `$RUNNER_TEMP/r2.sh`, 只有上传和指针两步 (和 `pacman` 的 `publish`) 带密钥 (env 锚点 `&keys`) 并 source 它; 密钥经 stdin 给 `curl -K -`, 不上命令行, 不打印, 不用 `set -x`. 凭据是 Gitea AC 组织的 secrets `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` (只能读写桶 `pkgs` 的对象的 R2 API 令牌), 经 `secrets: inherit` 进被调的工作流. 以前的 AWS (IAM 用户经 `aws sts assume-role` 换角色、CloudFront 失效) 2026-11-22 去掉 (用户定: AWS S3 / CloudFront 和腾讯 COS 都不用了).
  并发: 只有 `build.yaml` 有并发组 (用户定 2026-11-23): 推送和手动共用 `acdev-build-main`, `cancel-in-progress: true`, 新的构建取消还没跑完的上一次 (连它的测试); 被 tag.yaml 调用时组是 `acdev-build-<运行号>`, 每次发版自成一组, 不取消别人也不被取消. `tag.yaml`、`test.yaml`、`release.yaml` 没有组, 发版和构建各自占空闲的 runner. 每个作业的目录各自独立 (`~/.cache/act/<id>/`), `latest` 只往前走; 发版写 pacman 数据库时 publish.sh 乐观写入并重试.
  复用已有产物 (同 ackernel): `build` 每格、`guest`、`pkgs` 先算自己的输入 (`build`: 提交、libacde、版本、平台; `guest`: 提交、版本; `pkgs`: 提交、libacde、版本、`targets`) 的散列, 查 .127 的 `acdev/built/<目录>-<散列>` (内容是当时编出它的运行号); 有记录且那次的 `<运行号>/<目录>` 还在, 就用 nc + tar 取回、原样传到本次的 `<运行号>/<目录>/`, 后面的检出、编译、打包、guard 都在步骤级 `if` 上跳过 (作业照常成功, 下游不受影响; 作业级跳过在 Gitea 上会连带跳过下游); 否则照常编, 编完写记录. `pkgs` 另写 `built/libacde-<提交>-<版本>` (那次用的 libacde), 发版构建的 `plan` 读它, 有就用那个 libacde 而不是 main 的头, 所以推 main 的预演过了之后, 在同一提交上跑 `tag.yaml` (版本相同: 之间没有别的发版) 各作业都复用, 发出去的就是预演过 guard 的那些字节. 重新构建的产物不保证逐字节相同, 记录或产物不在了才会重编, 那时 R2 那步可能因内容不同而失败 (不覆盖).
  **当前状态 (2026-11-21, 那时还在 S3)**: 0.1.2 (提交 c34aa61e) 的 S3 `acdev/0.1.2/`、`SHA256SUMS` 和标签 `v0.1.2` 由 run 2765 发出; `install.*`、`latest`、`latest.json` 和 CloudFront 失效是用户 2026-11-21 让主会话照当时 `publish` 作业的做法用 .127 上 28 号的 `acdev-release` 手动补的; npm 上只有 0.1.0、0.1.1 (2026-11-18 发的), 0.1.2 没发. 2026-11-22 起桶换成 R2, 旧内容 (`acdev/` 下 install.*、latest、latest.json、0.1.1/、0.1.2/) 已原样拷过去.
  发版由负责发版的人做 (用户 2026-11-20 定): 我们只跑预演 (`build.yaml`), 不跑 `tag.yaml`, 也不续发 0.1.2.
  在内网 Gitea 1.27.1 上跑 (`http://gitea.dopamine/AC/acdev/actions` → 选工作流 → Run workflow; Gitea 读 `.github/workflows`; 没有 GitHub 镜像, 工作流只照 Gitea 写). 嵌套调用 (tag → build → test)、被调工作流的输出、`secrets: inherit`、被调工作流里的 `concurrency` 都在这台 Gitea 上验过 (2026-11-22, 用一个用完即删的仓库). 标签用 git 查、
  `git push` 推, 不用 `gh`. 不用 Gitea 自己的产物 (upload / download-artifact), 作业间的文件都经 .127.
  Gitea 的步骤默认 `bash -e -o pipefail`; 作业打的标签先在 Gitea 上; main 和发版 tag 同步到 GitHub 0x00-Community/acdev (用户定 2026-11-24).
  `test/release/workflow.test.ts` 检查这些不变量 (正好四个工作流、各自的触发和输入、作业关系与 `needs`、调用链、权限分配、并发组、版本的来源、每个平台编 acdev 和 acdevtool、`test.yaml` 不编、作业不装工具 (`pacman` 除外)、产物经 .127、`release.yaml` 只写 R2、`latest.json` 最后、只允许 main 发布、幂等规则、密钥只在要用的步骤里且不上命令行、没有 AWS / CloudFront、桶和前缀、`pacman` 的压缩和发布).
- **pacman 仓库 `agentcomputer`** (`release.yaml` 里 `r2` 之后的作业 `pacman`, 作业的 `REPO`): acdev 的 pacman 包发进 `pkgs.dopame.ai/agentcomputer/`, 即 Dopame OS 自己的系统软件源 (用户定 2026-11-23, 和 acdes、ackernel、acinstaller 等共用; 数据库 `agentcomputer.db` 和包平放, 只有 x86_64). `acdev/` 下只有发版文件 (版本目录、指针、安装器), 不是 pacman 仓库. 跑在 `x86_64-arch` 执行机上 (要 makepkg、repo-add、bsdtar、fakeroot; 缺了用 sudo pacman 装, 同 AC/os 的 build.yaml 和 acdes 的 release.yaml). 先读 `agentcomputer/agentcomputer.db` (公开地址, 它是 `no-cache`): 已经列着 `acdev-<版本>-*-x86_64.pkg.tar.zst` 就什么都不做 (makepkg 每次打出的字节不同, 发过的包文件不覆盖). 否则用 `ACKERNEL_TOKEN` (没有时 `github.token`) 浅克隆 AC/os, 跑它的 `scripts/ci/acdev-package.sh <目录> <run>` (从 .127 取那次的 `acdev-release`, 用 os 的 `packages/acdev/PKGBUILD` 打包, 布局同 install.sh 装出的 `~/.acdev/current`, 在 `/usr/lib/acdev`), 再 `scripts/publish.sh agentcomputer <包>` (传包、改数据库、删旧包, 用同样的 R2 secrets; 别的仓库也发进这个源, 没有能跨仓库的并发组, publish.sh 乐观写数据库, 被覆盖就重来). makepkg 的压缩不随执行机: `XDG_CONFIG_HOME` 指向临时目录, 里面的 `pacman/makepkg.conf` 写 `PKGEXT='.pkg.tar.zst'` 和 `COMPRESSZST=(zstd -c -T0 -3 -)` (makepkg 在 `/etc/makepkg.conf` 和 `makepkg.conf.d/` 之后读它, 但只在没设 `MAKEPKG_CONF` 时, 所以作业先 unset 它和 `PKGEXT`).
- **npm** (SDK `@acde/api` 是 `private`, 不发 npm: 工程按 `file:` 或 pkgs 上 `acde-api-<版本>.tar.gz` 的地址引用它; 主会话 2026-11-18 定)
  (`tag.yaml` 的最后一个作业 `npm`, 在 `release` 之后; 不在 `release.yaml` 里, 因为标准的 `release.yaml` 只传 R2. 留着是因为 npm 上已有 `@dopame/acdev` 0.1.0、0.1.1 和四个平台包, skill 的安装页和 `acdev doctor` 的修法都指向 npm; 用 repo secret `NPM_TOKEN`, 没有时打一条 warning、什么都不发):
  从 .127 取回本次运行的 `acdev-release` 并 `sha256sum -c`, 按版本目录里的 `acdevrt-<triple>` 每个平台一个 `@dopame/acdev-<os>-<cpu>` (`linux-x64`、`darwin-arm64`、`darwin-x64`、`win32-x64`; 内容按安装后的布局: 命令行归档、
  `libexec/acdev[.exe]`、`libexec/acdevd-*` 和该平台的 `acdevtools` 程序; 运行时包解进 `libexec/`, 以前误解进 `bin/`), 和
  `@dopame/acdev` (一行 JS 的 `acdev.mjs`, 按 `process.platform` / `process.arch` 载入对应平台包的 `lib/acdev/launcher.mjs`; 各平台包是它的 `optionalDependencies`, 平台包带 `os` / `cpu`; 它的 `bin` 现在叫 `acde`, 不是 `acdev`, 0.1.1 也是这样).
  先发平台包、最后发 `@dopame/acdev`, `npm publish --access public`; 这一版已经在 npm 上的包跳过 (重跑).
- 压缩: `dist/cli.js`、`dist/driver.js` (target node)、`dist/test.js` (target bun, `bun:test` 留作外部) 和根上的 `launcher.mjs` 都是 `Bun.build` 的
  `minify: true`, 不出 sourcemap. 打完去掉 shebang 和随之加的 `// @bun`: 带它 bun 不转译、按 latin1 读, 非 ASCII 乱码. `acdev/launcher` 留作外部
  (`launcher.mjs` 在包根, `import.meta.url` 仍指对), 运行时按包的 `exports` 自引用. 归档可复现: 混淆固定 `seed`, 打包前把暂存树的时间戳统一为 2000-01-01, 先 `tar -cf` 再用 `zlib.gzipSync` 压 (gzip 头不写时间), 同一提交两次构建字节相同 (`dist.ts` 里的 `OBFUSCATION_SEED`、`pinTimes`). `*.d.ts` 由 TypeScript 从 `src/driver/index.ts` 和
  `src/e2e/index.ts` 生成到 `dist/types/`. 包根的 `package.json` 由 dist.ts 生成, `exports` 指向 dist (源码仓库的 package.json 不变).
- dist 测试 (`test/release/dist.test.ts`) 需要 SDK: 它用 `acde-api` (同上, 对不上).
- **压缩格式** (2026-11-22, 用户要全换 zstd -3, 先换了不伤安装的部分): Linux 的 `acdevrt-*`、`acdevtools-*` 是 `.tar.zst` (`zstd -T0 -3`, 多线程输出和线程数无关);
  macOS 的仍是 `.tar.xz` (macOS 自带的 bsdtar 3.5.3 / libarchive 3.7.4 没有 libzstd, 解 `.tar.zst` 要调外部 `zstd`, 普通 Mac 上没有; 本机 macOS 27.2 验过);
  Windows 的仍是 `.tar.gz` (Windows 10 自带的 `tar.exe` 是 bsdtar 3.5.2, 只有 zlib, 不认 xz 也不认 zstd; Windows 11 较新的版本带 libzstd, 但不是每台都有);
  两个平台都用的命令行 `acdev-<版本>.tar.gz` 和 `acdev-guest-<版本>.tar.gz` 因此仍是 gzip; SDK `acde-api-<版本>.tar.gz` 必须是 gzip (包管理器按 URL 装 tarball, 只认 gzip).
  格式由 `build` 的 `pack` 按 triple 定, `scripts/release-guard.ts` 和测试按同一规则取名 (`shipped.ts` 的 `compression` 给出 tar 的压缩参数).
- **install.sh** (sh / dash / `bash --posix`): 认 triple (Rosetta 里按 `sysctl.proc_translated` 换 aarch64; 有 `/lib/ld-musl-*` 是 musl; MSYS 叫去用
  install.ps1), 按 triple 选 `acdevrt-<triple>` (SHA256SUMS 里列着 `.tar.zst` 就取它, 否则 `.tar.xz`; tools 包同理); 解 `.tar.zst` 先用 `zstd` 解到临时目录再 `tar -xf`, 没有 `zstd` 时
  要 tar 自带 libzstd (`tar --version` 里有), 都没有时在下载 acdev runtime 之前就失败并提示装 zstd; 解 `.tar.xz` 要 tar 认 xz: bsdtar (macOS) 自带, GNU tar 调 `xz`,
  两样都没有时同样先失败并提示装 xz / xz-utils; 包里必须有普通文件 `acdev runtime`; curl / wget 下载 (`fetch` 取小文件, 不出声;
  `download` 取 acdev 包、acdev runtime、guest 和 tools 包: stderr 是终端时 curl `--progress-bar` / GNU wget `--show-progress` (在临时目录里按文件名下, 进度条标的是文件名),
  不是终端时 (agent、CI) 和 fetch 一样安静; 每个下完校验后一行 `<文件>: <大小>, SHA-256 matches`; 开头先说一行在做什么. 超时: curl
  `--connect-timeout 20 --retry 2 --speed-limit 1024 --speed-time 30` (30 s 不到 1 KB/s 算卡住, 重试两次后失败), wget `-T 30`, GNU wget 再加
  `--tries=3`; BusyBox wget 不认 `--tries` / `--show-progress`, 只用 `-q -T 30 -O`. 进度测试用 `Bun.spawn` 的 `terminal` 开伪终端), shasum / sha256sum / openssl 校验, acdev 和 acdev runtime 都下载校验完、在暂存目录里
  拼好 (`libexec/acdev` 和 guest、tools 包里的程序) 才动安装目录, 失败什么都不动. 解进 `$ACDEV_INSTALL` (默认 `~/.acdev`) 的临时目录再改名成
  `versions/<版本>`; `current` 原子换 (`mv -T` / `mv -h`, 退回 `ln -sfn`); `bin` → `current/bin` (相对链接). 换完后清旧版本 (acde#93): 只留这次装的和 `current` 原先指的那个, 其余 `versions/*` 删掉; 还有程序在用的 (Linux 看 `/proc/*/exe`, 再看 `ps -axo command=` 里有没有那个目录) 留着, 说一声下次再删. `install.ps1` 同理: 先把旧版本改名成 `<版本>.old-<guid>` (里面有文件被占用时改名失败, 就留着), 改名成功再删. PATH 上没有且没给 `--no-modify-path` 时按
  `$SHELL` 往 zsh / bash (macOS 加 `.bash_profile`) / fish / `.profile` 的启动文件加一次. sh 一族的那行是
  `case ":$PATH:" in *":$HOME/.acdev/bin:"*) ;; *) export PATH=… ;; esac`: 同时读 `.zprofile` 和 `.zshrc` (登录的交互 zsh) 或 `.profile` 和 `.bashrc`
  的 shell 里也只加一次; 以前装的不带判断的整行原地换成这行 (`awk` 改写, 写回原文件). 这个终端的 PATH 上没有时, 输出的最后单独一行是
  这个终端里要敲的 `export PATH=…` (fish 是 `fish_add_path`): 装完在原来的终端里敲 `acdev` 是 command not found, 人会漏看夹在中间的提示.
- **install.ps1** (Windows PowerShell 5.1 或 PowerShell 7.2+, 只有 x64): 出错 `throw` 不 `exit` (`irm | iex` 时 `exit` 关掉用户的终端); 参数也可走
  `ACDEV_VERSION` / `ACDEV_NO_MODIFY_PATH`; 用系统的 `tar.exe`. 下载不用 `Invoke-WebRequest` (5.1 上它的进度条每块重画, 下载慢几倍, 所以以前全程
  `SilentlyContinue`, 87 MB 一声不吭): `Save-Remote` 用 `System.Net.Http.HttpClient` 流式写文件, 每个异步操作按 250 ms 轮询等 (Ctrl+C 能停),
  30 s 没数据算卡住 (`TimeoutException`), 连接失败、卡住、5xx/408/429、提前断开重试, 共 3 次, 其他 HTTP 错误直接失败 (`HTTP 404`).
  `-Shown` 的下载 (acdev 包、acdev runtime、guest 和 tools 包) 在终端里每 200 ms 一次 `Write-Progress` (标题是文件名, 已下/总量、速度、剩余秒数), 条件是调用方的
  `$ProgressPreference` 不是 `SilentlyContinue` (开头先记下, 再为脚本本身设成静默) 且输出没被重定向; 每个下完校验后一行
  `acdev: <文件>: <大小>, SHA-256 matches`, 和 install.sh 一样. Linux 上的 pwsh 7.4 / 7.6 跑过下载部分 (跳过 Windows 检查); Windows PowerShell 5.1 没在真机上跑过. triple 按 `PROCESSOR_ARCHITECTURE` (WOW64 下看 `PROCESSOR_ARCHITEW6432`):
  `x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc`, 取 `acdevrt-<triple>.tar.gz` (不用 xz: 安装器只用系统的 `tar.exe`, Windows 10 带的那个不一定认 xz), 用 `tar.exe` 解出 `acdev.exe`; 同样先在临时目录拼好整个版本目录 (`libexec\acdev.exe` 和 guest、tools 包里的程序) 再换. 同版本已在时整体改名挪开 (`<版本>.old-<guid>`, 改名失败才报「还在运行」), 装好再删,
  删不掉留到下次 (`Remove-Item -Recurse` 遇到占用的文件连 `-ErrorAction Stop` 都不停). `current` 是 junction, 先建 `current.next` 再换. PATH 加
  `current\bin` (`bin` 不做成链接: `acde.cmd` 的 `%~dp0..` 按字面算), 写 `HKCU\Environment` 的 `Path` (`DoNotExpandEnvironmentNames` 读、写回
  `REG_EXPAND_SZ`, 原有的 `%…%` 不展开), 设用户级 `ACDEV_INSTALL` (顺带广播 `WM_SETTINGCHANGE`), 当前会话也加上.
- **launcher** (`launcher.mjs`, 只用 `node:` 模块, 类型手写在 `launcher.d.mts`; 源码一律 `import … from 'acdev/launcher'`): `bin/acdev.mjs` (检出用) →
  `run`: `cliRuntime()` 跑 `cliFile()` (`dist/cli.js`, 否则 `src/cli.ts`, 这时 Node 上找 PATH 上的 bun), 环境 `cliEnv`; unix 上 SIGINT、SIGTERM、
  SIGHUP 都转给子进程 (只发给 launcher 的 SIGINT 也要停下 `acdev dev`, acde#91; 终端 Ctrl+C 时子进程收到两份, `acdev dev` 合并成一次, 见 `acde-dev.md`;
  别的命令要么收到第一份就退, 要么第二份无害), Windows 上 SIGINT 只吞掉 (Ctrl+C 本来就到子进程), 别的不转. 全局装的
  `bin/acdev` 不经它. `requireAcdert()`: `ACDEV_RUNTIME` (设了找不到直接报错), 全局装时安装器放在旁边的
  `libexec/acdev[.exe]` (旧装法是 `bin/acdert[.exe]`; `runtimeBeside` (旧名 `acdertBeside` 留一版), 同一版本目录), 最后 PATH; 检出跑的 acdev 只认 `ACDEV_RUNTIME` 和 PATH. 都没有时报错, 说出安装器该放的位置.
- musl 的 libacde 在 Alpine 上编 (`-C target-feature=-crt-static`, 动态链接 Alpine 的库).

## 执行机的工具链 (2026-11-18)

ci-debian 执行机是 gitea-runner 6.0.0 (原名 act_runner, 2026-11-19 从 0.6.1 升上来) 的宿主模式 (不在容器里), capacity 2 (用户定, 2026-11-18): 同一台上的两个作业共用 cicd 的家目录.
所以作业不装任何东西 (run 2562 里一格的 rust-cache 收尾清掉共用的 `~/.cargo`, 另一格的 cargo 就没了, 退出码 127), 工具链由 root 在 ci-debian 里跑
`scripts/runner-setup.sh` 预装, 归 root, 作业只能读; 升级: 执行机空闲时再跑一次.

- Debian 包: 构建要的库 (Linux 目标)、clang / lld / llvm (交叉)、测试要的 Mesa 软件 Vulkan、字体、python3-venv, 还有 zstd (打 Linux 的归档)、jq、awscli (acdev 已不用, 别的仓库的作业还用)、rsync、openssh-client. 执行机自带 node 20、npm 9、nc.
- Rust: rustup 的 stable 在 `/opt/rust` (`RUSTUP_HOME=/opt/rust/rustup`, `build.yaml` 的全局 env 设它; `test.yaml` 不用 Rust); 目标: 两种架构的 linux-gnu 和 linux-musl、
  x86_64-pc-windows-msvc、两个 apple-darwin; 组件 clippy、rustfmt. 不用 Debian 的 rustc: 1.85 太旧 (`as_chunks` 要 1.88, 依赖只写主版本号, 跟最新),
  也没有 msvc 和 darwin 的标准库.
- `/opt/cross`: bun 1.4.4、cargo-xwin 0.23.1 (只在 x86_64)、cargo-zigbuild 0.24.1、zig 0.17.1、`MacOSX15.5.sdk` (下载都校验 SHA-256, 整个目录换新).
- 命令都链进 `/usr/local/bin` (cargo、rustc、rustup…、bun、bunx、zig、cargo-xwin、cargo-zigbuild).
- 跨运行留在执行机家目录的: cargo 的下载 (`~/.cargo`, cargo 下载时自己加锁), `~/.cache/cargo-xwin-atl`, `~/.cache/zig`.

`mach-dxcompiler-rs` 0.1.4 的静态 DXC 要链 MSVC 的 ATL (`atls.lib`): Windows 那格设 `XWIN_INCLUDE_ATL=true` 和
`XWIN_CACHE_DIR=$HOME/.cache/cargo-xwin-atl`. cargo-xwin 的缓存目录不随 ATL 开关区分, 共用默认目录时, 不带 ATL 先填的缓存会让后来的链接报
`lld-link: error: could not open 'atls.lib'` (run 2545).

宿主模式把远程 action 的 git 仓库拷进作业缓存, 同一作业第二次准备同一个 action 时覆盖只读的 pack 文件失败 (run 2542, `pack-*.idx: permission denied`):
同一个作业里同一个远程 action (`uses: http://...`) 只出现一次 (现在只剩 checkout). 没有本地 action (`.github/actions`, 用户定 2026-11-18):
要复用的步骤在同一个文件里用 YAML 锚点 (`- &名字` 定义一次, 别的作业 `- *名字`), Gitea 认锚点. 步骤的 shell 是 `bash --noprofile --norc -eu {0}`
(工作流的 `defaults`; 不带 pipefail: plan 里取版本的管道允许空).

`test.yaml` 的 `&cleanup` 那一步只结束所属作业目录 (`~/.cache/act/<id>/`) 已经删掉的进程和端口 18000-18009 的占用者: 被取消的作业留下的; 同一个
runner 上正在跑的另一个作业目录还在, 不碰. 两个 WPT 作业同时落在一台机器上仍会争这些端口 (同一运行里 gate 和 wpt 二选一; 发版的测试和推送的预演的测试,
或手动的测试和别的测试同时跑时才会: 工作流都没有并发组).

## 产物机 .127 (2026-11-18)

产物只放 .127, runner 上长期只留工具链 (用户定, 2026-11-18). .127 不是 CI 机: 没有 cicd 用户、没有工具链, 只有用户 `artifacts`
(`/etc/nixos/artifacts.nix`, 家目录 `/srv/artifacts`), 每个仓库一个目录 (`ackernel`、`acinstaller`、`acdev`).

- 写: 各仓库的 CI 用自己的密钥经 ssh 写 (acdev 的是 secret `ARTIFACTS_UPLOAD_KEY`), 密钥在 .127 上限成 `rrsync -wo /srv/artifacts/<仓库>`
  (只能写, 不能读、列、删). 锚点 `&ssh` 那一步把密钥和 .127 的主机密钥写进 `$RUNNER_TEMP/ssh`, 设 `RSYNC_RSH`; 之后 `rsync -rt … "$TO:<路径>/"`.
  rrsync 3.5.0 不能覆盖目标位置上同名的已有文件, 所以一律传到目录 (`host:dir/`), 不写 `host:dir/file`; rsync 只建目标的最后一级, 所以带 `--mkpath` (rrsync 放行它; run 2583 没带, `<run 号>/build-*/` 建不出来).
- 读: 不用 http / ftp (用户定), .127 的 `artifacts-tar@` (端口 9127, socket 激活, 沙箱) 读一行相对路径, 回 `tar -C /srv/artifacts -cf - <路径>`:
  `printf 'acdev/<路径>\n' | nc $PULL | tar -x`. 没有认证, 拒绝 `..` 和绝对路径, 不存在的路径回空 (tar 报错, 工作流里吞掉再查目录). 千兆上约 110 MB/s.
- 布局: `build.yaml` 的 `acdev/<run 号>/` 下 `build-<triple>/` (含 `symbols/`)、`guest/`、`acdev-release/` (发布目录) 和 `run.json`; `acdev/built/` 是复用记录 (见「发布」)
  (`version`、`commit`、`libacde`、`release`、`run`; `test.yaml` 读它), `acdev/latest` 是最近一次过了 guard 的 run 号; test 的 `acdev/test-<run 号>/` 下 `wpt-gate/`、
  `wpt-shard-<n>/`、`wpt-expectations/`、`demo-e2e/` (baseline 的 `expectations` 作业从这里取回各 shard 的结果). 对外发布是 `release.yaml` 传 R2 (见「分发」的「发布」).
