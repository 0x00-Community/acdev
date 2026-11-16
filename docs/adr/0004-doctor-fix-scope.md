# `acde doctor --fix` 只直接修 acde 自己的、可撤销的事

## 状态

已采纳（用户定 2026-11-11）。

## 背景

MCP 的 `doctor_fix` 不给 `allow` 参数, 是 2026-11-11 的安全审查提出的; `--fix` 范围本身的背景原文未记录.

## 决定

直接修 acde 自己的、可撤销的 (skill、`.gitignore`、会话目录); 下载 / 安装 / 结束进程的先问 (重装运行时、装工程依赖、停会话); 用户该做的
决定一律不碰 (待答的批准、GPU 驱动和系统库、macOS 隔离、PATH 上别的 acde、工程的代码和配置).

## 后果

MCP 的 `doctor_fix` 只做不问的那几个, 不给 `allow` 参数: 同意要来自用户本人, 不该是 agent 自己填的参数. 详见 `docs/acde-doctor.md` 的
「`--fix`」.
