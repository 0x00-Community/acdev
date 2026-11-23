# 客户机代理 acdev-agent (`crates/agent`)

> 路径相对仓库根。

AC/acdev#115 的 S2 (总仓 `.scratch/acdev-debug-insight/issues/done/07-guest-integration.md`「拆法定稿」): 开发能力整个挪出 acdes 的管家,
由 acdev 只装进自己起的客户机. 代理是客户机里以 root 运行的系统服务, 对宿主讲管家 `dev.sock` 那套行协议, 背后走管家的五个开发钩子
(acdes `docs/manager.md`「开发钩子」) 和一条开发信任级 (`Trust::Dev`) 的合成器连接. 宿主一侧的 acdev 不用改: acdevd 的 `C` 隧道不带路径时先连
`/run/acdev/agent.sock`, 连不上 (旧客户机没有代理) 再退回 `dev.sock` (见 `docs/devd.md`).

`crates/agent` 是独立的 Cargo 工作区 (根工作区 `exclude` 掉, 有自己的 `Cargo.lock`), 以 path 依赖 libacde 的 `acde-wire` (管家控制通道的帧、
acompositor 协议的客户端绑定, feature `acompositor`) 和 `acde-scene` (注入的节奏), 以及 `crates/devd` 的库部分 (`acdevd::key` 读密钥、
`acdevd::seat` 问 logind 的活动用户, 两个程序共用一份). 交叉编译同 acdevd (`.cargo/config.toml`, musl 加 rust-lld).

- `acdev-agent serve [--socket PATH]`: 读 fw_cfg 密钥 (`acdevd::key::FW_CFG`), 没有就退出 (只在 acdev 起的客户机里跑); 在 `PATH`
  (缺省 `/run/acdev/agent.sock`, 0600) 上听, 每条宿主连接一个线程, 每个请求再一个线程, 慢的请求不挡别的.
- `acdev-agent --version`.
- systemd 单元 `acdev-agent.service` 的正文在 `npm/src/vm/guesttools/index.ts` (`AGENT_UNIT`): `ConditionPathExists` 是密钥文件, `Restart=always`, 日志进 journald, 标识 `acdev-agent`.
- 怎样装进客户机: 随 `acdev-guest-tools` 包, 由 `acdev vm provision` 装 (见 `docs/vm.md`「客户机工具包 acdev-guest-tools」).

## 连管家 (`src/link.rs`, `src/agent.rs`)

- 找会话: `loginctl` 问 seat0 的活动会话的用户 (`acdevd::seat::active_uid`), 在 `/run/user/<uid>/` 下找 `*.acde-manager` (管家的控制套接字,
  `SOCK_SEQPACKET`), 有几个时取名字最小的.
- 握手: 发 `{hello: {api, pid, dev_key}}`, `dev_key` 是密钥原文; 管家回 `{welcome: {kind: "dev", hooks}}` 才算连上, 回 `welcome: null` 时
  把 `error.message` 报出来. 帧的收发用 `acde_wire::channel::Channel`.
- 钩子调用 `{id, service: "dev", method, args: [参数]}`, 答案 `{id, ok}` 交给等它的线程; 帧级 `error` 变成错误文字. 缺省最多等 600 s,
  逐页收日志时每页 1.5 s. 管家断开时所有等待一起失败.
- 跟着会话走: 每次用钩子前都重新找一次活动会话的套接字, 和手上的连接不是同一个 (换了用户、会话重起) 或连接断了就重连. 另有一个线程每 2 s
  做一次同样的事并确保合成器连接在, 所以没有宿主连着时, 时间线和合成器的开发事件也照样进 journald; 连不上时只在原因变了时记一行警告.
- 合成器连接: `dev.screen()` 的答案附一个描述符, 代理在上面开 Wayland 连接 (`src/screen/`). 连接断了或管家连接换了 (按连接的序号认),
  下一次用时重要一条.

## 管家推来的事件

- `{type: "devevent", page, event}`: 把 `event` 原样写成一行, 发给说过 `{type: "hello", role: "dev"}` 的宿主连接 (同 `dev.sock`).
- `{type: "timeline", line}`: `line` 原样写进 journald (见下「日志」).
- `devinject`、`devwindow`、`devtools`: 现在不处理. S1、S2 期间管家自己经会话的 devwin 注入页面的输入、改窗口, 代理再做就重复了;
  S3 删掉会话那份驱动后, 由代理接手 (要管家在欢迎里说明, 待和 acdes 商定).

## 行协议怎样对到钩子 (`src/ops/`)

宿主发 `{type: "request", id, op, ...}`, 代理回 `{type: "response", id, ok, result | error}`. 钩子的答案就是 `dev.sock` 那一行去掉 `type`、`id`,
代理补上宿主的 `id`; 钩子本身失败 (参数不对、找不到页面) 回 `{ok: false, error}`.

| 宿主的请求 | 代理怎么做 |
| --- | --- |
| `webs` | `dev.webs()`, 去掉答案里只给代理的 `ports`、`windows` |
| `devtools` | `dev.webs()` 的 `ports` |
| `call {target, method, params}` | `dev.call({service: target, method, args: params})` |
| `open {name, path?, url?}` | `dev.act({action: "open", app: name, path, url})` |
| `appearance {...}` | `dev.act({action: "appearance", ...})` |
| `console` / `network` 带 `pages: true` | 按 `dev.webs()` 逐页 `dev.relay` (并行, 每页 1.5 s), 合成 `{pages: [{key, app, ...}]}`; `key` 是页面名, `since` 按它分给各页 |
| `screen`、`pointer`、`clipboard`、`drop`、`shot`、`input`、`window` | 代理自己在合成器连接上做, 见下「驱动」 |
| `render`、`hit` | 页面一半经 `dev.relay`, 再加合成器一半, 见下「08、09 的合成器一半」 |
| 其余 (snapshot、act、query、run、eval …) | `dev.relay({request})`, 页面由请求里的 `web` 定, 缺省同 `dev.sock` |
| `{type: "reload", app?, hot?}` | `dev.act({action: "reload", app, hot})`, 不回 |
| `{type: "quit"}` | `dev.act({action: "end"})`, 不回 |

## 驱动 (`src/screen/`)

从 acdes `crates/session/src/devwin/` 搬来的驱动部分: 注入 (带 `acde-scene` 的节奏、按键名到 evdev 码)、截屏与 PNG 编码、缩小、剪贴板
(ext-data-control)、拖放文件、改窗口 (状态、置前、摆放、关闭、桌面拿焦点). 窗口表仍归会话进程, 代理只记自己连接上的窗口:
标识里的窗口号 N (`acompositor-N`)、应用编号、几何、状态. 绑定 `acompositor_desktop_v1` 11 到 12 (11 起有开发事件, 12 起有 `render_state`、`hit`).

窗口怎样对上: 宿主说的窗口号和页面 `webs` 行里的 `window` 都是会话窗口表的 `id`, 和代理连接上的对象号不同. 代理问一次 `dev.webs()`:

- `shot`、`input`、`drop` 按 `web` 找 `webs` 行 (先比名字再比应用编号); 桌面、锁屏、确认页对整屏; 否则用行里的 `window` 在答案的 `windows`
  (会话窗口表, acdes 5aff0bc 起只给钩子, 每行带 `id`、`toplevel`、`pid`、`app_id`) 里取 `toplevel` 即 N; 对不上就报这个页面没有窗口.
- `window` 的 `window` 是会话窗口表的 `id`, 0 是桌面, 同样经 `windows` 换成 N.

## 08、09 的合成器一半 (`src/ops/probe.rs`, `src/screen/probe.rs`)

- `render {web?}`: 先经 `dev.relay` 要页面一半 (libacde `docs/dev/dev-ipc.md` 的 `render`), 再在合成器连接上发 `render_state`, 答案的
  `result.compositor` 是 `{composer: "gpu" | "cpu", device, driver, areas: [{window, surface, rect, drawn}]}`; `areas` 只留这个页面那扇窗
  (N) 的, 桌面页留 `window` 为 0 的 (面板). `drawn` 是 `none`、`frost`、`gpu-glass`、`cpu-glass-frosted`, `rect` 是物理像素的全局坐标.
- `hit {x, y}`: 先在合成器连接上发 `hit` (和页面问的时刻挨得最近), 再经 `dev.relay` 要页面一半, `result.compositor` 是
  `{window, role, surface, local: [sx, sy], beneath: [N...]}`: 落在哪扇窗 (N, 什么都没有是 0)、`role` (`toplevel`、`popup`、`subsurface`、
  `layer`、`lock`、`none`)、表面内坐标、被它挡住的窗口由近到远.
- 合成器一半失败 (acdes 旧于 desktop v12、连接不上) 时 `compositor` 是 `{error}`, 页面一半照常.
- 还没做: 09 的 `--expect` 落点断言.

## 日志 (`src/journal.rs`)

代理的日志写标准错误; 标准错误就是 journald (环境变量 `JOURNAL_STREAM` 和它的设备号、inode 对得上) 时每行带 `<N>` 优先级前缀, systemd 据此记级别; 命令行用法 (如 `overlay`) 不带. 时间线的行 (管家推来的, 以及合成器连接上的开发事件) 照
`event=<类型> key=value` 写, 值为空或含空白、`"`、`=` 时加双引号并转义. 合成器事件: `press window x y button`、
`move-request window serial accepted reason`、`resize-request window serial edges accepted reason`、`focus window`、`map window`、
`unmap window`、`drag-start window`、`drag-end window dropped`; `window` 都是 N.

## 检查

`cargo check --tests` (在 `crates/agent`; 旁边的 `../libacde` 要带 `wire/`). 单元测试: 时间线行的引号、答案的拼法、`open` / `appearance`
到 `dev.act`、逐页收日志的 `since` 与出错的行、窗口怎样对上、合成器的区域按窗口筛、缩小截图.

## acdev push 的叠加 (`src/overlay.rs`; 宿主一侧 `npm/src/push/index.ts`)

总仓 `.scratch/acdev-debug-insight/issues/11-hot-swap.md` 的热替换: 只改 JS 时不重新打包装机. 管家不知道有叠加, 叠加由代理在客户机里挂.

- 宿主 `acdev push [dir] --session vm`: 照 `acdev build` 构建出包目录, 读客户机叠加目录 `/var/lib/acdev/overlay/<包名>/push.json` 里上次的文件表
  (每个文件 `[大小, 修改时间毫秒]`, 不算哈希), 只推变了的, 删掉本地已没有的, 再写新的 `push.json` (`commit`、`dirty`、`at`、`files`); 都经 acdevd.
  然后在客户机里以 root 跑 `acdev-agent overlay mount <包名> [--reload <应用>]... [--desktop]`. 改了后台 (`backend/`、`services/`、`apps/<id>/backend/`)
  的照推, 提示要重开会话才跑新的.
- `acdev-agent overlay mount NAME`: 包名只许一段 (`[A-Za-z0-9._@-]`); 叠加目录 0755、其中 `package.json` 0644 (管家要求包目录与清单 root 所有、
  组和其他人不可写). 包已装 (`/usr/local/share/acde/packages/<名>` 或 `/usr/share/acde/packages/<名>` 下有 `package.json`) 就挂在它上面;
  没装就建 `/usr/local/share/acde/packages/<名>` 再挂. 推来的清单 (`package.json` 的 `acde`) 和装着的不同就拒绝 (退出码 2, 说改装包).
  已挂着时只核对清单. 挂好后各开一条到管家的开发连接调 `dev.act({action: "reload", app})` (`--desktop` 不带 `app`), 打印 `{target, mounted, reloaded}`.
- 记账: `/run/acdev/overlay.json` 记每个挂上的包 `{target, created, acde}` (`acde` 是挂之前装着的清单, 挂上后原包被盖住, 读不到了). 重启后挂载和这份记录一起没有.
- `acdev-agent overlay reset [NAME]`: 卸下 (`MNT_DETACH`), 自己建的挂载点删掉, 叠加目录删掉; 不给名字时全部. 宿主 `acdev push --reset` 跑它;
  `acdev vm provision` 在装任何包之前也跑一次, 免得旧的叠加盖住新装的包.
- 还没做: 总仓 `scripts/build/pkg.sh --install` 之前调 `overlay reset`; `acdev evidence` 与 `acdev test` 的留证附上 `push.json`; 只重启后台服务.
