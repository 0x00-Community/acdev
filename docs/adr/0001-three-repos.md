# acde 分成三个仓库

用户定 2026-11-13 (测试期间的架构): acde 分成 acdert (通用运行时库)、acdebin-dbg (本仓库, 跨平台调试运行时, 含开发者 CLI `acde`) 和
acdebin-system (Dopame OS 特化运行时) 三个仓库. 运行时的一切 (清单、`acde:` 模块、窗口模型、dev IPC) 以 acdert 为准, 本仓库只写调试运行时
和 CLI 自己的部分. 原文没有记下选这种分法的理由. 详见 `docs/architecture.md`.
