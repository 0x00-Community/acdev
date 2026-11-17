# CLI 和 acdert 的契约

> 路径相对 CLI 包根 `npm/`。

- 清单校验只有一份: `@dopame/acde-api/manifest` (acdert 的 `web/packages/acde-api`), acdert 的 Broker 和 acde 用同一段 (打进 `cli.js`). 检出的
  package.json 用 `file:../acdert/web/packages/acde-api` (仓内的 `acdert/`). **现在失效**: acdert 的 `web/` 已删除 (acdert 91e7dd1e), 取代
  方案未定, 这个依赖装不上, 用到 SDK 的测试和 `dist.ts` 的默认 `--api` 也找不到它.
- **运行时还不是安全边界**: 第三方沙箱 (acdert#30) 做好之前, `acde install` 装的包和 `acde build` / `acde dev` 的开发构建都按开发者自己的
  代码对待: 构建执行工程的构建工具和依赖, 后端是有开发者全部权限的普通进程; 清单的 capabilities 和 `fs` 的根只管 `acde:` 模块给什么,
  不隔离进程. 只装、只跑信得过的代码.
- `acde check` 对有配置的工程也用 SDK 的 `Manifest.check` (按构建会写的 `apiLevel`): 配置换成临时清单 (入口、图标、资源不查, 那些由
  `Project.check` 管), 第 1 级的规则 (`fs.roots` 只许公共位置名、能力名、第三方应用的外壳模块、服务的保留名) 在构建前报出, 文字与构建时相同.
- 命令行 `acdebin-dbg app <id>` / `acdebin-dbg desktop <id|包目录>`; 环境 `ACDE_PATH`、`ACDE_DEV`、`ACDE_HEADLESS`、`ACDE_RUNTIME`; dev IPC 见 `acde-dev.md`.
- 后端: acdebin-dbg 在 PATH 上有 bun 时 `bun --preload <dir>/acde-listen.js <entry>`, 否则 `node --import <acde-listen.js 的 file: URL> <entry>` (Windows
  盘符路径不是合法的模块说明符). `acde dev` 给 acdebin-dbg 设 `ACDE_RUNTIME` (`bun` / `node`, acde 自己跑在哪个上), `node` 时 acdebin-dbg 先找 node. 没有 `acde-listen.js` 的旧包不起.
- **Windows 后端契约** (2026-11-09 定, 和 acdert AGENTS.md「网页应用」的「Windows 后端契约」是同一份, 两边一起发版; 预加载的通道模式
  和套接字模式已实现 (acde#4、#5, 见 `acde-build.md` 的「preload」), 两种模式的优雅停止也已实现 (acde#6); 运行时一侧见 acdert#23、#24、#25).
  不变量: 后端运行期间没有 TCP 监听、没有命名管道, 套接字文件只有 SYSTEM 和当前用户能开; macOS / Linux 不变.
  - **两种模式**: node 走**通道模式**, 环境 `ACDE_APP_CHANNEL=fd`, 不设 `ACDE_APP_SOCKETS` (Node 在 Windows 上不能用文件系统 AF_UNIX);
    bun 走**套接字模式**, 环境 `ACDE_APP_SOCKETS=<本代目录>` 加 `ACDE_APP_CONTROL=fd`, 不设 `ACDE_APP_CHANNEL`. 其余变量同 unix.
    两种模式下运行时都经 CRT 的 `lpReserved2` 交给后端两根匿名管道: fd 3 (后端读) 和 fd 4 (后端写). 通道模式上面跑全部帧, 套接字模式只跑控制帧.
  - **通道帧** (大端): `type u8 | stream u32 | length u32 | payload`, 头 9 字节, payload 最多 64 KiB. OPEN 1 (运行时开流, payload 是 u16 的 `listen(P)`
    的 P)、DATA 2、FIN 3 (这一方向写完)、RST 4 (中止, payload 是 UTF-8 原因)、WINDOW 5 (payload u32, 给对方追加的信用字节数)、SHUTDOWN 6
    (流号 0, 无 payload, 请后端优雅退出). 流号由运行时分配、不复用; 每条流每个方向初始信用 256 KiB, 发 DATA 扣信用, 收方交出数据后发 WINDOW 补回.
    不认识的类型忽略; 不存在的流上的 DATA / FIN 回 RST; P 上没有登记 server 时预加载回 RST. 两端都在 FIN 排空后才算关闭, RST 只用于中止.
  - **预加载 (`acde-listen.js`)**: 通道模式把每个 OPEN 交给 `listen(P)` 登记的 server 当一条连接 (HTTP 和 WebSocket 升级都走它), 不真正监听;
    读 fd 3 用专用循环, 不长期占公共线程池. 套接字模式和 unix 一样把 `listen(P)` / `Bun.serve` 换成 `<ACDE_APP_SOCKETS>\<P>.sock`, 有
    `ACDE_APP_CONTROL=fd` 时读 fd 3 上的控制帧. 两种模式收到 SHUTDOWN 都停止接受新连接、让在途请求做完、关 server 后退出; 运行时等 3 秒后终止
    作业对象 (旧预加载不读控制帧, 就等满 3 秒). 预加载不改目录的 ACL. 支持通道的 `acde-listen.js` 含字符串 `acde-listen-channel/1`; 运行时起 node
    前查这个标记, 没有就不起, 打 warn `not started: acde-listen.js does not support the Windows channel (built by an older acde: acde build it again)`.
  - 套接字目录、作业对象、运行时一侧的连接与重试归 acdert, 见它的同一节.
