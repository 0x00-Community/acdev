# 命令行、调试运行时、页面资源和 SDK 同一次发布、同一个版本号

## 状态

已采纳（用户定 2026-11-14）。

## 背景

0.0.9 及更早是命令行和 acdert 分开发的.

## 决定

四个平台的 `acdebin-dbg-<triple>`、页面资源 `acde-host-<版本>.tar.gz`、SDK `acde-api-<版本>.tar.gz`、`acde` 命令行和安装器是同一次发布,
同一个版本号, 都放进 `pkgs.dopame.ai/acde/<版本>/` (同一版本也发到 npm), 由同一份 `SHA256SUMS` 校验, 标签 `v<版本>` 打在本仓库.

## 后果

acdert 自己不再发版; 现在的安装器不装 0.0.9 及更早的版本. 详见 `docs/release-distribution.md`.
