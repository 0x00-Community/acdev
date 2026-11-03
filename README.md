# acde-base

一个 Linux 桌面的底座, 用来替代 KDE / GNOME. 特别之处: 桌面和应用都是网页.

- 它自己就是 Wayland 合成器, 直接接管屏幕、键盘、鼠标.
- 网页用自己的渲染器画 (不是 Chromium, 没有浏览器), JS 跑在内嵌的 V8 里.
- 普通的 Wayland 程序照常能跑, 和网页窗口混在一起; 只会 X11 的程序跑不了.
- 现成的网页应用 (React、Vue、Next.js …) 不用改代码就能当桌面应用: `acde app build`, `acde app run`.
- 桌面长什么样由「桌面包」决定, 例如 [acde-dopamine](https://github.com/dopamine-org/acde-dopamine). 这个仓库只是平台.

## 构建和运行

```sh
cargo build --release -p acde
cd web && bun install && bun run build
ACDE_PATH=<桌面包目录> ../target/release/acde --desktop dopame
```

要 Linux 和一块支持 Vulkan 的显卡. 没接显示器时加 `ACDE_BACKEND=rdp`, 用远程桌面连上去看.

## 更多

所有细节都在 [AGENTS.md](AGENTS.md).
