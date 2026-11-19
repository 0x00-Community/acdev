# 客户机: QEMU 里跑 Dopame OS (`acdev vm`)

> 命令行的路径相对 `npm/`, 其余相对仓库根。

模拟器的第一块 (用户 2026-11-17: 虚拟机启动配置放在 acdev, 原型用 QEMU; 第一个里程碑只做 Linux KVM, 规范 gitea `AC/acde#103`):
在 Linux 宿主上用 KVM 起一台 x86_64 的 Dopame OS 客户机, virtio-gpu 显示、virtio 键盘和平板、串口日志, 再把宿主上的文件
(winman 和测试客户端的二进制) 送进去跑. 实现在命令行 `src/vm/`: `machine.ts` (目录、镜像、覆盖盘、QEMU 命令行、起停)、`channel.ts`
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
- 窗口用 QEMU 的 gtk 显示; `--viewer` 时是 acdev 自己的窗口 (`acdevtool view`, 取 `ACDEVTOOL`, 否则检出里 `crates/tool` 编出的,
  目前只有 Linux); 没有图形环境时用 `--headless` (截图照样能取) 或 `--vnc`.
- gtk 窗口下客户机的分辨率跟着窗口大小走: QEMU 的 gtk 前端每次窗口大小变化都把窗口尺寸经 `dpy_set_ui_info` 报给显卡, 显卡改了首选分辨率再告诉客户机
  (`ui/gtk.c` `gd_configure` → `gd_set_ui_size`; virtio 显卡时 `zoom-to-fit` 自动打开, 窗口不再按画面调). 窗口初始大小由 GTK 按开机时的小画面定,
  所以客户机常常一上来是 640×480, 把窗口拉大就行; 显卡的 `xres` / `yres` (默认就是 1280×800) 会被窗口尺寸盖掉, 设了也没用.
  测试和要固定分辨率时用 `--headless` (1280×800) 或 `--viewer` (`acdevtool view` 主动报 1280×800, 之后跟着窗口变).
- QEMU 没给 `-parallel` 时会给图形显示配一个默认并口, 接到一个文字控制台 (`system/vl.c` 的 `qemu_create_default_devices`: 图形显示时
  `add_device_config(DEV_PARALLEL, vc)`); gtk 把它放进标签页, SDL 给每个控制台开一个窗口, 就多出一个 640×384 的 `QEMU (acdev-1)`. 所以总是加
  `-parallel none`. 默认监视器不会出来: 给了 `-qmp` 就不再配 (`default_monitor = 0`); 串口已经接到 `serial.log`.
- `--gl` (virgl) 时 `acdev vm screenshot` 截不出图: QMP `screendump` 读的是控制台的显示表面 (`ui/ui-qmp-cmds.c` 的 `qmp_screendump` →
  `qemu_console_surface`), virgl 的画面在 GL 纹理里, 不画进这个表面. 所以带 `--gl` 时 `vm screenshot` 直接报错并指路: 登录着的会话里用
  `acdev screen --session vm -o FILE.png` (管家经 winman 截, 和 GL 无关), 或者不带 `--gl` 起. 是否 `--gl` 记在 `run/gl`.
- `--sdl` (试验, 只在 Linux): 换成 QEMU 的 SDL 窗口 (`-display sdl`, 带 `--gl` 时 `sdl,gl=on`, 显卡同 gtk 那两种). gtk 开窗时就拿窗口尺寸盖掉
  首选分辨率, SDL 只在用户拉动窗口时才报 (`ui/sdl2.c` 只处理 `SDL_WINDOWEVENT_RESIZED`), 窗口跟着客户机画面走, 所以客户机应能直接以 1280×800 起来,
  之后照样跟着拉动的窗口变. 还没实测; 和 `--headless`、`--vnc`、`--viewer` 只能选一个, 默认仍是 gtk.

## Windows (WHPX)

工作项 02 (三平台模拟器里程碑, 规范在总仓 `.scratch/acdev-m2/spec.md`). 依据总仓 `.scratch/roadmap/research/05-emulator.md` 第二节.

- 先开"Windows 虚拟机监控程序平台": `DISM /online /Enable-Feature /FeatureName:HypervisorPlatform /All` (管理员), 再重启;
  x86_64 宿主要 Windows 10 2004 以上 (QEMU 文档 `docs/system/whpx.rst`).
- 调试通道走 `127.0.0.1` 上的 TCP 端口转发加密钥 (见上面「调试通道」).
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
- 窗口: Homebrew 的 QEMU 没有 GTK, 所以 macOS 上 QEMU 自己的窗口是 `-display cocoa`; `--gl` (GTK 加 virgl) 只在 Linux 上有.
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
- 显卡: virt 上没有 VGA, 用 `virtio-gpu-pci` (`--gl` 时 `virtio-gpu-gl-pci`), 同样带 `id=gpu0` 和 `max_outputs=N`; QEMU 文档 `whpx.rst`:
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
已有在跑的就报错. 本机总仓约定共用 `logs/acdev-vm` (和 winman-lead 共用, 起之前先 `acdev vm status`).

`fetch` 取 os 仓 CI 最新的磁盘镜像 (`iso/latest-qcow2` 指的那个, 现在是 `dopameos-20261114T054429Z-x86_64.qcow2`, 约 1.7 GB; 地址见 os 仓
AGENTS.md「CI」, `ACDEV_VM_DIST` 可换), 边下边算 SHA-256, 和 `.sha256` 对不上就删掉报错. 镜像是 acinstall 整盘装好的系统 (UEFI、systemd-boot、
根在 acfs、内核 `linux-ackernel`), 装了 qemu-guest-agent, 启动后 greetd 在 tty1 起 acdev 的登录页 (acdebin-system). 用户 `dopame` 的密码是
os CI 的 secret, 用不着: 所有操作经 guest agent 以 root 跑. `start` 不改基础镜像; `--fresh` 丢掉覆盖盘和 UEFI 变量重来, 换了 `--image`
也重建覆盖盘.

## 命令

```sh
acdev vm fetch                                  # 下载并校验最新镜像
acdev vm start                                  # 后台起客户机, 开一个窗口, 等到 guest agent 和 acdevd 应答 (--wait 秒, 默认 300; 0 不等)
acdev vm start --headless --share ~/winman/target/release
acdev vm start --viewer                         # 画面在 acdev 自己的窗口 (acdevtool view, QEMU 的 D-Bus 显示, 见 docs/viewer.md)
acdev vm start --sdl                            # 试验: QEMU 的 SDL 窗口, 开窗不改客户机的首选分辨率 (只在 Linux)
acdev vm view                                   # 关掉之后再开一个 acdevtool view
acdev vm start --outputs 2                      # 两个显示输出 (多屏验收), QEMU 窗口里每个输出一个标签页
acdev vm screenshot second.png --output 1       # 取第二个输出
acdev vm status                                 # 目录、镜像、KVM、客户机在不在跑、是否就绪
acdev vm run -- 'uname -a; systemctl is-active greetd'   # 退出码就是客户机里命令的退出码
acdev vm shell                                  # 交互终端 (root 的登录 shell); acdev vm shell -- htop 只开一个程序
acdev vm logs 1234 --follow --grep error         # 跟着看 run --detach 那个进程组的输出, 只留含 error 的行
acdev vm push target/release/winman             # 拷进客户机 /opt/acdev/winman (目录也行: 打 tar 过去再解开); 可执行 755, 其余 644
acdev vm pull /tmp/shots ./shots               # 从客户机拉回文件或目录 (只留读写执行位); LOCAL 是已有目录时放进 LOCAL/<名字>
acdev vm mount                                  # 把 --share 的目录经 9p 挂到客户机 /mnt/acdev
acdev vm screenshot shot.png                    # QMP screendump, 无窗口也行; --gl 时截不出, 用 acdev screen --session vm -o shot.png
acdev vm console                                # 客户机内核日志从下次启动起进串口
acdev vm stop                                   # 让客户机自己关机 (acdevd → guest agent → ACPI), 都不行才杀掉 QEMU
```

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
  `--gl` 换成 `virtio-vga-gl` 加 gtk 的 OpenGL 即 virgl, 只是留着的选项, 不在路线上)、`virtio-keyboard-pci`、`virtio-tablet-pci`
  (绝对坐标, 指针跟着宿主鼠标)、virtio-net (用户态网络)、guest agent 的 virtio-serial 通道、`-virtfs` (有 `--share` 时).
  CPU 和内存用 `ACDEV_VM_CPUS` (4)、`ACDEV_VM_MEMORY` (8G). QEMU 经 `setsid` 起在后台, 不随 `acdev` 退出.
- guest agent 的套接字一次只接一个客户端: `GuestAgent.open` 先发 `guest-sync` 跳过前一个客户端留下的输出, 等不到就关掉连接, 不然后来的都连不上.
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
    并报大小, 所以都连上; `-display none` 不报, 第二个输出一直是 disconnected (2026-11-18 winman-test 实测).
  - 所以 `--headless --outputs N` (N ≥ 2) 不用 `-display none`, 改用 `-display dbus,p2p=yes` (不开窗口), 起来后 acdev 跑一次
    `acdevtool view --qmp … --outputs N`: 经 D-Bus 对 `Console_1`…`Console_{N-1}` 调 `SetUIInfo` (1280×800, 依次向右排), 就是 GTK 做的那件事
    (`ui/dbus-console.c` `dbus_console_set_ui_info` → `dpy_set_ui_info`), 然后退出; 打开的状态留在显卡里. 要 acdevtool view (同 `--viewer`).
    `egl-headless` 不报大小 (`ui/egl-headless.c` 不调 `dpy_set_ui_info`), 不能用.
  - `--vnc` 和 `--viewer` 只显示第一个输出 (VNC 服务端绑一个控制台〔未核实〕, acdevtool view 只接 `Console_0`), 和 `--outputs` 2 以上
    一起用时直接报错.
- 热插拔: q35 的根总线 `pcie.0` 不能热插拔 (`device_add` 报 `Bus 'pcie.0' does not support hotplugging`), 所以 `start` 预留两个
  PCIe 根端口 `rp1`、`rp2` (`chassis` / `slot` 11、12). 热插拔时 `device_add` 带 `bus=rp1` 或 `bus=rp2`, 一个端口挂一个设备.
- 设备守护进程: `start` 在客户机就绪后经 guest agent 装好 acdevd (`/usr/local/bin/acdevd`, 和宿主这份校验和不同才拷,
  systemd 单元 `acdevd.service`, 开机自启, 起之前 `modprobe qemu_fw_cfg`), 等它在调试通道上应答 (见 `docs/devd.md`). vsock 时 QEMU 带 `vhost-vsock-pci`, 客户机的 CID 由
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

## 把 winman 和测试客户端放进去跑

一条命令 (改了 winman 的源码就自动重编、推送、重启):

```sh
acdev vm dev ../winman --run 'systemctl stop greetd; winman --card /dev/dri/card1 winman-test-client'
```

也可以一步一步来:

- **共享目录** (改了马上能用): `start --share <宿主目录>` 再 `mount`, 客户机的 `/mnt/acdev` 就是那个目录 (9p, 内核 `CONFIG_9P_FS=m`、
  `CONFIG_NET_9P_VIRTIO=m`, `mount` 先 `modprobe`).
- **拷进去**: `push <文件或目录> [客户机路径]`.

客户机里默认跑着 greetd 和 acdebin-system, 占着 DRM 和输入设备. 换成 winman 时先停掉它:

```sh
acdev vm push target/release/winman /opt/acdev/winman
acdev vm push target/release/winman-test-client /opt/acdev/winman-test-client
acdev vm run -- 'systemctl stop greetd'
pid=$(acdev vm run --detach -- '/opt/acdev/winman --card /dev/dri/card1 /opt/acdev/winman-test-client')
acdev vm logs "$pid"
acdev vm screenshot winman.png
acdev vm kill "$pid"
```

guest agent 以 root 跑命令, 不在任何 logind 会话里, 对应 winman 调研 (总仓 `.scratch/winman/issues/04-session-start.md`) 的做法 A.
显卡是 virtio-gpu, 内核先用 simpledrm, `virtio_gpu` 载入后换成真驱动 (`/dev/dri/card1`). 宿主上编的二进制一般能直接跑 (客户机 Arch 的
glibc 较新); 不放心就静态链接 (musl).

## 测试

`test/vm.test.ts`: guest agent 和 QMP 的协议对着进程内的假服务端测 (同步跳过旧输出、执行与退出码、分块写、QMP 跳过事件); acdevd 协议的
宿主一侧对着按脚本回答的假连接测 (分帧、run 的输出与退出码、push 的帧序列、错误、先发密钥), 套接字传输对着进程内的 Unix 套接字服务端测;
QEMU 命令行的组成 (vsock 设备、端口转发、`-fw_cfg` 密钥); 没有客户机时的子命令.
设了 `ACDEV_VM_TEST_IMAGE` (一个 qcow2), 且有 QEMU 和 `/dev/kvm` 时, 再在临时目录里起一台真实客户机 (`start --headless` 等到 acdevd
应答、`run` 的输出与退出码、`push`、`--detach` 加 `kill` 和日志、`status`、错的密钥被拒、`screenshot`、`stop`), 约 20 s.
设 `ACDEV_VM_TRANSPORT=tcp` 再跑一遍就是端口转发 (2026-11-18 在本机 vsock、tcp 两遍都过; `unix` 要满足上面的条件, 本机 QEMU 8.2.2 不行). 守护进程自己的进程内测试在
`crates/devd` (`cargo test`).

## 验证过的 (2026-11-17, Ubuntu 24.04 的 WSL2, QEMU 8.2.2, OVMF 4M)

- `acdev vm start --headless --share` 用 KVM 约 20 s 就绪 (登录页截图 1280×800); `run`、`mount`、`push` (文件和目录)、`screenshot`、`stop` 都通.
- winman (`--card /dev/dri/card1`, virtio_gpu) 和 `winman-test-client` 在客户机里跑起来, 认出 virtio 键盘和平板, 测试窗口画在屏幕中间
  (当时经 `scripts/vm.sh` 的前身). 2026-11-17 又经 acdevd 验证: `push` 进 winman 和测试客户端, `run --detach` 跑起来 (日志里有 virtio_gpu
  和输入设备, 截图有测试窗口), `kill` 后进程都退出.

## 已知问题

- QEMU 8.2.2: 对 virtio 键盘执行 QMP `input-send-event` 时带上 `device` 参数, QEMU 会异常退出 (abort) (2026-11-18 winman-test 验收热插拔时
  发现). 不带 `device` 时发给默认的输入设备.

## 还没有

- 只有 x86_64 和 Linux 宿主. aarch64 客户机 (os 仓只写好、没构建过)、WHPX、Hypervisor.framework 在下一个里程碑.
- 交互终端 (03)、日志 (04)、构建推送运行一条龙 (05). 安装版的 acdev 还不带 acdevd (要 `ACDEV_DEVD` 或检出). 旧脚本的 `--kernel` / `--initrd` / `--append` (直接引导内核) 没有搬过来.
