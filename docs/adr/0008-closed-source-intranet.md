# 闭源, 仓库和构建依赖都放内网 Gitea

用户定 2026-11-08: 自己的代码是专有的 (根目录 `LICENSE`), 仓库和 release 不公开. 2026-11-14 补充: 二进制闭源, npm 上公开的只有启动器的几行 JS 和压缩过的产物.
所以不链接 GPL 的 ffmpeg, SDK 归档只发压缩过的 `dist/`.

用户定 2026-11-14: 只推内网 Gitea (`AC/acdert`), 不再双推 GitHub. 构建不从外网取东西: blitz 子模块在 Gitea `AC/blitz`, rusty_v8 的预编译库在 `mirror` 组织的
generic 包, CI 的 action 用 `mirror` 里的副本; crates.io 和 npm 还走外网. Cargo.toml / package.json 里的仓库地址照旧写 GitHub (npm 的 trusted publishing 认它).

见 `AGENTS.md`「协作规则」、`docs/dev/release.md` 和 `docs/dev/build-run.md`「构建不从外网取东西」.
