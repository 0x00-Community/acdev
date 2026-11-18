# 客户机设备守护进程 acdevd (`crates/devd`)

> 路径相对仓库根。

acdev 第一个里程碑工作项 02 (总仓 `.scratch/acdev/issues/02-device-daemon.md`; 用户 2026-11-17 定: 原型阶段在 acdev 里做一个只用 std、
和 acdebin-system 无关的独立小程序, 经 vsock 与 acdev 通信, 以后并入 acdebin-system). 作用类似安卓的 adbd. `crates/devd` 是独立的 Cargo
工作区 (根工作区把它 `exclude` 掉): 不依赖任何库, 编一下不到一秒, 客户机和宿主用同一个二进制.

- `acdevd serve [--port PORT]`: 在客户机里以 root 运行, 在 vsock 端口 (默认 5252, 任意 CID) 上听, 每条连接一个线程, 一条连接做一件事.
  有密钥时 (见下面「传输与密钥」) 同时在 TCP `0.0.0.0:PORT` 上听; 两个都听不了才退出.
- 宿主上找 acdevd 的顺序 (`npm/src/vm/binary.ts`): `ACDEV_DEVD`; `CARGO_TARGET_DIR` 下的 `release/acdevd`; 约定的共用产物目录
  `logs/cargo-target/acdev-devd/release/acdevd` (从检出往上逐级找 `logs/`, 即总仓的 `logs/`; devd 是独立工作区, 不和根工作区共用产物目录);
  `crates/devd/target/release/acdevd`; 都没有就 `cargo build --release`. 装进客户机之前先跑 `acdevd --version`, 和 `crates/devd/Cargo.toml`
  的版本比, 对不上就报错 (哪个文件、什么版本、要什么版本、怎么重编), 不装旧的进去 (旧的会在第一帧报 `unknown request 'A'`).
  注意: `CARGO_TARGET_DIR` 排在约定目录前面. 它若指着 acdev 根工作区的产物目录 (如 `logs/cargo-target/acdev`), 那里留着的旧 acdevd
  会先被找到、被版本检查拦下报错, 不会再往下找. devd 是独立的 Cargo 工作区: 编它时用它自己的约定目录
  (`CARGO_TARGET_DIR=<总仓>/logs/cargo-target/acdev-devd`), 或者用 `ACDEV_DEVD` 明确指定.
- 不是 Linux 的宿主上 (Windows、macOS) 不找也不编: 必须由 `ACDEV_DEVD` 给一个 Linux 客户机用的 acdevd, 版本在装进客户机后比 (见 `docs/vm.md`
  「Windows」).
- `acdevd connect CID [PORT]`: 在宿主上把标准输入输出接到客户机 `CID` 的 acdevd. 宿主的 bun 和 Node.js 都开不了 vsock 套接字,
  所以 acdev 起这个子进程, 经它的标准输入输出说协议.
- vsock 只用 libc 的 `socket` / `bind` / `listen` / `accept4` / `connect` (`AF_VSOCK` = 40, `sockaddr_vm`), 拿到的描述符包成
  `UnixStream` 读写; 接受连接不用 `UnixListener::accept`, 因为它会检查地址族.

## 传输与密钥 (`src/main.rs`、`src/key.rs`)

用户 2026-11-18 定 (三平台模拟器规范): 协议不变, 只换传输. Linux 宿主用 vsock; Windows、macOS 上的 QEMU 没有 vsock (Windows 编不出 vhost,
macOS 的 Homebrew 没开 vhost-user, 见总仓 `.scratch/roadmap/research/05-emulator.md`), 改走 QEMU 用户态网络的端口转发 (`hostfwd`)
到客户机的 TCP 端口 (宿主一侧默认是 `127.0.0.1` 上的端口; 转到 Unix 套接字要较新的 QEMU 和 libslirp, 条件见 `docs/vm.md`「调试通道」).
选哪种由宿主一侧的 `acdev vm start` 决定, 守护进程两种都听.

- **密钥**: `acdev vm start` 每次生成一个随机密钥 (32 字节的十六进制), 经 `-fw_cfg name=opt/acdev/key,file=…` 交给客户机.
  守护进程启动时读 `/sys/firmware/qemu_fw_cfg/by_name/opt/acdev/key/raw` (内核模块 `qemu_fw_cfg`, systemd 单元先 `modprobe` 它),
  去掉首尾空白.
- 有密钥时每条连接的第一帧必须是 `A` 加密钥 (逐字节比, 用时与内容无关), 不对或没有就回 `X` (`wrong key` / `this acdevd wants the key first`)
  并关闭; 对了不回答, 接着读真正的请求. 没有密钥时 `A` 可有可无 (照旧接受), 但**不听 TCP**: 没有密钥的 TCP 端口谁都能连, 而守护进程是 root.
- vsock 上也查密钥: 宿主上任何用户都能连客户机的 CID.
- TCP 连接拿到后关掉 Nagle, 描述符同样包成 `UnixStream` (读写、`shutdown`、`try_clone` 都只是描述符上的系统调用), 处理代码不分传输.

## 协议 (`src/frame.rs`、`src/serve.rs`)

每一帧是 `u32` 小端长度 (种类加内容的字节数, 最多 16 MiB)、一个字节的种类、内容. 连接上的第一帧决定做什么:

| 请求 | 内容 | 回答 |
| --- | --- | --- |
| `A` 密钥 | 密钥 (只能是第一帧, 之后才是下面的请求) | 不对时 `X`; 对了不回答 |
| `V` 版本 | 无 | `O` 版本号文字 |
| `P` 推送 | `u32` 权限位, 再接客户机里的绝对路径; 之后若干 `D` 数据帧、一个 `E` 结束这个文件; 可以再来 `P` … `E`; 最后 `Z` | `O` 文件个数 (`u32`) |
| `G` 拉取 | 客户机里的绝对路径 | 每个文件一个 `P` (`u32` 权限位, 再接相对路径; 拉的是单个文件时为空)、若干 `D`、一个 `E`; 最后 `O` 文件个数 (`u32`) |
| `R` 运行 | 一个标志字节 (`1`: 后台运行), 再接以 NUL 分隔的程序和参数 | `I` 进程号; 前台运行时之后是 `1` 标准输出、`2` 标准错误的片段, 最后 `Q` 退出码 (`i32`, 被信号结束时是 128 加信号号); 后台运行时是 `O` 日志文件路径 |
| `S` 终端 | `u16` 行数、`u16` 列数, 再接以 NUL 分隔的 `TERM` 值、程序和参数 (没有程序时是 root 的登录 shell); 之后宿主送 `D` 输入、`W` 改大小 (`u16` 行数、`u16` 列数) | `I` 进程号; 之后是 `1` 终端输出, 最后 `Q` 退出码 |
| `K` 停止 | `u32` 进程号, 可再接一个字节 `9` 表示强制结束 | `O` |

任何一步出错, 守护进程回 `X` 加原因, 然后关闭连接.

- 推送先写到同目录的 `.acdevd-part` 临时文件, 写完同步、设权限、改名, 缺的父目录会建好.
- 拉取 (工作项 05, 截图回传、产物取回): 目录按名字排序递归, 只送普通文件 (符号链接、设备等跳过, 不跟进子目录的符号链接), 相对路径相对拉的那个
  目录; 拉的路径本身是符号链接时跟过去. 每块 1 MiB. 宿主一侧写到 `.acdev-part` 再改名, 权限只留读写执行位 (去掉 setuid、setgid、粘滞位), 中途出错时删掉半截文件,
  拒绝带 `..` 或绝对路径的相对路径.
- 运行的程序各自开一个进程组, 标准输入是空的. 前台运行时宿主一侧断开 (比如在宿主上按 Ctrl+C) 会给整个进程组发 SIGTERM.
  后台运行的程序输出写到 `/var/log/acdevd/<进程号>.log`.
- 终端开在新的伪终端上: 程序是新会话的首进程, 伪终端是它的控制终端, 环境里有 `TERM` 和 root 的 `HOME`. 程序退出后再等 0.5 s 收完输出,
  给它的进程组发 SIGHUP, 回退出码并关闭连接; 宿主先断开时给进程组发 SIGHUP.
- `K` 给整个进程组发 SIGTERM (或 SIGKILL); 进程组不存在时回错误.

## 测试

`cargo test` (在 `crates/devd`): 用一对 Unix 套接字代替 vsock 和 TCP, 在进程内测密钥 (对的放行、错的和缺的拒绝、没有密钥时可有可无)、版本、拉取 (单个文件、目录树与权限位、不存在时报错)、推送 (内容与权限位)、前台运行 (分开的输出与退出码)、
后台运行再停止 (日志)、宿主断开时结束程序, 以及终端的大小、输入、改大小、退出码和断开.

## 宿主一侧 (`npm/src/vm/devd.ts`)

`Devd` 说上面的协议, 连接由 `Transport` 给: 实际用的 `RelayTransport` 起 `acdevd connect <cid> 5252`, 经它的标准输入输出读写.
`acdev vm` 的 `run`、`shell`、`push`、`kill` 和 `start` 末尾的就绪检查都经它; 装进客户机、找宿主二进制的做法见 `docs/vm.md`.
