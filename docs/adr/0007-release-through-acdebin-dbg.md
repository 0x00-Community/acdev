# 本仓库不发二进制, 由 acdebin-dbg 一次发版

## 状态

已采纳 (用户定 2026-11-14).

## 背景

原文未记录.

## 决定

本仓库不发二进制, 也不往 pkgs.dopame.ai 上传. 调试运行时、页面资源、SDK、命令行和安装器由 acdebin-dbg 的 release 工作流一次发出.

## 后果

版本号由 acdebin-dbg 在构建时写进本仓库 (不提交); 本仓库推 `v<x.y.z>` tag 只是触发 acdebin-dbg 的发布. 见 `docs/dev/release.md`.
