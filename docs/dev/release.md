# 发版

本仓库不发二进制, 也不往 pkgs.dopame.ai 上传东西 (用户定, 2026-11-14): 调试运行时 (acdebin-dbg 的二进制)、页面资源 (`acde-host-<版本>.tar.gz`, 由
本仓库 `web/packages/acde-host` 的 `build:release` 打)、SDK (`acde-api-<版本>.tar.gz`, `web/packages/acde-api` 的 `build`)、acde 命令行和安装器, 由
acdebin-dbg 的 `.github/workflows/release.yml` 一次发到 `pkgs.dopame.ai/acde/<版本>/` (S3 桶 `dopame-pkgs` 的 `acde/`) 和 npm, 它在 `acdert_commit` (缺省本仓库 main) 检出本仓库.
版本号不用手改 (2026-11-14 起): 它取 pkgs 的 `latest.json`、npm 和 `v*` tag 里最高的版本加一个 patch (或给定的版本), 由 acdebin-dbg 的 `scripts/set-version.sh`
在构建时写进本仓库根 `Cargo.toml` 的 `workspace.package.version` 和 `web/packages/*/package.json` (不提交). 本仓库推 tag `v<x.y.z>` 就发版:
`.gitea/workflows/release.yml` (只在 Gitea) 用 secret `RELEASE_TOKEN` (emmett 的 `write:repository` 令牌) 触发 acdebin-dbg 的 release, `publish=true`、
`acdert_commit` 是这个 tag 的提交、`version` 是 tag 的版本、acdebin-dbg 取它的 main. npm 上是 `@dopame/acde` (只有一行 JS, 加载本平台包里的启动器)、
`@dopame/acde-<os>-<cpu>` (二进制、构建好的命令行和页面资源, 按安装后的目录摆) 和 SDK `@dopame/acde-api`: 二进制闭源, 公开的只有这几行 JS 和压缩过的产物.
以前在 `pkgs.dopame.ai/acdert/<版本>/` 的 0.0.9 及更早的版本还留在那里.

Rust 包发到 cargo 源 ac 是手动的, 见下面「cargo 源 ac」那条的顺序 (`cargo publish --registry ac`, 从 HEAD 导出的干净副本发).

## cargo 源 ac

- 发布到 gitea.dopamine AC 组织的 cargo 源 `ac` (`.cargo/config.toml`; 读也要令牌, 匿名 401):
  `CARGO_REGISTRIES_AC_TOKEN="Bearer <令牌>" cargo publish -p <包> --registry ac`. ac 上除了 acdert 只有它不得不单独发的依赖: blitz fork 的包
  (blitz-dom / blitz-paint / blitz-traits / stylo_taffy / debug_timer, 原名), blitz 的 taffy (上游 Blitz 钉的 git 提交, `0.15.0-git.4e59968`);
  2D 场景是 acgpu 的 (acgpu 仓库自己发, 不开 `compiler`), acde-gpu 已并进 `src/gpu`. 顺序: acgpu → blitz 那五个 (在 `vendor/blitz` 里发) → acdert.
  升版本时改 `[workspace.package] version`; blitz 升版本时它自己的 `[workspace.package]`、`[workspace.dependencies]` 和这里的 `=0.3.0-beta.N` 一起改.
