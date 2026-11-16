# 本地构建与运行 acdebin-dbg

> 路径相对仓库根。

acdert 要和本仓库并排检出 (`../acdert`): `acdert` 是 path 依赖; 它依赖的 AC 内部 crate 从 AC 的 cargo 注册表 `ac` 取
(`.cargo/config.toml`, `credential-provider = "cargo:token"`), 不再有 `[patch.crates-io]`; rusty_v8 的预编译包取内网镜像
(`RUSTY_V8_MIRROR`), 不回退到 GitHub. `Cargo.lock` 不进 git, 拉取之后先 `cargo update`.

```sh
cargo build -p acdebin-dbg                              # target/debug/acdebin-dbg
(cd ../acdert/web && bun install && bun run build)   # acde-host 的 dist
ACDE_APP=../acdert/web/packages/acde-host/dist target/debug/acdebin-dbg doctor
```

不在安装目录里跑时要用 `ACDE_APP` 指向 acdert 的 `web/packages/acde-host/dist`. 用 `acde` (`npm/`): `ACDERT=<本仓库>/target/debug/acdebin-dbg acde dev`.
