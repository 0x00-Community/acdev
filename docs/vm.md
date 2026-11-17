# 客户机: QEMU 里跑 Dopame OS (`acde vm`)

> 命令行的路径相对 `npm/`, 其余相对仓库根。

模拟器的第一块 (用户 2026-11-17: 虚拟机启动配置放在 acdev, 原型用 QEMU; 第一个里程碑只做 Linux KVM, 规范 gitea `AC/acdev#103`):
在 Linux 宿主上用 KVM 起一台 x86_64 的 Dopame OS 客户机, virtio-gpu 显示、virtio 键盘和平板、串口日志, 再把宿主上的文件
(winman 和测试客户端的二进制) 送进去跑. 实现在命令行 `src/vm/`: `machine.ts` (目录、镜像、覆盖盘、QEMU 命令行、起停)、`channel.ts`
(QMP 和 QEMU guest agent 的按行 JSON 协议)、`command.ts` (`acde vm` 的子命令). 仓库根的 `scripts/vm.sh` 只是从检出跑 `acde vm` 的入口
(`scripts/vm.sh logs` 跟着看串口日志; 目录默认是仓库里的 `.vm/`, 旧名 `ACDEV_VM_DIR` 也认). 以后加 vsock 上的设备守护进程 (工作项 02)、
virtio-fs, 以及 Windows (WHPX)、macOS (Hypervisor.framework).

## 要什么

- `qemu-system-x86_64`、`qemu-img` (Debian / Ubuntu: `qemu-system-x86 qemu-utils`; Arch: `qemu-full` 或 `qemu-base`)、UEFI 固件 OVMF
  (`ovmf` / `edk2-ovmf`; 找不到时设 `OVMF_CODE`、`OVMF_VARS`)、`setsid` (util-linux).
- `/dev/kvm` 可读写. 打不开时退回 TCG 软件模拟, 能跑但慢得多, `start` 和 `status` 会说.
- 窗口用 QEMU 的 gtk 显示; 没有图形环境时用 `--headless` (截图照样能取) 或 `--vnc`.

## 目录与镜像

一切在 `$ACDE_VM_DIR` (默认 `$XDG_DATA_HOME/acde/vm`, 即 `~/.local/share/acde/vm`): `images/` (镜像和指向最新的 `latest.qcow2`)、
`disk.qcow2` (以基础镜像为底的覆盖盘) 和 `disk.base`、`vars.fd` (UEFI 变量)、`run/` (`qemu.pid`、`qmp.sock`、`qga.sock`、`share`)、
`logs/` (`serial.log` 串口、`qemu.log` QEMU 自己的输出、`qemu.cmd` 实际的命令行). 一个目录一台客户机, `start` 前看 `qemu.pid`,
已有在跑的就报错. 本机总仓约定共用 `logs/acdev-vm` (和 winman-lead 共用, 起之前先 `acde vm status`).

`fetch` 取 os 仓 CI 最新的磁盘镜像 (`iso/latest-qcow2` 指的那个, 现在是 `dopameos-20261114T054429Z-x86_64.qcow2`, 约 1.7 GB; 地址见 os 仓
AGENTS.md「CI」, `ACDE_VM_DIST` 可换), 边下边算 SHA-256, 和 `.sha256` 对不上就删掉报错. 镜像是 acinstall 整盘装好的系统 (UEFI、systemd-boot、
根在 acfs、内核 `linux-ackernel`), 装了 qemu-guest-agent, 启动后 greetd 在 tty1 起 acde 的登录页 (acdebin-system). 用户 `dopame` 的密码是
os CI 的 secret, 用不着: 所有操作经 guest agent 以 root 跑. `start` 不改基础镜像; `--fresh` 丢掉覆盖盘和 UEFI 变量重来, 换了 `--image`
也重建覆盖盘.

## 命令

```sh
acde vm fetch                                  # 下载并校验最新镜像
acde vm start                                  # 后台起客户机, 开一个窗口, 等到 guest agent 应答 (--wait 秒, 默认 300; 0 不等)
acde vm start --headless --share ~/winman/target/release
acde vm status                                 # 目录、镜像、KVM、客户机在不在跑、是否就绪
acde vm run -- 'uname -a; systemctl is-active greetd'   # 退出码就是客户机里命令的退出码
acde vm push target/release/winman             # 拷进客户机 /opt/acdev/winman (目录也行: 打 tar 过去再解开); 可执行 755, 其余 644
acde vm mount                                  # 把 --share 的目录经 9p 挂到客户机 /mnt/acdev
acde vm screenshot shot.png                    # QMP screendump, 无窗口也行
acde vm console                                # 客户机内核日志从下次启动起进串口
acde vm stop                                   # ACPI 关机, 60 s 不关就杀掉 QEMU
```

- 设备: q35、virtio-blk 系统盘、`virtio-vga` (客户机用 CPU 软件渲染, 不用 Mesa; 以后由 detour 做虚拟显卡转发, 用户 2026-11-17 定.
  `--gl` 换成 `virtio-vga-gl` 加 gtk 的 OpenGL 即 virgl, 只是留着的选项, 不在路线上)、`virtio-keyboard-pci`、`virtio-tablet-pci`
  (绝对坐标, 指针跟着宿主鼠标)、virtio-net (用户态网络)、guest agent 的 virtio-serial 通道、`-virtfs` (有 `--share` 时).
  CPU 和内存用 `ACDE_VM_CPUS` (4)、`ACDE_VM_MEMORY` (8G). QEMU 经 `setsid` 起在后台, 不随 `acde` 退出.
- guest agent 的套接字一次只接一个客户端: `GuestAgent.open` 先发 `guest-sync` 跳过前一个客户端留下的输出, 等不到就关掉连接, 不然后来的都连不上.
- 串口里默认只有固件和 systemd-boot 的输出: 装好的系统是静默启动 (`quiet loglevel=3`, 没有 `console=ttyS0`). `console` 在客户机启动项命令行
  末尾加 `console=tty0 console=ttyS0,115200 loglevel=6` (写在覆盖盘里, 重复跑不叠加).
- `run` 的输出在命令结束后一起打印 (`guest-exec`), 超时 600 s; 长时间运行的程序用 `setsid` 放后台, 输出写进文件再 `run cat` 去看.
  02 的设备守护进程接上后, 推送、运行改走 vsock.

## 把 winman 和测试客户端放进去跑

- **共享目录** (改了马上能用): `start --share <宿主目录>` 再 `mount`, 客户机的 `/mnt/acdev` 就是那个目录 (9p, 内核 `CONFIG_9P_FS=m`、
  `CONFIG_NET_9P_VIRTIO=m`, `mount` 先 `modprobe`).
- **拷进去**: `push <文件或目录> [客户机路径]`.

客户机里默认跑着 greetd 和 acdebin-system, 占着 DRM 和输入设备. 换成 winman 时先停掉它:

```sh
acde vm run 'systemctl stop greetd'
acde vm run 'setsid sh -c "/mnt/acdev/winman --card /dev/dri/card1 /mnt/acdev/winman-test-client > /var/log/winman.log 2>&1" < /dev/null > /dev/null 2>&1 &'
acde vm run 'cat /var/log/winman.log'
acde vm screenshot winman.png
```

guest agent 以 root 跑命令, 不在任何 logind 会话里, 对应 winman 调研 (总仓 `.scratch/winman/issues/04-session-start.md`) 的做法 A.
显卡是 virtio-gpu, 内核先用 simpledrm, `virtio_gpu` 载入后换成真驱动 (`/dev/dri/card1`). 宿主上编的二进制一般能直接跑 (客户机 Arch 的
glibc 较新); 不放心就静态链接 (musl).

## 测试

`test/vm.test.ts`: guest agent 和 QMP 的协议对着进程内的假服务端测 (同步跳过旧输出、执行与退出码、分块写、QMP 跳过事件); QEMU 命令行的组成;
没有客户机时的子命令. 设了 `ACDE_VM_TEST_IMAGE` (一个 qcow2), 且有 QEMU 和 `/dev/kvm` 时, 再在临时目录里起一台真实客户机
(`start --headless` 等到就绪、`run` 的退出码、`push`、`screenshot`、`stop`), 约 20 s.

## 验证过的 (2026-11-17, Ubuntu 24.04 的 WSL2, QEMU 8.2.2, OVMF 4M)

- `acde vm start --headless --share` 用 KVM 约 20 s 就绪 (登录页截图 1280×800); `run`、`mount`、`push` (文件和目录)、`screenshot`、`stop` 都通.
- winman (`--card /dev/dri/card1`, virtio_gpu) 和 `winman-test-client` 在客户机里跑起来, 认出 virtio 键盘和平板, 测试窗口画在屏幕中间
  (当时经 `scripts/vm.sh` 的前身).

## 还没有

- 只有 x86_64 和 Linux 宿主. aarch64 客户机 (os 仓只写好、没构建过)、WHPX、Hypervisor.framework 在下一个里程碑.
- vsock 上的设备守护进程 (02: 只用 std、和 acdebin-system 无关的独立程序, 以后并入 acdebin-system)、交互终端 (03)、日志 (04)、
  构建推送运行一条龙 (05). 旧脚本的 `--kernel` / `--initrd` / `--append` (直接引导内核) 没有搬过来.
