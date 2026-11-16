# Windows 上应用后端不开 TCP 监听和命名管道

2026-11-09 定, 和 acdert AGENTS.md「网页应用」的「Windows 后端契约」是同一份, 两边一起发版: 后端运行期间没有 TCP 监听、没有命名管道,
套接字文件只有 SYSTEM 和当前用户能开; node 走通道模式 (fd 3 / fd 4 两根匿名管道上跑全部帧), bun 走套接字模式 (`<ACDE_APP_SOCKETS>\<P>.sock`,
fd 3 只跑控制帧); macOS / Linux 不变. 帧格式、信用和优雅停止见 `docs/contract-with-acdert.md` 的「Windows 后端契约」, 预加载一侧见
`docs/acde-build.md` 的「preload」.
