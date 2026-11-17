# 客户机设备守护进程 acdevd (`crates/devd`)

> 路径相对仓库根。

acdev 第一个里程碑工作项 02 (总仓 `.scratch/acdev/issues/02-device-daemon.md`; 用户 2026-11-17 定: 原型阶段在 acdev 里做一个只用 std、
和 acdebin-system 无关的独立小程序, 经 vsock 与 acdev 通信, 以后并入 acdebin-system). 作用类似安卓的 adbd. `crates/devd` 是独立的 Cargo
工作区 (根工作区把它 `exclude` 掉): 不依赖任何库, 编一下不到一秒, 客户机和宿主用同一个二进制.

- `acdevd serve [--port PORT]`: 在客户机里以 root 运行, 在 vsock 端口 (默认 5252, 任意 CID) 上听, 每条连接一个线程, 一条连接做一件事.
- `acdevd connect CID [PORT]`: 在宿主上把标准输入输出接到客户机 `CID` 的 acdevd. 宿主的 bun 和 Node.js 都开不了 vsock 套接字,
  所以 acdev 起这个子进程, 经它的标准输入输出说协议.
- vsock 只用 libc 的 `socket` / `bind` / `listen` / `accept4` / `connect` (`AF_VSOCK` = 40, `sockaddr_vm`), 拿到的描述符包成
  `UnixStream` 读写; 接受连接不用 `UnixListener::accept`, 因为它会检查地址族.

## 协议 (`src/frame.rs`、`src/serve.rs`)

每一帧是 `u32` 小端长度 (种类加内容的字节数, 最多 16 MiB)、一个字节的种类、内容. 连接上的第一帧决定做什么:

| 请求 | 内容 | 回答 |
| --- | --- | --- |
| `V` 版本 | 无 | `O` 版本号文字 |
| `P` 推送 | `u32` 权限位, 再接客户机里的绝对路径; 之后若干 `D` 数据帧、一个 `E` 结束这个文件; 可以再来 `P` … `E`; 最后 `Z` | `O` 文件个数 (`u32`) |
| `R` 运行 | 一个标志字节 (`1`: 后台运行), 再接以 NUL 分隔的程序和参数 | `I` 进程号; 前台运行时之后是 `1` 标准输出、`2` 标准错误的片段, 最后 `Q` 退出码 (`i32`, 被信号结束时是 128 加信号号); 后台运行时是 `O` 日志文件路径 |
| `K` 停止 | `u32` 进程号, 可再接一个字节 `9` 表示强制结束 | `O` |

任何一步出错, 守护进程回 `X` 加原因, 然后关闭连接.

- 推送先写到同目录的 `.acdevd-part` 临时文件, 写完同步、设权限、改名, 缺的父目录会建好.
- 运行的程序各自开一个进程组, 标准输入是空的. 前台运行时宿主一侧断开 (比如在宿主上按 Ctrl+C) 会给整个进程组发 SIGTERM.
  后台运行的程序输出写到 `/var/log/acdevd/<进程号>.log`.
- `K` 给整个进程组发 SIGTERM (或 SIGKILL); 进程组不存在时回错误.

## 测试

`cargo test` (在 `crates/devd`): 用一对 Unix 套接字代替 vsock, 在进程内测版本、推送 (内容与权限位)、前台运行 (分开的输出与退出码)、
后台运行再停止 (日志)、宿主断开时结束程序.
