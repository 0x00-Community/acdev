# 定位、三仓关系与仓库结构

> 路径相对仓库根。

## 是什么

acdev 分三个仓库 (测试期间的架构, 用户定 2026-11-13): acdert (通用运行时 lib)、acdebin-dbg (本仓库, 跨平台调试运行时)、acdebin-system
(Dopame OS 特化运行时), 开发者 CLI `acdev` 在本仓库的 `npm/` (bun, 说明见 `docs/cli-overview.md`). acdebin-dbg 产出二进制 `acdebin-dbg`: 在 Linux / Windows / macOS 的别人桌面里开宿主原生窗口,
跑一个应用 (`acdebin-dbg app <id>`) 或一个桌面 (`acdebin-dbg desktop <id|包目录>`); `acdev dev` 拉起的就是它 (`acdev` 先找 `ACDERT`,
再找装在旁边的、PATH 上的 `acdebin-dbg`, 最后才是旧的 `acdert`).

## 仓库结构

- 仓库根的包 `acdebin-dbg` (`src/`): 可执行文件. `main.rs` 分命令 (`doctor` 自己做, `run` / `desktops` / `sessions` / `applications` / `open` 交给
  `acdert::common`, 其余在 `acde_hostwin::run` 里起 Broker); `platform.rs` 的 `Host` 是 acdert `Platform` 的宿主窗口实现
  (surface 认领给 hostwin、`native` 上加 hostnative 的导出、Windows 的内容类型、文件选择器); `hostnative.rs` 是 `native.Shell` 等宿主窗口
  的 JS 绑定 (用 acdert lib 根上平铺导出的绑定工具); `chooser.rs` 先用 `acdev dev` 预设的答案, Linux 上不是无头时走 portal
  (`acdert::Portal`), 否则用宿主窗口的原生对话框; `doctor.rs` 是 `acdebin-dbg doctor [--json]`.
- `crates/hostwin`: 宿主窗口和合成 (见 `docs/hostwin.md`).
- 合成器: 现在直接用 acdert 的 acde-gpu (wgpu: Vulkan / OpenGL / Metal / DX12); acdert 抽出合成器接口后, wgpu (vello) 实现搬到本仓库,
  另加 acgpu 实现 (feature `acgpu`).

目录: `src/` 是 acdebin-dbg 本体 (Rust, 仓库根的包); `crates/hostwin` 宿主窗口; `npm/` 是开发者 CLI `acdev` 这个 JS 包 (连同它自己的构建脚本 `npm/scripts/`); `scripts/` 是不随包发的安装器
(`install.sh` / `install.ps1` / `install.md`, 发版时传到 pkgs) 和发版检查 `release-guard.ts`.
