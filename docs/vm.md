# 客户机: QEMU 里跑 Dopame OS (`scripts/vm.sh`)

> 路径相对仓库根。

模拟器方向的第一块 (用户 2026-11-17: 虚拟机启动配置放在 acdev, 原型用 QEMU): 在 Linux 宿主上用 KVM 起一台 x86_64 的 Dopame OS 客户机,
virtio-gpu 显示、virtio 键盘和平板、串口日志, 再把宿主上的文件 (winman 和测试客户端的二进制) 送进去跑. 以后加 vsock、virtio-fs,
以及 Windows (WHPX)、macOS (Hypervisor.framework) 的加速器. `scripts/vm.sh` 是启停入口, `scripts/vm-agent.ts` (bun) 讲 QEMU 的 guest agent 和 QMP 协议.

## 要什么

- `qemu-system-x86_64`、`qemu-img` (Debian / Ubuntu: `qemu-system-x86 qemu-utils`; Arch: `qemu-full` 或 `qemu-base`)、UEFI 固件 OVMF
  (`ovmf` / `edk2-ovmf`; 找不到时设 `OVMF_CODE`、`OVMF_VARS`)、bun、curl.
- `/dev/kvm` 可读写 (一般是加进 `kvm` 组). 打不开时退回 TCG 软件模拟, 能跑但慢得多, 启动时会说一声.
- 窗口用 QEMU 的 gtk 显示; 没有图形环境时用 `--headless` (截图照样能取) 或 `--vnc`.

## 镜像

`scripts/vm.sh fetch` 取 os 仓 CI 最新的磁盘镜像 (`iso/latest-qcow2` 指的那个, 现在是 `dopameos-20261114T054429Z-x86_64.qcow2`, 约 1.7 GB,
地址见 os 仓 AGENTS.md「CI」, 可用 `ACDEV_VM_DIST` 换), 校验 `.sha256`, 放在 `.vm/images/` (`ACDEV_VM_DIR` 可换, `.vm/` 不进 git).
镜像是 acinstall 整盘装好的系统 (UEFI、systemd-boot、根在 acfs、内核 `linux-ackernel`), 装了 sshd 和 qemu-guest-agent, 启动后 greetd 在 tty1
起 acde 的登录页 (acdebin-system). 用户 `dopame` 的密码是 os CI 的 secret, 不需要它: 所有操作经 guest agent, 以 root 跑.

`start` 不改基础镜像: 客户机的改动写在 `.vm/disk.qcow2` (以基础镜像为底的覆盖盘) 和 `.vm/vars.fd` (UEFI 变量) 里, 下次启动接着用;
`--fresh` 丢掉它们重来. 换了 `--image` 也会重建覆盖盘.

## 命令

```sh
scripts/vm.sh fetch                         # 下载并校验最新镜像
scripts/vm.sh start                         # 后台起客户机, 开一个窗口
scripts/vm.sh start --share ~/winman/target/release   # 同时把一个宿主目录经 9p 给客户机
scripts/vm.sh wait                          # 等 guest agent 应答 (默认最多 300 s)
scripts/vm.sh run 'uname -a; systemctl is-active greetd'
scripts/vm.sh push target/release/winman    # 拷进客户机 /opt/acdev/winman (目录也行, 打 tar 过去再解开)
scripts/vm.sh mount                         # 把 --share 的目录挂到客户机 /mnt/acdev
scripts/vm.sh screenshot logs/vm/shot.png   # QMP screendump
scripts/vm.sh logs                          # 跟着看串口日志
scripts/vm.sh stop                          # ACPI 关机, 60 s 不关就杀掉
```

- 设备: q35、virtio-blk 系统盘、`virtio-vga` (客户机用 CPU 软件渲染, 不用 Mesa; 以后由 detour 做虚拟显卡转发, 用户 2026-11-17 定.
  `--gl` 换成 `virtio-vga-gl` 加 gtk 的 OpenGL 即 virgl, 只是留着的选项, 不在路线上)、`virtio-keyboard-pci`、`virtio-tablet-pci` (绝对坐标, 指针跟着宿主鼠标)、virtio-net (用户态网络)、
  guest agent 的 virtio-serial 通道. CPU 和内存用 `ACDEV_VM_CPUS` (4)、`ACDEV_VM_MEMORY` (8G).
- 日志: 串口 `logs/vm/serial.log`, QEMU 自己的输出 `logs/vm/qemu.log`, 实际的 QEMU 命令行 `logs/vm/qemu.cmd`. 运行中的套接字和 pid 在 `.vm/run/`.
- 串口里默认只有固件和 systemd-boot 的输出: 装好的系统是静默启动 (`quiet loglevel=3`, 没有 `console=ttyS0`). 跑一次 `scripts/vm.sh console`
  (在客户机启动项的命令行末尾加上 `console=tty0 console=ttyS0,115200 loglevel=6`, 写在覆盖盘里, 重复跑不会叠加), 之后每次启动内核日志都进串口.
- `--kernel`、`--initrd`、`--append` 直接引导一个内核 (比如 ackernel 新编的 `bzImage`), `--append` 里要自己写 `root=` 等,
  脚本再加 `console=tty0 console=ttyS0,115200`.
- `run` 的退出码就是客户机里命令的退出码, 输出在命令结束后一起打印 (guest agent 的 `guest-exec`), 超时 `ACDEV_VM_TIMEOUT` (600 s);
  长时间运行的程序用 `setsid` 放后台, 输出写进文件再 `run cat` 去看.

## 把 winman 和测试客户端放进去跑

两种办法:

- **共享目录** (改了马上能用): `start --share <宿主目录>` 再 `mount`, 客户机的 `/mnt/acdev` 就是那个目录 (9p, 内核
  `CONFIG_9P_FS=m`、`CONFIG_NET_9P_VIRTIO=m`, `mount` 会先 `modprobe`). 宿主上重编之后客户机直接看到新文件.
- **拷进去**: `push <文件或目录> [客户机路径]`, 默认放 `/opt/acdev/<名字>`; 可执行文件是 755, 其余 644.

客户机里默认跑着 greetd 和 acdebin-system, 占着 DRM 和输入设备. 换成 winman 时先停掉它:

```sh
scripts/vm.sh run 'systemctl stop greetd'
scripts/vm.sh run 'setsid sh -c "/mnt/acdev/winman --card /dev/dri/card1 /mnt/acdev/winman-test-client > /var/log/winman.log 2>&1" < /dev/null > /dev/null 2>&1 &'
scripts/vm.sh run 'cat /var/log/winman.log'
scripts/vm.sh screenshot logs/vm/winman.png
```

guest agent 以 root 跑命令, 不在任何 logind 会话里, 对应 winman 调研 (总仓 `.scratch/winman/issues/04-session-start.md`) 的做法 A:
以特权直接打开 `/dev/dri/card0` 和 `/dev/input/event*`. 显卡是 virtio-gpu, 内核先用 simpledrm, `virtio_gpu` 模块载入后换成真驱动
(镜像的 greetd 前有 `agentos-wait-gpu` 等这一步; 直接跑 winman 时要挑 virtio 的那张卡, 或者先等 `/dev/dri/card1`).
宿主上编的二进制要和客户机的 glibc 合得上: 客户机是滚动更新的 Arch, glibc 比多数宿主新, 一般没问题; 不放心就静态链接 (musl).

## 验证过的 (2026-11-17, Ubuntu 24.04 的 WSL2, QEMU 8.2.2, OVMF 4M)

- `fetch` 下载并校验 `dopameos-20261114T054429Z-x86_64.qcow2`; `start --headless --share` 用 KVM 起来, 约一分钟到登录页 (截图是 Dopame 的
  登录页, 1280×800); `wait`、`run`、`mount` (9p 里读到宿主的文件)、`push` (6 MB 的 winman 不到 1 s)、`console` (重启后串口有内核日志)、
  `screenshot`、`stop` 都通.
- winman (`--card /dev/dri/card1`, virtio_gpu) 和 `winman-test-client` (经共享目录) 在客户机里跑起来: winman 认出 virtio 键盘和平板,
  测试客户端的窗口画在屏幕中间.
- 那台机器上 `/dev/kvm` 一度被重新建立, 给当前用户加的 ACL 随之没了, 第二次启动退回 TCG (照样起来, 慢). 长期用要把用户加进 `kvm` 组并重新登录.

## 还没有

- 只有 x86_64 和 Linux 宿主. aarch64 客户机 (os 仓只写好、没构建过)、WHPX、Hypervisor.framework 以后加.
- vsock 和 virtio-fs 还没接. 客户机设备守护进程 (类似 adb 的 adbd: 只用 std、和 acdebin-system 无关的独立小程序, 经 vsock 和 acde 通信,
  以后并入 acdebin-system; 用户 2026-11-17 定) 还没写, `vm-agent.ts` 经 QEMU guest agent 是过渡.
