# 三个仓库: acdert 只做通用运行时库

## 状态

已采纳 (用户定 2026-11-13; 原文注明是测试期间的架构).

## 背景

原文未记录.

## 决定

acde 分成三个仓库. acdert 只出通用运行时逻辑, 对外是一个根包 `acdert` (rlib + `libacdert.so` + `include/acdert.h`);
平台特化的部分 (宿主窗口、DevTools、Wayland 合成器、DRM/KMS、会话) 归前端 acdebin-dbg / acdebin-system, 只经 `Platform` / `Window` 和合成器接口接进来.

## 后果

会话里的 shell / window / paint / supervise 已搬到 acdebin-system. 细节见 `docs/runtime/architecture.md`.
