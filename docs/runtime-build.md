# 本地构建与运行 acdev runtime

> 路径相对仓库根。

运行时库在仓内 `acdert/` (path 依赖, 工作区成员), `acdert/vendor/blitz` 是子模块 (`git submodule update --init`); 它依赖的 AC 内部 crate 从 AC 的 cargo 注册表 `ac` 取
(`.cargo/config.toml`, `credential-provider = "cargo:token"`), 不再有 `[patch.crates-io]`; rusty_v8 的预编译包取内网镜像
(`RUSTY_V8_MIRROR`), 不回退到 GitHub. `Cargo.lock` 不进 git, 拉取之后先 `cargo update`.

```sh
cargo build -p acdev                              # target/debug/acdev
target/debug/acdev doctor
```

构建运行时库要有 bun: `acdert/build.rs` 把 `acdert/js/` 的页面包打进二进制 (`ACDEV_BUN` 指定 bun 的路径). 管理中枢 (broker.js) 随
`web/` 删除 (acdert 91e7dd1e) 后没有取回, 原来进它的入口现在是单应用启动器 (`target/debug/acdev app <目录>`), 桌面起不来. 用 `acdev` (`npm/`): `ACDEV_RUNTIME=<本仓库>/target/debug/acdev acdev dev`.
