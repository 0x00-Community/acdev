# acde-base

acde (Agent Computer Desktop Environment): Linux 桌面的底座, 替代 KDE / GNOME. 桌面和应用都是网页.

- 自己就是 Wayland 合成器, 直接管屏幕、键盘、鼠标.
- 网页用自己的渲染器画, 不是 Chromium; JS 跑在内嵌的 V8 里.
- 普通 Wayland 程序照常能跑; 只会 X11 的不行.
- 现成的网页工程 (React、Vue、Next.js …) 用 `acde app build` / `acde app run` 打成桌面应用, 不用改代码.
- 桌面长什么样由桌面包决定, 例如 [acde-dopame](https://github.com/dopame-org/acde-dopame); 这里只是平台.

## 跑起来

要 Linux 和支持 Vulkan 的显卡.

```sh
cargo build --release -p acde
cd web && bun install && bun run build
ACDE_PATH=<桌面包目录> ../target/release/acde --desktop dopame
```

没接显示器: 加 `ACDE_BACKEND=rdp ACDE_RDP_USER=… ACDE_RDP_PASSWORD=…` (还要证书, 见 AGENTS.md), 用远程桌面连 3390 端口.

## 更多

细节全在 [AGENTS.md](AGENTS.md).
