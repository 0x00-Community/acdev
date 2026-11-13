# acde-base

> **已归档 (2026-11-14), 由 [acde-system](http://gitea.dopamine/AC/acde-system) 取代.** 本仓库只读, 不再接受提交.
> acde-system 是 Dopame OS 的桌面运行时 (Wayland 合成器、DRM/KMS、会话、RDP、系统服务), 建在
> [acdert](http://gitea.dopamine/AC/acdert) (通用运行时: V8、DOM、渲染) 之上; 开发者命令行是 [acde-cli](http://gitea.dopamine/AC/acde-cli)
> (`acde build` 代替这里的 `acde app build`). 包 `acde-system` provides / conflicts / replaces `acde-base`, 会话命令是 `acdert`.
> 下面的内容是归档时的样子, 不再更新.

acde (Agent Computer Desktop Environment): Linux 桌面的底座, 替代 KDE Plasma / GNOME. 桌面和应用都是网页.

- 自己就是 Wayland 合成器, 直接管屏幕、键盘、鼠标.
- 网页用自己的渲染器 (Blitz 分叉) 在 GPU 上画, 不是 Chromium; JS 跑在内嵌的 V8 里, 不用 Node, 不开端口.
- 普通 Wayland 程序照常能跑; 没有 Xwayland, 只会 X11 的程序跑不了.
- 现成的网页工程 (React、Vue、Next.js …) 用 `acde app build` / `acde app run` 打成桌面应用. 各框架的构建验过, 在 acde 窗口里跑还没逐个验.
- 桌面长什么样由桌面包决定, 例如 [acde-dopame](http://gitea.dopamine/AC/acde-dopame); 这里只是平台: 合成器、渲染、系统接口和登录页.

## 跑起来

要 Linux、Vulkan 驱动 (显卡优先; 没有显卡时 lavapipe 这类 CPU 实现也能画, 慢)、Rust 和 bun. GPU 驱动 acgpu 是路径依赖:
要和本仓库并排检出 (`../acgpu`).

```sh
cargo build --release -p acde
cd js && bun install && bun run build
ACDE_PATH=<acde-dopame>/packages/dopame ../target/release/acde-base --desktop dopame
```

`ACDE_PATH` 指向构建好的桌面包 (acde-dopame 里先 `bun install && bun run build`). `CARGO_TARGET_DIR` 不在仓库里时,
要用 `ACDE_APP=<仓库>/js/packages/acde-host/dist` 告诉 acde JS 在哪.

在哪跑决定画到哪:

- 已经在一个 Wayland 桌面里: 开一个嵌套窗口 (默认 1280x800, `ACDE_SIZE` 改).
- 没有图形界面的 tty: 接管显示器 (DRM/KMS + libinput).
- 没接显示器: 加 `ACDE_BACKEND=rdp ACDE_RDP_USER=… ACDE_RDP_PASSWORD=…`, 还要证书 (见 AGENTS.md), 用远程桌面连 3390 端口.

## 打包

- Arch 包: `packaging/arch` (`makepkg -s`, bun 在 Arch 的 extra 里; 没有 Arch 用 `podman-build.sh`).
  CI: `.gitea/workflows/package.yaml` 在 runner 标签 `archlinux` 上打包, 包是那次运行的 artifact `acde-base` (留 14 天), 不发布.
- npm 包: `npm/build.sh` 打出 `acde` (命令)、`@dopame/acde-linux-x64` (运行时)、`create-acde` (`npm create acde`) 和 SDK `@dopame/acde-api`.

## 仓库

内网 Gitea 的 [AC/acde-base](http://gitea.dopamine/AC/acde-base) (`ssh://git@gitea.dopamine:2333/AC/acde-base.git`) 是主仓库,
GitHub 的 `dopame-org/acde-base` 是镜像. `origin` 配两个 pushurl (先 Gitea 再 GitHub), `git push origin` 一次推两边:

```sh
git remote set-url origin ssh://git@gitea.dopamine:2333/AC/acde-base.git
git config --add remote.origin.pushurl ssh://git@gitea.dopamine:2333/AC/acde-base.git
git config --add remote.origin.pushurl git@github.com:dopame-org/acde-base.git
```

## 更多

细节全在 [AGENTS.md](AGENTS.md).
