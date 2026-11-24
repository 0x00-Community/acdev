# 客户机: QEMU 里跑 Dopame OS (`acdev vm`)

> 命令行的路径相对 `npm/`, 其余相对仓库根。

模拟器的第一块 (用户 2026-11-17: 虚拟机启动配置放在 acdev, 原型用 QEMU; 第一个里程碑只做 Linux KVM, 规范 gitea `AC/acde#103`):
在 Linux 宿主上用 KVM 起一台 x86_64 的 Dopame OS 客户机, virtio-gpu 显示、virtio 键盘和平板、串口日志, 再把宿主上的文件
(acompositor 和测试客户端的二进制) 送进去跑. 实现在命令行 `src/vm/`: `machine.ts` (目录、镜像、覆盖盘、QEMU 命令行、起停)、`channel.ts`
(QMP 和 QEMU guest agent 的按行 JSON 协议)、`command.ts` (`acdev vm` 的子命令). 仓库根的 `scripts/vm.sh` 只是从检出跑 `acdev vm` 的入口
(`scripts/vm.sh logs` 跟着看串口日志; 目录默认是仓库里的 `.vm/`). 以后加 vsock 上的设备守护进程 (工作项 02)、
virtio-fs, 以及 Windows (WHPX)、macOS (Hypervisor.framework).

## 要什么

- `qemu-system-x86_64`、`qemu-img` 和 UEFI 固件. 找 QEMU 的顺序 (`src/vm/host.ts` `qemuDirs`): `ACDEV_QEMU_DIR`、`PATH`, 再按平台:
  - Linux: 只看 `PATH` (Debian / Ubuntu: `qemu-system-x86 qemu-utils`; Arch: `qemu-full` 或 `qemu-base`); 固件 OVMF (`ovmf` / `edk2-ovmf`),
    没有时用 QEMU 自带的 `share/qemu/edk2-x86_64-code.fd`;
  - Windows: 注册表 `HKLM\SOFTWARE\QEMU` 的 `Install_Dir` (QEMU 官方安装包 `qemu.nsi` 写的)、`%ProgramFiles%\qemu` (安装包的默认目录,
    `InstallDir $PROGRAMFILES64\qemu`)、MSYS2 的 `C:\msys64\ucrt64\bin`、`mingw64\bin`; 固件用安装目录下的 `share\edk2-x86_64-code.fd` 和
    `share\edk2-i386-vars.fd` (安装包把 `share` 整个拷进去; 文件名照 QEMU 源码 `pc-bios/`, 安装后的实际位置〔未核实〕). 安装: 官网列的
    Stefan Weil 的安装包 https://qemu.weilnetz.de/w64/ , 或 `winget install -e --id SoftwareFreedomConservancy.QEMU` (同一个安装包);
  - macOS: Homebrew (`/opt/homebrew/bin` Apple 芯片、`/usr/local/bin` Intel)、MacPorts (`/opt/local/bin`), 固件同 Linux 的 `share/qemu`.
  `OVMF_CODE`、`OVMF_VARS` 两个都设了就用它们.
- 硬件加速 (`src/vm/host.ts` `preferredAccel`): Linux 上 `/dev/kvm` 能读写就 KVM (`-cpu host`), 打不开就 TCG 软件模拟; Windows 上 WHPX
  (`-accel whpx -cpu max`), macOS 上 HVF (`-accel hvf -cpu host`). WHPX / HVF 起不来 (QEMU 马上退出, 输出里提到它) 时说一句原因,
  退回 TCG 重起一次; 慢得多. `start` 和 `status` 会说.
- QEMU 进程用分离的子进程起 (Node 的 `detached`: POSIX 上是新会话, Windows 上不挂在当前控制台), 不随 `acdev` 退出, 不再要 `setsid`.
  Windows 上 `windowsHide` 只在没有窗口时打开 (`--headless`、`--vnc`、`--viewer`, `Machine.windowed`): 它让 libuv 在 `STARTUPINFO` 里写
  `SW_HIDE`, 而一个进程第一次 `ShowWindow` 时 Windows 用的是这个值, 不管程序自己要什么, 所以原来 QEMU 的 gtk 窗口一建出来就是隐藏的
  (2026-11-22 acdev-test 在用户的 Windows 上看到: qemu 在用户的交互会话里, 可 `MainWindowHandle` 是 0, 桌面上找不到窗口). 不加它也不会多出
  控制台窗口: `detached` 在 Windows 上是 `DETACHED_PROCESS`, 控制台程序 `qemu-system-x86_64.exe` 不分配控制台. 不论从 PowerShell、
  cmd 还是 WSL 里的 `powershell.exe` 起, 窗口都在用户桌面上〔修复后未在 Windows 上复测〕.
- 窗口: Linux 上默认用 QEMU 的 SDL 窗口 (`-display sdl`; 默认带 3D, 即 `sdl,gl=on`, 见下面「3D」), `--gtk` 换成 gtk 窗口; macOS 是 cocoa, Windows 是 gtk, 不变.
  理由见下面两条: gtk 开窗就拿窗口尺寸盖掉客户机的首选分辨率, SDL 不会, 客户机直接以 1280×800 起来, 之后照样跟着拉动的窗口变 (round21 后实测,
  WSLg 上 X11 窗口). QEMU 没编 SDL 时 (`Machine.displays` 看 `qemu-system -display help` 的列表) 默认退回 gtk 并提示一句; 明说 `--sdl` 而没有 SDL 时报错.
  `--viewer` 时是 acdev 自己的窗口 (`acdevtool view`, 取 `ACDEVTOOL`, 否则检出里 `crates/tool` 编出的,
  目前只有 Linux); 没有图形环境时用 `--headless` (截图照样能取) 或 `--vnc`.
- gtk 窗口 (`--gtk`) 下客户机的分辨率跟着窗口大小走: QEMU 的 gtk 前端每次窗口大小变化都把窗口尺寸经 `dpy_set_ui_info` 报给显卡, 显卡改了首选分辨率再告诉客户机
  (`ui/gtk.c` `gd_configure` → `gd_set_ui_size`; virtio 显卡时 `zoom-to-fit` 自动打开, 窗口不再按画面调). 窗口初始大小由 GTK 按开机时的小画面定,
  所以客户机常常一上来是 640×480, 把窗口拉大就行; 显卡的 `xres` / `yres` (默认就是 1280×800) 会被窗口尺寸盖掉, 设了也没用.
  测试和要固定分辨率时用 `--headless` (1280×800) 或 `--viewer` (`acdevtool view` 主动报 1280×800, 之后跟着窗口变).
- QEMU 没给 `-parallel` 时会给图形显示配一个默认并口, 接到一个文字控制台 (`system/vl.c` 的 `qemu_create_default_devices`: 图形显示时
  `add_device_config(DEV_PARALLEL, vc)`); gtk 把它放进标签页, SDL 给每个控制台开一个窗口, 就多出一个 640×384 的 `QEMU (acdev-1)`. 所以总是加
  `-parallel none`. 默认监视器不会出来: 给了 `-qmp` 就不再配 (`default_monitor = 0`); 串口已经接到 `serial.log`.
- 3D (virgl, 用户 2026-11-20 定为窗口里默认, `src/vm/gl.ts`): 有窗口时默认用带 GL 的 virtio 显卡 (`virtio-vga-gl`, aarch64 是 `virtio-gpu-gl-pci`),
  窗口是 `sdl,gl=on` / `gtk,gl=on`; `--no-gl` 关掉. `--headless` 默认不带 3D (原因见下一条), `--headless --gl` 才带, 用 `egl-headless`
  (在宿主的渲染节点上离屏画), 起的时候说一句截图用不了. 起之前判断宿主行不行, 不行就说一句并退回不带 GL (不报错): 不是 Linux 宿主
  (acdev 只在 Linux 上接了 GL; 不是 QEMU 做不到, 见下一条); `--vnc`; `--viewer` 和 `--headless --outputs N` (N ≥ 2): 这两种用 D-Bus 显示 (acdevtool view
  只收共享内存的画面, 而 `egl-headless` 不报大小, 见下面「多个显示输出」), 先不带 GL; `-device help` 里没有 `virtio-vga-gl`; 宿主没有
  `/dev/dri/renderD*` (WSL2 有, 经 `/dev/dxg` 走 mesa 的 d3d12). `--vga std` 本来就没有 3D, 静默不开. 起了以后 QEMU 才失败、日志里提到
  EGL / OpenGL / virgl / 渲染节点 / gbm / epoxy 的, 说一句后不带 GL 再起一次. 核对 (本机 QEMU 8.2.2, 只查没起): `-display help` 有
  `egl-headless`、`dbus`、`sdl`、`gtk`; `-device help` 有 `virtio-vga-gl`、`virtio-gpu-gl-pci`; Ubuntu 的包里 `-device virtio-vga-gl,help`
  单独跑会因为 GL 模块的符号 (`qemu_egl_display`) 没载入而报错, 所以只看 `-device help` 的列表.
- Windows 宿主上的 3D (2026-11-22 调研, 总仓 `.scratch/acdev/windows-3d.md`): QEMU 11.1.0 的 Windows 安装包 (Stefan Weil) 带着 `virtio-vga-gl`、
  `-display sdl,gl=on|core|es`、`gtk,gl=on`、virglrenderer 和 ANGLE 的 `libEGL.dll` / `libGLESv2.dll` (把 OpenGL ES 翻成 D3D11), 社区报告 WHPX 下
  `-device virtio-vga-gl -display sdl,gl=es` 能跑; acdev 在 Windows 上用 gtk、不带 GL, 还没接这条路, 也没验证, 所以起的时候说一句并不带 3D.
  接了也只有 OpenGL / OpenGL ES (virgl): 客户机里的 Vulkan 要 venus, 它要宿主的 blob 内存共享, QEMU 文档只列了 Linux 宿主的条件; 页面的 WebGPU
  只用 Vulkan, 所以 Windows 上的 virgl 帮不上 WebGPU (那时能用的只有客户机里 CPU 上的 lavapipe). `egl-headless` 要渲染节点, Windows 上没有.
  macOS 的 cocoa 显示能不能接 GL 没查.
- 带 3D 时 `acdev vm screenshot` 截不出图, 窗口和 `egl-headless` 都一样: QMP `screendump` 读的是控制台的显示表面 (`ui/ui-qmp-cmds.c` 的
  `qmp_screendump` → `ui/console.c` 的 `qemu_console_surface`), 而 `qemu_console_surface` 在扫描输出是 GL 纹理 (virgl) 时返回空, 只在
  `SCANOUT_SURFACE` 时才有表面. `egl-headless` 把 GL 画面读回到它自己的表面 (`ui/egl-headless.c` 的 `egl_fb_read` 写进 `edpy->ds`,
  再 `dpy_gfx_update`), 不是控制台的, `screendump` 读不到. 实测 (2026-11-20, 证据在总仓 `logs/system-test/wgpu-gl/`): `--headless`
  带 `egl-headless` 时第一次截出近乎全黑的图 (客户机还在用帧缓冲时的旧表面), 客户机切到 virgl 之后报 `no surface`. QEMU 里没有能让
  `screendump` 读 GL 扫描输出的开关, 所以 `--headless` 默认不带 3D, 保住截图. 带 3D 时 `vm screenshot` 直接报错并指路: 登录着的会话里用
  `acdev screen --session vm -o FILE.png` (管家经 acompositor 截, 和 GL 无关), 或者 `--no-gl` / 不加 `--gl` 的 `--headless` 起.
  `run/gl` 记的就是“带 3D、截不出图”(`on`), 不带 3D 记 `off`.
- SDL 窗口 (`ui/sdl2.c`、`sdl2-2d.c`): 窗口按客户机画面的大小开, 画面变了就跟着改窗口; 只在用户拉动窗口 (`SDL_WINDOWEVENT_RESIZED`) 时
  才把窗口尺寸报给显卡, 开窗时不报, 所以显卡的首选分辨率 1280×800 留着, 客户机直接用它. `--sdl`、`--gtk`、`--headless`、`--vnc`、`--viewer` 只能给一个.
- 先开"Windows 虚拟机监控程序平台": `DISM /online /Enable-Feature /FeatureName:HypervisorPlatform /All` (管理员), 再重启;
  x86_64 宿主要 Windows 10 2004 以上 (QEMU 文档 `docs/system/whpx.rst`).
- 调试通道走 `127.0.0.1` 上的 TCP 端口转发加密钥 (见上面「调试通道」).
- 套接字路径的长度 (所有平台, 2026-11-22): AF_UNIX 的路径上限是 107 字节 (macOS 103), `run/` 下的 `devd.sock` 超过 100 字节时 (目录放得深, 如 `vm fetch` 装 ISO 用的
  `images/.install-<ISO 名>/`, acdev-test 实测在默认目录下正好 108 字节, QEMU 起不来), 套接字改放 `$XDG_RUNTIME_DIR` (没有就是系统临时目录) 下的
  `acdev-<目录哈希 12 位>/` (`Machine.sockets`, `SOCKET_PATH_MOST`), 和 Windows 一样.
- QMP 和 guest agent 和别的平台一样是 Unix 套接字, 但 Windows 上不放在 `run/` 下, 而放在 `%TEMP%\acdev-<目录哈希 12 位>\` (`qmp.sock`、
  `qga.sock`, 端口转发选 unix 时还有 `devd.sock`; `Machine.sockets`), 镜像、覆盖盘等大文件仍在 `ACDEV_VM_DIR`. 原因: 2026-11-18
  acdev-test 实测, 默认目录 `%LOCALAPPDATA%\acdev\vm` 下 QEMU 能建套接字, 但 connect 报 10022 (WSAEINVAL); `%TEMP%`、`C:\acdev-test` 等处
  正常, `%LOCALAPPDATA%` 下任何新建的子目录都不行. 别人也撞上过, 都没查到根因: try-omarchy-windows 的 QMP 套接字同样在 `%LOCALAPPDATA%` 下报
  WSAEINVAL, 改放 `os.TempDir()` 解决 (https://github.com/omacom/try-omarchy-windows/issues/140 ); zed-industries/delta-claude 的
  `%LOCALAPPDATA%\Delta` 下也是 10022 (https://github.com/zed-industries/delta-claude/issues/37 ). 原因〔未核实〕; 路径长度不是 (sun_path 上限
  108 字节, 失败的路径比能用的 `C:\Users\…\acdevc` 长不了多少), `%TEMP%` 本身也在 `%LOCALAPPDATA%` 下却能用.
  连接时遇到 10022 (或 `EINVAL`) 不再等满 `--wait` 的 300 秒: guest agent 的等待 (`GuestAgent.ping`) 直接报错, 说是哪个套接字.
  Windows 从 10 1803 起支持 AF_UNIX (微软 https://devblogs.microsoft.com/commandline/af_unix-comes-to-windows/ ), 而 WHPX 本来就要 2004.
  Node 在 Windows 上把 `connect(path)` 当命名管道, 连不了 AF_UNIX (Node 文档 net「IPC support」), 所以每次连接起一个 `acdevtool relay`
  (`crates/tool`, 只用 std 加 `uds_windows`), 它把标准输入输出接到这个套接字上, 做法同 `acdevd connect`; 找它用 `ACDEVTOOL`, 否则
  检出里 `crates/tool` 编出的. 它出错时 (连不上) 把标准错误的那行当错误交给调用方, acdev 不退出. Linux、macOS 照旧直接连.
  - 不用 TCP: QMP 能关机、截屏、注入按键, guest agent 能以 root 在客户机里跑任何命令, 开在本机端口上等于给本机所有进程客户机的 root;
    不用 QEMU 的命名管道 (`-chardev pipe`): 8.2.2 的 `chardev/char-pipe.c` 只开一个实例, 初始化时阻塞到第一个客户端连上
    (`GetOverlappedResult(…, TRUE)`), 断开后不再接新连接; 不用 TLS 预共享密钥: Bun 1.4.4 的 `tls.connect` 不支持 `pskCallback`
    (2026-11-18 acdev-test 实测, TLS 1.2、1.3 都失败).
  - 别的用户连不上靠的是 `%TEMP%` (在用户自己的 `AppData\Local\Temp` 下) 的访问控制 (默认只有本人、SYSTEM 和管理员), 套接字文件继承它〔未核实〕.
- acdevd 要的是客户机 (Linux x86_64) 的程序, Windows、macOS 上既跑不了也编不出它: 不是 Linux 的宿主必须设 `ACDEV_DEVD` 指向一个在 Linux
  上编好的 acdevd (`crates/devd` 里 `cargo build --release`, 或 `--target x86_64-unknown-linux-musl`), 否则 `start` 一开始就报错. 宿主上
  跑不了 `acdevd --version`, 所以版本改在装进客户机后核对: 客户机里的 acdevd 回答的版本和 `crates/devd/Cargo.toml` 不同就报错 (所有平台).
- `push` 的权限位: 别的平台按宿主文件有没有执行位定 755 或 644; Windows 的文件没有执行位 (Node 22.20 在 Windows 上 `stat` 出的 `mode` 连 `.exe` 都是 666, 2026-11-22 实测),
  原来推进去的一律是 644, 推进去的 Linux 程序跑不起来. 所以 Windows 上看内容: 开头是 ELF 魔数 (`\x7fELF`) 或 `#!` 的给 755, 其余 644
  (`Devd.runnable`, `src/vm/devd.ts`).
- 没有 9p: `--share` 直接报错, 用 `acdev vm push`. 没有 acdevtool view: `--viewer`、`--headless --outputs N` 报错.
- `fetch` 不建 `latest.qcow2` 符号链接 (Windows 上要管理员或开发者模式), 最新镜像的名字写在 `images/latest` (所有平台都写).

### CPU 特性

客户机内核按 x86-64-v3 编 (ackernel `_processor_opt` 默认 `v3`: AVX2、BMI2 等). `start` 在客户机就绪后读 `/proc/cpuinfo`, 缺
`avx avx2 bmi1 bmi2 f16c fma abm movbe xsave` 中任何一个就报错. WHPX 的情况 (读 QEMU 8.2.2 `target/i386/whpx/whpx-all.c`):
- QEMU 的 `host` CPU 型号只在 KVM、HVF 下注册, WHPX 用不了 `-cpu host`, 所以用 `-cpu max`;
- WHPX 只把 CPUID 的少数几个叶子 (1、0x80000001 和 VMware 的两个) 交给 QEMU 按它的 CPU 型号回答, 其余 (含 AVX2、BMI 所在的叶子 7)
  由 Hyper-V 按宿主 CPU 回答 (那里的注释: "WHPX doesn't support setting CPUID values in the hypervisor once the partition has been setup").
  所以 AVX2 等取决于宿主 CPU 和 Hyper-V; `-cpu max` 保证叶子 1 里的 AVX、FMA、F16C、MOVBE、XSAVE 报上去. 实际够不够〔未核实〕, 要在
  Windows 上跑一次看 `start` 的检查.
- 内核在特性不够时可能根本起不来 (还没到能读 `/proc/cpuinfo`), 那时 `start` 只会等到超时; 看 `logs/serial.log` (先 `acdev vm console`).

### 过渡: WSL2 里用 KVM

Windows 11 上 WSL2 默认开嵌套虚拟化 (`.wslconfig` 的 `nestedVirtualization`, 默认 `true`, 只在 Windows 11: 微软
https://learn.microsoft.com/en-us/windows/wsl/wsl-config ). 在 WSL2 的 Linux 发行版里装 Linux 版的 acdev 和 QEMU, 就是 Linux 路径
(KVM、vsock、9p 都有); 窗口经 WSLg 显示. 本机 2026-11-17 起就是这样跑的. 只是要装 WSL, Windows 10 上没有嵌套虚拟化.

## macOS (HVF)

工作项 03 (三平台模拟器里程碑). Intel Mac 跑 x86_64 客户机 (和 Linux、Windows 同一份镜像); Apple 芯片只能跑 aarch64 客户机, 见下面
「aarch64 客户机」(工作项 04).

- QEMU: `brew install qemu` (Homebrew 在 Apple 芯片上装到 `/opt/homebrew`, 在 Intel 上装到 `/usr/local`, `qemuDirs` 两处都找), 或 MacPorts.
  Homebrew 的配方 (`Formula/q/qemu.rb`) 开了 `--enable-cocoa`、`--enable-virtfs`, 关了 GTK 和 SDL; Apple 芯片上的 HVF 要 macOS 15 的 SDK
  (`--disable-hvf if … MacOS.version <= :sonoma`), 和 Intel 无关. QEMU 自己只支持最新的 macOS 和上一版两年 (https://www.qemu.org/download/ ).
- 加速: `-accel hvf -cpu host` (QEMU 的 `host` 型号在 HVF 下注册). 起不来 (比如 `sysctl kern.hv_support` 是 0) 时说原因、退回 TCG.
  QEMU 要带 `com.apple.security.hypervisor` 权利 (苹果 Hypervisor 文档); Homebrew 的 QEMU 编的时候 QEMU 的构建会签上〔未核实〕.
- 窗口: Homebrew 的 QEMU 没有 GTK, 所以 macOS 上 QEMU 自己的窗口是 `-display cocoa`; 3D (virgl) 只在 Linux 上有, macOS 上自动不开.
  `--viewer` 和 `--headless --outputs N` 要 acdevtool view, 目前只有 Linux.
- 调试通道默认走 `127.0.0.1` 的 TCP 端口转发加密钥 (`hostfwd=unix` 要较新的 QEMU, 见「调试通道」); QMP 和 guest agent 照旧是 `run/` 下的
  Unix 套接字 (macOS 的 Unix 套接字路径上限 104 字节, `ACDEV_VM_DIR` 别放太深〔推论〕). 9p `--share` 可用.
- QEMU 用分离的子进程起 (macOS 没有 `setsid` 命令, 用 Node 的 `detached`).
- acdevd 同 Windows: 设 `ACDEV_DEVD` 指向 Linux x86_64 的 acdevd.

## aarch64 客户机

工作项 04. 宿主是 arm64 (Apple 芯片的 Mac、arm64 的 Linux 或 Windows) 时客户机是 aarch64, 也可以用 `ACDEV_VM_ARCH=x86_64|aarch64` 指定
(比如在 x86 Linux 上用 TCG 慢速跑 aarch64 镜像来验证镜像本身). 和 x86_64 的差别都在 `src/vm/host.ts` (`guestArch`、`guestDevices`、
`SYSTEM_FIRMWARE`):

- QEMU 是 `qemu-system-aarch64`; 机器 `-machine virt,gic-version=…`: KVM 下 `host`, 其余 `max` (os 仓 `image/from-iso.sh` 装 aarch64 盘时用
  `virt,gic-version=max`); CPU: KVM、HVF 用 `host`, WHPX 也用 `host` (QEMU 文档 `whpx.rst` 的 arm64 例子), TCG 用 `max`.
- 固件: Debian / Ubuntu 的 `qemu-efi-aarch64` (`/usr/share/AAVMF/AAVMF_CODE.fd`、`AAVMF_VARS.fd`)、Arch 的 `edk2-aarch64`
  (`/usr/share/edk2/aarch64/QEMU_CODE.fd`、`QEMU_VARS.fd`)、Fedora 的 `QEMU_EFI-pflash.raw`, 再退到 QEMU 自带的 `edk2-aarch64-code.fd` 加
  `edk2-arm-vars.fd` (Homebrew 在 `share/qemu` 下). 两块 pflash 的写法和 x86_64 一样〔Debian、Arch 的文件名照各自的包, 未逐一核实〕.
- 显卡: virt 上没有 VGA, 用 `virtio-gpu-pci` (带 3D 时, 也就是默认, `virtio-gpu-gl-pci`), 同样带 `id=gpu0` 和 `max_outputs=N`; QEMU 文档 `whpx.rst`:
  对非 Windows 客户机, `virtio-gpu-pci` 比 `ramfb` 能做得多.
- 串口是 PL011, 客户机里叫 `ttyAMA0`: `acdev vm console` 写 `console=ttyAMA0,115200`.
- 其余设备 (virtio 盘、网卡、键盘、平板、virtio-serial 的 guest agent、两个 PCIe 根端口、`-fw_cfg` 的密钥、Linux 宿主上的
  `vhost-vsock-pci`) 写法不变: virt 也有 `pcie.0`; fw_cfg 在 virt 上走 MMIO, 客户机的 `qemu_fw_cfg` 驱动从设备树或 ACPI 找到它,
  `/sys/firmware/qemu_fw_cfg/by_name/…` 路径一样〔推论, 未在 aarch64 客户机上看过〕.
- CPU 特性检查只对 x86_64 做.
- acdevd 要 aarch64 的: 宿主架构和客户机不同 (或不是 Linux) 时必须设 `ACDEV_DEVD` (`--target aarch64-unknown-linux-musl`, 或在 aarch64
  Linux 上编).
- 镜像: `fetch` 读 `ACDEV_VM_DIST` 下的 `latest-qcow2-aarch64` (x86_64 照旧是 `latest-qcow2`), 名字里要有 `aarch64`; 最新的名字记在
  `images/latest-aarch64`, 不建 `latest.qcow2`. `latest-qcow2-aarch64` 这个文件名是我们定的, 要和 os 维护者对齐〔os 仓还没有 aarch64 镜像〕.
- Apple 芯片上的 HVF 要 macOS 15 以上编的 QEMU (Homebrew 配方在 Sonoma 及更早关掉 arm64 的 HVF). 客户机内存超过 IPA 范围时的布局 (`highmem`)
  在 Apple 芯片上的行为〔未核实〕, 内存先用默认的 8G, 不行就 `ACDEV_VM_MEMORY=4G`.

## 目录与镜像

一切在 `$ACDEV_VM_DIR` (默认 `$XDG_DATA_HOME/acdev/vm`, 即 `~/.local/share/acdev/vm`; Windows 上没设 `XDG_DATA_HOME` 时是 `%LOCALAPPDATA%\acdev\vm`): `images/` (镜像和指向最新的 `latest.qcow2`)、
`disk.qcow2` (以基础镜像为底的覆盖盘) 和 `disk.base`、`vars.fd` (UEFI 变量)、`run/` (`qemu.pid`、`qmp.sock`、`qga.sock`、`share`)、
`logs/` (`serial.log` 串口、`qemu.log` QEMU 自己的输出、`qemu.cmd` 实际的命令行). 一个目录一台客户机, `start` 前看 `qemu.pid`,
已有在跑的就报错. 本机总仓约定共用 `logs/acdev-vm` (和 acompositor-lead 共用, 起之前先 `acdev vm status`).

`fetch` 取 os 仓 CI 最新的系统 (`Machine.DIST` = `https://pkgs.dopame.ai/iso`, `ACDEV_VM_DIST` 可换; 2026-11-22 起是 Cloudflare R2, 之前在腾讯 COS (已弃用)):
磁盘镜像是 `latest-qcow2` 指的那个 (约 1.7 GB), 下载站上没有或比 ISO 旧时从 ISO 装出来 (见下「从 ISO 装出镜像」). 边下边算 SHA-256, 和 `.sha256` 对不上就删掉报错. 镜像是 acinstall 整盘装好的系统 (UEFI、systemd-boot、
根在 acfs、内核 `linux-ackernel`), 装了 qemu-guest-agent, 启动后 greetd 在 tty1 起 acdes 的登录页. 用户 `dopame` 的密码是
os CI 的 secret, 用不着: 所有操作经 guest agent 以 root 跑.

**从 ISO 装出镜像** (`src/vm/image/install.ts`, `image/fetch.ts`, 2026-11-22): os 的 `scripts/publish-iso.sh` 只往下载站发 ISO 并更新 `iso/latest`, 不发 qcow2 和 `latest-qcow2` (没有这个指针时当作没有镜像).
`fetch` 先比两个指针里文件名的时间戳 (`dopameos-<YYYYMMDDTHHMMSSZ>-<架构>`): 镜像不比 ISO 旧就照旧下载镜像; ISO 更新时下载 ISO (同样核对
`.sha256`), 在一台自己的虚拟机里把它装成 `images/<ISO 名>.from-iso.qcow2`, 同一个 ISO 只装一次 (文件在就直接用), 装好后删掉 ISO. `--from-iso` /
`--qcow2` 强制走其中一条. 做法照 os 仓 `image/from-iso.sh` (那里是 CI 出云镜像用的), 收进 acdev, 运行时不依赖 os 仓、python3 或 dash:
1. 工作目录 `images/.install-<名>/` (一台独立的 `Machine`: 自己的 `run/`、`logs/`、套接字, 不碰正在用的客户机), 建 32G 的空 qcow2, 拷一份 UEFI 变量模板;
2. 用 ISO 启动 live 系统 (q35、`-vga std -display none`、光驱 `ide-cd`, 加速器照 `start` 选: KVM / WHPX / HVF, 起不来退回 TCG 并说一声), 等 guest agent (最多 600 s);
3. 经 guest agent 跑 `acinstall probe`, 取唯一一块不忙、没有分区的盘; 写安装计划 `/run/acinstaller-plan.json` (只经 agent 的文件写入, 不上命令行):
   `{where: {mode: disk, disk}, user, fullName, password (随机, 不留存; provision 另建测试用户), host, timezone, locale, sudoNoPassword: false, portable: true}`;
4. 后台跑 `acinstall install < 计划`, 每 10 s 读 `/run/acinstaller/status.json` (`{state, step, steps}`, `step` 从 0 起, `steps` 是名字或 `{name}` 的列表),
   打 `installing: step N of M (名字)`, 直到 `state` 不是 `running` (最多 3600 s); 不是 `done` 就报「the installation failed」并打出安装日志最后 30 行;
5. 挂上装好的盘, 去掉 initramfs 的 `autodetect`、内核参数加串口, `arch-chroot` 里 `mkinitcpio -P && sdboot-manage gen` (同 from-iso.sh), 关机;
6. 换新的 UEFI 变量、`-snapshot` 再启动一次, 查根是 acfs (`findmnt`), 关机;
7. `qemu-img convert -c -O qcow2 -o compression_type=zstd` 写出镜像.
全程写 `logs/install-<名>.log`. 对着的安装器格式: os `f866410` (2026-11-22) 时的 `acinstall probe` (`{disks: [{path, busy, partitions}]}`)、上面的计划、
`status.json`; 回来的形状对不上时 (不是 JSON、缺字段) 报「the installer's format changed」(`InstallerChanged`), 和装机本身失败分开, 那时要更新 acdev.
aarch64 (Apple 芯片) 没有 ISO 也没有镜像: 直接说没有本架构的 ISO, 让用 `start --image FILE` 给一个已有的镜像.
未核实: WHPX、HVF 下 live ISO 能不能起、装机多久 (Linux KVM 上 from-iso.sh 约 10 到 20 分钟). `start` 不改基础镜像; `--fresh` 丢掉覆盖盘和 UEFI 变量重来, 换了 `--image`
也重建覆盖盘.

**`--fresh` 清掉什么, 之后要做什么**: 客户机里装的、配的东西都在覆盖盘 (`disk.qcow2`) 上, `--fresh` 连它和 UEFI 变量一起丢, 回到基础镜像:
没有测试用户 `tester`, greetd 还是镜像里的旧登录命令, acdes / Dopame 是镜像构建时的旧包, `/opt/acdev` 和 pacman 的同步数据库也没有.
覆盖盘没有备份, 所以 `--fresh` 之后先跑一遍 `acdev vm provision` (可以重复跑, 每次结果一样):

```sh
acdev vm provision \
  --acdes ~/ACDE/acdes --acdes-bin <acdes 的 guest 构建> --libacde ~/ACDE/libacde \
  --pkgs <放 dopame 包 .pkg.tar.zst 的目录> --harness <dopame-harness 的构建>
```

它把这些推到 `/opt/acdev/provision`, 以 root 跑 `provision.sh`: `pacman -Sy` 补回同步数据库 (失败重试 3 次), 补装 greetd、xdg-user-dirs 和 acdes 依赖里的 fcitx5、fcitx5-rime、rime-pinyin-simp、foot、xdg-desktop-portal-gtk, 以及 dopame 的 check:grants 要用的 git (装不上的只提示, greetd 必须有);
acdes (合成器 acompositor 在 acdes 里) 按 acdes 仓自己的 `packaging/arch/PKGBUILD` 的 `package()` 装到根; 因为不走 pacman, 先用 `pacman -T` 查出 PKGBUILD 的
`depends` 里还没满足的 (认 provides 和版本, 如 `vulkan-driver`), 只装这些 (第七轮: 客户机缺 acdes 6bbcc46 新加的 `udisks2`, U 盘没人挂载), 装不上只提示 (二进制在 `/usr/lib/acdes`, `/usr/bin/acdes` 包装脚本、
`/etc/pam.d/acdes`、登录页和锁屏页、tmpfiles 等, 与正式包同一份布局), `/usr/bin/acdert` 指向 `acdes` (先删旧包留下的, 否则 `package()` 最后的 `ln -s` 会失败), 绕开 pacman 所以手动跑一次 `systemd-sysusers` (包里的 sysusers.d 把 greeter 加进 input、video 组, 建系统总管的 `acdes-agent` 用户)、对包装进来的每个 `/usr/lib/tmpfiles.d/acde*.conf` 跑 `systemd-tmpfiles --create` (如系统总管的 `/var/lib/acdes/system-agent`、`/run/acdes-system-agent`, 在启动它之前) 和 `glib-compile-schemas`; `--harness` 给的 `dopame-harness` 装到 `/usr/lib/dopame/dopame-harness`. Dopame 本身不再由 provision 摆放 (2026-11-23 起, 总仓构建流程 ebc22af): 原来的 `--dopame DIR` 只摆了 dopame 包的一部分 (`package.json`、`mcp.json`、`dist/`、后台服务、systemd 补充配置和 `depends`), 漏了 dist-share (壁纸包、光标、声音)、图标主题、pi 和登录项, batch16 锁屏缺壁纸包就是这么来的; 现在 dopame 用它自己完整的 `package()` 出包, 经下面的 `--pkgs` 装进客户机. `--dopame` 参数还认, 但一给就报错退出 (退出码 1, 在碰客户机之前), 提示改用 `acdev vm provision --pkgs DIR`, 不会悄悄失效. 建用户 `tester`
(`--user` 可换; 有 wheel、video、input、audio、render、seat 组时加进去), 密码 `ACDEV_VM_PASSWORD` (默认 `dopame-dev`), 重置 faillock, 建 XDG 用户目录 (固定用英文名 `Desktop`、`Documents`、`Videos` 等, 和以前的客户机一样, 不随客户机语言变成中文名, 免得测试脚本依赖的目录名对不上);
装好 acdev-guest-tools (见下「客户机工具包 acdev-guest-tools」) 后, 用包里的 `/usr/lib/acdev/acdev-dev-sudo <用户>` 给这个用户写 `/etc/sudoers.d/acdev-dev` (root:root, 0440, `DEV_SUDOERS`, `src/vm/guesttools/index.ts`): dopame 的客户机检查要临时替换桌面后台服务单元 (`acdes-session-agent@<UID>.service`) 的环境,
所以只放行五条命令, `<UID>` 是这个用户的实际 UID, 不给别的 root 权限: `install -D -m 644 * <目录>/zz-dopame-check.conf`、`rm -f` 这个文件、`rmdir --ignore-fail-on-non-empty <目录>`
(目录是 `/run/systemd/system/acdes-session-agent@<UID>.service.d`)、`systemctl daemon-reload`、`systemctl restart acdes-session-agent@<UID>.service`, 都是 NOPASSWD
(主会话 2026-11-22 定, acdev 与 dopame 之间). 先写成 `acdev-dev.tmp` (名字带 `.`, sudo 不读), `visudo -cf` 过了才改名, 不过就删掉并记一条 warning;
客户机里没有 sudo (`/etc/sudoers.d`、`visudo`) 时也只记 warning. 只有 acdev 起、provision 过的开发客户机有这个文件, 正式系统没有;
把 `greeter` 用户加进 video、input 组 (登录页的合成器直接开 `/dev/input/event*`), `/var/lib/acde/greeter` 整个归 `greeter`; 写 `/etc/greetd/config.toml` 让 greetd 在 tty1 以 `greeter` 用户跑 `/usr/bin/acdes --greeter`, 最后重启 greetd (`--no-restart` 不重启).
`--pkgs <宿主目录>` (`stagePkgs`/`PKGS_SCRIPT`, `src/vm/kernelpkgs.ts`, #111): 目录里所有 `*.pkg.tar.zst` (制品站的 acdes、dopame 包) 暂存进 `pkgs/`, 客户机里在 `pacman -Sy` 之后先 `pacman -Rdd`
掉旧包 `acdebin-system`、`acde-dopame` (`LEGACY_PACKAGES`, 文件和新包冲突; 只在 `pacman -Qq` 回的正是这个名字时才卸: 新的 acdes、dopame 包 `provides` 了旧名, `pacman -Q acdebin-system` 在装过新包后也成功, 回的却是 `acdes`, 原来照样去卸, pacman 报找不到目标、provision 不能重复跑), 再装 (2026-11-23 起, 这套处理只针对 acdev 起的开发客户机): 先从每个包的 `.PKGINFO` 读出 `depend`, 用 `pacman -T` 挑出还没满足的, 去掉版本条件, 去掉 `acdes` 开头的 (provision 按 PKGBUILD 摆放的 acdes 不归 pacman 管, 不去软件源找) 和这批包自己, 剩下的 `pacman -S --needed` 补装 (装不上只记 warning); 再一次 `pacman -U --nodeps --nodeps --overwrite '*'` (不因 acdes 不在 pacman 数据库里判依赖缺失, 覆盖早先摆放留下的文件); 失败退出 3, pacman 自己的报错照常输出. 总仓 `scripts/build/pkg.sh --install` 也走这里, 客户机里装包的逻辑只有这一份. 镜像 dopameos-20261114 里还是旧包, 测新包走这条.
provision 里没停下的失败 (装不上包、单元起不来、`pacman -Sy` 一直失败) 都经 `warn` 打 `acdev provision: warning: …` 并记进暂存目录的 `warnings`, 最后有一条就列出来、退出 4 (#111: 原来只打一行, 退出 0, QA 看不出蓝牙没装上). 例外是 btvirt 编不过 (主会话 2026-11-22 定): 经 `note` 打一行 `acdev provision: note: btvirt could not be built …`, 说明模拟蓝牙关着、可以用 `--btvirt FILE` 给编好的, 不计入 `warnings`, 不让 provision 退出 4. 起因是基底镜像 dopameos-20261114 的包数据库比镜像站旧, 装 `base-devel` 时 gcc 下载 404; provision 不为它做 `pacman -Syu` 那样的部分升级.
`push` 一个文件时, 目标以 `/` 结尾或在客户机里是目录 (经 acdevd 跑 `test -d`) 就放进去 (`<目标>/<文件名>`), 和 `cp` 一样.
acdes 的源码只暂存 `packaging/` 和 PKGBUILD 里用 `${srcdir}/acdes/<路径>` 点到的文件或目录 (带 `*` 的取它所在的目录; 点到的不存在时在宿主上报错), acdes 以后在 `package()` 里多装文件也不用改 provision.
acdes 的 PKGBUILD 也装 `system-agent` (从 acdes Akira/system-agent b93072d 起, `cargo build --release --locked -p acde-system-agent`) 时要给 `--system-agent-bin FILE`, 它和 acdes 一起放进 `src/target/release/`; PKGBUILD 用到它而没给时 provision 先报错 (不让 `package()` 失败在客户机里). PKGBUILD 里没有它时照旧. 同样的规矩用于管家的 Node-API 模块: acdes 的 PKGBUILD 装
`libacdes_manager_node.so` (到 `/usr/lib/acdes/manager.node`, 桌面后台服务经它连管家; acdes Akira/supervisor-broker 起) 时要给
`--manager-node FILE` (`cargo build -p acdes-manager-node` 的产物), 放进 `src/target/release/libacdes_manager_node.so`, 没给时 provision 先报错.
系统代理同样: acdes 的 PKGBUILD 装 `release/proxy` (到 `/usr/lib/acdes/proxy`, acdes-proxy; acdes Akira/restricted-run 起) 时要给 `--proxy-bin FILE`
(`cargo build -p acde-proxy` 的产物). 这三项在 `src/vm/provision.ts` 的 `ACDES_BUILDS` 里列着, acdes 再多一个这样的产物只加一行.
这三个选项只配 `--acdes` (按检出里的 PKGBUILD 摆放) 用; 用 `--pkgs` 装制品站的 acdes 包时, 包里已经有这些文件, 不用给.
acdes 装好后 (`--acdes` 和 `--pkgs` 两条路一样, `ACDES_SERVICES`), provision 启用并 (重新) 启动系统总管 `acdes-system-agent` (以系统用户 `acdes-agent` 运行)
和系统代理 `acdes-proxy`: acdes 的包把它们装好但不启用, 留给 os 打开 (PKGBUILD 的注释), 而 dopameos-20261114 镜像不打开; 不开时总管的风险审查和
`network: proxy` 的 Agent 联网都用不了. 单元文件不在 (旧的 acdes) 就跳过; 启用或启动失败记一条 warning (provision 最后退出 4).
acdevd 由 `vm start` 自己装. 不给 `--acdes` 时只做用户、greetd 和 Dopame 那几步, 这时客户机里要已经有 `/usr/bin/acdes`.

## 客户机工具包 acdev-guest-tools (`src/vm/guesttools/index.ts`, AC/acdev#115 S2)

acdev 只往自己起的客户机里装的东西收成一个 pacman 包 `acdev-guest-tools`, 正式系统不装. 版本跟 acdev 命令行 (`package.json` 的 `version`,
pacman 不认的字符换成 `_`, 包修订号 1). 内容:

- `/usr/bin/acdevd` 和 `acdevd.service` (同引导那份单元, 只是路径换成包里的);
- `/usr/bin/acdev-agent` 和 `acdev-agent.service` (客户机代理, 见 `docs/agent.md`; 单元的正文只在 `guesttools/index.ts` 一处);
- 模拟硬件的脚本 (`/usr/lib/acdev/acdev-wifi` 等) 和单元 (`/usr/lib/systemd/system/acdev-*.service`), 三样都在, 开哪几样由 provision 定;
- `/usr/lib/acdev/acdev-dev-sudo <用户>`: 写测试用的 sudo 规则 (上面那五条命令), 规则带用户和 UID, 所以由 provision 跑, 不在包里放成品.

做法: 宿主找 acdevd (`Machine.devdBinary`, 同 `start`) 和 acdev-agent (`Machine.agentBinary`: Linux 上客户机与宿主同架构时同 acdevd 的找法, 变量 `ACDEV_AGENT`,
共用产物目录 `logs/cargo-target/rust`, 都没有就 `cargo build --release`, 要旁边的 `../libacde`; 别的宿主取 `ACDEV_AGENT` 或安装目录的 `libexec/acdev-agent-<架构>`,
没有时提示一句, 包里就不带代理), 在暂存目录的 `tools/root` 摆好文件和 `.PKGINFO`. 客户机里 provision 脚本 (建完用户之后):

1. `pacman -Q acdev-guest-tools` 报出旧版本 (和这次不同时说一句它被替换);
2. 删掉打包之前散放的文件 (`LEGACY`: `/usr/local/bin/acdevd`、`/etc/systemd/system/acdevd.service`、`/usr/local/bin/acdev-*`、`/etc/systemd/system/acdev-*.service`), 免得 `/etc` 里的单元盖过包里的;
3. 用客户机自带的 `bsdtar` 把 `tools/root` 打成不压缩的 `acdev-guest-tools.pkg.tar`, `pacman -U --overwrite '*'` 装上 (同版本也重装, 开发时同一版本号的新构建照样换进去);
4. `daemon-reload`, `enable` acdevd (不重启: provision 正经它在跑, 下次开机或 `start` 换成包里的), `enable` 并重启 acdev-agent;
5. 跑 `acdev-dev-sudo`, 再接着装模拟硬件.

发版: CI 的 `guest` 一格 (`.github/workflows/build.yaml`) 拉 libacde, 编两个架构的 acdevd 和 acdev-agent, 一起放进 `acdev-guest-<版本>.tar.gz`; 安装器把它们放成
`libexec/acdev-agent-<架构>`, Windows、macOS 上的 acdev 也就带上代理 (`scripts/release-guard.ts` 核对这四个程序都在). 代价 (估计, 还没在执行机上量过, 第一次运行后按实测改):
这一格多一次 libacde 浅克隆加 `vendor/blitz` 子模块 (约半分钟), 代理每个架构冷编约 1 分钟 (依赖是 wayland-client、serde_json、png、rustix、kurbo、peniko,
没有 V8 和 blitz), 整格约多 2 到 3 分钟, 仍在 30 分钟的时限内, 且和 `build` 并行, 不拉长整条流水线; 代理静态 musl、`opt-level = "s"`、strip 后每个约 1.5 到 2.5 MB,
`acdev-guest` 包 (gzip) 约多 1.5 到 2 MB.

## 命令

```sh
acdev vm fetch                                  # 下载并校验最新镜像
acdev vm start                                  # 后台起客户机, 开一个窗口, 等到 guest agent 和 acdevd 应答 (--wait 秒, 默认 300; 0 不等)
acdev vm start --headless --share ~/acompositor/target/release
acdev vm start --viewer                         # 画面在 acdev 自己的窗口 (acdevtool view, QEMU 的 D-Bus 显示, 见 docs/viewer.md)
acdev vm start --gtk                            # Linux 上换成 QEMU 的 gtk 窗口 (默认是 SDL); 客户机先按开窗时的小窗口起
acdev vm view                                   # 关掉之后再开一个 acdevtool view
acdev vm start --outputs 2                      # 两个显示输出 (多屏验收), QEMU 窗口里每个输出一个标签页
acdev vm screenshot second.png --output 1       # 取第二个输出
acdev vm status                                 # 目录、镜像、KVM、客户机在不在跑、是否就绪
acdev vm run -- 'uname -a; systemctl is-active greetd'   # 退出码就是客户机里命令的退出码
acdev vm shell                                  # 交互终端 (root 的登录 shell); acdev vm shell -- htop 只开一个程序
acdev vm logs 1234 --follow --grep error         # 跟着看 run --detach 那个进程组的输出, 只留含 error 的行
acdev vm push target/release/acompositor             # 拷进客户机 /opt/acdev/acompositor (目录也行: 打 tar 过去再解开); 可执行 755, 其余 644 (Windows 上按内容: ELF 和 #! 脚本是 755)
acdev vm pull /tmp/shots ./shots               # 从客户机拉回文件或目录 (只留读写执行位); LOCAL 是已有目录时放进 LOCAL/<名字>
acdev vm mount                                  # 把 --share 的目录经 9p 挂到客户机 /mnt/acdev
acdev vm screenshot shot.png                    # QMP screendump, 无窗口也行; 带 3D (窗口里默认) 时截不出, 用 acdev screen --session vm -o shot.png 或不加 --gl 的 --headless
acdev vm console                                # 客户机内核日志从下次启动起进串口
acdev vm login                                  # 在登录页登录 tester (密码 ACDEV_VM_PASSWORD, 缺省 dopame-dev); acdev vm login qa 换用户
acdev vm stop                                   # 让客户机自己关机 (acdevd → guest agent → ACPI), 都不行才杀掉 QEMU
```

- `login [USER]` (`src/vm/guest.ts` `loginGuest`, 2026-11-22): 不按键登录. 密码 (`ACDEV_VM_PASSWORD`, 缺省 `dopame-dev`) 经 acdevd 推成 `/run/acdev-login-<随机>`
  (0600, 不上命令行), 以 root 跑 `faillock --user USER --reset` 和 `acdes greeter login USER < 文件`, 再删文件. acdes 那条命令只在 acdev 起的客户机里可用,
  交给正等着的登录页, 最多等 30 s 到 logind 里有这个用户的会话 (acdes `docs/packaging.md`「开发登录」). 退出码: 0 已登录 (本来就登录着也是 0), 1 密码错或没等到会话,
  2 用法错或不是开发客户机 (旧 acdes 没有这条命令也落在 2 或 127), 3 没有正等着的登录页; acdev 把它们换成一句说明. `acdev test --vm` 开头先登录一次: 1 照旧报错,
  2、3、127 只说一句、接着按原来的办法找会话.
- `acdev vm stop` (`Machine.stop` / `Machine.shutdown`) 按四级依次退, 输出写明是哪一级关掉的, 一眼看出是不是退到了强杀:
  1. acdevd 在场 (先 `version` 探一下) 时经它以 root 跑 `systemctl poweroff --check-inhibitors=no`: 不让会话里的抑制锁拦住, 也不经桌面
     (Dopame 的电源键默认是「问我要做什么」, 只按 ACPI 电源键时客户机只弹出询问, 原来要等满 60 s 再杀). 关机会把 acdevd 自己停掉,
     所以连接断开、拿不到退出码都算已发出; 退出码不是 0 才算失败. 之后等 QEMU 进程退出, 最多 30 s.
     30 s 到了还没关掉 (多半是某个单元停不下来, systemd 默认会等它 90 s) 就先留诊断再退下一级: 经 guest agent 跑
     `systemctl list-jobs --no-pager` 和 `journalctl -b -n 80 --no-pager -o short-monotonic`, 输出打到 stderr 并写进
     `<vm 目录>/logs/stop-<时间>.log`, 路径另起一行说出来; guest agent 不回应时说一句就跳过.
  2. acdevd 不在场或跑失败时, guest agent 的 `guest-shutdown` (`mode: powerdown`; 成功时它不回答, 发完就关连接), 同样最多等 30 s.
  3. 再不行发 QMP `system_powerdown` (ACPI 电源键), 等 10 s.
  4. 最后给 QEMU 发 SIGTERM.

- 设备: q35、virtio-blk 系统盘、`virtio-vga` (客户机用 CPU 软件渲染, 不用 Mesa; 以后由 detour 做虚拟显卡转发, 用户 2026-11-17 定.
  默认是带 GL 的 `virtio-vga-gl` 即 virgl, 见上面「3D」; `--no-gl` 换回 `virtio-vga`)、`virtio-keyboard-pci`、`virtio-tablet-pci`
  (绝对坐标, 指针跟着宿主鼠标)、virtio-net (用户态网络)、guest agent 的 virtio-serial 通道、`-virtfs` (有 `--share` 时).
  CPU 和内存用 `ACDEV_VM_CPUS` (4)、`ACDEV_VM_MEMORY` (8G). QEMU 经 `setsid` 起在后台, 不随 `acdev` 退出.
- guest agent 的套接字一次只接一个客户端: `GuestAgent.open` 先发 `guest-sync` 跳过前一个客户端留下的输出, 等不到就关掉连接, 不然后来的都连不上.
- `start` 等 guest agent 时 (`--wait` 秒, 默认 300; `Machine.ready` → `GuestAgent.ping`, 2026-11-23 用户在 Windows 上等了 2.5 分钟一行输出也没有):
  先说一句在等什么 (哪个套接字、多久、每 15 s 一行), 之后每 15 s (`WAIT_EVERY`) 打一行: 已经等了多久、超时多少、上一次连接为什么不行、串口日志在哪.
  每次没连上都查一下 QEMU 还在不在 (`run/qemu.pid` 和进程), 不在了就马上报错, 指向 `logs/qemu.log` 和 `serial.log`, 不再等满超时.
  超时后客户机照样跑着, 话里给出下一步: 看 `serial.log` (默认只有固件和引导器的输出, `acdev vm console` 之后才有内核的) 和 `qemu.log`,
  再 `acdev vm status`、`acdev vm wait` 接着等或 `acdev vm stop`. `vm wait` 用同一套进度行和超时说明.
- 等不到 guest agent 的几种情形, 从代码看: 每次尝试都要新起一个连接 (Windows 上是一个 `acdevtool relay` 进程) 发 `guest-sync`, 5 s 内没回就关掉,
  隔 2 s 再试, 客户机里的 agent 起来之前一直这样, 原来不出声. (1) 客户机本身起得慢: WHPX 比 KVM 慢, 第一次启动还要过 UEFI 和首次开机的初始化, 起不来
  退回 TCG 时更慢 (`start` 会说); (2) Windows 上 `acdevtool relay` 本身不可用 (找不到 `acdevtool.exe` 时 `crateBinary` 每次都抛错, 或连接报错):
  原来这些错误被当成“还没好”默默重试到超时, 现在进度行里的“上一次为什么不行”会把它说出来; (3) QEMU 中途退了 (比如 WHPX 出错): 原来照样等满,
  现在马上报. 用户那次是哪一种, 要看进度行或 `qemu.log`〔未在 Windows 上复现〕.
- 等待时按 Ctrl-C: 只停下等待, 不杀 QEMU (`start` 的 SIGINT 处理, 退出码 130), 说一句 `qemu (pid N) keeps running` 并指向 `acdev vm wait`、
  `acdev vm status`、`acdev vm stop`; 之后的命令照 `run/qemu.pid` 认出它. 只有 `start` 自己出错 (不是中断) 时才收掉 QEMU. QEMU 以分离进程起
  (Windows 上 `DETACHED_PROCESS`, 没有控制台), 收不到控制台的 Ctrl-C.
- 上次留下的套接字 (Windows): `%TEMP%\acdev-<哈希>\qga.sock` 这类 AF_UNIX 套接字文件, Node 先 `lstat` 再删时报 `EACCES` (2026-11-23 用户第二次
  `start` 就停在这里). 现在逐个 `unlink` (`host.ts` `clearSockets`), 删不掉就换一个新的套接字目录 `acdev-<哈希>-<随机>` 并记在 `run/sockets`,
  这次启动和之后的命令都从那里找; 下次 `start` 先忘掉这条记录, 再试默认目录. 上次的 QEMU 已经不在时不会因此失败.
- 串口里默认只有固件和 systemd-boot 的输出: 装好的系统是静默启动 (`quiet loglevel=3`, 没有 `console=ttyS0`). `console` 在客户机启动项命令行
  末尾加 `console=tty0 console=ttyS0,115200 loglevel=6` (写在覆盖盘里, 重复跑不叠加).
- 调试通道 (用户 2026-11-18 定): `start` 按平台选传输, 记在 `run/link.json`, 之后的命令照它连. Linux 用 vsock (`vhost-vsock-pci`);
  Windows、macOS 的 QEMU 没有 vsock, 改用用户态网络的端口转发 (`hostfwd=tcp:…`), 把 `127.0.0.1` 上一个空闲端口转到客户机 acdevd 的
  TCP 端口 5252, 靠握手密钥挡住本机别的进程 (acdev-lead 2026-11-18 定: macOS 和 Windows 一样默认走 TCP). 转发时不加 vsock 设备.
  `ACDEV_VM_TRANSPORT=vsock|unix|tcp` 强制选一种 (Linux 上用来验证转发). 每次 `start` 生成一个密钥写到
  `run/key` (只有自己能读), 经 `-fw_cfg name=opt/acdev/key,file=run/key` 交给客户机; 每条连接先发它 (见 `docs/devd.md`「传输与密钥」).
- `unix` 只在显式设了时用: 转到 `run/devd.sock` (`hostfwd=unix:…`, 文件权限另挡一层), 条件是
  - QEMU 带这个功能: 2025-08 写成、2025-10-05 合入主线 (QEMU 提交 6d10e021318b, "Add a feature for mapping a host unix socket to a
    guest tcp socket"), 第一个带它的发行版大概是 10.2 (未核实); 不支持时 QEMU 起不来, 报 `Invalid host forwarding rule 'unix:…' (Bad
    protocol name)` (本机 Ubuntu 24.04 的 QEMU 8.2.2, 2026-11-18 实测);
  - libslirp 4.7.0 或更新 (同一提交里的 `SLIRP_CHECK_VERSION(4, 7, 0)`), 而且不是 Windows 宿主 (`!defined(WIN32)`);
  - 套接字路径里没有 `-`: 转发规则按第一个 `-` 切开宿主一侧和客户机一侧, 直到 2026-06-12 合入的提交 2ec80ad92840 ("net/slirp: allow
    hostfwd socket paths with dashes") 才改成按最后一个切, 哪个发行版起带它未核实. `ACDEV_VM_DIR` 的路径里有 `-` 时 (如测试的临时目录)
    要用更新的 QEMU.
  出处: https://github.com/qemu/qemu/commit/6d10e021318b16e3e90f98b7b2fa187826e26c0a ,
  https://github.com/qemu/qemu/commit/2ec80ad92840df9750e9ad5beed494cb0b202ba9 .
  `status` 写出走的是哪种.
- 多个显示输出: `--outputs N` (1–16, 默认 1) 给显卡加 `max_outputs=N` (`virtio-vga` / `virtio-vga-gl` 的属性, 默认 1; 上限是 QEMU 的
  `VIRTIO_GPU_MAX_SCANOUTS` 16, 本机 QEMU 8.2.2 的 `-device virtio-vga,help` 核对过). 显卡固定 `id=gpu0`, 截图 `--output K` 就是 QMP
  `screendump` 的 `device: "gpu0", head: K` (`head` 必须和 `device` 一起给, QEMU `qapi/ui.json`).
  - 第 1 个以后的输出要有显示前端"接上"才算连接: QEMU 8.2.2 的 virtio-gpu 起来时只打开第 0 个输出 (`hw/display/virtio-gpu-base.c`
    `enabled_output_bitmask = 1`), 其余要等前端经 `dpy_set_ui_info` 报一个非零大小 (`virtio_gpu_ui_info`). GTK 窗口为每个输出建一个标签页
    并报大小, 所以都连上; `-display none` 不报, 第二个输出一直是 disconnected (2026-11-18 acompositor-test 实测).
  - 所以 `--headless --outputs N` (N ≥ 2) 不用 `-display none`, 改用 `-display dbus,p2p=yes` (不开窗口), 起来后 acdev 跑一次
    `acdevtool view --qmp … --outputs N`: 经 D-Bus 对 `Console_1`…`Console_{N-1}` 调 `SetUIInfo` (1280×800, 依次向右排), 就是 GTK 做的那件事
    (`ui/dbus-console.c` `dbus_console_set_ui_info` → `dpy_set_ui_info`), 然后退出; 打开的状态留在显卡里. 要 acdevtool view (同 `--viewer`).
    `egl-headless` 不报大小 (`ui/egl-headless.c` 不调 `dpy_set_ui_info`), 不能用.
  - `--vnc` 和 `--viewer` 只显示第一个输出 (VNC 服务端绑一个控制台〔未核实〕, acdevtool view 只接 `Console_0`), 和 `--outputs` 2 以上
    一起用时直接报错.
- 热插拔: q35 的根总线 `pcie.0` 不能热插拔 (`device_add` 报 `Bus 'pcie.0' does not support hotplugging`), 所以 `start` 预留两个
  PCIe 根端口 `rp1`、`rp2` (`chassis` / `slot` 11、12). 热插拔时 `device_add` 带 `bus=rp1` 或 `bus=rp2`, 一个端口挂一个设备.
- 设备守护进程: `start` 在客户机就绪后经 guest agent 核对 acdevd: acdev-guest-tools 装的 `/usr/bin/acdevd` 和宿主这份校验和相同时就用它 (若还留着下面这份引导用的, 删掉、`daemon-reload` 后重启 acdevd);
  否则装引导用的一份 (`/usr/local/bin/acdevd` 加 `/etc/systemd/system/acdevd.service`, 盖过包里的单元; 和宿主这份校验和不同才拷), 因为 provision 本身要经 acdevd 推文件、跑脚本.
  单元开机自启, 起之前 `modprobe qemu_fw_cfg`; 包旧了 (acdev 升级后还没重新 provision) 时也是引导的那份顶上, 重新 provision 后包里的接回来; 等它在调试通道上应答 (见 `docs/devd.md`). vsock 时 QEMU 带 `vhost-vsock-pci`, 客户机的 CID 由
  `$ACDEV_VM_DIR` 的路径算出 (`Machine.cid()`, 3 起), 宿主要能读写 `/dev/vhost-vsock`. 宿主一侧的 acdevd 取 `ACDEV_DEVD`, 否则用检出里
  `crates/devd/target/release/acdevd`, 没有就先 `cargo build --release` 编出来.
- `run`、`push`、`pull`、`kill` 走调试通道: `run` 经 `/bin/sh -c` 跑, 输出边跑边转回, 退出码就是它的; `--detach` 放后台、打印进程组号, 输出写到客户机
  `/var/log/acdevd/<进程组号>.log`; `kill PID` (`--force` 用 SIGKILL) 停掉整个进程组; 在宿主上按 Ctrl+C 断开时, 前台运行的程序被结束.
- `shell` 在客户机里开一个伪终端 (pty): 本地终端切到原始模式, 按键原样送进去 (Ctrl+C 给客户机里的程序), 本地窗口改大小时跟着改,
  退出码就是 shell 的. 不带命令时是 root 在 `/etc/passwd` 里的登录 shell (`-l`); 标准输入不是终端时也能用, 读完时送一个 Ctrl+D.
- `logs [SOURCE]` 经 `run` 在客户机里跑 `journalctl` 或 `tail`: 不带时是整个日志 (journald), 数字是 `run --detach` 的进程组号
  (`/var/log/acdevd/<号>.log`), `/` 开头是客户机里的文件, 其余当 systemd 单元名 (`journalctl -u`). 先给最后 `--lines` 行 (默认 50),
  `--follow` 一直跟着, 按 Ctrl+C 断开时客户机里的 `tail` / `journalctl` 随之结束. `--grep` 是正则 (不分大小写), 在宿主上按整行过滤.
- `dev [DIR]` 是构建、推送、运行的一条龙 (实现在 `src/vm/loop.ts`): 在宿主上进 DIR (默认当前目录, 那里的 `rust-toolchain.toml` 照常生效) 用 `cargo build --profile <配置>` 编它的 Cargo 项目 (`--profile`, 默认: 项目有 `[profile.guest]` 时用这个快速配置, 否则 `release`; 见 `docs/runtime-build.md`)
  (`--bin A,B` 只编这几个), 从 cargo 的 JSON 消息里取出可执行文件, 推到客户机 `/opt/acdev/bin/<名字>`, 把 `--run` 的命令 (默认第一个二进制;
  `/opt/acdev/bin` 加在 `PATH` 前面) 放后台跑, 用 `tail --pid` 把它的日志转到宿主的标准输出. 之后每秒看一遍 DIR 里文件的修改时间和大小
  (跳过 `target`、`.git`、`node_modules`; `CARGO_TARGET_DIR` 放在 DIR 里别的名字下会一直重编), 变了就重编: 编不过时旧程序接着跑,
  编过了就停掉旧的进程组、推送、再起. Ctrl+C (终端里 cargo 一起收到) 停掉程序后退出; 再按 Ctrl+C 不会跳过这一步.
- guest agent 只用来装 acdevd、`mount` 和 `console`.

## 模拟硬件

原本只能真机测的硬件, 在 QEMU 里能模拟的部分. 参数在 `npm/src/vm/hardware.ts`, U 盘在 `usb.ts`, 测试在 `test/vm/qemu.test.ts`「emulated hardware」.

### 声音

`start` 总是带一块声卡: `ich9-intel-hda` 加 `hda-duplex` (一路输出、一路输入). 选 HDA 不选 `virtio-sound-pci`: 本机 QEMU 8.2.2 两者都有
(`-device help` 核对过), 但 virtio-sound 是 8.2 才加的, 客户机内核要 `CONFIG_SND_VIRTIO`; HDA 由通用的 `snd-hda-intel` 驱动, 任何发行版内核都认,
q35 本身就是 ICH9, aarch64 的 virt 上走 PCIe 也能用. 后端由 `--audio` 选 (`-audiodev ...,id=snd0`):

```sh
acdev vm start                       # 默认 --audio none: 客户机有声卡, 声音哪里也不去
acdev vm start --audio wav           # 声音写进 <vm 目录>/logs/audio.wav (QEMU 的 wav 后端), 用来核对确实有输出
```

### U 盘

`start` 总是带一个 xHCI 控制器 (`-device qemu-xhci,id=xhci`). U 盘在运行中经 QMP 插拔: `blockdev-add` (raw, 节点名 `usbN-disk`) 加
`device_add usb-storage,bus=xhci.0,drive=usbN-disk,id=usbN,removable=on`; 拔是 `device_del`, 再反复 `blockdev-del` 直到客户机放开 (最多 10 秒).
插着的记在 `<vm 目录>/run/usb.json`, `start` 时清掉.

```sh
acdev vm usb add stick.img                   # stick.img 不存在时按 --size (默认 256M) 新建并格式化成 FAT, 卷标 ACDEV
acdev vm usb add photos.img --size 2G
acdev vm usb list                            # usbN 和镜像路径
acdev vm usb remove                          # 拔最后插的; 也可以给镜像路径或 usbN
```

新建镜像要本机有 `mkfs.vfat` (dosfstools) 或 `mkfs.exfat` (exfatprogs), 依次找 PATH、`/usr/sbin`、`/sbin`; 都没有就报错并说要装哪个,
不换别的办法. 镜像整块就是一个文件系统, 没有分区表 (U 盘常见的「超级软盘」布局).

### 睡眠

x86_64 (q35) 上开 S3: `-global ICH9-LPC.disable_s3=0`. 上游 QEMU 本身默认就开 (`hw/acpi/ich9.c` 的 `ich9_pm_reset_properties` 里
`disable_s3 = 0`), 显式写上是因为 libvirt 等常把它关掉, 这里不依赖默认. 客户机挂起后 (`systemctl suspend` 或电源设置), 用 `acdev vm wake`
(QMP `system_wakeup`) 叫醒; 客户机没睡时它什么也不做. aarch64 的 virt 没有 ACPI S3, 不加这个参数.

**测睡眠、唤醒要用 `--vga std`**: 默认的 virtio-gpu 过不了 S3, 唤醒后黑屏. 这是 QEMU 的已知缺陷 (QEMU issue #1860): 复位时显卡销毁了显示
资源, 客户机驱动恢复后还拿旧的资源编号提交, QEMU 报 `0x1203` (资源编号无效). `--vga std` 换成标准 VGA (x86_64 是 `-device VGA`,
aarch64 是 `bochs-display`〔aarch64 未核实〕), 客户机里由 bochs-drm 驱动; acompositor 只要 dumb buffer, 它满足.

```sh
acdev vm start --vga std                       # 标准 VGA, 1280x800
acdev vm start --vga std --resolution 1600x900
acdev vm run --detach systemctl suspend    # 后台跑, 不等它; 睡下后再 acdev vm wake
```

代价: 只有一块屏 (`--outputs` 2 以上报错); 分辨率固定在开机时给的大小 (`xres` / `yres`, 默认 1280x800), 不随窗口变 (标准 VGA 不接
窗口报来的尺寸); 没有 3D (默认的 GL 在这里自动不开). `--resolution WxH` 对 virtio 也有效, 是它开机时的首选分辨率 (之后照样跟着窗口变).
客户机内核要带 bochs 模块 (`CONFIG_DRM_BOCHS`, 模块名 `bochs`): 各轮测试的日志里查不到 `modinfo bochs` 或 `lsmod` 的记录, ackernel 的
配置脚本 (`packaging/configure.sh`) 也没有显式写它〔未核实〕; 起 `--vga std` 前在客户机里跑 `modinfo bochs` 确认. 还要注意 ackernel 的
`agentos-drivers prune` 按机器上的硬件删驱动, 在 virtio 显卡下 prune 过的客户机可能把 `bochs` 删掉 (`drivers/gpu/drm` 属于 gpu-other 组).

### 双屏

`--outputs N` 的参数链路 (`Machine.args`、`afterStart`、`switchOnOutputs`):
- `--headless --outputs N`: `-display dbus,p2p=yes`, 起来后 `acdevtool view --outputs N` 打开第 1 个以后的输出 (见上面「多个显示输出」).
- 带窗口: GTK 为每个输出建标签页并报大小, 都连上. SDL 不行: 它只在用户拉动窗口时报大小, 第 1 个以后的输出没有窗口可拉, 客户机一直看到
  disconnected. 所以默认窗口在 `--outputs` 2 以上时改用 GTK (说一句), 明说 `--sdl --outputs N` 报错.
- `--vnc`、`--viewer` 只显示第一个输出, 和 `--outputs` 2 以上一起用时报错 (不变).

### Wi-Fi、蓝牙、电池共同的做法 (客户机里, `src/vm/guesthw.ts`)

QEMU 没有无线网卡、蓝牙和电池, 这三样在客户机里用内核的模拟模块造, 默认都带 (用户 2026-11-19): `acdev vm provision` 把要的包
(`hw/packages`)、要开的单元 (`hw/on`) 和要关的单元 (`hw/off`) 写进暂存目录; 脚本 (`acdev-wifi`、`acdev-bt`、`acdev-battery`、`acdev-btvirt-build`, 在 `/usr/lib/acdev`)
和 systemd 单元 (`acdev-wifi.service`、`acdev-bt.service`、`acdev-battery.service`, 在 `/usr/lib/systemd/system`) 三样都随 acdev-guest-tools 装进去. provision 脚本装包
(装不上打一行 warning, provision 最后退出 4), `daemon-reload` 后对 `hw/on` 里的单元 `enable` 并立即 `restart` 一次, 再把单元日志里脚本自己的那两行 (`acdev-…: …`) 转到 provision 的输出. 以后每次开机由单元启用.

- 关掉: `--no-wifi` / `--no-bluetooth` / `--no-battery`. 关掉的那项不装包、不开单元; 已开的单元 `disable --now`
  (`hw/off` 列出它们), 单元和脚本仍在包里, 照样能手动跑. 旧的 `--wifi` / `--bluetooth` / `--battery` 已过时, 仍认, 什么也不改变.
- 单元: `Type=oneshot` + `RemainAfterExit=yes`, `ExecStart` 调脚本的 `up` (电池是 `100 charging`), `ExecStop` 调 `down` (电池 `off`),
  `Wants=` + `After=` 各自的守护进程 (NetworkManager、bluetooth、upower; 脚本里的 `systemctl start` 因此不会和开机顺序互等),
  `WantedBy=multi-user.target`.
- 缺内核模块、缺包或缺 `btvirt` 时脚本以 4 退出并说缺的是什么; 单元写了 `SuccessExitStatus=4`, 所以开机时这算成功 (单元是 active,
  开机不会被标成 degraded), 只在 journal (`journalctl -u acdev-wifi`) 和 provision 输出里留一条说明. 注意 hostapd、btvirt 自己起不来
  也是 4, 同样只留日志. 手动跑脚本时退出码照旧是 4.
- 手动起停: `acdev vm run -- systemctl stop|start acdev-wifi` (单元), 或直接 `acdev vm run -- acdev-wifi up|down` (脚本要 root, acdevd 是 root).
- 被 `agentos-drivers prune` 卸掉的模块 (第六轮查清, 之前这里的推断是错的): `mac80211_hwsim` 只有 virtio 的设备别名, 而 virtio 是固定总线,
  按 ackernel 的拆包规则 (`packaging/arch/split.awk`、`module-groups`) 它进了组包 `linux-ackernel-wifi-other`; 装机时 os 仓的
  `agentos-drivers prune` 把这台机器用不上的组包整个卸掉, 客户机里就没有它了. `bochs` (`--vga std` 用) 在 `linux-ackernel-gpu-other`
  里, 一般因为 virtio-gpu 也在这个组包而被留下, 但同样可能被卸. 所以 provision 装完基本的包后先查 `modinfo bochs`, 不在就
  `pacman -S --needed --noconfirm linux-ackernel-gpu-other` (总是查, 和 `--vga` 无关); 模拟硬件一节开头再查: Wi-Fi 那一项开着 (没有 `--no-wifi`) 且
  `modinfo mac80211_hwsim` 不在就装回 `linux-ackernel-wifi-other` (`PRUNED`, `src/vm/provision.ts`). 装上后不用重启, 下次 `modprobe`
  就能载入: 模块依赖表由装包时的 depmod 钩子更新〔推断: kmod 的 pacman 钩子〕, 装完仍查不到模块时 provision 再跑一次 `depmod -a`.
  装不上 (拿不到包、找不到包名) 只打一行 warning, provision 照常往下走, Wi-Fi 一项照旧按缺模块只记日志.
  之后如果在模块没载入时 (例如关掉了 `acdev-wifi.service`) 再跑 prune, 又会把组包卸掉; 重新 `acdev vm provision` 就能装回.
  组包从哪来 (第七轮查, 只读): 没有能给客户机配的仓库. ackernel 的 CI (`.gitea/workflows/cicd.yaml` 的 publish 步骤) 只把每次构建的产物
  rsync 到内网构建产物目录的 `stable/<编号>/` (另有指向最新一批的 `stable/latest`), 不是 pacman 仓库; os 的说法是模块组包和元包
  `linux-ackernel-drivers`「不是组件」, 只经 `AGENTOS_ACKERNEL_MODULE_PACKAGES` 进 live ISO 的本地仓库, 不进 `/opt/agentos`, 所以装好的
  系统里没有它们的来源; acinstaller 也写 `linux-ackernel` 不在 pacman 仓库里. os 的 `agentos` 仓库有没有组包没核实, 客户机也没配这个源.
  所以不给下面的参数时, `pacman -S linux-ackernel-wifi-other` 在客户机里报「未找到目标」, provision 只打 warning.
- `--kernel-pkgs <宿主目录>` (`src/vm/kernelpkgs.ts`): 从 ackernel CI 的产物目录里取**和客户机 `linux-ackernel` 同版本**的那一批
  (`stable/<编号>/`, 看客户机 `pacman -Q linux-ackernel` 的 pkgver-pkgrel 找对应的编号), 把整批或其中的组包放进一个宿主目录, provision
  不联网去取. 宿主上: 只认 `linux-ackernel-<组>-<pkgver>-<pkgrel>-<arch>.pkg.tar.zst` (主包 `linux-ackernel`、`-headers`、元包 `-drivers`
  和其他文件忽略), 一个都没有或版本不止一个就报错退出; 组包和它们的版本放进暂存目录 `kernel/`, 随 provision 推进客户机. 客户机里
  (装完基本的包、查 `bochs` 之前): `pacman -Q linux-ackernel` 的版本和这批不同就退出 3, 说出两边的版本和该取哪一批; 相同就按
  `pacman -Qqp` 取包名, 只 `pacman -U --needed --noconfirm` 客户机还没有的组包 (已装的组包和主包不动), 装不上也退出 3. 之后照常查
  `bochs` 和 `mac80211_hwsim`, 这时它们已经在了.
- `test_power` 和 `hci_vhci` 第六轮里客户机都有.

### Wi-Fi

`acdev-wifi up|down`. `up`: `modprobe mac80211_hwsim radios=2`, 第一个口交给 hostapd,
一个 hostapd 在 6 信道起两个接入点 (第二个用 `bss=<口>_1`, BSSID 是第一个口的 MAC 末字节加 1).
起 hostapd 之前先写 `/run/NetworkManager/conf.d/90-acdev-wifi.conf` (`[keyfile] unmanaged-devices` 列出 `<口>` 和 `<口>_1`) 并让 NetworkManager 重读配置:
只对第一个口 `managed no` 不够, hostapd 新建的 `<口>_1` 会被 NetworkManager 接管成普通网卡 (随机 MAC、类型 managed), `acdev-wpa2` 就没了,
它在同一块无线电上扫描还会搅乱 `acdev-open` (batch21、batch22). `up` 最后核对 `<口>_1` 确实是 AP, 不是就报出 hostapd 日志:

| SSID | 安全 | 密码 |
| --- | --- | --- |
| `acdev-open` | 开放 | 无 |
| `acdev-wpa2` | WPA2-PSK (CCMP) | `acdev-wifi-pass` |

第二个口交给 NetworkManager (`managed yes`, 再 `rescan`), 设置和控制中心能扫到这两个网络, 连 `acdev-wpa2` 时页面要密码.
NetworkManager 不会自己连上它们, 包括开放的那个: NetworkManager 只自动连已有的连接配置 (connection profile), 不为扫到的陌生网络
新建配置, 而脚本只扫描、不建配置. 测试里在设置中连过一次后, NetworkManager 会存下配置 (默认 `autoconnect=yes`), 之后开机会自己连;
要回到没连过的状态, `acdev vm run -- nmcli connection delete acdev-open` (或 `acdev-wpa2`).
配置和日志在 `/run/acdev-wifi/`. `down` 停 hostapd、删掉那份 NetworkManager 配置、卸掉模块. 包: `hostapd`、`iw` (NetworkManager 镜像里已有).

### 蓝牙

`acdev-bt up|down`. `up`: `modprobe hci_vhci`, 用 BlueZ 测试工具 `btvirt -C 5.2 -l2` 造两个虚拟控制器 (经 `/dev/vhci`, 它们之间能互相看见),
起 `bluetoothd`; 编号最大的那个当“对面的设备”: `btmgmt` 开电、改名 `acdev-peer`、可连接、可被发现, 在另一个上扫描就能找到它.
`bluetoothd` 两个控制器都管, 设置里会出现两个适配器 (没有办法只让它管一个). `down` 停 btvirt、卸掉模块.
- 按路径找 btvirt (`/usr/local/bin`、`/usr/lib/bluez`、`/usr/libexec/bluetooth`、`/usr/bin`, 最后 `type -P`): 第七轮里脚本的函数也叫
  `btvirt`, `command -v btvirt` 返回的是函数名, 装好的 `/usr/local/bin/btvirt` 也被当成没有; 函数已改名 `find_btvirt`.
- `-C 5.2` (第七轮查清): btvirt 默认造 Core 6.2 的双模控制器 (bluez 5.88 `emulator/main.c` 的 `BTDEV_TYPE_BREDRLE62`), 它在 LE
  特性里报 Shorter Connection Intervals (`emulator/btdev.c` 的 `le_features[9]`), 内核 (客户机 7.3) 于是在初始化时发 LE Read Connection
  Interval (0x20a3); btdev 回一组区间, 内核报 `Invalid response length for 0x20a3`、`Opcode 0x20a3 failed: -38`, 控制器初始化失败,
  不报给管理接口, `btmgmt info` 是 0 个、设置里“蓝牙不可用”. `-C 5.2` 的控制器不报这个特性, 也没有 6.x 的 LE 命令, 内核就不发它
  〔推断: 内核只在控制器报了这个特性时才发 0x20a3, 没对照 7.3 的 `hci_sync.c` 逐行看; 要等客户机里验证〕. `-C 6.0` 也不带 6.2 的特性,
  选 5.2 是为了连 6.0 的 Channel Sounding 一起避开. 不用 `-B` (只有 BR/EDR): 双模更像真机, 设置页的 LE 部分也能看到.
  btvirt 走的就是 `/dev/vhci` (`-l` 每个控制器 `vhci_open` 一次), 不是它的 server 模式.
- `up` 起 bluetoothd 后等最多 6 秒, 要管理接口 (`btmgmt info`) 看到两个控制器才算起来; 看不到时以 4 退出, 并带上 dmesg 里最后两行
  `Bluetooth: hci…`, 下次一眼就能看出是哪条命令卡住.
`btvirt` 从哪来 (2026-11-19 查): Arch 官方仓库里没有它, 已核实 `bluez-utils` 和 `bluez-deprecated-tools` 的文件列表 (archlinux.org
的包页面) 都没有; 第六轮客户机里也找不到. 它是 BlueZ 源码 `emulator/btvirt`, 只在 `--enable-testing` 时编. AUR 有没有现成的包没查到
(网页被拦), 也不想让 provision 依赖 AUR 助手. 所以 provision 按顺序:
1. 给了 `acdev vm provision --btvirt FILE` (在别处编好的 btvirt) 就装到 `/usr/local/bin/btvirt`;
2. 客户机里已有 `btvirt` 就用它;
3. 否则跑 `acdev-btvirt-build` (`/usr/lib/acdev`, 也能手动跑): 取已装 `bluez` 的版本 (`pacman -Q bluez`, 去掉包修订号),
   装 `base-devel glib2 dbus curl xz`, 下载 `https://www.kernel.org/pub/linux/bluetooth/bluez-<版本>.tar.xz`,
   `./configure --enable-testing` 并关掉用不到、要额外依赖的部分 (`--disable-manpages --disable-obex --disable-cups --disable-client
   --disable-mesh --disable-midi --disable-udev --disable-systemd --disable-hid2hci`), 只 `make emulator/btvirt`, 装到 `/usr/local/bin/btvirt`.
   失败 (没网、缺依赖、编不过, 包括包数据库比镜像站旧时 gcc 404) 只打一行 note, 不算 provision 的 warning, 蓝牙那一项照旧以 4 记日志.
没选自己写 `/dev/vhci` 的小程序: 要让 bluetoothd 认出适配器, 得回答内核初始化时的整套 HCI 命令 (复位、读特性、版本、地址、缓冲区…),
还要能扫到对面设备, 等于重写 btvirt 背后的 `emulator/btdev.c`; 用和已装 bluez 同版本的源码编 btvirt 最省事也最贴近真实.
〔未核实〕: 这组 configure 选项在客户机的 bluez 版本上能不能过、`make emulator/btvirt` 需不需要别的依赖, 要等客户机里跑一次.
包: `bluez`、`bluez-utils` (镜像里已有).

### 电池

libacde 读电池走 UPower 的 D-Bus (`src/runtime/power/bus.rs`: `EnumerateDevices`、每个设备的 `Percentage` / `State` / `TimeToEmpty`、
`OnBattery`, 再加 `/sys/class/power_supply/<NativePath>` 的充电上限), 所以假电池要让 UPower 自己看到: 用内核的 `test_power` 模块
(`/sys/class/power_supply/test_battery`、`test_ac`, 改模块参数时发 uevent, UPower 跟着更新), 不用 umockdev (它要把 upowerd 换成
`umockdev-run` 下的一份, 改电量还要另外通知).
默认 (单元 `acdev-battery.service`): 接着电源、100%、充电中, 一开机不会碰到低电量的处理. 手动切电量:
`acdev vm run -- acdev-battery <百分比> [charging|discharging]` (不给状态时是 discharging), 回到默认用 `acdev-battery 100 charging`
或 `systemctl restart acdev-battery`. 脚本载入模块, 写 `battery_capacity`、`battery_status` 和两路电源: 充电时 `ac_online=on`、`usb_online=off`, 放电时两路都 off
(`test_power` 的 `usb_online` 默认是 on, 不关掉的话 UPower 认为接着电源 (`OnBattery` 为 false), 第六轮里放电到 5% 也不触发严重电量倒计时);
有 `battery_current` 参数时一并写成充电 +1600、放电 -1600 (默认 -1600, 第六轮里内核报 Charging、UPower 却判成放电). 再起 `upower`.
`acdev-battery off` 把两路电源恢复成模块的默认值 (都 on) 再卸掉模块. 放电且百分比不高于 UPower 的 `PercentageAction` (`/etc/UPower/UPower.conf`,
默认 2) 时拒绝: UPower 到这条线会执行 `CriticalPowerAction` (关机或休眠), 客户机就没了; 要试“严重线”倒计时, 用比它高的值 (Dopame
的严重线在它上面). 包: `upower` (镜像里没有).

## 把合成器 (acdes acompositor) 和测试客户端放进去跑

合成器在 acdes 里 (`crates/acompositor`, 以 `acdes acompositor` 运行, 2026-11-20), 测试客户端 `acompositor-test-client` 也在那里.
一条命令 (改了 acdes 的源码就自动重编、推送、重启):

```sh
acdev vm dev ../acdes --bin acdes,acompositor-test-client --run 'systemctl stop greetd; acdes acompositor --card /dev/dri/card1 acompositor-test-client'
```

也可以一步一步来:

- **共享目录** (改了马上能用): `start --share <宿主目录>` 再 `mount`, 客户机的 `/mnt/acdev` 就是那个目录 (9p, 内核 `CONFIG_9P_FS=m`、
  `CONFIG_NET_9P_VIRTIO=m`, `mount` 先 `modprobe`).
- **拷进去**: `push <文件或目录> [客户机路径]`.

客户机里默认跑着 greetd 和 acdes 的会话, 占着 DRM 和输入设备. 单独跑合成器时先停掉它:

```sh
acdev vm push target/release/acdes /opt/acdev/acdes
acdev vm push target/release/acompositor-test-client /opt/acdev/acompositor-test-client
acdev vm run -- 'systemctl stop greetd'
pid=$(acdev vm run --detach -- '/opt/acdev/acdes acompositor --card /dev/dri/card1 /opt/acdev/acompositor-test-client')
acdev vm logs "$pid"
acdev vm screenshot acompositor.png
acdev vm kill "$pid"
```

guest agent 以 root 跑命令, 不在任何 logind 会话里, 对应 acompositor 调研 (总仓 `.scratch/winman/issues/04-session-start.md`) 的做法 A.
显卡是 virtio-gpu, 内核先用 simpledrm, `virtio_gpu` 载入后换成真驱动 (`/dev/dri/card1`). 宿主上编的二进制一般能直接跑 (客户机 Arch 的
glibc 较新); 不放心就静态链接 (musl).

## 测试

`test/emulator/guesthw.test.ts`: 三项模拟硬件的暂存、包与脚本的要点 (不起客户机).
`acdev vm` 的测试按主题分成四个文件 (2026-11-22 从原来一个 1000 多行的 `vm.test.ts` 拆出), 共用的假服务端、按脚本回答的假连接 (`Scripted`)、
帧的小工具和真实客户机的开关在 `test/vm/helpers.ts`; `bun test test/vm` 一起跑:
- `test/vm/channel.test.ts`: guest agent 和 QMP 的协议对着进程内的假服务端测 (同步跳过旧输出、执行与退出码、分块写、QMP 跳过事件); acdevd 协议的
  宿主一侧对着按脚本回答的假连接测 (分帧、run 的输出与退出码、push 的帧序列与权限位、错误、先发密钥), 套接字传输对着进程内的 Unix 套接字服务端测;
  `vm logs`、`vm dev`.
- `test/vm/qemu.test.ts`: QEMU 命令行的组成 (vsock 设备、端口转发、`-fw_cfg` 密钥、显示、`--viewer`); 不是 Linux 的宿主 (只测能在这里跑的部分); 模拟硬件.
- `test/vm/provision.test.ts`: provision 的暂存与脚本.
- `test/vm/guest.test.ts`: `acdev test --vm` 与客户机里的 DevTools 的宿主一侧、`vm stop`、往客户机会话里放文件, 和下面的真实客户机.
设了 `ACDEV_VM_TEST_IMAGE` (一个 qcow2), 且有 QEMU 和 `/dev/kvm` 时, 再在临时目录里起一台真实客户机 (`start --headless` 等到 acdevd
应答、`run` 的输出与退出码、`push`、`--detach` 加 `kill` 和日志、`status`、错的密钥被拒、`screenshot`、`stop`), 约 20 s.
设 `ACDEV_VM_TRANSPORT=tcp` 再跑一遍就是端口转发 (2026-11-18 在本机 vsock、tcp 两遍都过; `unix` 要满足上面的条件, 本机 QEMU 8.2.2 不行). 守护进程自己的进程内测试在
`crates/devd` (`cargo test`).

## 验证过的 (2026-11-17, Ubuntu 24.04 的 WSL2, QEMU 8.2.2, OVMF 4M)

- `acdev vm start --headless --share` 用 KVM 约 20 s 就绪 (登录页截图 1280×800); `run`、`mount`、`push` (文件和目录)、`screenshot`、`stop` 都通.
- acompositor (`--card /dev/dri/card1`, virtio_gpu) 和 `acompositor-test-client` 在客户机里跑起来, 认出 virtio 键盘和平板, 测试窗口画在屏幕中间
  (当时经 `scripts/vm.sh` 的前身). 2026-11-17 又经 acdevd 验证: `push` 进 acompositor 和测试客户端, `run --detach` 跑起来 (日志里有 virtio_gpu
  和输入设备, 截图有测试窗口), `kill` 后进程都退出.

## 已知问题

- QEMU 8.2.2: 对 virtio 键盘执行 QMP `input-send-event` 时带上 `device` 参数, QEMU 会异常退出 (abort) (2026-11-18 acompositor-test 验收热插拔时
  发现). 不带 `device` 时发给默认的输入设备.

## 还没有

- 只有 x86_64 和 Linux 宿主. aarch64 客户机 (os 仓只写好、没构建过)、WHPX、Hypervisor.framework 在下一个里程碑.
- 交互终端 (03)、日志 (04)、构建推送运行一条龙 (05). 安装版的 acdev 还不带 acdevd (要 `ACDEV_DEVD` 或检出). 旧脚本的 `--kernel` / `--initrd` / `--append` (直接引导内核) 没有搬过来.
