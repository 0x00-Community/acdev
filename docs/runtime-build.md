# 本地构建与运行 acdev runtime

> 路径相对仓库根。

运行时库是并排检出的 [libacde](http://gitea.dopamine/AC/libacde) (`../libacde`, path 依赖, 不是本工作区的成员, 自成一个工作区), 它的 `vendor/blitz` 是子模块
(在 libacde 里 `git submodule update --init`); 它依赖的 AC 内部 crate 从 AC 的 cargo 注册表 `ac` 取
(`.cargo/config.toml`, `credential-provider = "cargo:token"`), 不再有 `[patch.crates-io]`; rusty_v8 的预编译包取内网镜像
(`RUSTY_V8_MIRROR`), 不回退到 GitHub. `Cargo.lock` 进 git, 见下文「依赖与 Cargo.lock」.

```sh
cargo build -p acdev                              # target/debug/acdev
target/debug/acdev doctor
```

## 编译配置与产物目录 (总仓 `.scratch/acdev/build-time.md`, 2026-11-17)

- 产物目录: 本机按仓共用一个, 检出和所有工作树都设 `CARGO_TARGET_DIR=<总仓>/logs/cargo-target/acdev` (system 用
  `logs/cargo-target/system`, 总仓约定). 新工作树第一次编只重编改过的路径包, 依赖全部复用; 同一目录上
  Cargo 加锁, 同一仓的两次编译自动排队. 产物目录不在工作树里, 删工作树不会删它.
- `dev` (日常调试版): 只留行号级调试信息, 依赖包不带调试信息 (调试版二进制原来约 1.2 GB, 链接和推送都慢).
- `guest` (进客户机的日常编译, `cargo build --profile guest`, 产物在 `<产物目录>/guest/`): 以 `release` 为底, 不做链接时
  优化 (Link-Time Optimization, LTO)、256 个代码生成单元、增量编译、只留行号级调试信息、不剥符号; 依赖包优化级别 2, 本工作区
  自己的包 (libacde、根包、hostwin) 优化级别 0. 渲染和排版的热点 (vello、detour、blitz、stylo) 都在依赖包里, 照样优化; 改 libacde
  一个文件重编 10～14 秒 (全按级别 1 时是 1 分 14 秒);
  程序比正式发布版慢、体积大, 不能拿来量性能或冷启动. `acdev vm dev` 在项目有 `[profile.guest]` 时默认用它.
- `release` / `dist`: 正式发布 (体积优先、链接时优化), 只在量性能、发版前用.
- 链接器: Rust 1.90 起 x86_64 Linux 默认用自带的 rust-lld, 本机 rustc 1.97.1 编出的二进制 `.comment` 里是 `Linker: LLD`, 不用另装.

构建运行时库要有 bun: libacde 的 `build.rs` 把它的 `js/` 的页面包打进二进制 (`ACDEV_BUN` 指定 bun 的路径). 管理中枢 (broker.js) 随
`web/` 删除 (acdert 91e7dd1e) 后没有取回, 原来进它的入口现在是单应用启动器 (`target/debug/acdev app <目录>`), 桌面起不来. 用 `acdev` (`npm/`): `ACDEV_RUNTIME=<本仓库>/target/debug/acdev acdev dev`.

## DXC 钉版本 (2026-11-18)

Windows 目标经 wgpu-hal 的 `static-dxc` 依赖 `mach-dxcompiler-rs`, 它的 build.rs 在编译时从 GitHub 下预编译的 DXC.
0.1.6 和 0.1.7 下载前先不带认证查 GitHub 的 releases API, 确认那个发布是「不可变发布」, 查不到 `"immutable": true` 就 panic,
报 `Refusing to download a mutable GitHub release`. 匿名调用 API 每小时只有 60 次, 同一出口的几台执行机很快用完, 用完后的回应里
没有这个字段, 也会报同样的错. 发版试跑 run 2542 的 Windows 构建就停在这里; 本机同时查 API 得到的是 rate limit, 所以推断原因是限流, 不是发布真的可变 (没在执行机上核实). 0.1.5 已撤回. 0.1.4 不查 API, 直接下载并按包里写死的
SHA-256 校验, 所以根包在 Windows MSVC (x86_64) 上直接依赖 `mach-dxcompiler-rs = "=0.1.4"` (wgpu-hal 30 要求 `^0.1.4`, 合得上),
把它钉住. acdev 不提交 `Cargo.lock`, CI 每次 `cargo update`, 不钉就会解析到最新的 0.1.7.

解除条件 (任一): 上游新版不再在构建时匿名调用 GitHub API (或允许带令牌、允许跳过); 或预编译的 DXC 放进内网 gitea, 由环境变量指给它
(也合「构建不从外网取东西」); 解除时删掉根 `Cargo.toml` 里这一项和本节. 现在 `Cargo.lock` 已进 git, 锁文件本身就把它定在 0.1.4; `Cargo.toml` 里的 `=0.1.4` 仍留着,
是为了定期 `cargo update` 时不被顺手升到 0.1.7.

## 依赖与 Cargo.lock (用户定 2026-11-18)

- `Cargo.lock` 进 git: 根工作区 (acdev、crates/hostwin, 加上并排 `../libacde` 及其 `vendor/blitz` 的全部依赖) 一份, 另编的 `crates/devd`、
  `crates/tool`、`crates/tool` 各一份. CI 不再 `cargo update`, 取包和构建都带 `--locked` (`build.yaml` 的 `build` 和 `guest`;
  `test.yaml` 不编, 测的是构建出的产物); 锁文件和 Cargo.toml 对不上就直接失败, 不会悄悄解析到新版本.
- 发版时 `scripts/set-version.sh` 改了 acdev、libacde 的工作区版本号, 也同步改两边 `Cargo.lock` 里 `acdev`、`acde-hostwin`、`libacde`
  这三项的 version, 所以 `--locked` 照样过. 两边 `[workspace.dependencies]` 里点名这类包的版本要求也一起改成 `=<版本>`: libacde 把
  `acde-scene` 钉成 `version = "=0.1.0"`, 工作区版本号一改, 不跟着改就选不到版本 (cicd run 31 两格 build 都败在
  `failed to select a version for the requirement acde-scene = "=0.1.0"`).
- 更新依赖: 定期在工作树里 `cargo update` (三个小程序各在自己目录里跑), 只提交锁文件的变化, 单独一个提交
  (`build: cargo update ...`, 正文写升了哪些要紧的包); 交测试 Agent 编过并跑过测试再推. 只升某一个包用 `cargo update -p <包>`.
- libacde 改了依赖 (Cargo.toml 增删或改版本要求) 时, acdev 的锁文件要跟着更新, 否则 CI 的 `--locked` 失败: 在 acdev 里
  `cargo update -p libacde` (必要时加上新依赖的名字), 和 libacde 的那次改动一起排进同一个测试点.
