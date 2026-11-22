# 发版与分发

> CLI 相关路径相对 `npm/`, 安装器在仓库根 `scripts/`。

发版 (`.github/workflows/cicd.yaml`, 在 Gitea 上手动跑或推标签 `v<版本>`, 说明在下文「分发」的「发布」): 一次发布、一个版本号, 把四个平台的
`acdevrt-<triple>` (运行时)、`acdevtools-<triple>` (宿主小工具 `acdevtool`)、客户机守护进程 `acdev-guest-<版本>.tar.gz` (两个架构的 acdevd)、SDK `acde-api-<版本>.tar.gz`、`acdev` 命令行和安装器一起放进
`pkgs.dopame.ai/acdev/<版本>/`, 同一版本也发到 npm (`@dopame/acdev`、`@dopame/acde-<os>-<cpu>`、`@acde/api`, 见「npm」), 标签 `v<版本>`
打在本仓库. 版本号不用先提交: 推的标签给出它, 否则用输入 `version`, 都没有时取 pkgs 的 `latest.json`、npm 上两个包和 `v*` 标签里最高的版本加一个
补丁号; 各作业用 `scripts/set-version.sh <版本> acdev` 把它写进本仓库和旁边 libacde 的 `Cargo.toml` 的 `[workspace.package]`
(crates/hostwin 跟本仓库的走, 运行时库跟 libacde 的走)、`npm/package.json` 和 SDK 的 `libacde/acde-api/package.json` (不提交).
运行时库是并排检出的 libacde (`cicd.yaml` 里锚点 `&libacde` 那一步, `build` 和 `pkgs` 用: 经令牌克隆, 带子模块 `vendor/blitz`; `plan` 读一次 libacde 的 main, 输出 `libacde`,
`build` 和 `pkgs` 都检出这一个提交),
页面资源和启动器已嵌进 acdev 二进制, 不再有 `acde-host` 包和 `libexec/app` (2026-11-18 起; 原 AC/acdert 已归档).

## 构建耗时与并行 (cicd.yaml)

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
(`https://pkgs.dopame.ai`, S3 桶 `dopame-pkgs` 经 CloudFront `E3ET3L14ALFOXX`), `Doctor.DIST`、`Sdk.DIST`、测试都引用它; 脚本不能 import,
`scripts/dist.ts` 打包前用 `Pkgs.scriptProblems` 对两个脚本的默认值, 不一致就失败 (`test/pkgs.test.ts` 也查). 前缀 `acdev/` (桶里只有它和 `iso/`; 以前的 `acde/`、`acdert/`、`acde-dopame/` 连同旧版本 2026-11-18 删掉, 用户定): `acdev/install.sh`、
`acdev/install.ps1`、`acdev/install.md` (给 agent 读的安装步骤, 见 `skills.md`)、`acdev/latest`、`acdev/latest.json`, 和版本目录 `acdev/<版本>/`:
`SHA256SUMS` (下面每个文件一行)、`acdev-<版本>.tar.gz` (命令行, 一个通用包)、`acde-api-<版本>.tar.gz` (SDK, `package/` 布局, 只有类型
声明, 工程的 `@acde/api` 指向它)、`acdevrt-<triple>.tar.xz` (Windows `.tar.gz`, 里面只有 `acdev[.exe]`)、
`acdev-guest-<版本>.tar.gz` (`acdevd-x86_64`、`acdevd-aarch64`: 装进客户机的设备守护进程, 静态 musl, 和宿主平台无关)、
`acdevtools-<triple>.tar.xz` (Windows `.tar.gz`, 里面只有 `acdevtool[.exe]`, 每个平台都有). `acdevtool` 是 `crates/tool` 的一个程序, 两个子命令:
`relay SOCKET` (Windows 上命令行经它连 QMP 和客户机代理的 Unix 套接字) 和 `view` (客户机窗口, 见 `viewer.md`; 只在 unix 上编进去, 命令行目前只在 Linux 上用). 官网 `https://dopame.ai/install.*` 指向这里. 发布由仓库根 `.github/workflows/cicd.yaml` 完成 (见下). 本地托管目录就是
dist.ts 的 `--out`: `install.sh`、`install.ps1`、`install.md`、`latest` (版本号) 和上面的版本目录.

**运行时**: 命令行、调试运行时、页面资源和 SDK 是同一次发布, 同一个版本号 (用户定, 2026-11-14), 都在 `acdev/<版本>/` 里, 由同一份 `SHA256SUMS`
校验. 安装器 (含 `--version` / `-Version`) 取 `acdev-<版本>.tar.gz`、`acdevrt-<triple>.tar.xz` (Windows `.tar.gz`), 再取 SHA256SUMS 里
列着的 `acdev-guest-<版本>.tar.gz`、`acdevtools-<triple>` (和旧版本才有的 `acde-host-<版本>.tar.gz`), 都校验后才落位: 运行时放成
`libexec/acdev[.exe]`, guest 和 tools 包里的程序原样放进 `libexec/` (`libexec/acdevd-x86_64`、`libexec/acdevd-aarch64`、`libexec/acdevtool[.exe]`), 旧版本的 `app/` 放成 `libexec/app/`. 命令行找它们: `crateBinary` (`npm/src/vm/binary.ts`) 先看环境变量 (`ACDEV_DEVD`、
`ACDEVTOOL`), 再看安装目录的 `libexec/<名字>` (launcher 的 `libexecBeside`; acdevd 按客户机架构取 `acdevd-<x86_64|aarch64>`),
再看检出的构建产物. 0.0.9 及更早的版本是
命令行和 acdert 分开发的 (版本目录里有 `acdert-version`), 现在的安装器不装它们, 提示去掉 `--version` 装最新的. 没有这个平台的构建 (报出有哪些
平台)、下载或校验失败, 都在动安装目录之前失败, 之前装的版本和 `current` 照旧. Dopame 桌面包不随 acdev 安装.

装好后一个版本目录 (`versions/<版本>`; 归档里的顶层目录 `acdev-<版本>/` 加上安装器放的两项) 是:

```
bin/acdev            bin/acdev.sh 跑 lib/acdev/dist/cli.js: bun ≥ 1.4 用 bun, 否则 node ≥ 22.3 用 node; 都不行时 bun 太旧提示更新 bun, 否则 node 太旧提示更新 node, 都没有提示装其中一个
bin/acdev.cmd        Windows 的启动器: bin/acdev.cmd (CRLF), 同样的选法和提示; PowerShell 调 .cmd 时经 cmd 会丢掉参数里的双引号 (acde#33); 按 `where bun.exe` / `node.exe` 的完整路径直接调 (yarn 4 跑脚本时 PATH 最前面是它的 `node.cmd` 包装, 不带 `call` 调 .cmd 不会回来, acdev 一声不响地退出 0; `call` 又会把参数里的 % 再展开一次)
libexec/acdev[.exe]  安装器放的调试运行时 (不在 acdev 归档里)
libexec/acdevd-x86_64, libexec/acdevd-aarch64   客户机的设备守护进程 (acdev-guest 包)
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
- **发布** (`.github/workflows/cicd.yaml`, 手动运行 `workflow_dispatch`, 或推送标签 `v*`): 协作者的工作流为基础, 合入以下要求. 版本由 `plan` 定 (见上文开头: 推的标签、输入 `version`、或已发布的最高版本加一), 不以提交里的 `package.json` 为准; 手动发布时标签 `v<版本>` 是注释标签, 由工作流打在该提交上; 推送标签 `v<版本>` 本身就是正式发布 (`plan` 把它当 `publish`, 提交取标签指向的那个, 版本取标签名). 命令行、四个平台的 acdev runtime、页面资源和 SDK 一起发 (见「运行时」); Dopame 桌面不随 acdev 发布.
  发版: 在 Gitea 上手动跑 cicd (勾 publish, 填 `commit=<sha>`, 可填 `version`、`skip_targets`), 或在 main 的提交上推标签 `v<版本>`. `commit` 是 origin/main 上的提交 (完整或短 SHA), 正式发布必填. 预演: 同样手动跑, 不勾 publish (可省略 `publish` 与 `commit`, 用运行分支的头; 任何分支都可以, 只构建、打包、跑 guard, 不打标签、不上传).
  所有作业都直接跑在执行机上, 不用容器 (2026-11-18 起: ci-debian 执行机没有 Docker; 执行机自带的 node 20、npm 9 够 `node -p` 和 npm 那几步用, CLI 的冒烟测试走 bun; 工具链都由 `scripts/runner-setup.sh` 预装, 作业什么都不装, 见「执行机的工具链」), 不用 Ubuntu 的环境; `runs-on` 一律 `x86_64-debian` (`build` 的 Apple silicon 那一格除外, 在 `aarch64-debian`: aarch64 的 ci-debian 执行机共有的标签, 现在只有 .210) (三台 ci-debian 执行机 .110、.234、.243 共有的标签, 谁空谁接; 2026-11-18 起, 之前的 `debian12` 已不存在), GitHub 上也是: 不用任何 Ubuntu runner (用户定, 2026-11-13);
  作业顺序: `plan` 把 `commit` 解析为完整 SHA, 它必须是 origin/main 的祖先或等于 main 头 (否则失败); 正式发布只允许在 `main` 上运行; `v<版本>` (plan 的检出带全部历史和标签, 用 `git rev-parse` 查, 不调 forge 的 API) 不存在或指向该 SHA 才继续, 指向该 SHA 时允许重跑. 之后所有作业都 checkout 这个 SHA. `skip_targets` 定下要编的平台, 跳过的平台的 `build` 那一格在作业级 `if` 上跳过.
  `build` (每个平台一格: Linux 原生, Windows 用 cargo-xwin, macOS 用 cargo-zigbuild 和 MacOSX15.5 SDK; 都在 x86_64-debian 执行机上, 只有 `aarch64-apple-darwin` 在 `aarch64-debian` 执行机上 (现在只有 .210; 以后加的 aarch64 ci-debian 执行机自动纳入; 用户定, 2026-11-18), 那里 cargo-zigbuild 取 aarch64 gnu 版、zig 取 aarch64-linux 版, 按 `uname -m` 选) 拉 libacde 和它的 `vendor/blitz`, `cargo build --profile dist -p acdev` (ac 源用 `ACKERNEL_TOKEN`), 再在 `crates/tool` 里用同一套交叉工具 `cargo build --release` 编 `acdevtool`, 打成各只有一个文件的 `acdevrt-<triple>` 和 `acdevtools-<triple>` (固定时间和属主), 分离的调试信息放在同一个产物的 `symbols/` 里 (都传到 .127 的 `<run 号>/build-<triple>/`, 不发布). `guest` 和 `build` 并行, 在 `crates/devd` 里编两个架构的 acdevd (静态 musl, `crates/devd/.cargo/config.toml` 的 rust-lld) 打成 `acdev-guest-<版本>.tar.gz` (传到 `<run 号>/guest/`). `pkgs` 用 nc + tar 从 .127 取回这次要发的 `build-*` 和 `guest`, 只取其中的归档 (不要调试信息), 用 libacde 的 `acde-api` 作 SDK 跑 `dist.ts --runtime` 把它们放进版本目录, 写 `latest.json`, 解开 CLI 归档检查 `bin/acdev` 能起, 把整个发布目录传到 `<run 号>/acdev-release/` (加 `run.json`), 再用仓库根的 `scripts/release-guard.ts` 核对产物恰好是允许清单 (每个平台的 `acdevrt` 和 `acdevtools` 都在、各只有那一个程序) 并重新做泄漏检查, 过了才把 .127 上的 `latest` 指到这次运行; 预演到这里为止.
  正式发布是一个作业 `publish` (只有它有 `contents: write`): 从 .127 取回 `acdev-release`, 先 `sha256sum -c`, 再按 `SHA256SUMS` 列的文件逐个 `aws s3 cp` (名字只许 `[A-Za-z0-9._-]`; 没有 sync、递归或通配), 最后是 `SHA256SUMS`, 逐一回读校验; 已存在且逐字节相同则跳过 (重跑), 不同则失败 (不覆盖), 所以上传失败不会留下标签. 上传通过后打注释标签 `v<版本>` 并推送, 再换一次凭据 (上传可能用掉大半小时), 更新 `install.sh`、`install.ps1`、`install.md` (`text/markdown`)、`latest`, 最后才是 `latest.json`, 然后失效 CloudFront 的这些路径和 `/acdev/<版本>/*`, 最后发 npm (见下). 凭据: Gitea 仓库密钥 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 经 `aws sts assume-role` 换角色 `dopame-acde-release` 的临时凭据 (先 mask, 从不打印, 不用 `set -x`); 角色只能读写 `dopame-pkgs/acdev/*` 和失效这个分发 (2026-11-18 从 `acde/*` 改过来). `concurrency: acdev-release` 让发版排队且不取消进行中的运行.
  复用已有产物 (同 ackernel): `build` 每格、`guest`、`pkgs` 先算自己的输入 (`build`: 提交、libacde、版本、平台; `guest`: 提交、版本; `pkgs`: 提交、libacde、版本、`targets`) 的散列, 查 .127 的 `acdev/built/<目录>-<散列>` (内容是当时编出它的运行号); 有记录且那次的 `<运行号>/<目录>` 还在, 就用 nc + tar 取回、原样传到本次的 `<运行号>/<目录>/`, 后面的检出、编译、打包、guard 都在步骤级 `if` 上跳过 (作业照常成功, 下游不受影响; 作业级跳过在 Gitea 上会连带跳过 `publish`); 否则照常编, 编完写记录. `pkgs` 另写 `built/libacde-<提交>-<版本>` (那次用的 libacde), 正式发布时 `plan` 读它, 有就用那个 libacde 而不是 main 的头, 所以先预演、再勾 publish 发同一提交同一版本, 各作业都复用, 发出去的就是预演过 guard 的那些字节; 发版中途失败, 同样的 `commit` 和 `version` 再跑一次 publish, S3 上已有的文件逐字节相同而跳过、标签已指向同一提交也跳过, 接着做没做完的指针、CDN 和 npm. 重新构建的产物不保证逐字节相同, 记录或产物不在了才会重编, 那时 S3 那步可能因内容不同而失败 (不覆盖, 不留标签).
  **当前状态 (2026-11-21)**: 0.1.2 (提交 c34aa61e) 的 S3 `acdev/0.1.2/`、`SHA256SUMS` 和标签 `v0.1.2` 由 run 2765 发出; `install.*`、`latest`、`latest.json` 和 CloudFront 失效是用户 2026-11-21 让主会话照 `publish` 的做法用 .127 上 28 号的 `acdev-release` 手动补的; npm 还没发.
  发版由负责发版的人做 (用户 2026-11-20 定): 我们只跑不勾 `publish` 的构建, 不推发版标签, 也不续发 0.1.2.
  第二次换凭据时, 第一次的角色会话令牌还在环境里 (`AWS_SESSION_TOKEN`, 经 `GITHUB_ENV`), 和长期密钥配在一起 STS 会拒绝 (0.1.2 的 run 2765), 所以 `assume-role` 在 `env -u AWS_SESSION_TOKEN` 下调用.
  在内网 Gitea 上跑 (`http://gitea.dopamine/AC/acdev/actions` → `cicd.yaml` → Run workflow; Gitea 读 `.github/workflows`; 没有 GitHub 镜像, 工作流只照 Gitea 写): 是否发布只在 `plan` 里由 shell 判断一次 (`PUBLISH_INPUT` 是 `github.event.inputs.publish`
  的原样, 等于文字 `true` 才发布, 输出 `publish`), 之后的作业和步骤看 `needs.plan.outputs.publish == 'true'`; 不写 `inputs.publish`, 也不在表达式里
  比较 (这台 Gitea 勾了 publish 时 `inputs.publish` 仍是 false, `github.event.inputs.publish` 是布尔值, GitHub 上是字符串). 标签用 git 查、
  `git push` 推, 不用 `gh`. 不用 Gitea 自己的产物 (upload / download-artifact), 作业间的文件都经 .127.
  `publish` 换角色 `dopame-acde-release` 的凭据: repo secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 是 IAM 用户
  `gitea-acde-release` 的 key, 它只能 assume 这个角色, 用 `aws sts assume-role` (GitHub 的 OIDC 那条路 2026-11-18 去掉了). 同一 concurrency 组的第二次运行在 Gitea 上被取消 (GitHub 排队);
  Gitea 的步骤默认 `bash -e -o pipefail`; 作业打的标签只在 Gitea 上, 不往 GitHub 推 (用户定 2026-11-14: GitHub 不再更新).
  `test/release/workflow.test.ts` 检查这些不变量 (作业关系与 `needs`、权限分配、SHA 固定、版本一致、每个平台编 acdev 和 acdevtool、作业不装工具、产物经 .127、上传先于标签、`latest.json` 最后、只允许 main 发布、commit 必填与祖先检查、幂等规则、遮蔽凭据、角色 ARN、桶、前缀和区域).
- **npm** (SDK `@acde/api` 是 `private`, 不发 npm: 工程按 `file:` 或 pkgs 上 `acde-api-<版本>.tar.gz` 的地址引用它; 主会话 2026-11-18 定)
  (`publish` 的最后一步, 只在正式发布时; 用 repo secret `NPM_TOKEN`, 没有时打一条 warning、什么都不发):
  每个要发的平台一个 `@dopame/acde-<os>-<cpu>` (`linux-x64`、`darwin-arm64`、`darwin-x64`、`win32-x64`; 内容按安装后的布局: 命令行归档、
  `libexec/acdev[.exe]`、`libexec/acdevd-*` 和该平台的 `acdevtools` 程序; 运行时包解进 `libexec/`, 以前误解进 `bin/`), 和
  `@dopame/acdev` (一行 JS 的 `acde.mjs`, 按 `process.platform` / `process.arch` 载入对应平台包的 `lib/acdev/launcher.mjs`; 各平台包是它的 `optionalDependencies`, 平台包带 `os` / `cpu`).
  先发平台包、最后发 `@dopame/acdev`, `npm publish --access public`; 这一版已经在 npm 上的包跳过 (重跑).
- 压缩: `dist/cli.js`、`dist/driver.js` (target node)、`dist/test.js` (target bun, `bun:test` 留作外部) 和根上的 `launcher.mjs` 都是 `Bun.build` 的
  `minify: true`, 不出 sourcemap. 打完去掉 shebang 和随之加的 `// @bun`: 带它 bun 不转译、按 latin1 读, 非 ASCII 乱码. `acdev/launcher` 留作外部
  (`launcher.mjs` 在包根, `import.meta.url` 仍指对), 运行时按包的 `exports` 自引用. 归档可复现: 混淆固定 `seed`, 打包前把暂存树的时间戳统一为 2000-01-01, 先 `tar -cf` 再用 `zlib.gzipSync` 压 (gzip 头不写时间), 同一提交两次构建字节相同 (`dist.ts` 里的 `OBFUSCATION_SEED`、`pinTimes`). `*.d.ts` 由 TypeScript 从 `src/driver/index.ts` 和
  `src/e2e/index.ts` 生成到 `dist/types/`. 包根的 `package.json` 由 dist.ts 生成, `exports` 指向 dist (源码仓库的 package.json 不变).
- dist 测试 (`test/dist.test.ts`) 需要 SDK: 它用 `acde-api` (同上, 对不上).
- **install.sh** (sh / dash / `bash --posix`): 认 triple (Rosetta 里按 `sysctl.proc_translated` 换 aarch64; 有 `/lib/ld-musl-*` 是 musl; MSYS 叫去用
  install.ps1), 按 triple 选 `acdevrt-<triple>.tar.xz`; 解 `.tar.xz` 要 tar 认 xz: bsdtar (macOS) 自带, GNU tar 调 `xz`,
  两样都没有时在下载 acdev runtime 之前就失败并提示装 xz / xz-utils; 包里必须有普通文件 `acdev runtime`; curl / wget 下载 (`fetch` 取小文件, 不出声;
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

- Debian 包: 构建要的库 (Linux 目标)、clang / lld / llvm (交叉)、测试要的 Mesa 软件 Vulkan、字体、python3-venv, 还有 jq、awscli、rsync、openssh-client. 执行机自带 node 20、npm 9、nc.
- Rust: rustup 的 stable 在 `/opt/rust` (`RUSTUP_HOME=/opt/rust/rustup`, 两个工作流的全局 env 设它); 目标: 两种架构的 linux-gnu 和 linux-musl、
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

`test.yml` 的 `&cleanup` 那一步只结束所属作业目录 (`~/.cache/act/<id>/`) 已经删掉的进程和端口 18000-18009 的占用者: 被取消的作业留下的; 同一个
runner 上正在跑的另一个作业目录还在, 不碰. 两个 WPT 作业同时落在一台机器上仍会争这些端口 (同一运行里 gate 和 wpt 二选一, 不同分支的
test 运行同时跑时才会).

## 产物机 .127 (2026-11-18)

产物只放 .127, runner 上长期只留工具链 (用户定, 2026-11-18). .127 不是 CI 机: 没有 cicd 用户、没有工具链, 只有用户 `artifacts`
(`/etc/nixos/artifacts.nix`, 家目录 `/srv/artifacts`), 每个仓库一个目录 (`ackernel`、`acinstaller`、`acdev`).

- 写: 各仓库的 CI 用自己的密钥经 ssh 写 (acdev 的是 secret `ARTIFACTS_UPLOAD_KEY`), 密钥在 .127 上限成 `rrsync -wo /srv/artifacts/<仓库>`
  (只能写, 不能读、列、删). 锚点 `&ssh` 那一步把密钥和 .127 的主机密钥写进 `$RUNNER_TEMP/ssh`, 设 `RSYNC_RSH`; 之后 `rsync -rt … "$TO:<路径>/"`.
  rrsync 3.5.0 不能覆盖目标位置上同名的已有文件, 所以一律传到目录 (`host:dir/`), 不写 `host:dir/file`; rsync 只建目标的最后一级, 所以带 `--mkpath` (rrsync 放行它; run 2583 没带, `<run 号>/build-*/` 建不出来).
- 读: 不用 http / ftp (用户定), .127 的 `artifacts-tar@` (端口 9127, socket 激活, 沙箱) 读一行相对路径, 回 `tar -C /srv/artifacts -cf - <路径>`:
  `printf 'acdev/<路径>\n' | nc $PULL | tar -x`. 没有认证, 拒绝 `..` 和绝对路径, 不存在的路径回空 (tar 报错, 工作流里吞掉再查目录). 千兆上约 110 MB/s.
- 布局: release 的 `acdev/<run 号>/` 下 `build-<triple>/` (含 `symbols/`)、`guest/`、`acdev-release/` (发布目录) 和 `run.json`; `acdev/built/` 是复用记录 (见「发布」)
  (`version`、`commit`、`publish`、`run`), `acdev/latest` 是最近一次过了 guard 的 run 号; test 的 `acdev/test-<run 号>/` 下 `wpt-gate/`、
  `wpt-shard-<n>/`、`wpt-expectations/`、`demo-e2e/` (baseline 的 `expectations` 作业从这里取回各 shard 的结果). 对外发布照旧是 `publish` 传 S3.
