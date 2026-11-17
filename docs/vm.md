# 客户机: QEMU 里跑 Dopame OS (`acdev vm`)

> 命令行的路径相对 `npm/`, 其余相对仓库根。

模拟器的第一块 (用户 2026-11-17: 虚拟机启动配置放在 acdev, 原型用 QEMU; 第一个里程碑只做 Linux KVM, 规范 gitea `AC/acde#103`):
在 Linux 宿主上用 KVM 起一台 x86_64 的 Dopame OS 客户机, virtio-gpu 显示、virtio 键盘和平板、串口日志, 再把宿主上的文件
(winman 和测试客户端的二进制) 送进去跑. 实现在命令行 `src/vm/`: `machine.ts` (目录、镜像、覆盖盘、QEMU 命令行、起停)、`channel.ts`
(QMP 和 QEMU guest agent 的按行 JSON 协议)、`command.ts` (`acdev vm` 的子命令). 仓库根的 `scripts/vm.sh` 只是从检出跑 `acdev vm` 的入口
(`scripts/vm.sh logs` 跟着看串口日志; 目录默认是仓库里的 `.vm/`). 以后加 vsock 上的设备守护进程 (工作项 02)、
virtio-fs, 以及 Windows (WHPX)、macOS (Hypervisor.framework).

## 要什么

- `qemu-system-x86_64`、`qemu-img` (Debian / Ubuntu: `qemu-system-x86 qemu-utils`; Arch: `qemu-full` 或 `qemu-base`)、UEFI 固件 OVMF
  (`ovmf` / `edk2-ovmf`; 找不到时设 `OVMF_CODE`、`OVMF_VARS`)、`setsid` (util-linux).
- `/dev/kvm` 可读写. 打不开时退回 TCG 软件模拟, 能跑但慢得多, `start` 和 `status` 会说.
- 窗口用 QEMU 的 gtk 显示; 没有图形环境时用 `--headless` (截图照样能取) 或 `--vnc`.

## 目录与镜像

一切在 `$ACDEV_VM_DIR` (默认 `$XDG_DATA_HOME/acdev/vm`, 即 `~/.local/share/acdev/vm`): `images/` (镜像和指向最新的 `latest.qcow2`)、
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
acdev vm status                                 # 目录、镜像、KVM、客户机在不在跑、是否就绪
acdev vm run -- 'uname -a; systemctl is-active greetd'   # 退出码就是客户机里命令的退出码
acdev vm shell                                  # 交互终端 (root 的登录 shell); acdev vm shell -- htop 只开一个程序
acdev vm logs 1234 --follow --grep error         # 跟着看 run --detach 那个进程组的输出, 只留含 error 的行
acdev vm push target/release/winman             # 拷进客户机 /opt/acdev/winman (目录也行: 打 tar 过去再解开); 可执行 755, 其余 644
acdev vm pull /tmp/shots ./shots               # 从客户机拉回文件或目录 (权限位照旧); LOCAL 是已有目录时放进 LOCAL/<名字>
acdev vm mount                                  # 把 --share 的目录经 9p 挂到客户机 /mnt/acdev
acdev vm screenshot shot.png                    # QMP screendump, 无窗口也行
acdev vm console                                # 客户机内核日志从下次启动起进串口
acdev vm stop                                   # ACPI 关机, 60 s 不关就杀掉 QEMU
```

- 设备: q35、virtio-blk 系统盘、`virtio-vga` (客户机用 CPU 软件渲染, 不用 Mesa; 以后由 detour 做虚拟显卡转发, 用户 2026-11-17 定.
  `--gl` 换成 `virtio-vga-gl` 加 gtk 的 OpenGL 即 virgl, 只是留着的选项, 不在路线上)、`virtio-keyboard-pci`、`virtio-tablet-pci`
  (绝对坐标, 指针跟着宿主鼠标)、virtio-net (用户态网络)、guest agent 的 virtio-serial 通道、`-virtfs` (有 `--share` 时).
  CPU 和内存用 `ACDEV_VM_CPUS` (4)、`ACDEV_VM_MEMORY` (8G). QEMU 经 `setsid` 起在后台, 不随 `acdev` 退出.
- guest agent 的套接字一次只接一个客户端: `GuestAgent.open` 先发 `guest-sync` 跳过前一个客户端留下的输出, 等不到就关掉连接, 不然后来的都连不上.
- 串口里默认只有固件和 systemd-boot 的输出: 装好的系统是静默启动 (`quiet loglevel=3`, 没有 `console=ttyS0`). `console` 在客户机启动项命令行
  末尾加 `console=tty0 console=ttyS0,115200 loglevel=6` (写在覆盖盘里, 重复跑不叠加).
- 调试通道 (用户 2026-11-18 定): `start` 按平台选传输, 记在 `run/link.json`, 之后的命令照它连. Linux 用 vsock (`vhost-vsock-pci`);
  Windows、macOS 的 QEMU 没有 vsock, 改用用户态网络的端口转发到客户机 acdevd 的 TCP 端口 5252: macOS (和其余非 Linux) 转到
  `run/devd.sock` (`hostfwd=unix:…`, 文件权限挡住别的本机用户), Windows 转到 `127.0.0.1` 上一个空闲端口 (`hostfwd=tcp:…`).
  `ACDEV_VM_TRANSPORT=vsock|unix|tcp` 强制选一种 (Linux 上用来验证转发). 转发时不加 vsock 设备. 每次 `start` 生成一个密钥写到
  `run/key` (只有自己能读), 经 `-fw_cfg name=opt/acdev/key,file=run/key` 交给客户机; 每条连接先发它 (见 `docs/devd.md`「传输与密钥」).
  `status` 写出走的是哪种.
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
设 `ACDEV_VM_TRANSPORT=unix` (或 `tcp`) 再跑一遍就是端口转发. 守护进程自己的进程内测试在
`crates/devd` (`cargo test`).

## 验证过的 (2026-11-17, Ubuntu 24.04 的 WSL2, QEMU 8.2.2, OVMF 4M)

- `acdev vm start --headless --share` 用 KVM 约 20 s 就绪 (登录页截图 1280×800); `run`、`mount`、`push` (文件和目录)、`screenshot`、`stop` 都通.
- winman (`--card /dev/dri/card1`, virtio_gpu) 和 `winman-test-client` 在客户机里跑起来, 认出 virtio 键盘和平板, 测试窗口画在屏幕中间
  (当时经 `scripts/vm.sh` 的前身). 2026-11-17 又经 acdevd 验证: `push` 进 winman 和测试客户端, `run --detach` 跑起来 (日志里有 virtio_gpu
  和输入设备, 截图有测试窗口), `kill` 后进程都退出.

## 还没有

- 只有 x86_64 和 Linux 宿主. aarch64 客户机 (os 仓只写好、没构建过)、WHPX、Hypervisor.framework 在下一个里程碑.
- 交互终端 (03)、日志 (04)、构建推送运行一条龙 (05). 安装版的 acdev 还不带 acdevd (要 `ACDEV_DEVD` 或检出). 旧脚本的 `--kernel` / `--initrd` / `--append` (直接引导内核) 没有搬过来.
