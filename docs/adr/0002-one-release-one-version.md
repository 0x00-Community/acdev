# 命令行、调试运行时、页面资源和 SDK 同一次发布、同一个版本号

用户定 2026-11-14: 四个平台的 `acdebin-dbg-<triple>`、页面资源 `acde-host-<版本>.tar.gz`、SDK `acde-api-<版本>.tar.gz`、`acde` 命令行和
安装器是同一次发布, 同一个版本号, 都放进 `pkgs.dopame.ai/acde/<版本>/`, 由同一份 `SHA256SUMS` 校验, 标签 `v<版本>` 打在本仓库; acdert
自己不再发版. 0.0.9 及更早是命令行和 acdert 分开发的, 现在的安装器不装它们. 详见 `docs/release-distribution.md`.
