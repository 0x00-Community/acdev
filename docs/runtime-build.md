# 本地构建与运行 acdebin-dbg

> 路径相对仓库根。

运行时库在仓内 `acdert/` (path 依赖, 工作区成员), `acdert/vendor/blitz` 是子模块 (`git submodule update --init`); 它依赖的 AC 内部 crate 从 AC 的 cargo 注册表 `ac` 取
(`.cargo/config.toml`, `credential-provider = "cargo:token"`), 不再有 `[patch.crates-io]`; rusty_v8 的预编译包取内网镜像
(`RUSTY_V8_MIRROR`), 不回退到 GitHub. `Cargo.lock` 不进 git, 拉取之后先 `cargo update`.

```sh
cargo build -p acdebin-dbg                              # target/debug/acdebin-dbg
(cd acdert/web && bun install && bun run build)      # acde-host 的 dist (web/ 已删除, 见下)
ACDE_APP=acdert/web/packages/acde-host/dist target/debug/acdebin-dbg doctor
```

不在安装目录里跑时要用 `ACDE_APP` 指向 `acdert/web/packages/acde-host/dist`. acdert 的 `web/` 已删除 (acdert 91e7dd1e), 取代方案未定:
现在没有页面资源可构建, `acdert` 本身也编不过 (`src/host/mod.rs` 读 `web/` 里的 `level.js`). 用 `acdev` (`npm/`): `ACDEV_RUNTIME=<本仓库>/target/debug/acdebin-dbg acdev dev`.
