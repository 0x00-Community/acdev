# 本地构建与运行 acdev runtime

> 路径相对仓库根。

运行时库在仓内 `acdert/` (path 依赖, 工作区成员), `acdert/vendor/blitz` 是子模块 (`git submodule update --init`); 它依赖的 AC 内部 crate 从 AC 的 cargo 注册表 `ac` 取
(`.cargo/config.toml`, `credential-provider = "cargo:token"`), 不再有 `[patch.crates-io]`; rusty_v8 的预编译包取内网镜像
(`RUSTY_V8_MIRROR`), 不回退到 GitHub. `Cargo.lock` 不进 git, 拉取之后先 `cargo update`.

```sh
cargo build -p acdev                              # target/debug/acdev
target/debug/acdev doctor
```

## 编译配置与产物目录 (总仓 `.scratch/acdev/build-time.md`, 2026-11-17)

- 产物目录: 本机按仓共用一个, 检出和所有工作树都设 `CARGO_TARGET_DIR=<总仓>/logs/cargo-target/acdev` (system、winman 各用
  `logs/cargo-target/system`、`logs/cargo-target/winman`, 总仓约定). 新工作树第一次编只重编改过的路径包, 依赖全部复用; 同一目录上
  Cargo 加锁, 同一仓的两次编译自动排队. 产物目录不在工作树里, 删工作树不会删它.
- `dev` (日常调试版): 只留行号级调试信息, 依赖包不带调试信息 (调试版二进制原来约 1.2 GB, 链接和推送都慢).
- `guest` (进客户机的日常编译, `cargo build --profile guest`, 产物在 `<产物目录>/guest/`): 以 `release` 为底, 不做链接时
  优化 (Link-Time Optimization, LTO)、256 个代码生成单元、增量编译、只留行号级调试信息、不剥符号; 依赖包优化级别 2, 本工作区
  自己的包 (acdert、根包、hostwin) 优化级别 0. 渲染和排版的热点 (vello、detour、blitz、stylo) 都在依赖包里, 照样优化; 改 acdert
  一个文件重编 10～14 秒 (全按级别 1 时是 1 分 14 秒);
  程序比正式发布版慢、体积大, 不能拿来量性能或冷启动. `acdev vm dev` 在项目有 `[profile.guest]` 时默认用它.
- `release` / `dist`: 正式发布 (体积优先、链接时优化), 只在量性能、发版前用.
- 链接器: Rust 1.90 起 x86_64 Linux 默认用自带的 rust-lld, 本机 rustc 1.97.1 编出的二进制 `.comment` 里是 `Linker: LLD`, 不用另装.

构建运行时库要有 bun: `acdert/build.rs` 把 `acdert/js/` 的页面包打进二进制 (`ACDEV_BUN` 指定 bun 的路径). 管理中枢 (broker.js) 随
`web/` 删除 (acdert 91e7dd1e) 后没有取回, 原来进它的入口现在是单应用启动器 (`target/debug/acdev app <目录>`), 桌面起不来. 用 `acdev` (`npm/`): `ACDEV_RUNTIME=<本仓库>/target/debug/acdev acdev dev`.
