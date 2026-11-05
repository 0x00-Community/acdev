# acdert

> **⛔ 第一原则: 不许在任何层次上魔改 web 接口.**
>
> - web 接口 (DOM、`window`、`fetch`、`localStorage`、事件、Web Audio、WebGPU …) 必须和浏览器**完全兼容**: 行为、签名、
>   事件、错误都照标准. 不许给标准对象加私有方法 / 字段 / 事件, 不许改标准接口的语义, 不许为了 acde 方便改写标准行为.
>   做不到兼容的就是缺口, 记成「还没有」, 不拿一个长得像的私有版本顶替.
> - **全局只有两个**: `window` (web 兼容) 和 `globalThis` (node 兼容). 没有 `acde` 全局, 也不许再往全局上挂任何非标准的东西.
> - 系统接口只有一个入口: `acde:` 内置模块, 照 `node:fs` 的写法导入 (`import { fs } from 'acde:fs'`、
>   `import { apps } from 'acde:apps'`、`import self from 'acde:window'` …; 类型在 SDK `@dopame/acde-api`). 清单的 capabilities
>   决定能导入哪些, 没开的导入直接失败. 文件、终端、网络、窗口管理、会话这类能力都走它, 不往 web 接口里塞, 也不让页面直接碰 napi.
> - acde 的定位是一个运行时 (像 node / bun / workerd 之于 wrangler): 标准接口原样提供, 特殊能力只经 `acde:` 模块提供.
>   标准 Node 不让页面直接碰系统调用, acde 偏要让: 桌面 (包括它的 React 组件) 直接 `import { fs } from 'acde:fs'` 读写文件,
>   这正是 acde 存在的目的. 「魔改」只许发生在 `acde:` 这一层, 标准接口一个字不动.
> - **`acde:` 模块是进程内注入, 不是 RPC**: 像 wrangler 拉起 workerd 时把 binding 注入 worker 那样, acde 在页面所在的进程里把
>   `acde:` 模块直接注入页面的 V8, 调用直接进 Rust 原生实现 —— 不经 unix socket, 不经 IPC / 消息端口, 不转给别的进程代办.
>   现在 web 进程经 port 把调用发到 Broker、由 `rpc.ts` / `remote.ts` 代理 (见「通信」) 是错的做法, 是要收回的债,
>   新能力不许再往这条 RPC 上加.
> - 兼容的是**标准接口**, 不是 Chromium: 渲染器是自研的 (Blitz 分叉 acrender, 没有 JS 引擎, 页面 JS 在 acde 自己的 V8 里),
>   不搬 Chromium 那一套 —— 没有 devtools、远程调试端口、浏览器外壳、多余的进程和后台服务. 缺什么按标准补进自己的实现, 不引入浏览器内核.
> - **现状差距很大**: acde-dopame 大量直接用 napi 导出做底层接口, web 层也有过非标准的扩展,
>   这些都是要收回的债, 不是可以照抄的先例; 新代码不许再加, 动到旧代码时往这个方向收. (已收回: `acde` 全局、`window` 上的
>   `acde:*` 事件、`agentrt:open-app` 和 `__agentrtAsks`: 事件改成 `acde:` 模块上的 `on`, 见「通信」.)
> - **目标 (在做, 见「运行时进程」)**: 所有窗口 (包括桌面) 共用一个 V8 (一个运行时进程), 每个窗口 / 桌面 / Broker 各一个
>   isolate (各一个线程), 内存、生死、CPU 时间均衡.
>   `acde:` 模块在各自的 isolate 里直接注入, 系统能力是进程里共享的同一份 Rust 实现; 桌面包服务之间、页面和服务之间是
>   isolate 之间的进程内调用 (像 workerd 的 service binding), 不经 socket. 现在的「每个窗口一个 web 进程 + port + Broker 代理」
>   是在这之前的做法.

说明都在本文件里 (没有 README). full agentic.

acdert 是 acde 的运行时, 和开发者 CLI [acde](https://github.com/dopame-org/acde) 的关系像 workerd 和 wrangler:
acdert 是一个二进制, 跑桌面和应用 (标准接口原样提供, 特殊能力只经 `acde:` 模块注入); acde (TypeScript, 跑在 bun 上) 建工程、
构建、装包, `acde dev` 拉起 acdert. 产品名 acde 留给 CLI 和对开发者的接口: `acde:` 模块、`@dopame/acde-api`、`acde.config.jsonc`、
`acde_window` / `acde_shell` 协议、`ACDE_*` 环境变量、`$XDG_*/acde/` 状态目录、`/usr/share/acde/packages`、XDG 桌面名 `acde`
都不改名; 改成 acdert 的只有程序 (`acdert`、`/usr/lib/acdert`、`/usr/bin/acdert`、会话项)、Arch 包和 crate.
本仓库从 acde-base `3c8cea6` 拷来 (不带历史), acde-base 先不动; Arch 包 `acdert` provides / conflicts `acde-base`.
acde-base 的 `acde app` 子命令和 `web/packages/acde-app` 搬去了 acde 仓库; 清单校验 (`manifest.ts`) 留在运行时这边,
并进 SDK (`@dopame/acde-api/manifest`, 见「网页应用」), 像 workers-types 出自 workerd 仓库.

acde = Agent Computer Desktop Environment. Dopame 的桌面基座, 替换 KDE Plasma / GNOME. 它自己就是 Wayland 合成器: 桌面是一张网页, 页面 JS 跑在内嵌的 V8 里 (不用 Node),
用没有 JS 引擎的原生 web 渲染器 Blitz (`vendors/acrender`) 画出来, 系统接口在 Broker 里走 napi, 不监听任何端口 (远程桌面后端除外).
原生应用作为 Wayland 客户端连进来, 和网页窗口一起由 acde 合成. 只支持 Wayland: 没有 X server, 也没有 Xwayland,
只会说 X11 的程序 (Java AWT、默认走 X11 的 LWJGL 游戏、xeyes 一类) 跑不了.

acdert 只是平台: 合成器, 渲染, 系统接口, host 和登录页 (发行时带上 Dopame 桌面包, 但不认识它). 具体的桌面 (页面, 应用, 它们要的服务) 由桌面包提供,
例如 [acde-dopame](https://github.com/dopame-org/acde-dopame). 登录时选哪个桌面, 见下面「桌面包」.

本文件是仓库里唯一的说明, 子目录不放 AGENTS.md; 各子目录的说明在下面按路径命名的章节里. 过时的测量记录不留, 要看翻 git 历史.

## 进程结构

```
acdert (crates/acdert, 主进程, 没有 V8)             crates/shell Wayland 合成器 (独立线程): canvas / 窗口表, 所有窗口都是 Wayland 客户端
 └─ acdert runtime (子进程, 自己的进程组)          主线程: Broker isolate (web/packages/acde-host) 系统接口、当前桌面的服务、窗口记录、会话;
     │                                              crates/runtime 系统接口 (Broker 经 napi 调); 经 `acde_shell` 管合成器; 起 web
     ├─ web desktop (线程 + isolate)               当前桌面的页面: V8 isolate + render 文档 + 光栅化 + Wayland 客户端
     └─ web <app>#<窗口> (线程 + isolate)          每个应用窗口一个, 只拿到它的清单允许的 `acde`
原生程序                                            普通 Wayland 客户端
```

主进程 (crates/acdert `supervise.rs`, `Supervisor`): 定好 `WAYLAND_DISPLAY` 之后建一对 socketpair, 起 `acdert runtime <同样的参数>`
(`ACDE_SHELL_FD` 是继承下来的那一头, runtime 的 napi `Shell.broker()` 接过去并设回 CLOEXEC; 没有这个变量时 `Shell.broker()` 照旧在
自己进程里起合成器). 合成器等 runtime 在这条连接上发来第一条消息才起 (`desktops`、交给别的会话、出错退出这些不碰 DRM 的路径不起它);
连接先挂断或 runtime 先退出就不起. SIGINT / SIGTERM / SIGHUP 转给 runtime (它的进程组, 终端的 Ctrl-C 只到主进程); runtime 正常退出
(或被转过去的信号结束) 时主进程停合成器, 用它的退出码退出; 被别的信号杀掉 (崩溃) 时在同一个合成器上新建一条 `acde_shell` 连接重起它,
60 秒内最多 3 次. runtime 设了 PDEATHSIG (主进程死它跟着死).

web (crates/acdert `web.rs` `spawnWeb`: runtime 里的一条 JS 线程 `acde`, 栈 8 MiB, 自己的 isolate (堆上限 `heapMb`) 和事件循环;
本文其余地方说的「web 进程」都指它): 和 Broker 之间的消息是结构化克隆的字节, 投进对方事件循环的通道 (没有 socket); `terminate`
置停止并 `terminate_execution` (卡在 JS 里也停得下, 退出码 137); 线程 panic 只结束这个 web (退出码 134, 原因 `panic: …`);
句柄的 `busyMs` (当前任务跑了多久, Broker 判卡死) 和 `cpuMs` (这条线程用掉的 CPU, `/proc/self/task/<tid>/schedstat`;
`DebugApi.stats` 每个 web 带上). 段错误、abort 仍然带掉整个 runtime (主进程重起它). 里面是 crates/render 的文档、
crates/paint (光栅化线程: 交给 acgpu, 今天是它的 Vulkan 回退 —— vello 画、filter / drop-shadow / backdrop 合成都在 acgpu 里) 和 crates/window
(Wayland 客户端: xdg_toplevel + linux-dmabuf + `acde_window`, 输入 / 剪贴板 / 拖放 / frame). 它死掉只掉它的窗口.

### 运行时进程 (目标, 在做)

acdert 是**一个**可执行文件, 在 Linux / Windows / macOS 上都能跑, 定位像 workerd: 运行时本身, 标准接口原样提供, 特殊能力只经
`acde:` 模块注入. 发行时带上 Dopame 桌面包 (acde-dopame, 源码仍在它自己的仓库, 不编进二进制), 开发者的工程是桌面时用工程自己的.
两种跑法, 运行时是同一套:

| 跑法 | 命令 | 平台 | 输出 | 合成器 |
| --- | --- | --- | --- | --- |
| **AgentComputer 会话** (真实运行环境, Dopame OS) | `acdert --desktop <id>` (登录页起) | Linux | 屏幕 (DRM/KMS) 或 RDP | acdert 自己 (主进程) |
| **调试桌面** (`acde dev`) | `acdert desktop <id \| 目录>` | Linux / Windows / macOS, 在别人的桌面里 (也包括 Dopame OS 自己的会话里) | 每个窗口一个宿主原生窗口, 桌面也是一个 (特殊的) | 宿主系统的 |
| **调试窗口** | `acdert app <id \| 目录>` | 同上 | 只有这个应用的窗口 (桌面的窗口建了但不显示) | 同上 |

调试模式不是 WebUI, 也不推流: 不开端口、不用浏览器, 和 Tauri / Electron 一样, 每个窗口都是宿主系统的原生窗口, 装饰 (标题栏、
边框) 也用宿主的 (acde-host 的窗框 `frame.ts` 不加, 标题经 surface 的 `setTitle` 给原生窗口). 桌面是一个特殊的窗口 (window 0):
它的大小就是「屏幕」(`output`, `ACDE_SIZE` 或主显示器的 90% × 85%, 最大 1440 × 900), 别的窗口的坐标相对它的内容区原点;
桌面的面板 (`pin`: 菜单栏、Dock、弹出层) 画在桌面窗口里 (不开单独的窗口). 只支持通用的东西: Dopame OS 特有的
(合成器、登录页、NetworkManager、fcitx5、AT-SPI、PipeWire、greetd、交出会话) 不注入, 也不模拟.

实现是 crates/hostwin (`acde-hostwin`): winit 开窗口、收输入, wgpu 的 surface 上屏 (macOS Metal, Windows DX12 / Vulkan, Linux
Vulkan), 页面由 vello 画进一张 Rgba8 纹理再拷到 surface (layers 的滤镜和 backdrop 还没做, 按顺序直接画). 主线程跑 winit 的事件循环,
Broker 在 `acde` 线程 (栈 64 MiB), 每个窗口一个 `acde-host-<id>` 线程出帧. 对 acde-host 的接口和 Linux 一样:

- Broker 的 `native.Shell.broker()` 换成 hostwin 的 `Shell` (crates/acdert `hostnative.rs`): grant / place / focus / hide / close /
  windows / shortcut …, 对象上 `hosted: true`; `inject` / `screenshot` 没有. 窗口的关闭按钮发 `windowcloserequest`: 桌面的结束
  会话, 别的走 `closeWeb` (先问 `beforeclose`).
- web 的 `claimSurface` 拿到 hostwin 的 `Surface` (crates/acdert `surface.rs` 是 Wayland / 宿主两种的 enum), 另有 `hosted`、
  `setTitle`、`setImeArea`. 输入: winit 的按键换成 evdev 码 (`keys.rs`), 输入法的 `Ime::Commit` / `Preedit` 是 `imecommit` /
  `imepreedit` 事件 (acde-host 直接交给 `TextEntry`). 窗口被挡住 (macOS 的另一个 Space、最小化) 时这一帧不上屏, 等 winit 的
  `Occluded(false)` 再把已经画好的那张纹理上屏, 不重画页面.
- 系统能力: fs、terminal (pty; macOS 上没有 pidfd / eventfd / close_range, 换成轮询、socketpair、逐个 close)、应用后端的
  unix socket 在所有 unix 上注入; network、office、IME、语音只在 Linux. OpenSSL 在 macOS / Windows 上静态编进去 (`vendored`).
- 验证 (只在 macOS 上验, Windows / Linux 的宿主窗口只写不验): `ACDE_HOST_DUMP=<目录>` 让每个窗口每帧把画好的页面 (GPU 读回)
  写成 `<目录>/<窗口 id>.png`; `ACDE_DEBUG_DIR` 照旧能在各 web 里求值. 不截屏.

调试桌面和调试窗口只差两点:

- **权限等级**: 调试桌面里的页面是桌面, 拿桌面的权限 (`acde:windows` / `acde:apps` / `acde:desktops` / `acde:session` /
  `acde:inspect` …, 桌面包的服务也起); 调试窗口里的页面是应用, 只拿它清单 capabilities 给的模块.
- **事件类型**: 桌面收桌面的事件 (`acde:windows` 的 open / close / title …、`acde:desktop` 的 download / notification / shortcut …);
  应用收自己窗口的事件 (`acde:window` 的 shortcut / request …).

别的 (一个 V8、每个窗口一个 isolate、注入、均衡) 都一样. 调试模式不是浏览器外壳, 不带 devtools、远程调试端口 (见第一原则).
现状: `acdert app <id>` (原来的 `acde window <app>`) 和 `acdert desktop <id|包目录>` (同 `--desktop`) 只认装好的包或包目录;
`acde dev` 先 install 再起它们. macOS 上起会话 (`acdert` 不带子命令也一样) 都走宿主窗口; Linux 上 `app` / `desktop` 子命令在别人的
桌面里 (有 `WAYLAND_DISPLAY` / `DISPLAY`, 没设 `ACDE_BACKEND`) 走宿主窗口, 别的照旧是会话.

`acde dev` 和 acdert 之间: IPC 是 crates/ipc (`acde-ipc`): unix 上 unix socket, Windows 上命名管道 (`CreateNamedPipeW` /
`ConnectNamedPipe`, 客户端 `CreateFile` 打开, 忙时 `WaitNamedPipeW`, 读写就是 `ReadFile` / `WriteFile`), 一行一个 JSON. acde 是服务端
(`ACDE_DEV` 是它的地址), acdert (hostwin 的 `acde-dev` 线程) 连上去, 先发 `{"type":"hello","pid"}`; 收 `{"type":"reload","app"?}`
(推给 Broker 一个 `devreload`: 有 app 时关掉它所有窗口 (不问 `beforeclose`) 再打开, 位置由「窗口管理」记的 rect 摆回;
没有 app 时重起 desktop web, 桌面服务不重起) 和 `{"type":"quit"}`; 连接断了 (acde 退出) acdert 就退出. 工程的构建结果经 `ACDE_PATH`
(Windows 上用 `;` 分隔) 交给 acdert, 不装进包目录. 日志就是 acdert 的 stderr (acde 起它时继承). `ACDE_PATH` 的分隔、`process.platform`
(`sys` 给的 `platform`, 和 Node 的值一样) 都按平台.

```
AgentComputer:
acdert (主进程)                     合成器 (crates/shell) + 窗口管理 + 输入 / 外设. 没有 V8, 不跑 JS
acdert runtime (子进程, 一个)       一个 V8 (一个 Platform), 所有 JS 都在这里
 ├─ Broker isolate                  会话、当前桌面的服务、应用记录; 经 `acde_shell` 管合成器
 ├─ desktop isolate                 桌面页面 + render 文档 + 光栅 + 自己的 Wayland 连接
 ├─ <app>#<窗口> isolate × N        每个应用窗口一个, 只注入清单允许的 `acde:` 模块
 └─ 共享的 Rust 状态                crates/runtime 的系统实现、窗口和应用表, 一份, 各 isolate 直接调
原生程序                            普通 Wayland 客户端

调试桌面 / 调试窗口:
acdert (一个进程)                   同上的 runtime (Broker / desktop / 应用各一个 isolate), 每个窗口是宿主的原生窗口, 没有合成器
```

- **一个 V8, 每个窗口一个 isolate**: 所有窗口 (包括桌面) 共用一个 V8 —— 同一个进程、同一个 Platform、同一份共享的 Rust 状态;
  每个窗口 / 桌面 / Broker 是自己的 isolate, 因为只有 isolate 能让窗口之间的内存、生死、CPU 时间各管各的 (同一个 isolate 里的
  context 共用一个堆和一个线程, 一个卡住全卡住).
- **均衡**: 每个窗口拿到的资源是对等的, 谁也挤不掉谁.
  - 内存: 每个 isolate 自己的堆上限 (清单 `heapMb`, 没给就用缺省值, 大家一样), 外部内存 (ArrayBuffer、render 文档、GPU 缓冲)
    按 isolate 记账并报给它的 V8 堆; 超限终止这个 isolate.
  - 生死: isolate 各自建、各自销毁; 一个死了只掉它的窗口, 别的 isolate 和共享状态不动.
  - CPU: 每个 isolate 一个线程、同一优先级, 由内核公平调度; 按线程记每个 isolate 用掉的 CPU 时间; 单个任务超过上限 (卡死)
    终止这个 isolate. 不允许某个 isolate 抬自己的优先级或占多个线程 (Worker 也算在它的账上).
- **`acde:` 模块**: isolate 起来时按清单 capabilities 注入 (像 workerd 的 binding), 绑定在本线程直接调 Rust, 不序列化、不跨进程.
  能力的限制 (fs 的 roots …) 在注入时绑进去, 不在调用时由 Broker 查. 没给的模块不注入, import 直接失败. 某个平台上没有的能力
  (调试模式里没有原生程序的窗口、`acde:windows` 只管 acde 自己开的窗口 …) 同样不注入, 不给假的实现.
- **共享状态**: 窗口表、应用表、会话这些跨窗口的状态是 runtime 里的 Rust 表, 各 isolate 直接读写; 要合成器动手的 (关窗口、
  聚焦、隐藏、放置、快捷键 …) 经 `acde_shell` (AgentComputer) 或宿主窗口 (调试模式).
- **桌面包服务** (assistant …): 在 Broker isolate 里 (或自己的 isolate); 别的 isolate 调它是进程内跨 isolate 调用 (结构化克隆,
  经线程间通道), 像 workerd 的 service binding. 这是唯一的跨 isolate 调用, 只给 JS 写的服务用, 系统能力不走它.
- **`acde_shell`**: 主进程起 runtime 时交给它的私有 Wayland 协议连接 (只有这条连接能绑定), 取代 Broker 现在直接调的 napi `Shell`
  (launch / inject / windows / grant / hide / focus / close / shortcut / place / animate / screenshot / stats / quit / 事件). 这是平台
  协议 (和任何 Wayland 客户端一样), 不是 `acde:` 模块的通道.
- **系统调用限制在调用者自己身上**: 一个窗口 (包括桌面) 的 `acde:` 调用在它自己的 isolate 线程上执行, 出什么错只算它的:
  - 异常回到调用者; 同步阻塞 (`spawnSync`、慢 I/O) 只卡它自己的线程; 内存记在它的账上.
  - 每个注入的绑定在边界上 `catch_unwind`: Rust 侧 panic 变成调用者里的异常 (或终止这个 isolate), 不跨线程传播, 不 abort 进程.
  - Broker 不替任何窗口执行系统调用 —— 现在 `#serve` 在 Broker 线程上替窗口调 fs / terminal / office / `spawnSync`, 一次错误调用
    卡死或 panic 就带死 Broker, 而 Broker 现在和合成器同进程, 会话跟着黑屏. 这是要收回的第一笔债.
  - 剩下的风险只有进程级的 (段错误、abort、被 OOM killer 杀): runtime 进程整个掉, 所有页面掉, 合成器和原生程序不动, 主进程按
    策略重启 runtime (60 s 内 3 次为限). 所以共享的 Rust 状态里不写 `unsafe`, 绑定层不 `unwrap`.
- **合成器和窗口分开**: 合成器 (含窗口表、焦点、grab、输入路由这些机制) 永远在主进程, 不跑 JS, 不执行任何窗口的系统调用;
  窗口的放置策略、桌面 UI、服务都在 runtime. 不把合成器并进 runtime 来省掉 `acde_shell`.
- **删掉**: `acde web` 子进程、port 帧 (`[u32 长度][u8 种类][结构化克隆]`)、`spawnWeb`、acde-host 的 `rpc.ts` / `remote.ts` 代理和
  Broker `#serve` 里系统能力的分支、Broker 对 `Shell` 的 napi 直接调用.

迁移顺序 (每步都能单独验):

1. (已做) `acde_shell` 协议: 合成器侧实现现在 napi `Shell` 的方法和事件; Broker 先在主进程里改成经它调 (接口对 TS 不变).
2. (已做) Broker 搬进 `acdert runtime` 子进程: 主进程只剩合成器, 起 runtime 时交 `acde_shell` 和 Wayland 连接 (`WAYLAND_DISPLAY`).
3. (已做, 外部内存记账除外) web 从子进程改成 runtime 进程里的线程 + isolate: `spawnWeb` 对 TS 不变, port 换成进程内通道;
   堆上限、CPU 时间和卡死检测按 isolate. 还没有: 外部内存 (ArrayBuffer、render 文档、GPU 缓冲) 按 isolate 记账.
4. (已做) 系统能力直接注入: fs / terminal / network / office / ime 在各 isolate 里绑定同一份 Rust 对象; 删掉 Broker 代理的这些分支.
   ime 在 crates/acdert `webnative.rs`, 别的见下. Broker 自己 (桌面服务) 还有 napi 的 `Finder` / `Terminals` / `Network`, 是另一份.
   - `spawnWeb` 第 7 个参数是这个 web 拿到的系统能力 `{fs, terminal, network, office}` (Broker `#grants`: 桌面全给, 应用按清单); 给了的才注入
     (`natives.fs` / `natives.terminal`), 没给的 `import('acde:<名字>')` 直接失败; Broker 不再给 web 发这些的 shape, `#serve` 收到
     直接拒绝. 每种在 Broker 线程第一次用到时建一份, 所有 web 共用.
   - terminal: crates/runtime `Terminals` 加 Rust 侧的 `listen(id, sink)` (sink 返回 false 表示收不到了, 下次发时摘掉) 和
     `shared()` (共用同一张会话表, 不是 owner: 只有 `new()` 出来的那个 drop 时关掉所有会话). crates/acdert `terminal.rs` 绑成
     `natives.terminal`: open / subscribe / input / resize / close 都返回 promise (和经 RPC 时一样能 `.catch`), 失败和 napi
     一样 (message 是失败的 JSON, `code 'GenericFailure'`); subscribe 的事件投回这个 web 的事件循环. Broker 自己的 napi
     `Terminals` 是另一张表 (会话结束时 `closeAll`). shell 在 runtime 进程里起 (和 GPU、Wayland、各 web 同进程), 所以 pty 的
     子进程 exec 前 `close_range(3, ~0)`: runtime 里的 fd (Mesa 的 udmabuf / memfd、没带 CLOEXEC 的管道) 一个都不带过去
     —— 带过去的管道写端曾让 `quit` 等读线程永远等不到 (退出时卡死).
   - network: crates/runtime `Networks` (所有 web 共用: 第一次调用时连 NetworkManager, `NetCall` 是六个调用, `listen` 可以挂任意多个
     Rust sink, 第一次挂时才开始盯 PropertiesChanged). crates/acdert `network.rs` 绑成 `natives.network`, `watch` 的状态投回这个 web
     的事件循环. 连接活到 runtime 退出 (不在 drop 时关: 关了盯信号的线程退出时 zbus 会报 remove match rule 失败).
   - office: crates/runtime `OfficeService` (Document Server 的会话、令牌和桥接 socket, 一个 runtime 只能有一个, 文件走 web 共用的
     `Workspace`). Broker 起服务时调 `sys.openOffice()` 开它 (失败的原因打一行 warn, 要 office 的应用就算不可用),
     结束时 `sys.closeOffice()`; napi `Office` 删了. crates/acdert `office.rs` 绑成 `natives.office` (server / state / status / save /
     new), web 的 `acde:office` 再加上 `editorPage` (`office.ts` 的 `OfficePage.write`, 纯 JS 写编辑页文件, 在 web 自己里跑).
   - 调用都在 crates/acdert `offload.rs`: 每次一条线程做阻塞的活, promise 在这个 web 的事件循环上落定; 失败是带 `code` (和 `status`)
     的 Error.
   - fs: crates/runtime `Workspace` (Finder 的共享状态 + 这个 web 能用的 roots, `None` 是全部) 和 `FsCall` / `FsReply`, napi
     `Finder` 也是它的包装. Broker 线程第一次 `spawnWeb` 时建一份, 每个 web 按清单拿一个 `scoped` 的副本 (`{fs}`: `true` 是全部,
     roots 数组, `null` 是没有); roots 在 Rust 里查
     (第一个参数: root, `locate` 是 path; 不带参数的 `state` / `roots` / `desktop` 在限了 roots 时拒绝), 拒绝是 `status 403`、
     `code 'forbidden'` 的 Error, 别的失败和 napi 一样: message 是失败的 JSON, `code 'GenericFailure'`. crates/acdert `fs.rs` 把它
     绑成 `natives.fs` (每次调用一条 `acde-fs` 线程, 结果投回这个 web 的事件循环), web 的 `acde:fs` 就是它. Broker 自己 (桌面服务、`locate`、office) 还用自己的 napi `Finder` (另一份
     `Place`, Broker 不读写它).
5. 窗口 / 应用 / 会话表进 Rust 共享表, `acde:windows` / `acde:apps` / `acde:window` / `acde:session` / `acde:desktops` 直接调.
6. 桌面包服务改成跨 isolate 的进程内调用; 删掉 `rpc.ts` / `remote.ts` 和 port.
7. 调试模式 (`acde dev` 用它): 每个窗口一个宿主原生窗口 (crates/hostwin, 见上).
   - (已做) macOS: Dopame 桌面、应用窗口、fs、终端都能用.
   - Linux (只写): 同一份 hostwin (winit 的 Wayland / X11); `arboard` 的剪贴板.
   - Windows (只写): rustix / pty / unix socket 这些 unix 的东西换成 Windows 的 (ConPTY、命名管道), 没有的不注入.

## 窗口模型 (split-window)

本分支的目标: 窗口模型只剩两个抽象 —— **canvas**(工作区) 和 **window**. 窗口的内容是一串三角形, 框架不解析、也不知道它从
哪来; 窗口只有 `fullscreen` / `free` / `fixed` / `pinned` 四种模式. 桌面、面板、菜单都是窗口. acdert 的窗口层不认识 web:
DOM → 三角形是 acrender 那边的事. **canvas 和 window 是框架里 Rust 的结构 (表项), 不映射到任何 DOM / JS 对象**, 跟 web 无关;
web 只是产生三角形的一个客户端. 迁移顺序里标了 (已做) 的就是现状, 没做的写在第 6 步.

**现状为什么不对**: 网页窗口是 acde 进程里的线程 (`crates/acdert/src/web.rs` 的 `acde-web`), 每个窗口有自己的 Document, 但
几何来自桌面文档里的 `<iframe>` 槽位, z 序是桌面 above 那半张的绘制顺序, 桌面还画窗口周围的内容. 结果是窗口一挪、一压栈,
桌面就要重录 above; 窗口永远只能在桌面的 below 和 above 之间; 一个页面 panic、卡 GC 或吃满堆, 合成器和别的窗口一起受影响.
根子是把"网页"写进了窗口模型 (surface / role / 槽位); 框架本该只知道"一块缓冲、四种模式".

### canvas: 工作区

canvas 像 macOS 的 Space、GNOME 的工作区: 屏幕只有一块, 但可以有好几个 canvas, 同一时刻屏幕只显示一个, 互相切换.

- canvas 是唯一给出绝对大小的地方: `rect` 是屏幕的逻辑尺寸, `scale` 是屏幕缩放 (HiDPI). 同屏的 canvas `scale` 相同.
- canvas 不被绘制: 它只提供坐标、裁剪范围、一个 z 列表和一个焦点.
- 窗口的 rect 是 canvas 坐标, **可以超出 canvas, 超出的部分不渲染** (就是不在屏幕上); 拖出去不拦.
- **创建后不变**: 不平移、不缩放、不改尺寸. 屏幕分辨率或缩放变了就重建一个 canvas; 窗口怎么迁过去是窗口管理的事.

| 字段 | 内容 |
| --- | --- |
| `id` | 框架分配 |
| `rect` | 屏幕逻辑尺寸; 也是裁剪范围; 创建后不变 |
| `scale` | canvas → 屏幕像素; 创建后不变 |
| `windows` | z 列表, 任意长; 顺序就是压栈顺序 |
| `focus` | 每个 canvas 一个活动窗口 |

### window: 相对 canvas 的大小

窗口本身没有绝对大小: `rect` 是 canvas 坐标, 屏幕像素 = 乘 canvas 的 `scale`. `fixed` / `pinned` 的"不变"都是相对 canvas
说的, 同屏切换 canvas 时它们的屏幕大小不变.

- `fullscreen`: 铺满它所在的 canvas, 尺寸跟 canvas 走, 不接受 resize.
- `free`: 位置和尺寸都可以变.
- `fixed`: 尺寸不变, 位置可以变.
- `pinned`: 位置和尺寸都不变.

窗口的内容只有三角形: 客户端交一条缓冲, 框架不跑 JS、不持有文档、不调 acrender; 谁产生它 (acrender 渲染的 web、原生客户端、
别的渲染器) 框架不管. 标题栏、边框、阴影也是内容 —— 客户端自己画 (CSD), 不是框架或别的客户端的概念.

z 序、几何、焦点、grab 在框架里, 客户端只能请求 (见「平台职责」).

| 字段 | 内容 |
| --- | --- |
| `id` | 框架分配 |
| `canvas` | 属于哪个 canvas |
| `mode` | `fullscreen` / `free` / `fixed` / `pinned` |
| `rect` | canvas 坐标; 可以超出 canvas; 屏幕像素 = 乘 `scale` |
| `z` | 在 canvas 的 z 列表里的位置 |
| `content` | 客户端给的缓冲 (dmabuf / shm), 带 damage 和 opaque 区域 |
| `input` | 输入区域, 默认整个 rect (shell 按 surface 记, 是 wl_surface 的输入区域, 不在 crates/model 的表里) |
| `grab hints` | 可选: 客户端声明的拖拽 / 改大小把手 (同上, shell `acde_window` 的 `Hints`) |
| `parent` / `modal` | 可选: 对话框挂在哪、是不是模态 |
| `focus` | 是否活动 |

### 分层与职责

四层, 每层只回答自己的问题; 换掉任何一层, 别的层不动.

| 层 | 谁 | 负责 | 不负责 |
| --- | --- | --- | --- |
| 内容 | 客户端 (内容生产者: acrender、原生程序、别的渲染器) | 决定画什么: 自己的 UI → 三角形 | 窗口摆哪、谁在上、何时上屏 |
| 渲染 | 客户端 | 内容 → 像素: 光栅、字体、图片、canvas, 出 dmabuf / shm | 合成别的窗口、屏幕时序 |
| 合成 | 框架的后端线程 | 谁在谁上、裁到哪、不透明度 / 变换、动画、backdrop 取哪块、跳过哪些损伤 —— **只出计划** | 碰像素、决定内容 |
| 呈现 | 后端 (GPU / CPU / DRM / RDP) | 执行计划: plane、GPU pass、软件光栅、编码; 挑最省的路 | 决定画什么、谁在上 |

契约 —— 每层只认这些:

- 渲染 → 合成: 缓冲句柄 (dmabuf fd / shm) + `damage` 矩形 + opaque 区域 + 形状 / backdrop 请求 + 同步点. 不交像素, 不交场景.
- 合成 → 呈现: `CompositePlan` —— 有序图层 `{缓冲, 源矩形, 目标矩形, 裁剪, 变换, 不透明度, 效果引用}` + 损伤矩形 + 目标缓冲.
  纯数据, 没有回调, 不引用客户端对象.
- 呈现 → 合成: 完成事件、下一个 vblank、能力 (格式 / 修饰符、plane 数、能不能直扫、纹理上传成本).

性能靠契约, 不靠某一层聪明:

- 只传句柄 → 零拷贝; 只报脏区 → 增量; 计划是纯数据 → 后端能遮挡剔除、合并损伤、把全屏窗口直接放 plane.
- 每层都能丢帧 / 延后: 客户端慢, 合成器用上一次的缓冲; 后端忙, 下一帧再合成. 没有同步等待.
- 框架不读像素, 所以窗口再多, 框架的像素工作量是零.
- 换渲染器只动上面两层; 换 GPU / RDP / 软件光栅只动呈现层; 加效果是 `CompositePlan` 加字段, 实现不了就降级画.

### `CompositePlan`

合成器每次出帧前重建它 (crates/model `plan.rs`, shell `compositor/composite.rs`): 纯数据, 不引用客户端对象, 不碰像素,
成本只跟可见窗口数有关.

```rust
pub struct CompositePlan {
    pub damage: Vec<Rect>,     // 屏幕物理像素, 最多 8 块 (MAX_DAMAGE, 多了按并起来面积增长最小的两块合并)
    pub route: Route,
    pub layers: Vec<Layer>,    // 从底到上; 已经被不透明上层剔除过
}

pub enum Route { Composite, Direct }

pub struct Layer {
    pub window: WindowId,      // 窗口表的 id; 呈现层据此找到这个窗口的缓冲 (smithay 的 surface 渲染元素)
    pub dst: Rect,             // 屏幕物理像素, 已经乘过 canvas 的 scale、套过 look
    pub clip: Rect,            // dst 和 canvas 求交
    pub look: Look,            // 合成器级 {opacity, scale (绕窗口中心), dx, dy (canvas 坐标)}
    pub effect: Option<Effect>,
    pub redraw: bool,          // effect 的输入 (它下面的内容) 这一帧变了
}

pub enum Effect {
    Backdrop { rect: Rect, radius: f32, blur: f32, saturate: f32, brightness: f32 },
}
```

输入 (`Input`, 每个窗口一份, 从底到上): 窗口本地物理像素的 damage 和 opaque 区域 (shell 从 smithay 渲染元素的
`damage_since` / `opaque_regions` 取, 按元素 id 记上次看到的 commit)、上一帧的 rect 和 look (挪动 / 动画的新旧两块)、
`acde_window.set_backdrop`、缓冲能不能直扫; 另加上一帧有、这一帧没了的窗口 (`gone`, 关掉的窗口) 的范围.

- 坐标全是屏幕物理像素: canvas 坐标 × `scale`、窗口 rect、canvas 裁剪都由框架做完.
- 遮挡: 从上往下走, look 是单位阵且 opacity 为 1 的窗口的 opaque 区域记下来; 整个 clip 被某一块盖住的窗口不进 `layers`,
  被盖住的损伤也不报. shell 只把 `layers` 里的窗口交给呈现层 (popup、layer-shell 的 surface 不进计划, 照旧画).
- backdrop: 只有它**下面**的窗口的损伤 (或 `gone`) 碰到 backdrop 区域时 `redraw` 才为真, 整块进 damage; 窗口自己的内容变了
  不重新模糊. 呈现层 (shell `effects.rs`, GLES): 把下面的渲染元素画进一块离屏纹理 (区域外扩模糊半径), 双 Kawase
  降采样 / 升采样 (层数同 crates/paint: `ceil(log2(blur / 2))`, 1..5), 再用圆角遮罩 + 饱和度 + 亮度的着色器画在窗口下面;
  结果按窗口缓存, `redraw` 为假且参数没变时直接用. 着色器编不出来时 backdrop 不处理 (降级), 不出错. 每次模糊打一行
  `perf::compose backdrop`.
- `Route::Direct` 只在一种情况给: 只剩一层、铺满 canvas、opaque 区域盖满、没有 effect、opacity = 1、look 是单位阵、元素有
  底层缓冲 (`underlying_storage`). shell 现在只数它 (`stats().direct`, `plans` 是建了几次计划); 真正上 plane 由 smithay 的
  DrmCompositor 自己判断, 画面一样.
- `damage` 现在只用来决定 backdrop 要不要重算和打日志; 每块输出的重画区域仍由 smithay 的 `OutputDamageTracker` / DrmCompositor
  按元素算 (两边算法一致: 元素损伤 + 挪动的新旧位置).

### 平台职责: 窗口管理 / 焦点 / 外设

这三件事属于框架 (Broker + 合成器), 不属于任何客户端. 渲染层以后换成纯 Rust 的 UI 也一样.

- **窗口管理**: canvas 表、窗口表、z 序、几何、四种模式、`free` 的 min / max、`fullscreen` 跟 canvas. 客户端只能请求
  `request_move` / `request_resize` / `request_mode` / `request_activate`, 框架裁决; 没有直接改表的接口 (`acde.windows.place` /
  `raise` / `focus` 删掉). 桌面包提供策略 (放在哪、怎么摆) 和视觉; 没有 strut, 面板只是 `pinned` 窗口.
- **焦点**: 每个 canvas 按 z 序和策略 (click-to-focus / follows-mouse + 延迟) 决定活动窗口, 键盘只发给它. 客户端收到
  `activate` / `deactivate`, 不能自己抢. `parent` / `modal` 决定模态组; 菜单是 `pinned` 窗口, 打开时请求 grab. 文本焦点跟
  窗口焦点走, IME 由框架转给 fcitx5, 失焦时撤销 text-input 焦点.
- **外设**: grab 是框架的状态机, 同一时刻一个指针 grab、一个键盘 grab; 来源只有框架自己 (移窗、改大小、菜单) 和客户端请求
  (pointer-constraints / relative-pointer / keyboard-grab / 菜单 grab); 释放条件 (Esc、按下别的窗口、失焦、客户端死) 由框架
  兜底. 全局快捷键是框架持有的注册表: 三级作用域 (session / desktop / app), 先到先得、冲突拒绝, session 级不可覆盖, app 级
  只在它的窗口有焦点时生效; 语义照 `wlr-global-shortcuts`, wire 格式自己定. `inject` 走同一条路由.
- **grab 的现状** (shell `grabs.rs` `InputGrabs`): 客户端 `acde_window.request_grab(kind)`: 这一种已经被别的窗口拿着、或框架
  正在移窗 / 改大小 (指针) 时拒绝, 否则授予 (键盘 grab 同时把焦点给它), 结果是 `grab(granted, kind)`. 指针 grab 期间指针事件都
  发给它 (坐标照旧相对它的窗口); 键盘 grab 期间焦点不动. 收回 (两种一起, `grab_lost` 发一次): 在别的窗口 (或桌面) 上按下 →
  `other_window` (这次按下照常处理); Esc → `esc` (这次 Esc 不发给任何窗口); 焦点被框架给了别的窗口 → `focus_lost`; 客户端
  死掉 → 静默丢掉. `release_grab` 自己交还.
- **模态的现状**: xdg-dialog `set_modal` + xdg_toplevel `set_parent` 记进窗口表 (`set_parent`, 第一次带尺寸的提交时也同步一次).
  框架要把焦点给一个窗口 (点击、`Shell.focus`、`request_activate`) 时, 它有模态子窗口就改给最上面那层模态子窗口 (`modal_child`,
  一层层往下找), 所以父窗口收不到键; 父窗口有焦点时子窗口变成模态, 焦点立刻转过去; 有焦点的子窗口关掉, 焦点回到父窗口
  (再按同样的规则). 指针不拦: 点父窗口照样发给它, 只是键盘焦点不过去.
- **指针约束和抑制快捷键**: 客户端拿着指针 grab 时指针只发给它, pointer-constraints 也只对它生效 (锁定 / 限制都按它的
  surface 算). keyboard-shortcuts-inhibit 一律批准: 有焦点的 surface 有生效的抑制器时, 只有 session 级快捷键还拦 (desktop /
  app 级的组合照常发给窗口); Esc 收回 grab 不受影响.
- **动画中的命中**: 窗口有 look 时, 指针位置按 look 反算回窗口里的坐标 (`Look::unmap`), 命中和发给客户端的坐标都按画出来的位置.
- **快捷键的现状** (crates/model `shortcut.rs`, shell `input.rs`): 组合写成 `ctrl+alt+t` (修饰 ctrl / alt / shift / super,
  键是 xkb keysym 名, 不分大小写); 按未修饰的那层 keysym 匹配 (Shift 要写进组合). 注册: 同一组合已有 session 级, 或新的是
  session 级而组合已被任何作用域占用, 或同作用域已有 (app 级按 owner 区分) → 拒绝 (同一个注册重复交是成功). 匹配顺序:
  session → 有焦点的窗口 (owner = 它的 Broker 窗口 id) 的 app 级 → desktop. 命中的按键 (连同它的松开) 不发给窗口, 发
  `shortcut {window: owner, key: 组合, title: 作用域}`. 窗口关掉时它的 app 级快捷键一起删.

### 进程模型

- 主进程: 合成器线程 + 窗口管理 + 系统接口. **没有 V8, 没有文档, 不跑 web.**
- 窗口属于客户端, 客户端是一个进程; **一个客户端开几个窗口由渲染侧决定**, 框架不管. 例如 web 窗口的客户端里是 V8 + acrender,
  那是渲染侧的事, 与框架无关.
- 客户端是合成器的 Wayland 客户端: `wl_surface` + dmabuf / `wl_shm`, `damage_buffer`, fifo / commit-timing, 指针 / 键盘 /
  data-device, presentation, syncobj. opaque、damage、configure 走标准协议; 模式请求、backdrop、拖拽把手走 `acde_window`.
- 隔离粒度是客户端进程: 它死掉只掉它自己的窗口 (一个客户端多个窗口时一起掉), 合成器和别的客户端不动. 一个客户端一个窗口还是
  一组窗口, 是渲染侧的取舍, 不是框架的规则.

### 协议: `acde_window`

窗口进程是 `xdg_toplevel` 客户端. 只有一种窗口角色: 菜单、面板、桌面都是 toplevel, 谁在上是窗口表的事, 不用 xdg-popup /
layer-shell. 标准协议负责缓冲、`damage_buffer`、`set_opaque_region`、`set_input_region`、configure / ack、`set_parent` /
`set_modal`、激活、指针键盘、data-device、fifo、presentation、syncobj、pointer-constraints、relative-pointer、text-input.
扩展协议只带框架才知道或只能由框架做的事.

**请求** (客户端 → 框架)

| 请求 | 参数 | 语义 |
| --- | --- | --- |
| `request_mode` | `mode` | 请求 `fullscreen` / `free` / `fixed` / `pinned`; 框架裁决, 生效走 `mode` 事件 |
| `set_backdrop` | `rect`, `blur`, `saturate`, `brightness` | `rect` 是窗口本地坐标 (物理像素), 框架映射到屏幕. 这块下面的内容先由呈现层处理, 再画这个窗口; 空 `rect` 取消. 窗口自己的滤镜 (CSS filter 一类) 是渲染侧的事, 不进协议 |
| `set_grab_hint` | `rect`, `edges` | 窗口本地坐标 (逻辑像素). 客户端自己画的标题栏 / 边框; 指针在这里按下时框架开始移动 (`edges` 空) 或改大小 (`edges` 是边 / 角). 多次调用累加, 重叠处后给的优先; 空 `rect` 清掉全部 (窗口改了尺寸先清再重给). 只影响框架的命中, 不改 `set_input_region` |
| `request_grab` | `kind` | 请求指针 / 键盘 grab (菜单这类要独占输入的场景); 框架授予或拒绝, 结果走 `grab` / `grab_lost` |
| `release_grab` | `kind` | 交还自己拿着的 grab; 不再发 `grab_lost` |
| `request_activate` | — | 提到最前并请求键盘焦点; 框架按策略决定 |

**事件** (框架 → 客户端)

| 事件 | 参数 | 语义 |
| --- | --- | --- |
| `mode` | `mode` | 生效的模式 (尺寸仍走 xdg configure) |
| `grab` | `granted`, `kind` | 客户端请求的指针 / 键盘 grab 的结果 |
| `grab_lost` | `reason` | 被框架收回: `esc` / `other_window` / `focus_lost` |

**命名**: 接口就叫 `acde_window`, 名字里不带编号; 这份 spec 不按代编号, 除非用户明确要求.

### 协议: `acde_shell`

Broker 管合成器的私有协议 (`crates/model/protocol/acde-shell.xml`): 合成器起来时建一对 socketpair, 一头作为带 `shell` 标记的
客户端插进 Display, 另一头交给 Broker; `acde_shell` 全局只对这条连接可见 (`can_view`), 别的客户端绑不到. 合成器侧是 shell
`compositor/acde_shell.rs` (请求换成内部的 `Command`, 事件是 `ShellEvent` 类型化发出, Broker 还没绑上时最多攒 256 条, 第一次绑上时补发; 之后再绑上的 (重起的 runtime) 先收一条当前的 `output`),
Broker 侧是 shell `link.rs` (wayland-client, 读线程 `acde-shell-link`), napi `Shell` 的方法和事件对 TS 不变. 窗口 id 是合成器窗口表的 id,
坐标是 canvas 逻辑像素, int 参数 -1 表示没有, 小数走 wl_fixed (1/256).

| 请求 | 对应 `Shell` | 说明 |
| --- | --- | --- |
| `grant` | `grant` | 令牌拆成高低 32 位; `width` / `height` 为 0 是不给 rect, `size_*` 为 0 是不给 size |
| `release` / `focus` / `hide` / `close` / `place` / `raise` / `set_mode` | 同名 | `raise` 的 `above` -1 是最前 |
| `list` → `acde_shell_list` | `windows` / `canvases` | 回 `window` × N、`canvas` × N、`done` |
| `stats` → `acde_shell_stats` | `stats` | 回 `done` (毫秒是 wl_fixed) |
| `screenshot` → `acde_shell_result` | `screenshot` | 回 `done(width, height)` 或 `failed(message)`; 存 PNG 在别的线程, 写完才回 |
| `shortcut` → `acde_shell_result` | `shortcut` | 冲突时 `failed` |
| `unshortcut` | 同名 | |
| `inject_move` / `inject_motion` / `inject_button` / `inject_wheel` / `inject_key` | `inject` | type 在 Broker 侧先解析成枚举 |
| `animate` | `animate` | `given` 位标记给了哪些值 (没给的不变, 没给 easing 用缺省) |
| `launch` → `acde_shell_result` | `launch` | argv、env (key=value) 是以 NUL 结尾的串首尾相接; 合成器起程序 (它的 `WAYLAND_DISPLAY`, 去掉 `DISPLAY`), 回 `done(pid)` |
| `quit` | `quit` | Broker 先停读线程再发, 然后等合成器线程拆完 (同进程时; 分进程时由主进程等) |

事件一种一个: `output`、`window_open`、`window_close`、`window_title`、`window_fullscreen(fullscreen)` (→ `windowfullscreen` /
`windowunfullscreen`)、`window_minimize`、`window_activate`、`window_animated`、`shortcut(owner, key, scope)` (→ `{window: owner, key,
title: scope}`)、`window_gone`、`window_min_size`、`window_parent`、`milestone`、`input_target`; Broker 侧还原成「shell」一节表里的
`Event`. `exit` 不是协议事件: 连接断了 (或 `quit`) 时 Broker 侧自己发.

### 帧、损伤与输入

- 合成器只认缓冲: 句柄 + `damage_buffer` (缓冲坐标) + opaque 区域 + backdrop 区域. 窗口内部怎么画 (`Frame` / `Plane` /
  `Commands`, acrender 的) 不在这里.
- 损伤映射: `rect.loc` + 乘 canvas 的 `scale` → 屏幕损伤, 裁到 canvas; 窗口移动 = 旧位置 ∪ 新位置 (都裁到 canvas; 挪出屏幕或被整块盖住的窗口, 它的旧位置照样算上面 backdrop 的「下面变了」). 输入反过来:
  屏幕坐标除以 `scale`.
- 遮挡: 用不透明的上层剔除下面, `CompositePlan` 只包含最终要画的图层.
- resize: 只有 `free` 收尺寸 configure, 每帧最多一次; `fullscreen` 跟 canvas; `fixed` 只移动不改尺寸; `pinned` 都不变.
  新缓冲到之前把旧缓冲按新尺寸裁 / 留白, 不留黑帧.
- 输入: 单向异步, 合成器不等回包; 同一帧内合并 (pointermove 只留最后一个, 按键不合并); 客户端一个任务里改完状态才 commit
  一次, 一帧最多一块缓冲. 目标 `[测]`: 悬停 / 打字到上屏 ≤ 1 帧, 点击到变化 ≤ 2 帧; IPC 往返 ≤ 0.2 ms, 主要成本是事件
  循环排队.

### 合成与窗口行为

- 每个 canvas 一个 z 列表, 合成裁到 canvas 的 `rect` (就是屏幕).
- 桌面 = 每个 canvas 里 z 最低的 `fullscreen` 窗口; 面板 = `pinned`; 菜单 = `pinned`, 压到最上. "谁在上"只有一种排序规则.
- 动画是声明式 transition `{window, opacity / transform, duration, easing, delay}`, 框架在 vblank 上插值, 完成发事件; 客户端
  不逐帧驱动 (那等于把窗口管理搬回页面, 还多一条每帧的 IPC).
- 放置和焦点策略是声明式: 放置 (cascade / center / tile / 按父窗口偏移) 和焦点 (click-to-focus / follows-mouse + 延迟) 是
  框架内置实现加参数. 桌面包可以挂一个**异步**调整钩子 (窗口打开后、放置前一次机会, 带超时), 超时或失败用默认; 不让框架同步
  回调客户端 —— 它卡住, 窗口管理跟着卡住, 连关窗口都做不到.

### 生命周期与能力

- 合成器先起、建 canvas; 客户端连上来创建窗口挂到 canvas 上, 框架按策略放.
- 客户端死: 销毁窗口、发 `windowclose`、按策略重启 (60 s 内 3 次为限). 桌面客户端死: 屏幕上少一块背景, 别的窗口不受影响;
  框架不画兜底边框 (装饰不是框架的概念). 合成器死: 会话结束.
- 客户端带一个 token, 绑定 (窗口, 应用, capabilities); Broker 的 RPC 按 token 校验; 剪贴板、拖拽载荷、文件读取按
  capability; `inject` 只有 Broker 能给; 拖拽跨进程由框架中转 (data-device), 客户端之间不直接说话.

### 删掉的机制

`Frame.below` / `above` 和壁纸拆分 (`crates/render` `paint_part(Part::Only/Without)`), blitz-paint 的
`Part::All/Without/Only` 和 `SLOT_MARKER` 全透明填充, `<iframe>` 窗口槽位 (文档仍 `skip_iframe_content`), `Shell.bind` /
`bindIn` / `unbind`, `WebWindow.slots` / `holes` / `order`, surface 表里的 `kind` / `role`, layer-shell 的层
(background / bottom / top / overlay), popup 角色, strut, maximize, "装饰是框架或桌面的概念", `Shell.grant` /
`claimSurface` 令牌和 `webnative` 的 surface `pump` / `wait` 的进程内版本 (现在跨进程, 见「组件契约」的 shell)、把 `RenderHandle`
交给 shell 的路径.

### 接口改动 (先改这里, 再动代码)

- `crates/shell`: canvas 表 + 窗口表 + 单一 Wayland 角色 (`xdg_toplevel`) + `acde_window`; 四种模式; 去掉 `RenderHandle` /
  `Frame` / `Part` / slots / role / layer. napi `Shell`: `place(window, x, y, w, h)`、`raise(window, above?)`、
  `setMode(window, mode)`、`windows()`、`canvases()`、`shortcut(combo, scope, owner)` (客户端的请求走 `acde_window`); 去掉
  `bind` / `bindIn` / `unbind`.
- `crates/acdert`: 主进程不再有 `acde-web` 线程和页面的 isolate; 窗口内容由客户端进程提供.
- `acde-host`: 窗口表以合成器为准; 客户端拿到 `windowopen` / `windowclose` / `windowactivate` / 几何变化事件; 系统接口按
  客户端校验; 没有改几何、z 序、焦点的方法.
- 渲染侧 (acrender / web 桌面): 变成普通客户端 —— 桌面是每个 canvas 里 z 最低的 `fullscreen` 窗口, 面板和菜单是 `pinned` 窗口.

### 迁移顺序 (每步都能单独验)

1. 引入 canvas (先只有一个, `rect` = 屏幕) 和窗口表 `id` / `canvas` / `mode` / `rect` / `z` / `content`: 现有 web 窗口先映射成
   `free` 窗口, 内容仍由现在的线程产生.
2. (已做) 把 web 从合成器进程搬出去: 每个 web 一个进程 (渲染侧的选择), 画面直接走 linux-dmabuf; 几何先由合成器默认摆放
   (桌面 fullscreen, 窗口居中 free), 槽位不再决定几何.
3. (已做) 几何和 z 进框架: 合成器按内置策略和 Broker 给的 rect 摆窗口, 叠放和焦点以窗口表为准; 客户端只发请求
   (`acde_window`, xdg move / resize, grab hint); 槽位 (`slots.ts`、`acde.windows.bind` / `unbind` / `focus`) 删掉.
4. (已做) 桌面 / 面板 / 菜单是普通窗口: 桌面是 z 最低的 `fullscreen` 窗口, acde 自己的客户端只有 xdg_toplevel; 第三方的
   xdg_popup (菜单、tooltip) 和 layer-shell surface 照常接受, 在表里是 `pinned` (popup 带父窗口), 画法不变 (popup 在所有窗口
   上面, layer 按自己的层). 装饰一律客户端画 (xdg-decoration / KDE 都回 client-side); maximize 请求不理 (回原样 configure);
   xdg fullscreen 请求 = 表里的 `fullscreen`, 退出时回 `free` 和原来的位置.
5. (已做) 装饰是客户端自己的内容: 一个文档一帧只出一张 `Plane` (画布背景在里面), 删了 `Frame.below` / `above` / `surfaces`、
   壁纸拆分、`<iframe>` 槽位的洞和 `Hit::Surface`, blitz-paint 的 `Part` / `SLOT_MARKER` (acrender 仓库已并进
   `vendors/acrender`, 没有另一份要同步). 窗口里的 backdrop-filter / filter / drop-shadow 在客户端进程里画 (`acde-paint`),
   backdrop 只模糊这个窗口自己已经画好的内容; 要透出下面的窗口走 `acde_window.set_backdrop` (合成器做, 第 6 步).
6. (已做) 后端: `CompositePlan` (遮挡剔除、damage ≤ 8 块、`Route::Direct` 判定)、合成器做的跨窗口 backdrop (GLES Kawase)、
   合成器级 opacity / transform 的 transition (`Shell.animate`)、grab 状态机、全局快捷键注册表 (`Shell.shortcut`)、模态组、
   keyboard-shortcuts-inhibit、动画中的窗口按变换后的位置命中. `Route::Direct` 只计数 (上 plane 由 smithay 判断).
   本机 Xe3 + HDMI 180 Hz 的 DRM 上验过: 出帧 180 fps, 毛玻璃、动画位置和 RDP 一致; 全屏 fps-probe (XRGB, smithay 当整块不透明)
   盖住桌面时计划只剩一层, 每帧都判 `Direct`.

### 验收

每步 `cargo test --release -p acde-render` (`ACDE_PAINT_VERIFY=1` 再跑一遍) 加在真机上起一次会话, 和 fps-probe 比出帧.
用例: 窗口表里只有四种模式, 没有 role / layer / popup; 只挪位置时只有新旧两块脏; `pinned` 窗口盖在 `free` 窗口上; 菜单跨两个
窗口; blur 窗口背后的内容变了只有 blur 区域脏; `kill -9` 一个客户端, 合成器和别的客户端不动, 它自己的窗口全掉 (`windowclose`
照发); 输入到上屏
的延迟有测量; `fixed` 窗口能移动但收不到尺寸 configure, `pinned` 位置和尺寸都不能变; `fullscreen` 窗口跟 canvas 改尺寸;
窗口一半在 canvas 外时外面那半不画, 损伤也不超出 canvas; 两个 canvas 的 z 序和焦点互不影响; 系统接口里没有改几何 / z / 焦点
的方法; 模态打开时父窗口收不到按键、关掉恢复; Esc 和点别的窗口释放 grab; 同一个快捷键第二次注册被拒.

### 待定 (只在分层上)

`Sync` 用哪套 (syncobj acquire point / dma-fence fd / 隐式同步) 和过期怎么处理; 呈现层的能力协商什么时候做 (plane 数、格式、
修饰符、能不能直扫), 做不出来谁降级; 软件回退时客户端光栅和 CPU 合成怎么分工、谁等谁; 一个窗口的内容跨 canvas 时缓冲要不要
重出.

### 要量的 `[测]`

输入到上屏的延迟分布 (IPC + 事件循环排队), 4K 下 N 个窗口的损伤合并与遮挡剔除成本, backdrop 每帧多一次采样 / 模糊的成本,
`Route::Direct` 在实际会话里命中多少次.

## 宿主: crates/acdert (V8, 不用 Node)

acdert 是一个 Rust 可执行文件, 内嵌 V8 (rusty_v8, crate `v8`); 页面的 DOM 只有 Blitz 那一份.

- **系统接口**: runtime / shell 的 `#[napi]` 导出原样链接进 acde, 只在 Broker 的 isolate 里注册 (crates/acde-napi 用
  rusty_v8 实现 Node-API 的 C 接口, 见「目录」). web 的 isolate 里没有 napi: 它的 surface (shell)、输入法 (runtime 的 `Ime`)
  和后端连接 (runtime 的 `UnixClient`) 由 crates/acdert `webnative.rs` / `backend.rs` 直接绑给 JS, web 结束时一起放掉.
- **事件循环**: 每个 isolate 一个 (crates/acdert `rt.rs`): 定时器、别的线程发来的任务、V8 平台任务 (延迟的也在这里排,
  不另起线程). 每个任务结束时跑 microtask 和 after-task 钩子 (web 在这里 flush canvas、present WebGPU、提交文档); V8 自己的
  任务不算页面的任务, 钩子在循环下次等之前补一次. 事件不轮询: shell 的事件队列从空变成非空时直接给那个 isolate 的循环发任务
  (web: `surface.wait()` 落定; Broker: `Shell.onEvents`), 空闲的 web 不醒.
- **DOM**: 节点树、属性、文字、表单状态都在 render 的 Blitz 文档里. JS 侧 (web/packages/acde-dom) 是按需创建的
  包装对象和浏览器算法 (事件派发、MutationObserver、Range ...), 经 `DomNative` (acde-dom `src/native.ts`, 契约)
  直接读写文档. 文档由一把锁保护, JS 线程每个调用拿一次 (建节点的拿两次: 建, 再 pin); render 线程出帧时拿.
  JS 改了文档而这个任务还没结束 (还没 `commit()`) 时 render 线程不出帧, 滚动和动画也停; 卡住的任务没写过文档时照常滚动、跑动画.
- **节点生命周期**: 连在文档上的节点一直活着; 断开的子树里有 JS 包装对象 (pin) 就活着, 没有就由 Rust 释放.
  建节点的函数 (createElement、clone、parseInert ...) 交出的节点由 crates/acdert 的绑定 pin 住、包装对象随即建好; `describe` 交出的
  由 render 自己 pin.
  包装对象: 连着的节点强引用, 断开的变成 WeakRef, FinalizationRegistry 回收时 unpin (acde-dom `realm.ts`).
- **页面**: ES 模块由 V8 直接编译链接 (crates/acdert 的模块加载器): 同源资源, 以及 `file:` URL (直接读盘).
- **服务**: 跑在 Broker isolate 里, 只用 `ServiceContext` 和 Web 标准接口, 不能 import `node:`.

## 桌面包

桌面包是一个目录, `package.json` 里有 `acde` 字段 (类型见「web/packages/acde-api」, `@dopame/acde-api`):

```json
"acde": {
  "desktops": [{ "id": "dopame", "name": "Dopame", "entry": "dist/ui/desktop/index.html", "services": ["assistant"] }],
  "apps": [{ "id": "term", "label": "终端", "icon": "terminal", "entry": "/ui/terminal/term.js", "capabilities": { "terminal": true } }],
  "assets": { "/ui/": ["dist/ui"] },
  "services": [{ "name": "assistant", "module": "dist/services/assistant.js" }]
}
```

- **desktops**: 桌面. `entry` 是包里的 HTML 文件, 由 desktop web 加载, 满屏, 在所有窗口后面. 用前端三件套写就行;
  系统能力从 `acde:` 模块导入 (`acde:fs`, `acde:windows`, `acde:apps`, `acde:desktops` …; 桌面全都有). `heapMb`: desktop web 的
  V8 堆上限 (默认 1024, 最小 32).
- **apps**: 应用. `entry` 是同源 URL, 指向一个默认导出 `WindowApp` 的模块; `capabilities` 决定它能导入哪些 `acde:` 模块.
- **assets**: 同源 URL 前缀 → 包里的目录. 页面和应用的脚本、样式、图片都从这里来.
- **services**: 在主线程 (Broker) 跑的 ES 模块, 默认导出 `ServiceFactory`. 桌面启动时启动 (默认包里全部, 或桌面的
  `services` 列出的), 桌面结束时关闭; 它返回的命名空间挂在 `acde.<名字>` 上, 应用要在 capabilities 里写上服务名才能调.
  桌面自己的重活 (原生程序、模型、子进程) 放进它自己的进程: `ctx.spawn(argv, {cwd, env, onLine, onExit})` (acde-api
  `ServiceProcess`: `write` 写 stdin, `end` 关掉 stdin, `kill` 给它的进程组发信号). 和应用后端一样由 crates/acdert `child.rs` 起
  (自己的会话和进程组, acde 死了它收到 SIGTERM, 环境只有 `env` 给的); stdout 逐行交给 `onLine` (没给就进日志), stderr 逐行进
  acde 的日志, 前缀 `[<服务名>]`. 服务关闭 (`close` 返回之后) 时 Broker 给它起的、还活着的进程组发 SIGTERM, 3 秒后 SIGKILL;
  要收尾的进程在 `close` 里先 `end` 再等它退出. 例: acde-dopame 的总管和小弟是它自己的 Rust 程序, assistant 服务这样起它.

acdert 依次在这些地方找包: acde-host 自己 (只有品牌资源, 没有桌面), `ACDE_PATH` (冒号分隔的包目录),
`$XDG_DATA_HOME/acde/packages/*`, `$XDG_DATA_DIRS/acde/packages/*` (默认 `/usr/local/share:/usr/share`). 同一个 id 先到先得.

除了包里的桌面, acde 还列出不是 acde 的 Wayland 会话 (外部会话, `src/foreign.ts`): `$XDG_DATA_DIRS/wayland-sessions/*.desktop`
(默认 `/usr/local/share:/usr/share`, 同名文件先到先得), id 是 `session:<文件名去掉 .desktop>`, 例如 KDE Plasma 的
`plasma.desktop` 是 `session:plasma`; 显示的名字去掉 "(Wayland)", DesktopNames 是 KDE 的前面加上 KDE
("Plasma (Wayland)" 显示成 "KDE Plasma"). 不列: acde 自己的 (`acde.desktop`、`acde-*.desktop`、`acdert.desktop`、`acdert-*.desktop`、Exec 跑的是 `acde` 或 `acdert`)、
`Hidden=true` / `NoDisplay=true`、TryExec 或 Exec 的程序找不到的. Exec 按 Desktop Entry 规范拆参数, 去掉 `%f` 一类的字段码.
`acdert desktops` 也列出它们, `acdert sessions` 不给它们写会话项.

选桌面只在登录页上 (见下面「登录页」), 没有单独的选择器页面, 登录之后不再问. 启动哪个桌面: `acdert --desktop <id|包目录>`
(登录页就这样起), 否则 `ACDE_DESKTOP`, 否则上次进的 (`$XDG_STATE_HOME/acde/desktop`: 自己会话里起了哪个 acde 桌面就记哪个,
`--greeter` 和 `acdert app` / `acdert desktop` 不记), 否则第一个装了的 acde 桌面, 否则第一个外部会话, 都没有就报错退出. `acdert app <id>`
不算外部会话, 一个桌面也没有时用一个空的 (`Packages.bare`, id `window`, 没有服务). 桌面可以通过
`acde.desktops.choose(id, remember)` 换桌面: Broker 关掉当前桌面和它的服务, 启动新的; `remember` 写状态文件 (KDE 也行, 下次直接交出去).
改了名的桌面 (`Packages.RENAMED`, 现在只有 `dopamine` → `dopame`): 这三处给旧 id 都先找新 id (没装新的才认旧的),
记住的是旧 id 而找到的是新桌面时把状态文件改写成新 id;
起这个桌面时新的页面存储 (`$XDG_CONFIG_HOME/acde/storage/dopame.json`) 不在而旧的 (`dopamine.json`) 在, 就把旧文件改名过去 (只搬文件,
里面的键由桌面包自己迁).

交出会话: 选的是外部会话时 (`choose`, 或启动时按上面的规则选中它), acde 把要跑的命令写进交接文件
`$XDG_RUNTIME_DIR/acde/exec` (没有就 `/run/user/<uid>/acde/exec`; 第一行是逐个单引号引起来的 argv, 之后每行一个
`NAME=value`: `XDG_CURRENT_DESKTOP` (DesktopNames 用 `:` 连起来)、`XDG_SESSION_DESKTOP` (第一个 DesktopNames)、
`XDG_SESSION_TYPE=wayland`、`DESKTOP_SESSION` (文件名)), 然后退出码 3 结束 (运行中: 像注销一样结束, 停掉会话起的程序,
合成器撤掉导出的环境变量; 启动时: 不起 Broker 和合成器, 写完就退). 会话入口 `/usr/bin/acdert` 读这个文件, 在同一个登录会话里
`exec` 它 (见「packaging/arch」). 直接跑 `acde` (开发) 时没人接, 只是退出码 3.

登录页 (`acdert --greeter`, greetd 的 greeter, acde-host `greet/`): 一页里选账户、选桌面、输密码, 登录就进那个桌面.
桌面是 greeter 能看到的所有桌面 (`acde.desktops.list()`, 不含登录页自己; 只有系统装的包和 `ACDE_PATH`, 用户自己
`$XDG_DATA_HOME` 下的包 greeter 看不到), 只有一个时不显示这一栏. greetd 的 `start_session`: acde 桌面是
`/usr/bin/acdert --desktop <id>`, 外部会话直接是它的 Exec 加上「交出会话」那四个环境变量 (不经 acde). 每个账户上次登录的桌面由
Broker 在登录成功后同步写进 `$XDG_STATE_HOME/acde/greeter.json` (`{用户名: 桌面 id}`; 不用页面的 localStorage: 登录后 web 被
SIGKILL, 延迟写盘的会丢), `acde.greeter.users()` 每项带 `desktop`; 没记过的用列表第一个 (acde 桌面在外部会话前面). greeter 用户
没有 home (`/`), 会话入口给 `--greeter` 把 `XDG_STATE_HOME` / `XDG_CACHE_HOME` 指到 `/var/lib/acde/greeter` (tmpfiles.d 建, 归
greeter; fontconfig 的缓存也在这里), 写不了只打 warn. 自动登录 (greetd `initial_session`) 不经登录页, 按上面的规则选.
别的显示管理器: acdert 装一个 `acdert.desktop` (上次的桌面, 否则第一个), 桌面包为它的每个桌面装
`acdert-<id>.desktop` (`Exec=acdert --desktop <id>`), 用 `acdert sessions <目录> --package <包目录>` 生成.

## 看和操作桌面 (`acde:inspect`)

给 agent (Dopame 的总管) 用的: 不截图, 把屏幕变成一棵文字的语义树 (照 Android 的无障碍树 / Playwright 的 aria snapshot), agent 按
ref 点击、输入、按键. 只有桌面 (`acde.inspect`) 和桌面包的服务 (`ServiceContext.inspect`) 拿得到; 网页接口不动.

- **网页的树** (render `Dom::semantics(root, limit)`, `crates/render/src/dom/semantics.rs`, JS `DomNative.semantics`): 拿一次文档锁,
  resolve 之后在 Rust 里走一遍, 出 JSON. 每个节点 `{id, role, name?, value?, states?, level?, rect, more?, children?}`, id 是 render 的节点 id
  (不复用, 所以 ref 跨多次查看稳定), rect 是 CSS 像素. 角色: `role` 属性优先 (`presentation` / `none` 不算), 否则按标签 (a[href] → link,
  input 按 type, select → combobox, h1-6 → heading, ul/ol → list …), 都没有但 `cursor: pointer` (父元素不是) 的是 `clickable`
  (React 的事件在根上, 看不出谁有 onClick). 名字: aria-label, aria-labelledby, `<label>` / placeholder (表单), alt, svg 的 `<title>`, 按钮
  / 链接 / 标题这类用里面的文字 (没有文字用子孙的 aria-label / alt / title), 最后 title; 最多 120 字. 值: 输入框 (密码是 `•••`)、
  select 选中的项、aria-valuenow / valuetext. 状态: focused (body / html 不算), checked, mixed, selected, expanded / collapsed,
  disabled, pressed, current, readonly, modal, scrollable. 剪掉: `display: none`, `visibility` 不是 visible, 透明度 0, aria-hidden,
  inert, script / style / iframe 和 acde-host 的窗框; 落在视口或滚动容器裁剪外的整棵子树 (数进 `hidden`); 没有角色、名字、状态的
  元素展开成它的子节点, 没有名字也没有子节点的非交互元素不出; 每个父节点最多 60 个子节点 (`more`), 全树最多 limit 个 (默认 600,
  `truncated`). 文字节点用所在元素的 id, 相邻的合成一行.
- **web 侧** (`pageinspect.ts`, rpc 服务 `inspect`): `tree`, `point(id)` (元素可点的一点: 不在视口里先 `scrollIntoView` 居中, 在中心和
  四个四分点上 `hitTest`, 命中它或它的子孙才算; 全被挡住时报挡住它的元素), `type(id, text, replace)` (focus 之后走输入法提交的那条路
  `Host.insertText`, 和用户打字一样发 beforeinput / input; replace 先全选), `focus(id)`.
- **Broker** (`inspect.ts`, `Broker.inspect`): 窗口表来自 `Shell.windows()` (桌面的面板算桌面的一部分, 不单列), 窗口的 ref 是
  `w0` (桌面) 和 `w1`、`w2` … (第一次看到时发, 会话内不变), 元素是 `w3.12`. `snapshot({window?, ref?, all?, diff?, limit?, find?, tree?})` →
  `{text, windows, trees}`: text 先列窗口 (上面的在前: 类型、应用、标题、焦点 / 最小化 / 模式; 位置和尺寸只在 `windows` 里), 再列有焦点的窗口 (或指定的
  窗口 / 子树, `all` 是所有可见窗口) 的树 (`tree: false` 只列窗口); `find` 在所有可见窗口 (或指定的) 里找名字或值含这段文字的元素 (不分大小写,
  最多查 3000 个节点), 只给它们 (连同子节点) 和到它们的祖先, 不记进 diff 的基准, 一行一个节点 `- button "新建文件夹" [pressed] [w1.52]`, 输入框带 `: "值"`; rect 只在
  `trees` 里, 文字里不给. 每个窗口 (子树) 记着上次给出的行; `diff` 时只给变了的行 (`+` 新的、`~` 改了的、`-` 没了的, 按 ref 和角色
  对), 窗口表没变只写一句, 变的行超过六成时整个重列. `act(ref, action, arg)` 回 `{ok, text}`: 做完等页面安静 (web `settle`: 文档 200 ms 没有 DOM 变化, 最多 3 秒; 原生窗口固定
  0.4 秒; 关窗口等 0.4 秒), 这期间 Broker 里新起、还没映射的 web 窗口再等它出现 (最多 5 秒); 窗口表或焦点变了 (开了新
  窗口) 先等新的焦点窗口安静, 给它的变化, 否则给那个窗口的变化. `run(steps)` 是一串 `{ref, action, text}` 依次做 (每步之间等安静),
  某步失败就停, 最后只看一次变化. 动作: click / double / right / hover / scroll (arg 是像素, 默认 400) 按 `point`
  算出的屏幕坐标经 `Shell.inject` 发 (点是一次性的, 没有动画); 那一点被更上面的窗口盖住时先把目标窗口提到最前, 目标是桌面就报被谁
  挡住. type / settext 走 web 的 `type`; key (arg 像 `"ctrl+a backspace"`, 空格分开依次按, `+` 是组合, 名字见 `keys.ts` 的 `keyCode`)
  先 focus 再经 `Shell.inject` 按. 窗口的 ref 能 focus / restore / minimize / close / key. `open(name)`: 按 id、名字找 acde 应用, 再找
  原生程序 (`natives`), 起它, 等窗口表变了 (最多 5 秒) 再等焦点窗口安静, 回整份快照.
- **原生窗口** (runtime `src/atspi.rs`, napi `Accessibility`): 读 AT-SPI2. 自己的会话起服务时 (`startServices`) 打开: 把会话总线上
  `org.a11y.Status.IsEnabled` 设成 true, 连上无障碍总线; 没有 at-spi 时打一行 warn, 原生窗口只有标题. GTK3 (atk-bridge) 不管开关都上报;
  Qt 要开关为 true (或 `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`), 而且只在真的显示平台 (wayland / xcb) 上报, `QT_QPA_PLATFORM=offscreen`
  没有树; 开关打开之前起的 Qt 程序要重开. `tree(pid, title, limit)` 按窗口的 pid 找应用, 按标题挑它的顶层窗口, 角色规范成上面的
  ARIA 风格, rect 是 GetExtents 的窗口坐标 (Broker 加上窗口位置; 客户端画装饰的 GTK 窗口里有没有阴影边距没验过). 状态: 好几个节点同时报
  focused (Qt 的 focus proxy: 状态栏按钮跟着编辑区报) 而其中有可编辑的, 只留可编辑的那个; disabled 只标在控件和可聚焦 / 可编辑的节点上
  (Qt 给所有节点挂 Action). 先试应用的 `Cache.GetItems`, 不行逐个节点并发查 (GTK3 和 Qt 实际都走了逐个查, 原因没查). 没有名字的容器
  (panel、split-pane、filler …) Broker 展开掉, 有动作的非按钮节点带 `clickable`; ref 是 Broker 按 (bus name, object path) 发的序号.
  `act`: click 先试 AT-SPI 的 Action (click / press / activate …), 没有再按坐标点; type / settext 用 EditableText; focus 用
  Component.GrabFocus. 检查 `crates/runtime/tests/atspi-check.sh` (私有会话总线 + at-spi; GTK3 跑在 broadway 上, Qt 跑在
  `kwin_wayland --virtual` 上): tree / click / focus / type / settext / limit / 出错, GTK3 13 个节点 1.6 ms, Qt Quick 6 个节点 1.0 ms.
  在 acde 会话里用 KWrite (Qt Widgets) 验过: 树 35 ms, 点 "New File" 和输入都生效. GTK4、Chromium / Electron、Firefox 没验过.
- **量过的** (.169, RDP 后端, Dopame 桌面): 整个桌面的树 888 字, 6 ms; 文件窗口 689 字, 3 ms; 一次 act (含等 0.4 秒和看变化) 约 420 ms.

## 默认应用

文件和文件夹用谁打开 (web/packages/acde-host `src/open.ts`, runtime `src/bus.rs`). 一个入口 `Opener.open(路径或 URI, {app?, select?})`, 四条路进来:
桌面和有 `openFiles` 能力的应用调 `acde.openPath` (桌面在 `acde.apps` 上), 会话总线上的 `org.freedesktop.FileManager1`
(浏览器下载的「在文件夹中显示」、编辑器的 reveal: `ShowFolders` / `ShowItems` / `ShowItemProperties`), acde 自己的
`org.dopame.Acde1.Open(as uris, s app)` (`acdert open [--app <id>] <路径|URI>...` 调它; 没有会话时退出码 3),
以及原生程序的 xdg-open / gio open (经下面装的 desktop entry 又回到 `acdert open`).

- **选应用**: 类型先按路径定 (文件夹 `inode/directory`; 文件先问 `gio info`, 再 `file --mime-type`, 再按扩展名; 链接是
  `x-scheme-handler/<scheme>`), 再按 XDG MIME Applications 规范读 mimeapps.list (每个目录先读 `acde-mimeapps.list`:
  `$XDG_CONFIG_HOME`, `$XDG_CONFIG_DIRS`, `$XDG_DATA_HOME/applications`, `$XDG_DATA_DIRS/applications`), 第一个装了的
  `[Default Applications]` 项就是它; `acde-<app>.desktop` 指 acde 应用 `<app>`. 没有设过的, 用清单 `mimeTypes` 里写了这个类型的
  第一个 acde 应用 (写全名的先于 `type/*`), 再没有就用第一个写了它的原生程序. `app` 给了就用它 (acde 应用的 id, 或原生程序的
  `foo.desktop`).
- **交给应用**: acde 应用收到 `request` (和应用间 `acde.open` 同一个事件); 窗口提到最前、最小化了的也显示: 桌面收到
  `windowshow {window}` (只有这条路发; 页面自己 `apps.open` / `launch` 不发).
  有 `fs` 能力的应用拿 Finder 的位置 `{root, path, file}` (`fs.locate` 算; 文件管理器显示一个文件时 `path` 是它所在的文件夹,
  `file` 是要选中的名字), 没有的拿 `{url}` (file:// 或链接). 不在任何 Finder 根里的文件, 交给能打开它的原生程序, 没有就报
  `outside_roots`. 原生程序用 `gio launch <它的 desktop entry> <路径>` 起.
- **Finder 的根** (runtime `fs/workspace.rs`): 桌面文件夹、「下载」(`XDG_DOWNLOAD_DIR`, 否则 `~/Downloads`, 存在时: 下载完
  「在文件夹中显示」总得能打开)、`~/agentos-work` (存在时). 最后看的位置记在
  `$XDG_STATE_HOME/acde/finder-place.json`, 下次会话从那里开始.
- **改默认**: `acde.setDefault(mime, 应用)` 写 `$XDG_CONFIG_HOME/acde-mimeapps.list` 的 `[Default Applications]` (别的组和行留着).
  只在 `XDG_CURRENT_DESKTOP=acde` 下生效, 不动 KDE 那边的设置. `acde.handlers(路径)` 列出能打开它的应用 (acde 的在前), 标出默认的.
- **装给别的程序看**: `acdert applications <目录> [--package <包目录>] [--exec acde]` 给每个有 `mimeTypes` 的应用写
  `acde-<app>.desktop` (`Exec=acdert open --app <app> %U`, `NoDisplay=true`, `OnlyShowIn=acde;`; 通配符不写进 MimeType) 和包的
  `acde-mimeapps.list` (每个类型给第一个写了它的应用). 桌面包装进 `/usr/share/applications`.
- **总线上的名字**只在自己的会话里拿 (`ACDE_BUS_NAMES=1/0` 强制; 嵌套跑时 FileManager1 是外面桌面的); 两个名字都允许被替换,
  后起的会话拿走. 不装 D-Bus activation 文件: 没有会话时不该为了打开一个文件夹起一个 acde.

## desktop web / window web

每个 web (一个 `acde web` 进程) 有自己的 DOM、CSS、JS 堆、render 文档 (线程) 和合成器 surface; 相互之间、和系统之间只通过 `acde`
调用, 由 Broker 按应用清单检查.

- **渲染**: 每个 web 是一个进程, 一个 xdg_toplevel. 它自己光栅化 (crates/paint, 三块轮转的 GBM 画布), 画完经
  linux-dmabuf 交给合成器, 合成器和原生窗口一样合成. 窗口 id 和原生窗口同一个空间 (桌面 0, web 窗口从 `1<<20` 起, Broker 发).
  桌面是 canvas 里 z 最低的 `fullscreen` 窗口; 别的 web 窗口先是居中的 `free` 窗口 (尺寸是清单的 `size`, 默认 800x600, 不超过屏幕), 叠放以窗口表为准.
- **输入**: 标准 Wayland: 合成器按窗口表的 z 找到指针下的窗口发 wl_pointer / wl_keyboard, web 进程 (crates/window) 转成
  shell 事件进队列; 滚轮的默认滚动和 :hover 在它自己的 render 线程上. 拖放和剪贴板走 data-device. pointermove 和浏览器一样
  对齐到帧 (acde-host `host.ts`): 只留最新的一个, 下一个 `frame` 或别的事件来之前才派发 (连同命中测试), 鼠标回报率再高, 页面每帧
  也只处理一次移动.
- **窗口管理** (合成器内置的策略, Broker 可以用 `Shell.place` / `raise` / `setMode` 改): 新窗口居中, 按窗口数错开 32 像素; 应用的窗口记得位置 (Broker `src/places.ts`): 窗口关掉时合成器发 `windowgone`, Broker 按应用 id 记下它最后的 rect (全屏的记进全屏之前的那块; 会话结束时开着的窗口也记) 到 `$XDG_STATE_HOME/acde/windows.json` (`ACDE_STORAGE` 为空时只在内存), 这个应用下次打开、又没有别的窗口开着时用 `grant` 的 `rect` 摆回去 (尺寸不超过屏幕; 露出屏幕不到 48 像素或标题栏在屏幕上沿之外时照旧居中);
  有父窗口的居中在父窗口上方; 原生窗口在第一次带尺寸的提交时摆. 点进一个窗口: 它拿到焦点并提到它那一层的最前 (桌面不动;
  `pinned` 永远在 `free` / `fixed` 上面). 模式由框架裁决: 只有 `free` 改尺寸 (`Shell.place` 对 `fixed` 只挪位置, `pinned`
  只有 Broker 能摆 (桌面的面板, 见下), 对 `fullscreen` 不理); `fullscreen` 铺满 canvas. 客户端只能请求: `acde_window.request_mode` / `request_activate`, xdg 的
  `move` / `resize` (客户端自己画的标题栏), 或 `set_grab_hint`: 指针在 hint 里按下由框架开始移动 (edges 空) 或改尺寸, 这次按下
  不发给客户端. 页面里是 `acde.window.requestMode` / `setGrabHint` / `requestActivate`. 隐藏 (最小化) 是框架状态 (`Shell.hide(window, hidden)`):
  隐藏的窗口不画、不命中、不拿焦点 (藏起有焦点的窗口时焦点给剩下最上面的), 留在窗口表和 z 列表里, 显示时拿焦点; `windows()` 带 `hidden`.
  只有桌面能隐藏 / 显示 / 提到最前 (`acde.windows.hide` / `show` / `focus`); 应用的 `acde.window.minimize` 只是给桌面发
  `windowminimize`, 由桌面决定. 从应用外面打开到某个窗口 (`windowshow`) 时 Broker 先显示它、给它焦点. 隐藏后丢弃还没有.
- **窗框** (acde-host `src/frame.ts`): 应用窗口默认由 acde-host 在窗口 web 里画一条标题栏, 应用不用改代码 (React、Vue、
  任何编译成 html/js/css 的页面一样). 它是挂在 `<html>` 下 (不在 `<body>` 里) 的 `<acde-frame>`, 样式全是内联 `all: initial` 加
  `!important`, 应用的 CSS 和 `body.innerHTML = ''` 碰不到; 被删掉或 `<html>` 的 style 被改掉时补回去. `<html>` 加上
  `padding-top` (标题栏高 32 px) 和 `box-sizing: border-box; height: 100%`, 所以 `height: 100%` 的布局照常; `100vh` 仍是整个窗口,
  会比内容区多 32 px. 标题是 `document.title` (HTML 入口) 或 `acde.window.setTitle`, 没有时用清单的 `label`; 左边关闭、最小化 (`acde.window.minimize`,
  由桌面决定藏不藏) 和全屏 (`requestMode` 在 `fullscreen` 和 `free` 之间切). 拖动和改大小不经 JS: 标题栏
  (按钮以外) 和四边四角是 `setGrabHint`, 窗口尺寸变了先清掉再重给. 清单 `frame: false` 的应用自己画 (自己调 `setGrabHint`),
  不加这条.
- **钉住的面板** (桌面的 Dock、菜单栏、下拉菜单、弹出层): desktop web 的页面调 `acde.desktop.pin(element, {margin?})`
  (返回 `{update(), unpin()}`), 这个元素和它的子树就成了一个单独的 `pinned` 窗口, 在所有 `free` / `fixed` 窗口上面; 状态、
  事件、React 树都还在同一个文档里, 页面不用改结构. 链路: acde-host `src/pinned.ts` 量元素的 `getBoundingClientRect` (加
  `margin`, 并上 render 报的实际绘制范围, 裁到屏幕), 找 Broker 要令牌 (`panel.open(rect)` → `Shell.grant({mode: 'pinned', rect})`,
  只有桌面能调), 同一个 web 进程的 Wayland 连接再开一个 toplevel (crates/window `panel.rs`, `surface.openPanel`), 再告诉 render
  这个元素是面板 (`Dom::set_panel`). render 照常录整页, 展开片段时跳过面板元素的引用 (blitz-paint `flatten`), 把它单独展开平移到
  面板原点, 帧里多一个 `Panel {id, size, plane, extent}`; 同一个光栅化任务把主窗口和各面板画进各自的画布 (crates/paint `Painter`
  按 plane 分画布). 主窗口里那块变成「挪走了」, 损伤照常算. 面板的输入区域只是元素自己的盒子 (`wl_surface.set_input_region`),
  面板矩形里其余透明的地方点下去落到下面的窗口; 指针坐标加上面板原点送回同一个文档. 几个 surface 合起来算激活: 主窗口或任一面板
  有焦点就是 `activate` (点菜单栏不让页面 `blur`, 点到应用窗口才 `blur`). 元素挪了、改了大小或 `hidden` / `style` / `class`
  变了 (ResizeObserver; MutationObserver 看元素和它所有祖先, 变化后 700 ms 再补量一次, 等 CSS 过渡停下) 时重新量, 经 `panel.place` 挪窗口 (`Shell.place`); CSS 过渡和动画这类观察不到的,
  由 render 报: 面板画出去 (`extent` 超出面板) 时 window 线程发 `panelmove` (带文档坐标的绘制范围), 页面把面板矩形并上它
  (只增不减, 元素藏起来时清掉; 这个事件在绘制范围每次变化、而且超出面板时都发). 元素量不到 (断开、宽高为 0) 时面板
  `Shell.hide`, render 照旧单独画它; 在屏幕外的照样开 / 挪到那里 (窗口可以在 canvas 外); pinned 窗口重新显示不抢焦点. 元素算出来
  `pointer-events: none`、`visibility: hidden` 或透明度为 0 时输入区域为空, 点击穿过去 (Dopame 开机时的菜单栏). 面板里的
  backdrop-filter 转成这个面板的 `set_backdrop` (取最大的那块), 由合成器模糊它下面的窗口. 要求: 元素自己是 stacking context
  (定位加 z-index、transform 等; 不是也行, render 把它当成片段边界, 换面板集合时清一次绘制缓存), 不带祖先的裁剪和透明度.
- **帧**: `requestFrame` 之后, 上一帧画完交出去就给下一帧 (光栅化定节奏, 不等合成器 vblank; 动画同样), 但两帧之间至少隔
  输出刷新周期的 0.9 倍 (取最快那块输出当前模式的刷新率, wl_output 报的; 没有刷新率时不限), 页面没出新帧时
  退回 wl_surface 的 frame 回调; `ACDE_WEB_FPS` 指定时用它. stress 窗口 (每帧重画) 约 900 帧/s.
- **通信**: 只有 `acde:` 模块. 每个 web 的能力是 Broker 按它的清单给的代理 (`remote.ts` 的 `RemoteBridge`), `define` 把每个
  能力登记成内置模块 `acde:<名字>` (HostNative `defineModule`, crates/acdert `modules.rs` 用 V8 的合成模块提供, 导出 `{<名字>, default}`;
  没登记的 `acde:` 导入解析时就失败); 页面没有 `acde` 全局. **事件不派到 `window` 上**: 宿主的通知都进 `remote.ts` 的 `Notices`
  (每个 web 一个, 挂在 `WindowList` 上), 页面经模块上的 `on(类型, 处理函数)` 订阅, 返回退订函数, 处理函数收原来事件里的
  对象: `acde:windows` 的 `on('open' | 'close' | 'title' | 'fullscreen' | 'unfullscreen' | 'minimize' | 'activate' | 'menus' | 'parent' |
  'crash' | 'hang' | 'show' | …)` (shell 的窗口事件去掉 `window` 前缀), `acde:apps` 的 `on('changed')` (桌面), `acde:desktop` 的
  `on('download' | 'notification' | 'screenshot' | 'shortcut')`, `acde:window` 的 `on('shortcut')` 和原有的 `request` 等;
  别的类型 `on` 直接抛 TypeError. 本文件里的 `acde.<名字>.<方法>` 是简写, 指 `acde:<名字>` 模块导出的值. 调用经
  web 和 Broker 之间的进程内通道 (V8 结构化克隆的字节) 到 Broker (`rpc.ts`: 返回值、抛出的错误原样回来, 回调函数可以跨: 终端输出这类).
  ⚠ 这是现状, 不是设计: `acde:` 模块应当在 web 进程里直接注入、直接调原生实现, 见第一原则; 这条 RPC 是要收回的债.
  - window web: 清单里有的服务 (`acde.fs`、`acde.terminal` …), `acde.window` (标题、菜单、关闭、最小化、`on` 事件:
    `beforeclose` 返回 false 留住窗口、`request` 别的应用 `acde.open(<id>, {…})` 要它打开什么 (要那个应用清单的 `open`
    允许 `<id>`; 窗口就是为一个请求开的时, 那个请求交给第一个 `request` 处理函数, 在 `mount` 之后才加的也收得到, 只给一次:
    `WindowSelf` 的 `#opening`; 窗口开着、还没有处理函数时来的请求也先存在这里, 交给下一个注册的)、`activate` / `deactivate`
    (`suspend` / `resume` 在类型里, 但没有丢弃, 不会发);
    各事件处理函数的签名是 acde-api `AcdeWindow.on` 的重载;
    对框架的请求 `requestMode(mode)`、`setGrabHint(rect, edges?)`、`setBackdrop(rect | null, effect?)`、`requestActivate()`、
    `requestGrab(kind)` / `releaseGrab(kind)` (结果是 `grab {kind, granted}` / `grablost {reason}` 事件)、app 级快捷键
    `shortcut(combo)` / `unshortcut(combo)` (按下时 `acde:window` 的 `on('shortcut', ({key}) => …)`), 见
    「窗口管理」), `acde.open(app, request)` (要清单的 `open` 允许), `acde.windows` 只管它自己起的原生程序 (`launch` 带 `slot: true`:
    归这个 web, 它关时一起关; 要清单的 `slots`).
  - desktop web: 全部服务、`acde.apps` (`list` / `launch` / `open`; `natives()` / `runNative(id)` 见下面「原生应用」)、`acde.windows` (所有窗口; 加 `kill`、`invokeMenu`、`stats`、
    `focus(id)` / `hide(id)` / `show(id)` (提到最前并给焦点 / 隐藏 / 显示, 见「窗口管理」), `animate(id, options)` (同 `Shell.animate`)、`shortcut(combo, scope?)` / `unshortcut` (session / desktop 级, 默认 desktop))、
    `acde.session`、`acde.inspect` (「看和操作桌面」). 窗口的生命周期事件 (`windowopen` 等) 由 Broker 转给它, web 窗口的带 `web: true`; Broker 另发
    `windowmenus` (应用的菜单, 动作留在应用里, 桌面点了用 `invokeMenu` 让应用执行)、`windowready`、`windowcrash {reason}`、
    `windowhang` / `windowresponsive`、`windowshow` (从应用外面在它里面打开了文件或文件夹, 「默认应用」: 提到最前, 最小化了的显示出来).
  - 不在清单里的调用被拒绝 (403, `forbidden`); 同步要答案的 (`assistant.status()`、`session.own()`) 是 web 启动时的值.
- **原生应用** (acde-host `src/launcher.ts`): `acde.apps.natives()` 列出装了的原生程序, 给桌面的启动器和 Dock 用: `$XDG_DATA_DIRS/applications`
  (含 `$XDG_DATA_HOME`, 同名先到先得) 里的 `.desktop`, 去掉 `Hidden` / `NoDisplay` / `Terminal=true`、`OnlyShowIn` 没有 (或 `NotShowIn`
  有) `XDG_CURRENT_DESKTOP` 的、TryExec 或 Exec 的程序找不到的、acde 自己的 `acde-*.desktop`; 按名字排序. 每项
  `{id (文件名), name, comment (GenericName, 否则 Comment), icon, keywords, wmClass (StartupWMClass)}`, 文字按会话语言取.
  `icon` 是图标文件的绝对路径 (页面用 `file://` 加载), 找不到是空串: `Icon` 是绝对路径就用它, 否则按 hicolor、breeze、Adwaita、
  AdwaitaLegacy 的顺序读主题的 `index.theme` (`~/.icons`, `$XDG_DATA_DIRS/icons`), 取 Context 是 Applications / Legacy、
  Scale 为 1、Size 至少 32 的目录 (不要 symbolic), 大的在前; 先在这些目录和 `$XDG_DATA_DIRS/pixmaps` 里找 `<名字>.svg`, 没有再找
  png. 结果缓存到某个 applications 目录的 mtime 变了 (装卸软件) 为止 (ac 上 30 个应用首次约 20 ms). `runNative(id)` 用
  `gio launch <文件>` 起它, 返回 pid; 它的窗口照常经 `windowopen` 来, `appId` 一般是 id 去掉 `.desktop` 或 wmClass.
  两个都只有桌面能调.
- **应用清单**: 包的 `package.json` 里 `acde.apps` (类型 acde-api `manifest.d.ts`, 解析 acde-host `apps.ts`): `id`、`label`、`icon`、
  `entry` (默认导出 `WindowApp` 的模块, 或 HTML, 见「网页应用」)、`capabilities` (fs [可限 roots]、terminal、office、launch、
  slots、open、openFiles、session、desktops (`acde:session` / `acde:desktops`, 本来只给桌面; 系统设置这类应用要), 其余的键是服务名,
  如 `assistant`)、`mimeTypes` (「默认应用」)、`heapMb` (默认 256, 最小 32)、`size` (窗口的默认尺寸 `[宽, 高]`, 逻辑像素, 默认 800x600)、
  `multiple`、`frame` (默认 true: acde-host 画标题栏, 见「窗框」)、`backend`. acdert 自己不带应用 (只有登录页一个桌面); 应用都来自桌面包 (acde-dopame) 或第三方包.
- **沙箱**: 每个 web 是独立的 V8 isolate, 页面和 web 的宿主代码 (acde-host 的 web.js) 在同一个 realm 里, 拿到的只有裁剪过的
  `acde`. ⚠ 这不是安全边界: 页面碰得到宿主给 web 的原生接口: `sys` (整个 acde 进程的环境变量、读写文件、`spawn` / `run` / `kill`)、
  它的 surface、输入法, 还能 import `file:` 模块. 每个 web 是自己的进程 (环境只有 Broker 给的那些, 会话结束随 PDEATHSIG 一起走),
  崩溃、卡死、堆超限都只影响它自己; 系统调用级的沙箱 (Landlock / seccomp) 还没加.
- **内存**: web 的 V8 堆上限是清单的 `heapMb` (应用默认 256, 桌面默认 1024), 超了只停这一个 web: 窗口的, 桌面收到
  `windowcrash {reason: 'memory'}`; 桌面的, 按下面「生命周期」重新起. render 文档自己的上限 (图片缓存等) 照旧. 隐藏的窗口不出帧、画布放掉. 隐藏久了丢弃 (停掉 web, 再显示时重新起) 还没有.
- **生命周期**: 启动 → 运行 ⇄ 隐藏 → 关闭: 先问应用 (`beforeclose`, 3 秒不答就关), 再停 web 的线程、放掉 surface;
  它起的原生窗口一起关. web 的进程自己停了 (堆超限、加载时抛错) 是崩溃: 桌面在窗框里说明, 可以重新打开.
  无响应: Broker 读每个 web 循环当前任务跑了多久 (`busyMs`, 不靠心跳), 超过 5 秒报 `windowhang`, 回到循环报 `windowresponsive`;
  桌面可以强制关 (`kill`). desktop web 自己停了 Broker 重新起它 (一分钟最多 3 次), 窗口照常.
- **调试**: `acdert app <id>` 只跑一个应用 (Broker 直接起它, `fullscreen`, 桌面只是底色); 每个 web 有名字 (`files#1048576`, 也是它
  事件循环的名字, `perf::task` 日志带它), 报错带名字 (`acde: [files#1048576] page error: …` / `uncaught: …`); 运行中的会话用 `ACDE_DEBUG_DIR`
  (「web/packages/acde-host」) 和 `packaging/qemu/drive.sh` 驱动和测量. 没有自动验收; 无显示器时用 `ACDE_BACKEND=rdp` 起整个会话.

## 网页应用 (SDK, 清单, 应用后端)

acdert 是运行时 (像 workerd): 开发者的工具是 acde 仓库的 CLI `acde` (像 wrangler: `acde new / check / build / install / dev`,
`acde.config.jsonc`、框架识别、模板、后端的 listen preload 都在那边). 本仓库对外只发 SDK `@dopame/acde-api` (类型, `load`,
Vite 插件, 清单校验, 见「web/packages/acde-api」), acde 依赖它. 原来的 acde-sdk 仓库照 multiproc 分支写的 `intercept`
(外设劫持) 在 split-window 上没有, 没带过来 (按第一原则, 这类能力以后只经 `acde:` 模块提供, 不再加 `acde:*` 窗口事件).

- **校验只有一份**: `web/packages/acde-api/src/validate.ts` (`@dopame/acde-api/manifest`, TypeScript 源码, 给 bun 和打包工具) 的
  `Manifest` —— `Manifest.app` 是 Broker 读应用清单用的同一段 (acde-host `apps.ts` / `packages.ts` 导入, 打进 broker.js),
  `Manifest.check` 再加上只有工具 (acde 的 `check` / `build`) 才查的: 资源目录在不在、`entry` / `backend.entry` 落不落在某个 assets 前缀的目录里、id 重复、heapMb 太小、不认识的 capability
  (警告: 得有同名的桌面服务).

普通网页应用 (`index.html` + 任意框架 + 可选的后端) 不改代码就是 acde 的窗口应用. 页面由 acdert 的 V8 和 render 跑
(没有浏览器); 后端是 acdert 起的 bun 进程 (任意 Bun / Node 框架: Hono, Express, Fastify …).
都不开端口: 后端的 listen 换成 unix socket, 往外连 (它当客户端) 照常.

- **开发**: 工程、构建和 `acde dev` 是 acde 仓库的事 (见它的 AGENTS.md). 运行时只认构建出来的包: 清单 `package.json`、
  `web/`、`backend/server.js` 和它旁边的 `backend/acde-listen.js` (acde 的 `src/listen.ts` 打包: 把每个 `listen(P)` 换成
  `<sockets>/P.sock`, 下面「后端」用它).
- **清单**: 应用的 `entry` 可以是 HTML (窗口 web 把它当文档加载), 或以 `/` 结尾 (文档由后端渲染: 窗口 web 在页面装好后端
  传输之后 `fetch(init.url)` 取 HTML, 取不到时画一页错误; 换页同样按地址重新取; acde-host `page.ts` `PageSource.served`);
  `backend: { entry, port? }` (默认 3000).
- **脚本**: classic `<script>` (含 `src`, 先读本地资源, 没有就经后端取; 没有 `async` 的按文档顺序执行, 都在 DOMContentLoaded 之前)、
  `type="module"` 和 `type="importmap"` (acde-dom `dom/page.ts`). import map 由 crates/acdert `modules.rs` 在解析模块说明符时用:
  `imports` 和 `scopes`, 精确匹配或以 `/` 结尾的前缀匹配, 键是 URL 时按解析后的 URL 匹配; 多个 import map 合并, 先到的键优先.
- **浏览器接口 → 窗口** (acde-host `src/webapp.ts`, `pagecalls.ts`, `downloads.ts`; acde-dom `dom/picker.ts`):
  HTML 入口的文档地址是 `http://acde.local/` (应用目录同时挂在 `/` 下, BrowserRouter 不用 basename);
  `document.title` 是窗口标题; `window.close()` / `location.reload()` 关闭 / 重启这个 web, 之前先发 `beforeunload`
  (取消就留下); `localStorage` 每个应用一个文件 (`$XDG_CONFIG_HOME/acde/storage/app-<id>.json`); `alert` 画在窗口里
  (`confirm` / `prompt` 不阻塞, 返回 false / null); 链接: `#frag` 滚动, 同应用的页面换页, 外部 http(s) 交给浏览器应用,
  `<a download>` / blob: / data: 存进下载目录, 桌面经 `acde:desktop` 的 `on('download')` 收到; `<input type=file>` / `showOpenFilePicker` /
  `showSaveFilePicker` 走 xdg-desktop-portal 的 FileChooser (runtime `portal.rs`); `Notification` 转给桌面
  (`acde:desktop` 的 `on('notification')`); 窗口隐藏 / 显示是 `visibilitychange`; `navigator.language` 跟会话的语言; `screen.width` / `height` (和 `avail*`) 是主输出的逻辑尺寸 (Broker 放进 init 的 `screen`, 输出变了发 `{type: 'screen'}`), `innerWidth` 才是窗口自己的. 声音: `Audio` /
  `AudioContext` 由 crates/acdert 经 PipeWire 播放 (acde-dom `src/audio/`). 还没有: indexedDB, Web Worker, `crypto.subtle`,
  OffscreenCanvas / createImageBitmap, 全屏和指针锁定, 页面直接联网 (经后端取), `:target`.
- **后端**: acde-host `src/backend.ts` 起 `bun --preload acde-listen.js server.js`, 应用第一个窗口打开时起, 最后一个窗口关掉和
  会话结束时停 (SIGTERM 给它的进程组, 3 秒后 SIGKILL), 一分钟内第 4 次崩溃后不再起 (到它的窗口都关掉为止). 进程由
  crates/acdert `child.rs` (`sys.spawn`) 起: 自己的会话和进程组; 环境从零建 (ACDE_APP_ID、ACDE_APP_DATA、ACDE_APP_SOCKETS、
  PORT、NODE_ENV=production, 加上会话的 HOME、USER、PATH、LANG、LANGUAGE、TZ、XDG_RUNTIME_DIR); 工作目录是数据目录
  `$XDG_DATA_HOME/acde/apps/<id>/`; 输出逐行进 acde 的 stderr, 前缀 `[<app>#backend]`; acde 退出或崩溃时收到 SIGTERM
  (`PR_SET_PDEATHSIG`; 它跟的是 fork 的那个线程, 所以所有子进程都由一条常驻的 `acde-fork` 线程 fork, web 停了不连累
  它起的进程). 网络和主机一样, 不另开命名空间: 作为客户端往外连 (外网、局域网、本机的服务, 连接时内核给的临时端口) 都照常;
  作为服务端, preload 把每个 listen 换成 unix socket, 指定端口的 UDP bind 和在现成的 fd / handle 上 listen 直接拒绝 (`EACCES`).
  preload 管不到的 (原生扩展, 它起的子进程) 开的端口是真端口, 没有兜底, 应用不要用带原生扩展的包.
  socket 目录 `$XDG_RUNTIME_DIR/acde/apps/<id>/` (0700), 起之前和停之后删掉其中的 socket.
  后端能读写用户能读写的所有文件. 构建时没有 `acde-listen.js` 的旧包不起, 要重新 `acde build`.
- **路由**: 窗口里的 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` 发往同源非资源的路径或 `localhost:<port>` 时,
  由窗口自己的线程发起 (crates/acdert `backend.rs` 绑的 `natives.backend`, runtime `unixhttp.rs` 的 `UnixClient`; 连接的 I/O 在
  runtime 的 `acde-rt` 线程上, 事件是这个 web 事件循环的任务), 不经 Broker. 页面只给端口, socket 目录是 Broker 在 init 里给的
  (`init.sockets`), 只能连自己应用的 socket; socket 还没出现 (后端在起) 或拒绝连接时重试 10 秒. 别的地址照旧不联网.
- **语音输入**: runtime 的 `Voice` (`src/voice/`), 桌面包的服务拿去给页面的输入框用. `listen(onEvent)` 返回 id: 从 PipeWire 的默认
  输入设备录音 (节点 `acde.voice`, 16 kHz 单声道 s16, PipeWire 负责重采样), 同时连豆包输入法的流式识别 (非官方接口, 和
  vinput-registry 的 doubaoime provider 同一套协议: 第一次用时匿名注册一个设备 (`log.snssdk.com`, ttEncrypt), 身份存在
  `$XDG_STATE_HOME/acde/doubao-ime.json` (0600); 识别走 WebSocket `frontier-audio-ime-ws.doubao.com`, protobuf 包 JSON, 音频直接发
  PCM, 10 ms 一个包, 连上之前录到的先攒着). 事件: `{type: 'partial', text}` (到目前为止的全文, 变了才发), 结束时恰好一个
  `{type: 'final', text}` (没听清时 text 为空) 或 `{type: 'error', message}`. `stop(id)` 停止录音, 发完剩下的音频, 等定稿 (最多 10 秒);
  录满 60 秒自动停. 新的 `listen` 取消上一个 (被取消的不再发事件). 没有麦克风时用 PipeWire 的虚拟源验: `pactl load-module
  module-pipe-source source_name=vt file=/tmp/vt.fifo format=s16le rate=16000 channels=1`, 带 `PIPEWIRE_NODE=vt` 起 acde, 按实时速度
  往 fifo 里写 PCM (一次写完会被一口气读掉).
  日志 (target `acde_runtime::voice`, 每次录音一个编号 `语音 #N`): 开始、停止 (或停的时候它已经结束了)、被新的录音取消、识别服务
  连上用了多久、麦克风的 PipeWire 流每次状态变化 (从 Streaming 掉到 Paused / Unconnected 或出错记 warn: 声卡掉线、被拔或被占)、
  超过 1 秒没送来音频、录满自动停, 结束时一行: 识别出几个字 / 取消 / 出错的说明, 加上用时和收到了几秒音频. 识别出的文字不进日志.

## 组件契约

各组件只按这里的接口对接; 改接口先在本文件里改, 再通知相关的人.

### render (`crates/render`, Rust 接口, 没有 napi 导出)

- `Document::new(width, height, scale, &Options {base_url, resources: [Resource {prefix, dirs}], default_lang, verify_paint, svg_text_path, reduced_motion, dark, name})`:
  尺寸是物理像素, scale 是 hidpi 缩放. base_url 默认 `http://acde.local/`; 同源资源按 resources 最长前缀匹配, 在 dirs 里依次找;
  `file:` 直接读盘; 不联网, 读不到的资源回空内容. 读和解码在调用的线程上同步做 (拿着文档锁).
  `Document` 只发句柄: `dom()` (JS 线程), `handle()` (web 进程的 `acde-window` 线程); 另有 `scene()` / `sync()` 给测试.
  crates/acdert 建文档时只传 resources、reduced_motion、dark 和 name (web 的名字, 只用在日志里); `Dom::set_reduced_motion` 可以事后改.
- 线程: 文档由 JS 线程和专用的 `acde-render` 线程共用 (一把锁, BaseDocument 不是 Send); `acde-window` 线程只往命令队列里放命令.
- DOM: `Dom` 是 acde-dom 的 `DomNative` (契约 `web/packages/acde-dom/src/native.ts`, 每个函数一个同名的 snake_case 方法),
  crates/acdert 的 V8 绑定在 JS 线程上直接调. 节点 id 是 u32, 不复用, `<html>` 是 0; 查询是 CSS 像素; 出错的说明以 DOMException 的名字开头.
  改了文档、还没 `Dom::commit` 时 render 线程不出帧; 这期间来的指针和滚动先存着, commit 时按原顺序放回队列最前面 (不对着改到
  一半的 DOM resolve 和算 :hover). pin 是标记, 不计数. `Dom::hit_test` (Blitz 的 `element_from_point`)
  返回节点 id; `<iframe>` 只是一个空盒子 (`skip_iframe_content`), 和别的元素一样.
- 光标与文字 (CSS 像素, 偏移是 UTF-16): `Dom::caret_rect(id, offset)` (给输入法候选框定位)、`caret_from_point(x, y)`、`text_rects(node, start, end)`.
- 出帧 (物理像素): `RenderHandle {tick(now_ms), frame() → Option<Frame>, scroll_at, pointer, commit, invalidate, set_waker}`.
  `set_waker` 装上时已经有没取走的帧 (第一帧可能在合成器装 waker 之前就出了), 马上叫一次.
  CSS 动画和过渡的时钟是单调的墙上时间, tick 只把它对齐到 vblank 的时间 (不往回走).
  `Frame {plane, panels, size, animating, commit, trace}`: trace 见「日志和计时」; plane 是整页 (含画布背景), 不含钉住的元素;
  `panels` 是 `Dom::set_panel(id, Some([x, y, w, h]))` (CSS 像素) 钉住的元素, 每个 `Panel {id, size, plane, extent}`: plane 平移到面板
  原点、损伤按面板自己算 (逐条比), extent 是画到的范围 (面板坐标, 不裁).
  `Plane {commands, tolerance, layers, damage, damage_rects, bounds}` (`scene_for(rect)` 取一块区域的场景, `scene()` 整层, 测试用): damage_rects 最多 8 块变化区域 (可能相互重叠; damage 是它们的并集,
  宽高为 0 表示没有变化); bounds 是画到的范围, None 表示什么都不画. layers: 有 backdrop-filter / filter 时
  scene 按它们切成的段 (从下到上), 为空时直接画 scene. 每段 Layer {scene, bounds, backdrop, filter}:
  有 backdrop 时, 光栅化方先把画布上 backdrop.bounds (圆角 radius(), 再和 clip 求交) 里已画好的内容按 blur() / saturate() / brightness()
  处理, 再画这一段; 有 filter 时, 这一段先画进临时纹理, 做滤镜后再合成. 坐标都是物理像素.
  (`crates/paint` 现状: backdrop 的 blur / saturate / brightness, filter 的 drop-shadow、模糊和颜色矩阵在 GPU 上做; 其他滤镜效果忽略,
  照常画.)
- `Dom::capture(id, scale)`: 单独录一个元素的子树 (拖动图标), 返回画出来的内容的包围盒 (x/y/width/height, CSS px)、
  pixel_width/pixel_height、实际缩放 scale 和放好位置的 `scene` (像素坐标, 不光栅化); 不带祖先的 transform/opacity/裁剪, 单边超过
  2048 像素时缩小, 什么都没画时返回 None. JS 拿到的是 `picture` 编号 (crates/acdert `dom.rs` `keep_picture` / `take_picture`, 每个 web 只留最后一个),
  `startDrag` 的图标带它时 web 进程的光栅化线程把这个 scene 画进一块 GBM dmabuf (crates/paint `Painter::icon`), 经 linux-dmabuf
  交给合成器当拖动图标; 不带 `picture` 时用 `rgba` (Dopame 自己画的文件图标, 当图片画进 dmabuf). `Capture::pixels()` 在 GPU 上画完
  读回, 只给测试用.
- canvas 2D 要像素的地方都在 GPU 上 (render `gpu.rs`): 用 web 进程光栅化线程的同一个 wgpu 设备 (crates/paint 发布 `Gpu` 时
  `gpu::install`; 光栅化线程起来之前 `gpu::expect`, 之后要设备的调用最多等 10 秒; 两样都没有时 (测试) 自己开一个非 CPU 的设备),
  在上面跑一个离屏的 vello (`Mutex` 里, 头一次用时建). flatten (命令超过上限)、canvas 当图片源 (drawImage / createPattern) 画进一张
  纹理 (`CanvasImage`, 和 WebGPU canvas 同一个类型), scene 里引用它, 光栅化线程按 blob id 把它换成那张纹理 (`Overrides`), 不读回;
  `putImageData` 先画成纹理再 `write_texture` 写进那块; `shadowBlur` 把形状画进纹理, 再用 compute shader (`blur.wgsl`, 两遍可分离
  高斯, 顺带上色) 做成阴影纹理; `getImageData` / `toDataURL` 画完同步读回 (标准接口要同步的像素, 浏览器也是这样). 提交都拿
  `Shared::submit_lock` (和光栅化线程挂信号量的那段互斥).
- 选项 default_lang (BCP 47, 默认 zh-Hans): 没有 lang 属性的内容按这个语言选 CJK 字体变体 (zh-Hans → SC,
  zh-Hant → TC, zh-HK → HK, ja → JP, ko → KR); 元素上的 lang 优先.
- 所有入口都有 catch_unwind, panic 时调用返回 Err 或丢掉这一帧.
- 增量录制 (见 vendors/acrender 的 blitz-paint 表): 只重录变了的片段. 片段的命令放在 `Arc` 里, 一帧 (`Commands`, `commands.rs`)
  是片段外画的几条命令加上一串片段切片 (片段, 范围, 放置变换), 不拷贝; 损坏、切层、按区域取场景都在切片上走, 变换现算;
  命令只在光栅化某块区域时 (`scene_for`) 才拷贝并放置. `verify_paint` (crates/acdert 里
  只能用环境变量 `ACDE_PAINT_VERIFY=1` 打开): 每帧再整页录一次逐条比对, 不一致时打日志并用整页结果, `paint_mismatches` 计数;
  测试和验收用, 产品里不开.
- 长时间运行: 解码后的图片缓存最多 256 张 / 64MB (正在用的不受影响), 同一个 @font-face 只注册一次. JS 的 `stats()` 有
  nodes / images / imageBytes / mallocBytes, Rust 的 `Stats` 另有字体数; 字体字节、SVG 缓存、样式表的数只在 blitz 的 `MemoryStats` 里, 没拿出来.
- 开了 blitz-paint 的 `scrollbars` (overlay 滚动条, 滚动后淡入) 和 blitz-dom 的 `floats` (CSS float).
- 选项 reduced_motion: `@media (prefers-reduced-motion: reduce)` 成立 (createDocument 的 `reducedMotion`, 来自 web 的 init).
- 选项 dark: stylo 设备的配色是深色, `@media (prefers-color-scheme: dark)` 成立 (createDocument 的 `dark`, 来自 web 的 init);
  `Dom::set_dark(on)` (JS `setDark`) 事后改配色, 变了才重新算样式, 和 `set_reduced_motion` 一样要 commit. 会话的配色怎么来见
  「web/packages/acde-host」的配色.
- `<iframe>` 不渲染内容, 见下面「iframe 策略」. Blitz 文档开 `skip_iframe_content`: 不取 src / srcdoc、不建子文档.

### shell (`crates/shell`, napi 类 `Shell`)

shell 是完整的 Wayland 合成器 (smithay), 跑在**自己的线程**上 (calloop), 不受 JS 卡顿影响; 每个 web 是其中的 surface,
原生窗口和它们一起合成. 上机用 DRM/KMS + libinput, 无显示器用 RDP 后端 (`ACDE_BACKEND=rdp`, 见「web/packages/acde-host」).

- 协议: xdg-shell、xdg-dialog、keyboard-shortcuts-inhibit、xdg-decoration 和 KDE server-decoration (都回 client-side: 装饰是客户端的内容)、`acde_window`、linux-dmabuf v4、wl_drm、
  linux-drm-syncobj、wp_presentation、fifo / commit-timing、viewporter、fractional-scale、pointer-constraints + relative-pointer、
  pointer-gestures、data-device + primary-selection、xdg-activation、cursor-shape (按形状名从 xcursor 主题取图, 没有的画箭头; 指针在窗口的改大小 grab hint 上时合成器画对应方向的双向箭头, 合成器移窗时画 grabbing、改大小时画那个方向的箭头, 盖过客户端设的光标)、single-pixel-buffer、
  wlr-layer-shell、ext-session-lock、idle-notify / idle-inhibit、text-input-v3 + input-method-v2 + virtual-keyboard、xdg-output.
  没有 Xwayland, 不接 X11 程序.
- Broker 侧 (napi `Shell`): `Shell.broker()` 建合成器 (没有桌面文档). `onEvents(cb)` 在队列从空变非空时叫醒 Broker, `pump()` 取事件.
  `grant({desktop?, window?})` → `{window, token}`: 给 web 进程的令牌 (随机 64 位, 只认领一次: 客户端在 `acde_window.bind` 里交回,
  合成器把那个 toplevel 登记成这个窗口); desktop 为真是桌面 (窗口 0, fullscreen, z 最低), window 是已有的 web 窗口 (换进程),
  都不给是新 web 窗口 (`size` [w, h] 是它居中摆放时的尺寸, 默认 800x600); 带 `rect` ([x, y, w, h]) 的是摆在那里的窗口 (`mode` 另给, 默认 `free`; 桌面的面板给 `pinned`, 不抢焦点). `release(window)` 作废它没用掉的令牌; `place` / `raise` / `setMode` / `windows` / `canvases` 见「窗口模型」
  (`windows()` 每行另有 `window`: 绑定过 `acde_window` 的窗口的 Broker 窗口 id, 和 `pid`: Wayland 客户端的进程号); `animate(window, {opacity?, scale?, dx?, dy?,
  duration? (毫秒, 默认 200), delay?, easing? (linear / ease / ease-in / ease-out / ease-in-out, 默认 ease)})`: 从现在的 look
  过渡到给的值 (没给的不变), 每帧插值, 做完发 `windowanimated`; 回到单位阵的窗口不再记 look; `shortcut(combo, scope, owner)` /
  `unshortcut(...)` 见「平台职责」, 冲突时 `shortcut` 抛错;
  `focus`, `hide(window, hidden)`, `close`, `quit` (停掉合成器, 等它的线程拆完 EGL / GBM 再返回, 最多 3 秒:
  进程随后 `exit`, Mesa 的 atexit 清理和合成器线程同时释放会把堆弄坏); `socketName` (子进程的
  `WAYLAND_DISPLAY`); `launch(argv, {cwd, env})` (去掉 `DISPLAY`, 返回 pid); `stats(reset?)`;
  `screenshot(path)` (主输出离屏画一遍存 PNG); `inject(...)` (见下). 令牌是 Shell 里的一张表 (不是指针).
- web 侧: natives 的 `claimSurface(token)` (crates/acdert `webnative.rs` → crates/window `Surface::claim`: 连上合成器, 开 toplevel,
  `acde_window.bind(token)`, 等到窗口 id; 一条 `acde-window` 线程负责 Wayland 和光栅化) 给出这个 web 的 surface:
  `pump`、`wait()` (队列非空时落定, 不占线程, 空闲时不醒)、`requestFrame`、`setClipboard`、`readClipboard(): Promise<string>`、
  `startDrag(data, icon?)`、`window`. 文档的提交走 `Dom::commit`, 不走 surface.
- 事件 (坐标是逻辑像素, button / code 是 evdev 码):

| 事件 | 给谁 | 说明 |
| --- | --- | --- |
| `pointermove` / `pointerdown` / `pointerup` / `wheel` `{x, y, button, deltaX, deltaY}` | web surface | web 进程从 wl_pointer 转来 (crates/window) |
| `keydown` / `keyup` `{code, key}` | web surface | web 进程从 wl_keyboard 转来 (xkb 的修饰后字符) |
| `activate` / `deactivate` | web surface | xdg_toplevel 的 activated 状态变了 |
| `frame {time}` | web surface | 见上面「帧」 |
| `resize {width, height, scale, software}` | web surface | configure 给的尺寸 (物理像素) 和 fractional-scale; software: 它的光栅化在 CPU 上 |
| `dndenter {x, y, mime}` / `dndmove` / `dndleave` / `dnddrop {x, y, data}` | 指针下的 web surface | 原生程序 (或别的 web) 拖进来; data 是 类型 → 文本, 松手时 shell 已经读好 (smithay 等不到 JS) |
| `dragend {button}` | 发起拖动的 web | 1: 放到了原生窗口或别的 web 上 (不要再处理这次放下), 0: 没有 |
| `output {width, height, scale}` | Broker | 主输出 |
| `windowopen` / `windowclose` / `windowtitle {window, title, appId}` | Broker | 原生窗口的生命周期; `windowopen` 带上客户端映射前已经设好的 title / app_id, 之后任一个变了发 `windowtitle` |
| `windowfullscreen` / `windowunfullscreen` | Broker | 窗口的模式变成 / 不再是 `fullscreen` (xdg 全屏请求、`acde_window.request_mode`、`Shell.setMode`, 桌面除外); 全屏铺满 canvas, 进全屏前的位置和尺寸记着, 退出时放回 |
| `windowminimize` | Broker | 应用的请求, 桌面决定怎么办 (没有 maximize: 框架只有四种模式) |
| `windowactivate {window}` | Broker | 用户点进了一个窗口的内容 (原生或 web), 每次按下都发; 桌面把窗框提前, 不要再回调 focus |
| `windowanimated {window}` | Broker → 桌面 | `animate` 的过渡做完 |
| `shortcut {window, key, title}` | Broker → owner | 注册的快捷键按下了; app 级给那个窗口的 web, 别的给桌面; 页面里是 `acde:window` / `acde:desktop` 的 `on('shortcut')` |
| `grab {key, code}` / `grablost {title}` | web surface | `acde_window` 的 grab 结果 (key 是种类, code 1 是授予) / 被收回 (title 是原因); 页面里是 `acde.window.on('grab' / 'grablost')` |
| `windowgone {window, x, y, width, height}` | Broker | 绑定过 `acde_window` 的窗口 (web) 没了, 带它最后的 rect (canvas 坐标; 全屏的是进全屏之前的, `pinned` 不发); 给「窗口管理」记位置 |
| `windowminsize {window, width, height}` | Broker | 窗框不能比它小 |
| `windowparent {window, parent}` | Broker | 对话框等子窗口: 显示在父窗口上方, 不进 Dock; parent 为空表示不再是子窗口 |
| `milestone {title, time}` | Broker | 合成器的启动里程碑, 各一次 (第一帧提交、第一次 vblank、第一个原生窗口) |
| `inputtarget {window, x, y, button}` | Broker | 设了 `ACDE_DEBUG_INPUT` 时每次按下; window 0 是桌面 web |
| `exit` | Broker | 合成器退出 |

- 注入输入 `inject({type, x, y, button, dx, dy, source, code})`: type 是 `move` (绝对) / `motion` (相对, 像真鼠标, 锁鼠标时
  指针不动) / `down` / `up` / `wheel` / `keydown` / `keyup`; wheel 的 source 是 `wheel` / `finger` (dx dy 都为 0 表示手指离开) /
  `continuous`. 和真实输入同一条路由, 只在合成器内部, 不碰真实设备. 给验收和 agent 操作原生应用用.
- 第一帧网页等 JS 第一次 commit 才上屏 (可以先建 Shell 再加载页面). HiDPI: 输出的缩放默认是整数, 按显示器 EDID 的物理宽度算 DPI, 取 `floor(DPI / 96 + 0.3)` (1 到 3; 没有物理尺寸时, 例如 RDP 后端, 是 1; 27 寸 4K 是 2), `ACDE_SCALE` 指定时用它 (可以是分数). 启动时每块输出打一行 `输出 <名字>: <分辨率> 物理 <宽>x<高> mm 缩放 <s> 位置 <x, y>`,
  多块输出按逻辑宽度 (分辨率除以缩放) 从左往右排. 光标一律合成进画面, 不用 DRM 光标平面 (`render_frame` 不给
  `ALLOW_CURSOR_PLANE_SCANOUT`): 带 T2 的 Intel Mac 上 2 倍缩放时, 走光标平面的光标只能走屏幕左上 1/4; 改成合成之后在
  那台 Mac 上验过, 光标走满全屏 (Xe3 + 4K HDMI 上 `ACDE_SCALE=2` 也一样). 其他环境变量: `ACDE_SOCKET`
  (Wayland socket 名), `ACDE_RENDER_NODE`,
  调试用的 `ACDE_WEB_FULL` (每帧整张重画) / `ACDE_WEB_POLL` (不用信号量, 轮询) / `ACDE_SCANOUT=0` (DRM 上不把客户端缓冲直接放到主平面或叠加平面, 全部合成; 平面分配变了时打一行 info `平面 <输出>: …`, 查闪烁用). 日志见「日志和计时」.

### GPU 与性能 (硬约束)

acde 是原生桌面, 性能按原生桌面要求: **整条链路不允许 CPU 拷像素、不允许 GPU 回读**. 例外: RDP 后端 (每帧回读损坏区域)、
截屏、标准接口要同步给像素的 (canvas 的 `getImageData` / `toDataURL`, 见「组件契约」的 render).

**网页只在 GPU 上画, 不支持 CPU 光栅化** (用户定, 2026-11-02): 没有 vello_cpu, CPU 类型的 Vulkan 设备 (lavapipe) 不认. 没有 GPU
(虚拟机的 virtio-gpu 没有 3D、nomodeset) 时网页图层不可用 (日志 `网页图层不可用: 没有 GPU (Vulkan)`), 页面不出帧. 合成器自己 (GLES)
不在此列.

- 原生应用 (OpenGL / GLES / Vulkan, 例如 Minecraft): 客户端在 GPU 上渲染, 经 linux-dmabuf v4 (带 feedback) 零拷贝交给合成器
  (旧 EGL 客户端走 wl_drm); 全屏且格式/修饰符合适时直接扫描输出 (上 DRM plane), 否则用 GPU 合成.
  每个 surface 有 pre-commit 钩子 (`handlers.rs` `block_until_ready`): 客户端给了 syncobj 的 acquire point 就等它, 否则等
  dmabuf 的读 fence, 客户端的帧画完才生效. 现状的缺口: wp_presentation 的时间是处理 vblank 事件时的 `now`, 不是硬件时间戳;
  没有 tearing-control 和 VRR.
- 网页图层: 在 web 进程里, Blitz 由 vello 在 GPU (wgpu, Vulkan) 上画进画布 (crates/paint, 光栅化线程 `acde-web`). 画布是 web
  进程自己 GBM 分配的 dmabuf (linear), 经 linux-dmabuf 交给合成器 (viewporter 裁掉对齐用的边, 也做分数缩放), Vulkan 信号量
  导出的 sync_file 落定后才 commit; 合成器还拿着的画布不画; 不经 CPU. 只重画脏区域, 页面没变化时不重画. 选中的设备写在日志 (`网页图层用 ...`).
- 光栅化调度: 每个 web 进程一条光栅化线程 (`acde-web`), 一次一帧: 上一帧交出去 (sync_file) 之前不开始下一帧, 编码前只等
  两个任务之前的那次提交 (等它导出的 sync_file, 不在 wgpu 里等), CPU 编码和 GPU 执行重叠. 挪窗口时内容不重新光栅化, 只换位置. 闲 2 秒放掉中间纹理.
- 叠放: 只看窗口表的 z (见「窗口管理」); 网页窗口和原生窗口一样是一块缓冲. web 窗口里的 backdrop-filter 只模糊它自己窗口里
  已经画的内容 (跨窗口的毛玻璃是 `acde_window.set_backdrop`, 合成器做).
- 网页的帧预算: 120fps 下每帧 8ms, 输入到上屏延迟和原生应用同级. JS 侧每个 DOM 调用的开销用 acde-dom `test/cost.test.ts`
  和 `test/caches.test.ts` 盯 (原生调用次数); 运行时的数: shell `stats(reset?)` (合成的 `frames` 和 p50 / p95 / max, `plans` / `direct`; 网页光栅化的计时在
  web 进程的 `perf::raster` 日志里) 和 DomNative
  `stats(reset?)` (resolve、出帧、`frameLocked` 只算出帧里 paint 那段); `drive.sh perf` 用它们和各线程的 CPU 量一段操作.
  提交里写测到的数.
- 网页里的 WebGPU (`navigator.gpu`, `<canvas>` 的 `webgpu` 上下文): acde-dom `src/gpu/` 经 `GpuNative` 调 crates/acdert `webgpu/`,
  跑在这个 web 进程光栅化线程的那个 wgpu 设备上 (crates/paint `gpu.rs`, 提交都经 `Gpu::submit`). canvas 纹理光栅化线程直接当
  图片画, 不经 CPU; 每个任务结束时 present. 一个 GPUDevice 只是错误和 `destroy()` 的范围. 网页图层不可用时页面拿不到 adapter.
  map 和 `onSubmittedWorkDone` 的回调由 `acde-gpu-poll` 线程非阻塞地轮询 (有在等的回调时, 队列没空 0.5 ms 一次, 空了 4 ms 一次):
  wgpu 的 `poll(Wait)` 等 GPU 的整段时间都拿着设备的 snatch 读锁, 这时有线程要销毁资源 (拿写锁), 别的线程的提交、建视图、
  `onSubmittedWorkDone` 就全排到 GPU 做完之后. 所以每帧的路径上不用 `Wait`.
  `toDataURL` / `copyExternalImageToTexture` 同步读回; `toBlob` 异步读回, PNG 在单独的线程上编码 (crates/acdert, 用 render 的
  `encode_png`). 背压: 两批 present 没做完 (超过 1 秒的不算) 时这次 vblank 不跑 rAF 回调. 当时只在 Lima 的 lavapipe 上验过, 真 GPU 上没验过.
- WebGL: 还没有. 要做 (用户定, 2026-11-03): `webgl` / `webgl2` / `webgpu` 三种 canvas 3D 上下文都由 acgpu 实现 (acgpu docs/roadmap.md「canvas 3D」), 接口照 web 标准. Canvas 2D 由 render 画
  (acde-dom `src/dom/canvas.ts` 编成命令流, 经 `Dom::canvas` 交给 render; `Path2D` 的 SVG 路径字符串连同 addPath 的变换原样
  送过去, render 用 kurbo 解析, 出错时画出错之前的部分). 一张 canvas 攒的命令超过 20000 条时 render 把它
  在 GPU 上画成一张纹理再接着记 (`ACDE_CANVAS_MAX_COMMANDS`, 0 不限).

### iframe 策略

网页里的 `<iframe>` **不由 Blitz 渲染** (`skip_iframe_content`), 也不再是窗口槽位 (split-window 第 3 步): 窗口的位置只由窗口表
决定, 页面不能把别的窗口嵌进自己. 要显示别的程序, 起它 (`acde.windows.launch` / `acde.apps.launch`), 它是自己的窗口.

### 协作规则

- Rust 和 TypeScript 代码不写注释 (`//`, `/* */`, `///`, `//!`, JSDoc 都不写), 要说明的写进本文件. 例外: 版权和许可证行
  (crates/acde-napi 里 Deno 的版权), 工具要读的指令 (`/// <reference>`, `@ts-expect-error` 这类), `vendors/` (上游源码,
  改动处的 `acrender:` 注释照旧). derive 要读的文字 (帮助, schema 描述) 写成属性, 不写成文档注释.
- 几个会话同一个工作区、同一个 git index: 只改自己负责的路径; 要改的文件里有别人没提交的改动, 先等对方提交.
  根 `Cargo.toml` 由 shell 负责人提交, 其他人要改就告诉他.
- 提交一律 `git commit -- <自己的路径>` (只提交这些路径, 不会带上 index 里别人暂存的东西), 推送前 `git show --stat HEAD`
  确认文件列表. `git rm` / `git add` 之后立刻提交, 不要让暂存的改动在 index 里放着. 做完一段就提交并 `git push origin main`.
- 同一个分支上可能有别人还没推的本地提交, `git push` 会把它们一起推上去: 推之前 `git log origin/main..HEAD` 看一眼,
  有别人的提交先问对方验过没有.
- 改 `crates/shell`、`crates/render`、`vendors/acrender` 或 `web/` 的提交, 先在这棵树编出来的 acde 上起一次会话
  (没有一键验收), 在提交信息里写明验了什么、没验什么.
- 系统调用走 rustix (安全的封装), 不直接依赖 libc; rustix 没有的用专门的 crate: 信号处理器 signal-hook, 本地时间 jiff.
- 依赖版本只写主版本号 (`x.y.z` 只写 `x`: `log = "0"`, `wgpu = "30"`), lock 里用最新的 (`cargo update`); 升级跨了 0.x 的次版本
  (API 会变) 就跟着改代码. 例外只有 `=` 精确钉住的: 由 `[patch.crates-io]` 换成 `vendors/` 的 crate 和与之配套的 (blitz-*、stylo*、
  parley、html5ever、cssparser), 写成 `"0"` 会让解析器挑 crates.io 上更新的版本而不用补丁.
- 改了自己 crate 的依赖: 对应的 `Cargo.lock` 改动放在同一个提交里 (先确认 lock 的 diff 里只有自己的变化),
  提交前 `cargo build --release --locked -p acdert` 必须通过, main 任何时候都要能 `--locked` 编过. `web/bun.lock` 同理.
- 不 force push, 不 amend / rebase 已推送的提交. 提交信息英文, Conventional Commits (`feat(shell): …`), 每行不超过 72 字符, 正文写原因和验证情况
  (性能数字注明负载), 不加 Co-Authored-By.
- 汇报时分开写「已验证 / 未验证」.
- 输出诊断用 `log` 的宏 (`log::warn!` …, 计时见「日志和计时」), 不用 `eprintln!`; acde-host 用 `src/log.ts` 的 `Log`. 例外: 测试、命令行的用法和结果
  (stdout)、fps-probe (独立的程序).
- 说明都写在本文件里, 不放 README, 子目录不放 AGENTS.md.

## 目录

| 路径 | 语言 | 职责 |
| --- | --- | --- |
| `crates/shell` | Rust | 合成器与系统交互 |
| `crates/render` | Rust | Blitz 原生 web 渲染 |
| `crates/runtime` | Rust | 系统接口的 napi 导出. 异步执行器 `src/rt.rs`: 线程 `acde-rt` 上一个 ntex System (运行时 ntex 自己选: io_uring, 不行用 polling), 也是 napi 的 `async-runtime` 后端, 阻塞活进它的线程池; HTTP / WebSocket 用 ntex, TLS 用 OpenSSL, 不用 tokio; 唯一起的子进程是终端的 shell (`std::process`, 一条 `terminal-<pid>` 线程用 pidfd 等它). 检查在 `tests/`, 用编好的 acde 跑 (`acdert run`, 不要 Node): `tests/run.sh <acde> tests/<x>-check.mjs` (fs-copyin、terminal), 输入法 `tests/ime-check.sh` (在私有 D-Bus 和 fcitx5 上跑 `src/ime.rs` 里 ignored 的 Rust 测试; `Ime` 不是 napi 导出, 只由 crates/acdert `webnative.rs` 绑给 web), `tests/portal-check.sh <acde>`; 临时目录在 `$ACDE_CHECK_TMP` (默认 `$TMPDIR`) |
| `crates/acdert` | Rust | `acdert` 可执行文件: 内嵌 V8, 每个 isolate 的事件循环, 模块加载, web 线程 (`spawnWeb`), 把 render 的文档绑给 JS (见「宿主: crates/acdert」) |
| `crates/paint` | Rust | `acde-paint`: web 进程的光栅化线程 (render 的帧 → GBM dmabuf, 画和合成交给 acgpu; 拖动图标), WebGPU 和 render 的 canvas 共用 acgpu 打开的 wgpu 设备 |
| `crates/window` | Rust | `acde-window`: web 进程的 Wayland 客户端 (sctk): toplevel、linux-dmabuf、输入 → shell 事件、剪贴板、拖放、frame、`acde_window` |
| `crates/hostwin` | Rust | `acde-hostwin`: 调试模式的宿主原生窗口 (winit + wgpu surface + vello), Broker 的 `Shell` 和 web 的 `Surface` 的宿主版, 见「运行时进程」 |
| `crates/ipc` | Rust | `acde-ipc`: 进程间的一条双向字节流 (unix socket / Windows 命名管道), `acde dev` 用 |
| `crates/model` | Rust | canvas / 窗口表、shell 事件 (`Event` / `Inbox`)、`acde_window` / `acde_shell` 协议 (`protocol/acde-window.xml`、`protocol/acde-shell.xml`) |
| `crates/log` | Rust | `acde-log`: 日志 (env_logger, 在自己的线程上写 stderr) 和全链路计时, 见「日志和计时」 |
| `crates/acde-napi` | Rust | 用 rusty_v8 实现的 Node-API C 接口 (napi8), 让 runtime / shell 的 `#[napi]` 导出在 Broker 里可用. 改自 Deno `ext/napi` (deno_napi 0.191.0, MIT, 见 LICENSE-MIT): 任务派发换成嵌入方的, 去掉了旧式模块注册、async_hooks、callback scope、napi9+ 和 runtime / shell 链接不到的入口 (删掉后 `cargo build -p acdert` 照样链接成功的那些: Date、DataView、TypedArray、escapable handle scope、new_target、freeze / seal、detach、async cleanup hook、symbol、instanceof 等); cleanup hook 只检查参数, 不存 (Env 不析构, 本来就不会跑); 每个 async work 起一条 `acde-napi-work` 线程 (只有 shell 的 screenshot 用); `open` 把一个模块的导出注册进一个 context |
| `crates/fps-probe` | Rust | 量合成器出帧的 Wayland 客户端, 和 KDE 对比用 (见「crates/fps-probe」) |
| `web/packages/acde-host` | TypeScript | `acdert` 的 JS 部分: Broker (主线程) 和每个 web 线程的宿主, 包发现, 桌面服务, 登录页 (`greet/`) |
| `web/packages/acde-dom` | TypeScript | web 里的浏览器全局对象和 DOM (包着 render 的文档) |
| `web/packages/acde-api` | TypeScript | `@dopame/acde-api`: SDK, 桌面包和应用的接口类型 (唯一对外发布的 JS 包) |
| `packaging/arch` | | Arch 包 `acdert` |
| `packaging/office` | | `office-ds.sh`: runtime Office 用的 ONLYOFFICE Document Server 容器 |
| `packaging/qemu` | | 在运行中的会话里驱动和测量 (`drive.sh`), 汇总计时日志 (`perf-log.sh`) |

## 构建和运行 (开发版)

```sh
cargo build --release -p acdert                # target/release/acdert
cd web && bun install && bun run build       # packages/acde-host/dist/{broker,web}.js
../target/release/acdert desktops                                           # 装了哪些桌面
ACDE_PATH=<acde-dopame 的包目录> ../target/release/acdert --desktop dopame  # 起这个桌面
```

acdert 找 bundle 的顺序: `$ACDE_APP`, 自己旁边的 `app/dist` (装好的包), `<exe>/../../web/packages/acde-host/dist` (仓库里的
`target/release/acdert`; `CARGO_TARGET_DIR` 在别处时要设 `ACDE_APP`). 上机用 DRM/KMS + libinput (在没有显示的 tty 上跑);
已有桌面里开发用 `ACDE_BACKEND=rdp` (见「web/packages/acde-host」的 Run).

## 发版 (npm)

`.github/workflows/release.yml`: 推 `v*` tag (或手动给版本) 时, 六个平台 (darwin-arm64 / x64、linux-arm64 / x64、win32-arm64 / x64)
各编一次 `cargo build --release --locked -p acdert` 和 host bundle, 再检出 acde 仓库, 用它的 `scripts/pack.ts` 打成 npm 包
(`@dopame/acdert-<平台>`: acdert 和旁边的 `app/dist`; `@dopame/acde-api`; `acde`; `create-acde`) 并发布. 包怎么分、开发者怎么装,
见 acde 仓库 AGENTS.md 的「分发」. secret: `DOPAME_READ_TOKEN` (读私有的 acgpu 和 acde)、`NPM_TOKEN`. 某个平台编不过时其余照发, 那个
平台不进 acde 的可选依赖 (Windows 移植做完之前就是 win32). 这个 workflow 还没跑过.

## 日志和计时

所有 Rust crate 用 `log` 的宏, acde 启动时由 `crates/log` (`acde-log`) 装 env_logger: 过滤用 `RUST_LOG` (env_logger 的语法, 在默认的
`warn,acde=info,acde_shell=info,…,usvg=error` 后面追加, 同名的覆盖), 每行 `<进程启动以来的毫秒> <E/W/I/D/T> <线程名> <target>: <内容>`.
格式化在打日志的线程上, 写 stderr 在 `acde-log` 线程上 (积压超过 8 MB 时丢掉并记下丢了几行): 合成器、光栅化、render 线程不会被
journald 卡住. 退出前和 panic 时 `acde_log::flush()` 把积压的写完. smithay 的 tracing 事件经 tracing 的 `log` feature 进同一个 logger.
JS 里 `console.*` 是 target `js`, 页面错误和没接住的异常是 `js` 的 error; acde-host 用 `src/log.ts` (`Log.write`, `Log.enabled`
缓存每个 target 开没开, `Log.clock()` 和 Rust 的 `acde_log::now_ms()` 同一个零点: 本进程启动, 所以同一个进程里的线程可比; web 和 Broker 同在 runtime 里, 时间可比).

计时都是 debug 级、target `perf::<段>`, 平时关着 (一个原子读), `RUST_LOG=perf=debug` 打开全部 (或 `perf::rpc=debug` 只开一段).
每行带 `ms=` 和别的 `键=值`; `packaging/qemu/perf-log.sh [日志文件]` (或从 stdin, 例如 `journalctl -b -t acdert -o cat`) 按种类汇总:
次数、ms 的 p50 / p95 / max / 平均, 以及其余数值的平均.

| target | 哪里 | 一行是 |
| --- | --- | --- |
| `perf::latency` | crates/window (web 进程, 这一帧的 frame 回调时) | 一次输入到上屏: `<pointerdown/pointerup/keydown/wheel/scroll> owner=<surface> ms=<总>`, 分段 `queue` (进队列到 JS 取走) `js` (到 commit) `render` (到 render 出帧) `raster` (到光栅化做完) `present` (到 vblank) |
| `perf::task` | crates/acdert | 事件循环里超过 8ms 的任务: `task ms= hook=` (hook: 任务后的钩子, 提交文档、flush canvas), V8 自己的任务 `v8` |
| `perf::frame` | render | 每帧: `<web> commit= resolve= paint= finish= ms=` |
| `perf::raster` | crates/paint、crates/window (web 进程) | 光栅化任务 `job surfaces= wait= record= ms=` (ms 是交给 GPU 之前), 每个 surface 从发出到做完 `surface owner= ms=` |
| `perf::compose` | shell | 合成一帧: `<输出> elements= ms=`, RDP 的含读回 `rdp elements= rects= ms=`; 计划 `plan inputs= layers= damage= route=`; 一次 backdrop 模糊 `backdrop window= w= h= blur= ms=` (CPU 侧, 含画下面的元素) |
| `perf::rpc` | acde-host | web 侧 `call <服务>.<方法> error= ms=` (往返), Broker 侧 `serve <服务>.<方法> ms=` (处理) |

桌面包服务起的进程 (`ctx.spawn`) 的 stderr 逐行进 acde 的日志 (前缀 `[<服务名>]`); 它们按同样格式打的 `perf::<名字>` 行 (例如
acde-dopame 的 `perf::assistant` / `perf::agent`) `perf-log.sh` 照样汇总. 会话的 `RUST_LOG` 由服务自己决定传不传.

输入到上屏的 Trace (`acde_log::Trace`, 时间都是 `now_ms`): web 进程收到 Wayland 输入、放进事件队列时盖时间 (`Event.stamp`, crates/model `Inbox`), web 取走时 crates/acdert
记 `pumped` 并交给 render (`Dom::input`), 下一次改了文档的 `commit` 记 `committed` (1 秒内没有改文档的 commit 就丢掉), 出帧时记 `framed`
(`Frame.trace`, 一帧没被取走时并进下一帧, 留最早的), shell 光栅化做完记 `rastered`, 合成这一帧排上 vblank 后, vblank 时打 `perf::latency` (RDP 后端没有 vblank: 合成完、发给客户端时打).
滚动不经 JS: render 的 `scroll_at` 直接开一个 `scroll` 的 Trace. pointermove 不算 (悬停由 render 线程做).

JS 的热点: `ACDE_PROFILE_DIR=<目录>` 让每个 isolate (Broker 和每个 web) 开 V8 的采样 CPU profiler (经 inspector 协议, crates/acdert
`profile.rs`, 250µs 一次), 每 `ACDE_PROFILE_SECONDS` (默认 30) 秒和 isolate 结束时写一个 `<web 名>-<n>.cpuprofile` (Chrome DevTools
能打开). `bun packaging/qemu/profile-top.mjs [--top N] [--callers 函数名] 文件...` 按函数汇总自身时间, `--callers` 看一个函数的时间
从哪些调用链来. 原生调用 (DOM、sys) 的时间多半记在调用它的 JS 函数上 (例如 `metricsOf` 的自身时间其实是 render 的 resolve, 或在等
文档锁). 开着 profiler 会慢一些, 量耗时时关掉.

## vendors

- **依赖的来源只有两处**: crates.io 和这里的 `vendors/` (Cargo.lock 里没有 git 来源, 构建不需要 GitHub). 不在 crates.io 上的依赖
  拷进这里, 不用 git 依赖. 访问 crates.io 慢的机器在自己的 `$CARGO_HOME/config.toml` 里换镜像 (不进仓库), 国内用 rsproxy:
  `[source.crates-io] replace-with = "rsproxy-sparse"` 加 `[source.rsproxy-sparse] registry = "sparse+https://rsproxy.cn/index/"`;
  bun 用 `BUN_CONFIG_REGISTRY=https://registry.npmmirror.com`.
- 都是直接放在本仓库里的源码 (没有 submodule, 不带上游历史): 直接在这里改, 改动处加 `acrender:` (ironrdp-server 是 `acde:`)
  注释, 下面的表同步更新; 升级上游时把这些改动重新打上去. 有 `Cargo.toml` 的末尾加了空的 `[workspace]`, 根 `Cargo.toml` 用
  `[patch.crates-io]` 替换上游 (crate 名不改).
- **acgpu 是依赖, 不进本仓库** (用户定, 2026-11-02 / 11-03): 我们自己的 GPU 用户态驱动 acgpu (dopame-org/acgpu) 是独立仓库, 这里
  不放它的拷贝 (没有 `vendors/acgpu`), 以 Rust crate 依赖它: git 依赖仓库根的 `acgpu` 包, 钉 rev (crates/render 和
  vendors/acrender 的 Cargo.toml). 网页图层画进 acgpu 的 2D 场景 (`acgpu::PaintScene` / `Scene` / `RenderCommand` / `Filter`):
  blitz-paint 和 crates/render 直接画进它, 没有 anyrender 这一层 (已删; 它画 SVG 的 anyrender_svg 搬成了 blitz-paint 的 `svg.rs`).
  画出来是 acgpu 的事, 回退也归 acgpu: 谁来画由 `acgpu::Backend::pick(Capability::Pages)` 定, 今天是 Vulkan 回退
  `acgpu::fallback` (feature `fallback-vulkan`, 缺省开; 关掉时 acgpu 驱动做不了的直接 panic). 整页的光栅和合成 (vello 渲染、
  图层的滤镜 / 投影 / 毛玻璃、dma-buf 画布导入、sync_file) 都在 `acgpu::fallback` 的 `Raster` / `Composer` / `Device` 里;
  crates/paint 只剩线程、GBM 画布分配、损伤和区域、把 render 的帧拆成 `Part` (`plane.rs` 实现 acgpu 的 `Content`),
  canvas / WebGPU 纹理当场景里的图片是 acgpu 的 `GpuImage` (render 里叫 `CanvasImage`), `Overrides` 也是 acgpu 的. canvas 2D 的
  离屏光栅 (画、读回、写入、阴影) 是 acgpu 的 `Offscreen`; render `gpu.rs` 只剩共享设备的全局入口和几个转发函数.
  改 acgpu 的场景接口就是改 acde 的接口: 先在 acgpu 提交推送, 再在这里改 rev.

版本看各目录的 `Cargo.toml` 和根 `Cargo.lock`.

| 目录 | 上游 |
| --- | --- |
| `vendors/acrender` | DioxusLabs/blitz, main `fb297a38`, 整组 blitz crate, 自己是一个 workspace, + 改动 |
| `vendors/fontique` | linebender/parley, + 改动 |
| `vendors/parley` | linebender/parley, + 改动 |
| `vendors/stylo` | servo/stylo, + 改动 |
| `vendors/stylo_atoms` | servo/stylo, + 一个 atom |
| `vendors/vello` | linebender/vello (crates.io `vello` 0.11.0), + 改动 |
| `vendors/ironrdp-server` | Devolutions/IronRDP, + 改动 (tokio → ntex, TLS 用 OpenSSL) |
| `vendors/taffy` | DioxusLabs/taffy, git 提交 `4e59968`, 未改 |

### vendors/acrender

Blitz (`MIT OR Apache-2.0`, 许可证文件保留, 依赖的许可证见 `docs/licensing.md`): HTML / SVG + CSS 的文档算成可绘制的场景
(样式, 布局, 排版, 绘制录制), 不含 JS 引擎. 只留 crates/render 用到的 `blitz-dom`, `blitz-paint`, `blitz-traits`, `stylo_taffy`,
`debug_timer`; HTML 解析用 crates/render 自己的 html5ever TreeSink. 合并上游: fetch 上游和 `fb297a38` 比对, 按 `acrender:`
注释和下面的表重新打上改动, 删掉的目录不带回来. 和上游结构不同: `build_inline_layout_into` 在 `layout/inline/build.rs`;
`paint_scene` 保留上游签名, 内部先录进 `Scene` 再回放; blitz-dom 重新导出 `taffy`.

crates/render 另开 blitz-paint 的 `scrollbars` 和 blitz-dom 的 `floats`; 上游的 custom-widget 删了.

验证: 在 `vendors/acrender` 里 (macOS 也行) `cargo fmt --all --check`, `cargo clippy --workspace --all-targets`,
`cargo check -p blitz-dom --no-default-features`, `cargo test -p blitz-dom -p blitz-paint`,
`cargo clippy -p blitz-paint --all-targets --features scrollbars`; 再在 Linux 上 `cargo test --release -p acde-render`
(含 `tests/svg.rs` 里上游会失败的用例), 加 `ACDE_PAINT_VERIFY=1` 再跑一遍.

#### 绘制 (blitz-paint)

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/cache.rs` (新), `src/render.rs` `record` / `ensure` / `flatten`, `src/lib.rs` `paint_scene_cached` / `paint_scene_reference` | 增量录制: 按绘制边界 (根、stacking context、裁剪/滚动容器、图片和 SVG、canvas、≥16 个子节点的元素下的块级子元素) 缓存片段, 片段用局部坐标录, 子边界只留引用; 复用前逐项核对输入 (`Dep::holds` 就地比: 样式 Arc、布局盒、滚动、状态、paint_epoch、排版代数、子节点、选区; 被剔除的还比 scrollable overflow), 只重录变了的. 片段的命令放在 `Arc<[RenderCommand]>` 里, 一帧按引用展开成 `Piece` (片段, 范围, 放置变换) 交出去, 不拷贝 (`placed` 公开给使用方现算变换). 剔除只按视口. 表单控件、iframe 每帧重录. 缓存按命令条数设上限, 淘汰最久没用的; 缩放等全局输入变了就清空. 整页录制给 verify 对照 | 上游每帧整页重录, paint 时间和页面大小成正比 |
| `src/render.rs` `render_element_part` `border_box` | 剔除和片段范围用的边框盒放在元素自己的坐标里 | 上游多算一次位置, 挪过的片段永远不能复用 (可回馈上游) |
| `src/layers.rs`, `src/render.rs`, `src/render/background.rs`, `src/render/box_shadow.rs` | `LayerManager` 换成 `push_layer` / `maybe_with_layer` (要层时才建); 不需要的裁剪路径不建 | 上游超过 1024 层静默丢裁剪; 每个元素每次录制都建路径 |
| `src/debug_overlay.rs` (删) | 去掉 devtools 叠加层和 euclid 依赖 | 从不打开, 每帧每个元素查一次开关 |
| `src/lib.rs` `paint_element` | 只画一个元素和它的子树, 不带祖先的 transform / opacity / 裁剪 | `Dom::capture` (拖动图标) |
| `src/lib.rs` `paint_scene_cached` / `paint_scene_reference`, `src/render.rs` `flatten` / `render_element`, `src/cache.rs` `reuse` | `pinned`: 这些元素不进帧, 各自单独展开 (放置在文档里), 返回给调用方; 录制时它们总是引用 (即使不是边界), 整页录制跳过它们 | 桌面的面板 (「desktop web / window web」的钉住的面板) |
| `src/render.rs` `draw_canvas_background`, `src/render/background.rs` | 画布背景: 根 (没有就 body) 的整个背景 (颜色和图片层) 铺满画布 | 上游只填背景色 |
| `src/render.rs` `draw_canvas_picture`, `src/cache.rs` `is_boundary` | `<canvas>` 画它的 2D 图, 适配进内容盒; canvas 是绘制边界 | canvas 2D |
| `src/render.rs`, `src/text.rs` | 有内边距 / 边框 / 圆角背景的行内元素按行画背景和边框 | 上游不画 span 的 padding / border |
| `src/render.rs` `draw_text_input_text` | 空输入框画 placeholder (`::placeholder` 的颜色和透明度) | 上游不画 |
| `src/render/box_shadow.rs` | spread 加到圆角半径上; 内外阴影的偏移和模糊乘缩放; 透明的内阴影只跳过它自己; 多个内阴影第一个在最上面 | CSS Backgrounds 3; 上游 HiDPI 下阴影减半 |
| `src/render/box_shadow.rs`, `src/render.rs` (滚动偏移、`draw_svg`), `src/render/background.rs` | 这些偏移在元素自己的坐标里加 | 祖先有 scale / rotate 时偏移没跟着缩放; 增量片段和整页录制不一致 |
| `src/render/border.rs` `draw_outline` | outline 沿中线描边, 支持 `outline-offset`、dashed / dotted、圆角; 在内容之后画, 乘元素的 opacity | 上游只会实线、画在背景之前 |
| `src/render.rs` `draw_svg`, `draw_simple_svg`, `draw_svg_tree` | 有 `simple` 时画它的命令; usvg 树相对元素画再整体放置 | 见 blitz-dom 的 simple SVG; 位置不同结果不同 |
| `src/text.rs` `stroke_text`, `Ellipsis`, `draw_ellipsis_marker`, `src/render.rs` `ellipsis` | `text-overflow: ellipsis` 和 line-clamp 的 "…" | 上游不支持 |
| `src/render/gradient.rs` | 色标位置按规范修正; 超出渐变线的色标: 线性拉长渐变线, 径向 / 锥形夹回 | 上游画错 |

#### 文档 (blitz-dom)

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/layout/damage.rs` `propagate_damage_flags` | 内联 `<svg>` 后代的损伤只重建这个 `<svg>`, 往上只传 REPAINT | 改 path `d` 让所有祖先重建、重新布局 |
| `src/mutator.rs` `set_attribute` / `clear_attribute` / `restyle_for_attribute`, `document.rs` `snapshot_attribute` | SVG 子元素的属性、HTML 元素只影响选择器的属性 (class / id / style / data-* / aria-* 等) 只让元素自己重算样式, 后代和兄弟靠快照失效 (快照补上新加的属性名); 有 `:has()` 或 nth-of 时仍重算父元素子树; 值没变的 set 直接返回 | 上游任何属性都重算父元素整棵子树并全量重建 |
| `src/node/simple_svg.rs`, `svg.rs`, `element.rs`, `layout/construct.rs` | 只有基本图形 + 纯色 fill/stroke 的 SVG 直接从 DOM 转成 kurbo 路径, 不经 usvg (`DocumentConfig.svg_text_only` 改走文本); `<text>` 单独拼成小 SVG 走 usvg; 嵌套 `<svg>` 交给 usvg; `ACRENDER_SVG_PATH=1` 打印走了哪条路 | usvg 解析是每帧重建 SVG 的大头 |
| `src/node/serialize.rs` `svg_source` | 序列化内联 SVG 时写进算好的绘制属性和字体, CSS 给的几何算成属性, 零尺寸图形不输出 | usvg 看不到页面 CSS, 不认 SVG2 的 CSS 几何 |
| `src/util.rs` `parse_svg_image` / `parse_svg_with` | 按源文本 (+ 字体库) 缓存解析结果 (512 条, 满了清空); 没有 `<text>` 的用空字体库 | 样式一变就重新解析; 系统字体库冷启动 ~70 ms |
| `src/util.rs` `FONT_DB`, `src/document.rs` `svg_fonts` | fontdb 的通用字族用 fontique 选的字体; SVG `<text>` 能用页面的 @font-face | 默认字族没装时整段 `<text>` 不画 |
| `src/webkit_compat.rs` (新), `document.rs`, `net.rs`, `node/element.rs`, `cssom.rs` | 解析前改写 `-webkit-line-clamp` / `display: -webkit-box` / `-webkit-inline-box` | Stylo servo 版不认 |
| `src/layout/inline/*.rs`, `node/text.rs` | ellipsis 用盒子自己的字体另排一个 "…"; 超过 line-clamp 时高度截到第 N 行 | 见 blitz-paint 的 ellipsis |
| `src/node/inline_edge.rs` (新), `layout/inline/build.rs` / `layout.rs` | 有 padding / border / margin 的行内元素两端各放一个零高行内盒 | Parley 不管 span 的边距 |
| `src/layout/construct.rs` `flush_inline_pseudos_recursive` | 按子元素自己的 display 决定是否往下走 | 嵌套行内元素的 ::before / ::after 不建 (可回馈上游) |
| `src/resolve.rs` `needs_layout`, `resolve_layout_children`, `layout/damage.rs` | 没有布局损伤、缓存还在、视口没变时不跑 taffy / round_layout; 建盒子只走有构造损伤的子树; refresh_hover 只在有变化时跑 | 上游空闲帧也整树走一遍 |
| `src/layout/inline/layout.rs` | 没有行内盒时 min/max-content 宽度用缓存; shrink-to-fit 断行宽度放宽 0.01 (开了 `floats` 的断行器也一样) | 每次量都重算整段文字; f32 误差把最后一个词挤到下一行 |
| `src/stylo.rs`, `resolve.rs` `resolve_containers`, `document.rs` | `container-type` 和 `@container`: 用上次布局的内容盒尺寸, 尺寸变了的子树重算, 最多再跑两遍 | 上游不支持 |
| `src/stylo.rs` `resolve_stylist` | 遍历里被取消的动画/过渡, 元素再遍历一次 | `animation: none` 之后动画值留在样式里 |
| `src/stylo.rs`, `layout/construct.rs`, `node/text.rs` | 输入框的 placeholder 排版, `::placeholder` 按需计算 | 见 blitz-paint 的 placeholder |
| `src/config.rs` `default_lang`, `tree.rs`, `document.rs`, `iframe.rs`, `stylo.rs` | 根没有 lang 时用文档的默认语言, 作为 -x-lang 继承, 传给 parley 当 locale | 汉字字体按语言选地区变体; 不影响 `:lang()` |
| `src/node/node.rs` `hit_inner` | transform 不可逆的元素和它的子树命中不到 | 上游拿 NaN 逆矩阵比大小 |
| `src/config.rs` `skip_iframe_content`, `mutator.rs` `load_iframe` | 打开时 `<iframe>` 不加载, 没有子文档 | 网页不嵌别的文档 (见「iframe 策略」) |
| `src/document.rs` `set_canvas_picture` / `layout_canvas_text` | 存每个 `<canvas>` 的 2D 图; canvas 的 `fillText` / `measureText` 排一行字 | canvas 2D |
| `src/node/element.rs` `paint_epoch` / `repaint`, `node/text.rs` `generation`, `layout/list.rs` | special data、背景图片、列表标记变了时 paint_epoch 加一; 文字重排时 generation 加一 | 绘制缓存靠它们判断 |
| `src/document.rs` `cache_image` | 图片缓存超过 256 张或 64 MB 淘汰最旧的 | 上游从不淘汰 |
| `src/document.rs` @font-face 加载, `net.rs` `FontSources` | 同一字体只注册一次, 加载过的源不再取、不再解码 | 每个样式表都重新取字体, fontique 从不注销 |
| `src/document.rs` `geometry_generation`, `memory` / `MemoryStats` | 公开几何代数; 文档留着的东西的大小 | 查内存增长 (几何代数原来给命中盒子用, 现在没有使用方) |
| `src/document.rs` `create_node`, `forget_layout_child` | 不再记 `changed_nodes`; 删节点时从布局父节点 / 包含块的子节点列表里去掉 | 上游无限增长; 旧 key 让 taffy panic |
| `src/mutator.rs` `flush`, `document.rs` `add_stylesheet_for_node` | 跳过同一批里已经删掉的节点 | render 线程 panic |
| `src/document.rs` `repair_after_panic` | panic 之后去掉对已删节点的引用, 全部标成要重新样式、构造、布局 | 否则之后每次 resolve 都再 panic |
| `src/layout/damage.rs` `repaint_inline_root`, `clear_damage_and_dirty_flags` | 行内元素自己的损伤让 inline root 的 paint_epoch 加一; `display: none` 子树的构造损伤留着不清 | span 只改颜色时片段照旧复用; 以 hidden 启动的窗口里 SVG 从没构造过 |
| `src/document.rs` `physical_unrounded_geometry` | 只减包含块的滚动偏移, 不减自己的 | 滚动容器自己的 rect 跟着自己的滚动走 |
| `src/stylo_device.rs`, blitz-traits `shell.rs` `Viewport.reduced_motion` | `Viewport` 多一个 `reduced_motion`, 变了算设备变化, 建 stylo 设备时设上 | `prefers-reduced-motion` |
| blitz-paint `src/render.rs` 开头 | `scrollbars` 下补上 `Color` / `Stroke` 的 import | 上游这段代码 feature 关着, 没编过 |
| 删掉的 | `src/events/`、`form.rs`、`debug.rs`、blitz-traits `devtools.rs` (Blitz 自己的输入、表单、devtools); parallel-construct (rayon); `<canvas src=数字>` 自定义绘制源; CSS 光标 (`stylo_to_cursor_icon.rs`, cursor-icon); custom-widget (`node/custom_widget.rs` 和它在 mutator / 布局 / 绘制里的分支) | acde 自己处理输入和光标, 文档单线程用, 没有绘制源接口和自定义控件 |
| `assets/default.css` | `::placeholder` 默认颜色是 54% 的 currentcolor | 和 Firefox 一致 |

### vendors/fontique

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/backend/fontconfig.rs` `SystemFonts::members`, `Member`, `family_uncached` | 初始化时按每个字体的第一个族名建一张表, 查族时直接从表建 `FamilyInfo`, 不再每个族一次 `FcFontSort` | `system-ui` 展开成约 165 个族, 首次 resolve 有 78 ms 花在 `FcFontSort` 上, 改后 2.9 ms |
| `src/collection/mod.rs` `System::shared` | 系统字体只扫一次, 进程里所有 `Collection` 共用 (`load_system_fonts` 照旧重扫) | 每个文档 (每个 web) 一个 Collection, 上游每个都重扫一遍系统字体, 每开一个窗口多 ~10 ms |
| `src/font.rs` `mod tests` | 关掉 | 它 include 的资源不在 crates.io 的包里 |

验证: `cd vendors/fontique && cargo test --release --features system --lib acrender` (对本机每个族名比较新旧两种查法).

### vendors/parley

acrender 和 acde 用的是同一份 (`cargo tree -i parley` 只有一个).

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/shape/mod.rs` `FontSelector::select_font` | CJK 标点只有同时有汉字的字体才算覆盖; 全是 Common/Inherited 的 cluster 先试前一个 cluster 的字体 | generic 族展开后 "。" 落到蒙古文之类的字体上; 和 Firefox 一致 |
| `src/shape/mod.rs` `CjkVariant`, `shape_text`, `FontSelector` | 按 locale 把字体栈里别的地区的 CJK 字族换成本地区的 (Noto Sans CJK JP → SC 等), 缓存键加上地区 | 不带语言时所有页面的汉字都落到同一个地区 |
| `src/shape/mod.rs` `begin_segment` | 脚本回退的 (script, locale) 不在 fontique 跟踪的组合里时按没有 locale 查 | 否则每次排版都跑一次 fontconfig, 首帧 10 ms → 170 ms |

验证: 和 headless Firefox 截图对比 "你好。" "中文、英文" "「引号」" "English。" 在几个字体栈下的样子.

### vendors/stylo

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `stylesheets/rule_parser.rs` `AtRuleType::from_name` | `"container"` 去掉 `if cfg!(feature = "gecko")`; `container-type` 由 servo 的 pref `layout.container-queries.enabled` 打开 (Blitz 建文档时设) | servo 构建在解析时就丢掉 `@container` (匹配和求值的代码两边共用) |
| `servo/media_features.rs`, `device/servo.rs` | `prefers-reduced-motion` 媒体特性, 设备上的 `set_reduced_motion` / `reduced_motion` | servo 版只有 `prefers-color-scheme` |
| `servo/animation.rs` `maybe_start_animations` | 已经在跑的动画名 `continue` 到下一个名字 | 上游 `return` 掉整个函数, `animation-name` 里排在它后面的新动画永远不起 |

验证: `cargo test --release -p acde-render --test geometry` (container、prefers_reduced_motion), `--test compositor` (多个动画).

### vendors/stylo_atoms

crates.io 上的原样拷来 (加了空的 `[workspace]`), 只在 `static_atoms.txt` 加了 `prefers-reduced-motion`: stylo 的媒体特性名要是静态 atom.

### vendors/vello

crates.io 的 `vello` 0.11.0 原样拷来 (去掉 `Cargo.toml.orig` / `Cargo.lock`, 加了空的 `[workspace]`), 只改 `src/scene.rs`:

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/scene.rs` `DrawGlyphs::draw` / `try_draw_colr`, `color_bitmaps` | 只有彩色位图 (sbix、CBDT) 代替轮廓; 只带 EBDT (黑白 / 灰度) 位图的字体照常画轮廓 | 上游只要有位图 strike 就走位图, EBDT 的非 packed mask 直接跳过, 整个字形不画: 装了 opendesktop-fonts 时 fontconfig 给 `sans-serif` / `serif` 的中文回退是 AR PL New Sung, 所有用通用族的中文都是空白 |

验证: `cd vendors/vello && cargo clippy --all-targets` (剩上游原有的两条警告, 跑完删掉生成的 `Cargo.lock`); 在装了 opendesktop-fonts
的机器上 wgpu 路径画 `font-family: sans-serif` / `'AR PL New Sung'` 的中文 (12、16、28 px).

### vendors/taffy

Blitz `fb297a38` 用 git 依赖钉的提交 (crates.io 上没有), 只拷了 `src/`、`README.md`、`LICENSE`、`Cargo.toml` (去掉 dev-dependencies、
benches / examples, 换成空的 `[workspace]`). 源码未改. Blitz 换了 taffy 时, 发布版够用就改回 crates.io 依赖.

### vendors/ironrdp-server

RDP 后端 (crates/shell `compositor/rdp.rs`) 的服务端: 握手、TLS / NLA (CredSSP, NTLM)、位图编码、键鼠. 上游跑在 tokio 上 (还经
ironrdp-tokio 带进 reqwest), 这里改成跑在 ntex 上 (运行时 ntex 自己选), TLS 用 ntex-tls 的 OpenSSL filter; 其余 IronRDP crate
仍用 crates.io 的. 改动处 grep `acde:`: `src/transport.rs` (新: ntex 版的 FramedRead / FramedWrite、TLS 握手、std 监听 +
`ironrdp-accept` 线程), `src/server.rs`, `src/helper.rs` (OpenSSL 读证书、建 acceptor、`SSLKEYLOGFILE`), `Cargo.toml`, `clippy.toml`.

和上游的不同: 事件通道是 async-channel (`try_send`); `with_tls` / `with_hybrid` 收 OpenSSL 的 `SslAcceptor`; `run_connection(_with)`
收 ntex 的 `Io`; `RdpServer::run` 要在 ntex System 里跑; TLS 握手 5 秒超时; 不支持 Kerberos (只用 NTLM).

验证: `cd vendors/ironrdp-server && cargo clippy --all-targets --all-features` (跑完删掉生成的 `Cargo.lock`), Linux 上
`cargo clippy --release -p ironrdp-server --all-targets` 和 `-p acde-shell`; 再用 RDP 后端起整个会话, FreeRDP (`xfreerdp3 /cert:ignore`,
无显示时放在 Xvfb 里) 分别以 `ACDE_RDP_SECURITY=tls` 和 `nla` 连上: 出帧、键鼠到桌面、错的密码被拒之后对的照样能连、断开再连.

## crates/render

Blitz (DOM / Stylo / Taffy / 绘制) 包成的渲染引擎, 接口见「组件契约」的 render.

### 已知问题

- canvas 的图案 (createPattern) 在第一次用它画时取来源的位图, 规范是 createPattern 那一刻 (host 在来源之后又变了时会重发样式).
- vello 0.11 (vello_encoding `Resolver::resolve`): 没有图片的场景把图集当 1x1 重建, 已上传的图片仍标成已上传, 之后贴图画空;
  一帧渲染多次时触发, 每个场景垫一块 1x1 渐变绕开 (7376f11; 现在是 acgpu 的 `VelloScene::keep_atlas`). 升级 vello 时看上游修了没有.
- `ACDE_PAINT_VERIFY=1 cargo test -p acde-render` 在机器忙时偶发 `tests/damage.rs` `damage_covers_every_changed_pixel` 等帧超过
  5 秒 ("no frame"), 单独重跑都过.

### 测试数据 (crates/render/tests/fixtures)

- `replay/*.ops.gz`: 旧 acde-host 的 DOM 操作流 (已不能再录), `tests/replay.rs` 回放 (`cargo test --release -p acde-render --test replay`,
  1280x800, 不带资源). 格式: 每批 `[u32 长度][f64 距开始的毫秒][字节]`, 小端, gzip; 一批是若干条 `u8 操作码 + 参数`
  (1 createElement、2 createText、3 setAttribute、4 removeAttribute、5 setText、6 appendChild、7 insertBefore、8 remove、
  9 addStylesheet、10 createElementNS、11 release、12 canvas), 新节点按创建顺序拿 id. `editor-close`: os-v2 开机、打开编辑器
  (CodeMirror)、关掉 (旧版 panic 的那一批); `open-browser`: 开机进桌面、从 Dock 打开浏览器. 测试里写死的节点 id 是录制时分配的.
- `svg/*.svg`: os-v2 运行时 DOM 里所有不同的 `<svg>`, 给 "简单 SVG 跳过 usvg" 做逐像素对比. 是页面 DOM 的原样, 不带页面 CSS
  (render 实际拿到的是带计算样式序列化后的内容), 只当结构参考.

## crates/fps-probe

和 KDE (KWin) 比出帧用的普通 Wayland 客户端 (wayland-client; 只要 wl_shm、xdg-shell、wp_presentation, 有 xdg-decoration 就要服务端
装饰), 不依赖 acde 的任何东西, 任何 Wayland 合成器上都能跑. 开一个窗口 (默认 640x360), 每个 frame 回调画一帧整窗都在变的动画
(shm, 整个 buffer 报损坏), 每帧要 presentation feedback; 每秒往 stdout 打一行 JSON, 关窗口或 `--seconds N` 到了时再打一行
`"summary": true` 的总数. 只在 Linux 上编 (`cargo build --release -p fps-probe`).

`fps-probe [--seconds N] [--size WxH] [--label 名字] [--fullscreen]`. 字段: `fps` (每秒上屏几帧)、`callbacksPerSecond`、`refreshHz`
(合成器报的刷新率)、`intervalMs` (相邻两次上屏的间隔, mean / p50 / p95 / p99 / max)、`missedVblanks` (有 vblank 序号时按序号,
否则按间隔除以刷新周期取整; 刷新本身慢了 (间隔一直略大于周期) 时数不出来, 看 `intervalMs`)、`latencyMs` (commit 到上屏)、
`discarded`、`flags` (`vsync` / `hwClock` / `zeroCopy` 各几帧)、`desktop` (`XDG_CURRENT_DESKTOP`).

对比: 同一台机器、同一个显示器, 分别登录 KDE Plasma 和 acde, 在会话里的终端跑 `fps-probe --seconds 30 --label kde` /
`--label acde`, 期间做同样的事 (闲着、拖别的窗口、开关应用、播视频), 比两边的 summary.
- 量的是合成器把一个原生窗口送上屏的节奏. acde 的网页图层 (桌面、网页窗口) 自己跟不上时合成器照常出帧, 屏幕上是上一帧网页,
  这里看不出来; 要配上 `drive.sh perf` 的 `webs` 和 `shell.raster`.
- acde 的 wp_presentation 时间是处理 vblank 时的时钟 (`hwClock` 为 0), KWin 在 DRM 上是硬件时间戳.
- 无显示器时也能跑 (KWin `kwin_wayland --virtual --socket <名字>`, acde `ACDE_BACKEND=rdp ACDE_SOCKET=<名字>`), 但刷新是各自的
  软件定时器 (实测 KWin virtual 60fps, acde 的 RDP 后端约 57fps), 只能验程序本身, 不能拿来比.

## packaging/arch

`PKGBUILD` 打出 `acdert` 包 (合成器, 原生渲染, 系统接口, 登录页; provides / conflicts `acde-base`), 在 Dopame 镜像里替换 KDE Plasma. 桌面是桌面包, 各自打包.

| 路径 | 是什么 |
| --- | --- |
| `/usr/lib/acdert/acdert` | crates/acdert 的程序 |
| `/usr/lib/acdert/app/` | acde-host 打好的 `dist/` (`broker.js`, `web.js`)、登录页 `greet/` (`acdert --greeter`, greetd 的 greeter)、它用的品牌 `brand/` (标志和字标) 和 `package.json` (`/acde/brand/` 从它的清单来); 没有 node_modules |
| `/usr/share/acde/packages/` | 系统装的桌面包, 每个一个目录 |
| `/usr/lib/acdert/office-ds.sh` | 文稿用的 ONLYOFFICE Document Server (docker) 启动脚本 |
| `/usr/bin/acdert` | 会话入口 (POSIX sh), 见下 |
| `/usr/share/wayland-sessions/acdert.desktop` | 给显示管理器的会话项 (上次进的桌面, 否则第一个); 桌面包另装 `acdert-<id>.desktop` |
| `/usr/lib/tmpfiles.d/acde.conf` | `/var/lib/acde/greeter` (0700, greeter): 登录页的状态和 fontconfig 缓存 |
| `/etc/xdg/fcitx5/profile` | fcitx5 的系统默认配置: 默认英文, Ctrl+Space 切到拼音; 用户自己的 profile 优先 |
| `/usr/share/xdg-desktop-portal/acde-portals.conf` | `XDG_CURRENT_DESKTOP=acde` 的 portal 后端: 全部用 GTK (flatpak / snap 应用的文件对话框) |

会话入口 `/usr/bin/acdert`: 子命令 (desktops、sessions、applications、open、run、app、desktop) 和 `-h` / `--help` / `--version` 直接 exec acdert.
否则跑 `/usr/lib/acdert/acdert` (没有 `WAYLAND_DISPLAY` / `DISPLAY` 时 shell 自己接管 seat 走 DRM/KMS).
异常退出就重新拉起 (journal 里 `-t acdert` 一行 `acdert exited with status N: starting it again`), 60 秒内第 3 次崩溃放弃, 退回显示管理器
(登录页 `--greeter` 放弃时改成 `exec agreety --cmd /usr/bin/acdert`, 免得 greetd 一直重启它); 正常退出或收到 TERM/INT/HUP 不重启.
退出码 3 且有交接文件时 (「桌面包」): 读完删掉, 程序在就导出里面的环境变量并 `exec` 它, 不在就记一行日志、按崩溃处理.
(acdert 自己不认 `--help` / `--version`, 会报 unknown option.)

输入法是 fcitx5: 会话入口不设 `GTK_IM_MODULE` / `QT_IM_MODULE` / `XMODIFIERS`, 原生 Wayland 应用走 text-input-v3 (shell 实现
input-method-v2, IBus 不支持它); 网页里的输入框走 runtime 的 `Ime` (D-Bus).

包从 PKGBUILD 所在仓库的 `HEAD` 构建 (`git archive`), 未提交的改动不会进包. x86_64 和 aarch64 都能打; 版本从 `v*` tag 来
(`v1.2.3` 即 `1.2.3`, 之后的提交是 `1.2.3.r<数>.g<hash>`). 可选依赖: acde-dopame、greetd、Document Server (docker)、
`plasma-workspace` (装了登录页里就有 KDE Plasma)、GPU 自己的 Vulkan 驱动 (`vulkan-intel`、`vulkan-radeon`、`nvidia-utils`):
依赖里的 `vulkan-driver` 要由其中一个满足 (lavapipe 不算, 网页不在 CPU 上画), 镜像要在包列表里列上它们.

构建: Arch / CachyOS 上 `cd packaging/arch && makepkg -s`; 没有 Arch 的机器用 `packaging/arch/podman-build.sh out/`
(一次性的 archlinux 容器). `check()` 不要显示器跑一次 `acdert desktops --package <greet>`, 要列出登录页 `greet`.
发版: 没有 CI. 打 `v*` tag 并推送, 在 x86_64 Arch 和 Arch Linux ARM 机器上各跑一次 `packaging/arch/release.sh <tag>`
(本机架构的包和 `.sha256`; `gh` 已登录就建 GitHub release 并上传). agentos 仓库的 `scripts/components` 钉住用哪个 tag,
ISO 构建时从这里的 release 下载包放进镜像的本地仓库.

## packaging/qemu

会话所在的机器上驱动和测量会话的 `drive.sh` / `drive.mjs` (会话要带 `ACDE_DEBUG_DIR` 起). 网页只在 GPU 上画以后, 没有 3D 的
虚拟机 (agentos 仓库 `image/test-lima.sh` 的 Lima, virtio-gpu) 起不来网页图层, 不再在上面验收 (用户定, 2026-11-02); 验收在有 GPU 的
真机上 (.169 Intel、.187 AMD).

- greetd 的 `initial_session` 只在 greetd 第一次启动时跑, 改了配置要重启虚拟机.
- fcitx5 退出时把内存里的 profile 写回, 要改 profile 先 `kill -9` 它再改.
- 崩溃后要能在 agreety 里重新登录, 用户必须有密码. 测试 VM 的密码不进仓库.
- Lima (vz) 的 virtio-gpu (没有 3D) 在 renderD128 上分配 GBM 报 Permission denied: web 进程 (crates/window) 没设 `ACDE_RENDER_NODE` 时
  按 renderD* 再 card* 的顺序试分配一块 64x64 linear 画布, 用第一个分配得了的 (这里是 card0, 日志 `网页窗口用 ... 分配画布`).
- 光标在哪都不走光标平面 (见「组件契约」的 shell), 每次移动合成一帧 (只重画光标的新旧位置). 待机唤醒和热改分辨率在虚拟机里验不了.

本机有显示器、但 seat0 被登录器 (gdm) 占着时, 不用停登录器也能验 DRM 后端: 以自己的身份在另一个 VT 上开一个 logind 会话跑 acde,
`sudo systemd-run --unit=acde-drm-test --uid=$USER -p PAMName=login -p TTYPath=/dev/tty7 -p StandardInput=tty-force <脚本>`
(PAM 建出 seat0 上 active 的会话, libseat 走 logind; `su -l` / `openvt` 建不出会话, 打开 card 会 EPERM). 脚本里设
`ACDE_BACKEND=drm ACDE_DEBUG_DIR=…` 并用 `timeout` 兜底. 测完结束那个 logind 会话 (`loginctl list-sessions` 里 tty7 的那个,
`loginctl terminate-session <id>`; acde 在会话的 scope 里, `systemctl stop acde-drm-test` 杀不到它, 下次再起就是两个 acde 盯着同一个
调试目录), 再 `chvt 1` 切回登录器.

### 驱动和测量 (`drive.sh`, `drive.mjs`)

`drive.sh [-d DIR] [-t 秒] 命令 [参数...]` (dash, 不要 Node): 把命令行交给会话的 Broker (`ACDE_DEBUG_DIR`, 默认取环境变量,
或 `-d`), 由 `drive.mjs` 在 Broker 里执行, 打印 JSON (出错时退出码 1).

| 命令 | 做什么 |
| --- | --- |
| `keys ctrl+space n i h a o` / `type 'nihao'` | 按键 (evdev 名, `+` 是组合键, 大写字母带 Shift) / 打字, 经 `Shell.inject` |
| `move X Y` / `click [X Y] [right]` / `drag X1 Y1 X2 Y2` / `wheel X Y DY` | 指针 (逻辑像素) |
| `eval WEB CODE` | 在 web 里求值 (`desktop`, `<app>#<window>`) |
| `windows` / `launch APP` / `close WINDOW` | Broker 的窗口表; 经桌面的 `acde.apps` / `acde.windows` 开关窗口 |
| `stats [reset]` | shell 和每个 web 的 render 的现值 |
| `screenshot PATH` | 主输出离屏画一遍存成 PNG (`Shell.screenshot`), 回 `{width, height}` |
| `perf 场景 [秒] [参数]` | 量一段操作: 开始时把计时清零, 结束时报这段时间里的数 |

`perf` 的场景 (输入 60Hz): `idle`, `pointer` (指针在桌面中间绕圈), `drag [APP]` (按住窗口标题栏绕圈拖, 默认 files; `dragged`
说明真拖动了), `scroll [APP]`, `stress [N]` (N 个 stress 应用的窗口每帧重画, 要把 `web/packages/acde-host/tests/fixtures/stress-app`
加进 `ACDE_PATH`), `contend [N]` (stress 窗口重画的同时拖一个 files 窗口: 各 surface 抢光栅化线程), `open [APP]` (反复开关窗口).
结果: `cpuPercent` (100 是一个核), `threads` (按线程名合计: `acde-web` 光栅化, `acde` 是 Broker 和各 web 的主线程 (JS),
`acde-render`), `rssMb`, 都含 acde 下面所有进程 (测量期间结束的不算); `shell`: 每秒合成几帧和 p50 / p95 / max;
光栅化看 web 进程的 `perf::raster`; `webs`: 每个 web 每秒出几帧、`frame` / `frameLocked` / `resolve` 的平均和最长.
无显示器时用 RDP 后端起会话再量: `ACDE_BACKEND=rdp`, `ACDE_DEBUG_DIR=<目录>`, `--seconds N`.

## web

Bun workspace (`bun install`, `bun run build`, `bun run typecheck`, `bun run test`; 没有 pnpm, 没有 Node: 测试是 `bun test`).
这里的代码都跑在 `acdert` 进程里, 没有 HTTP 服务. 跑桌面要把 `ACDE_PATH` 指向一个构建好的 acde-dopame 包.

### web/packages/acde-api

SDK: 桌面包和应用写代码时依据的类型, 唯一对外发布的 JS 包. 代码只有两段手写的 JS (没有构建): `load(name)` (`src/load.js`:
`import('acde:<name>')` 的默认导出, 拿不到 (不在 acde 里, 或清单没给这个能力) 时是 null, 不让整个模块图链接失败; 说明符是变量并带
`@vite-ignore` / `webpackIgnore` / `turbopackIgnore`, 打包工具不碰它; 类型按 `AcdeModules` 给, 桌面服务可以合并声明进去) 和
`@dopame/acde-api/vite` (`src/vite.js`: build 时 `acde:*` 留作外部模块, dev 时换成替身, 方法调用都 reject, `on` 返回空的退订函数,
页面在普通浏览器里也能开). 其余是声明: `src/manifest.d.ts`
(`PackageManifest`, package.json 的 `acde` 字段), `src/service.d.ts` (`ServiceFactory`, `ServiceContext`, `ServiceInstance`),
`src/page.d.ts` (`AcdePage`: 各个 `acde:` 模块的值, `WindowApp`, Finder 的数据), `src/config.d.ts` (`AcdeConfig`:
`acde.config.jsonc`, 同样的 JSON schema 是 `config.schema.json`, 包导出 `./config.schema.json`), `src/modules.d.ts` (`acde:<名字>`
模块的声明, 每个导出同名的值和 default; 桌面服务的名字落到 `acde:*`; 用 `/// <reference types="@dopame/acde-api" />` 或 tsconfig 的
`types` 引入); `src/validate.ts` (导出 `./manifest`) 是清单校验 (「网页应用」), Broker 和 acde CLI 共用. 还没上 npm: acde 仓库
用 `file:../acdert/web/packages/acde-api` 依赖它 (两个仓库并排检出), `acde new` 让应用的 devDependency 指向 acde 装好的那份;
acde-dopame 仍拷一份 (`scripts/sync-acde-api.sh`).

### web/packages/acde-dom

web 里的浏览器全局对象和 DOM, 经 `DomNative` / `GpuNative` / `AudioNative` / `HostNative` (契约 `src/native.ts`) 调 crates/acdert (`HostNative.requestFrame` 是
acde-host 从 surface 装上的); 打进
acde-host 的 `dist/web.js` (从源码打, 自己不构建). 输入框和 contenteditable 的编辑 (插入、删除、按键) 只有
`dom/editing.ts` 一份: `execCommand` 和 acde-host 的 `text.ts` (经 `WebInternals.editing`) 共用. 测试在 happy-dom 做的 MockDom 上跑, 不经 render;
`test/caches.test.ts` / `test/cost.test.ts` 数原生调用次数. 布局类的读 (rect、metrics、计算样式) 缓存到下一次 DOM 写入 (含焦点、
表单值 / 选中状态这类状态调用) 或下一个指针事件、帧、滚动; 写和读交替会每次都让 render resolve 一遍, 和浏览器一样.
只按标签选的 live 集合 (`getElementsByTagName`, `document.images` / `forms` / `scripts` / `embeds` / `all`) 只在树变了时重查,
`links` / `anchors` 任何改动都重查.

Web Animations (`dom/animation.ts`): 时间、事件、`finished` 在 JS 里按 host 的时钟走; 关键帧变成 `@keyframes acde-animation-<n>`
规则, 插进 head 里的 `<style data-acde-animations>`, 再在元素的内联 style 上写 `animation-*` 列表 (按创建顺序, 后面的盖前面的),
由 render 线程跑 (CSS 动画). 时间换成 CSS: 当前时间折进 `animation-delay` (负的就是从中间开始), playbackRate 除进时长和延迟,
倒放翻 direction 并对调 forwards / backwards; 暂停是 `animation-play-state`. 新的动画排到列表最后; 一个动画重起、暂停、跳时间时
只有它换新名字 (render 当新动画起), 别的保持原名和原值, 照常跑.
结束后 fill 没盖住的、cancel 的从列表里拿掉; 列表空了恢复元素原来的内联 `animation*`. 不用的规则攒着, 下次插规则时或 1 秒后
一起删 (插删 `@keyframes` 都让 render 整页重算样式), 元素被回收时它的规则也删. 近似: effect 的 easing 作用在每一段关键帧上
(两帧时和规范一样), endDelay 只算进结束时间 (不进 CSS), 没有 composite, 元素自己的 CSS 动画 (样式表里的) 在 WAAPI 动画期间被内联的盖掉;
`commitStyles` 在结束时写最后一帧的值, 否则写计算样式. 内联 style 的改动会出 MutationObserver 记录.

### web/packages/acde-host

acdert 的宿主代码, esbuild 打成 crates/acdert 跑的两个 ES 模块 (运行时没有 Node): `dist/broker.js` (入口 `src/main.ts`, 主 isolate)
和 `dist/web.js` (入口 `src/worker.ts`, 带 acde-dom, 每个 web 线程). 不监听端口, 不发 HTTP 请求. 构建
`bun run --filter @dopame/acde-host bundle`, 类型检查在 `web/` 里 `bun run typecheck`.

| 文件 | 做什么 |
| --- | --- |
| `src/main.ts` | 命令行 (下面); 起 Broker、fcitx5 (自己的会话)、`--launch` 的程序、XDG autostart (desktop web 第一帧 (经 `page.shown`) 之后 300 ms, 5 秒兜底; 登录页上不起) |
| `src/broker.ts` | 主线程: `Shell.broker()`、服务、窗口表、起 window web、关闭和崩溃、看门狗、重起 desktop web; 按清单检查每个调用 |
| `src/bridge.ts`, `src/services.ts` | 给 web 的接口: runtime 的 `Finder` / `Office` / `Terminals` / `Network` (Terminals 和 Network 并行打开, 之后 Finder, 有它才开 Office; 打不开的去掉并在日志里说一行), 桌面包的服务 (按清单顺序挂上, 同名先到先得, acde 自己的名字保留) |
| `src/packages.ts`, `src/apps.ts` | 包发现、桌面、应用清单、启动哪个桌面、会话项 |
| `src/open.ts` | 「默认应用」 |
| `src/foreign.ts` | 外部 Wayland 会话和交出会话 |
| `src/worker.ts`, `src/host.ts` | web 线程: 文档、surface、acde-dom、页面; shell 输入 → DOM 事件, vblank → 页面的帧, 窗口事件 → `acde:windows` 的 `on` (`Notices`) |
| `src/remote.ts`, `src/rpc.ts` | web 里的 `acde:` 模块 (按 Broker 给的服务建代理, 登记成内置模块), `acde:windows` / `acde:window`; 消息端口上的调用 (函数作为引用跨过去, 对方丢掉或结束时释放) |
| `src/keys.ts`, `src/text.ts`, `src/ime.ts`, `src/panel.ts` | 键码和修饰键、往输入框和 contenteditable 里输入 (acde-dom 的 `editing`)、剪贴板; 输入法 (每个键先给它, 只发变了的状态), 预编辑和候选框由页面画 |
| `src/inspect.ts`, `src/pageinspect.ts` | 「看和操作桌面」: Broker 侧 (窗口、ref、文字、变化、act), web 侧 (语义树、点哪里、输入) |
| `src/dnd.ts`, `src/session.ts` | 拖放 (进出原生程序); `acde.session` (注销, 关机 / 重启只在自己的会话里) |
| `src/frame.ts`, `src/pinned.ts` | 「窗框」; 「钉住的面板」 |
| `src/crashes.ts`, `src/log.ts` | 一段时间里崩了几次 (服务、web、后端的重启上限); `Log` (见「日志和计时」) |
| `src/webapp.ts`, `src/pagecalls.ts`, `src/downloads.ts`, `src/backend.ts` | 「网页应用」: HTML 入口、页面的浏览器调用、下载、应用后端 |
| `src/storage.ts`, `src/places.ts`, `src/office.ts`, `src/autostart.ts`, `src/desktopentry.ts`, `src/debug.ts`, `src/timeline.ts`, `src/page.ts`, `src/native.ts`, `src/sys/` | localStorage 文件; 应用窗口的位置 (「窗口管理」); Document Server 的编辑页; XDG autostart; 读 .desktop 文件 (autostart、外部会话、原生程序共用); `ACDE_DEBUG_DIR`; 启动标记; window web 的文档; crates/acdert 给的原生接口 (`sys/` 用 node 风格的名字包了一层, XDG 目录在 `sys/os.ts`) |
| `greet/`, `brand/` | 登录页 (`--greeter`, 见「桌面包」的登录页); 它的品牌: `mark.mjs` 和 `art.mjs` 是 agentos 仓库 `branding/` 的原样拷贝 (母版, 只在那边改; 几何从设计稿 `dopamine_01.ai` 抽出来), `lockup.mjs` 用 `drawLockup` 在一块 `<canvas>` 上按 devicePixelRatio 画整个 lockup (标志、设计稿的字形、四角星; resize、配色变了重画, 字色取 `.lockup` 的 `color`), `brand.css` 是配色 (浅色 / `prefers-color-scheme: dark`); 包清单的 `assets` 把它挂在 `/acde/brand/` |
| `scripts/bundle.mjs`, `scripts/fake-ds.ts`, `tests/fixtures/stress-app` | 打 `dist/` (压空白和语法, 保留名字, source map); 替身 Document Server (`bun scripts/fake-ds.ts`); `drive.sh perf stress` 用的应用 |

#### Run

```sh
acdert                                    # 会话: 桌面按「桌面包」的规则选
acdert --desktop dopame                   # 那个桌面 (`acdert desktops` 的 id, 或包目录)
acdert --greeter                          # 登录页 (greetd)
acdert app files                          # 只跑一个应用, 窗口铺满输出
acdert desktop dopame                     # 同 --desktop (acde dev 用它; 宿主窗口后端还没有)
acdert desktops                           # 装了的桌面和外部会话; * 是会启动的那个 (不要显示器)
acdert sessions DIR --package PKG         # 给包的每个桌面写 acdert-<id>.desktop
acdert applications DIR --package PKG     # 「默认应用」的 desktop entry 和 acde-mimeapps.list
acdert open [--app ID] PATH|URI...        # 在运行中的会话里打开
acdert run FILE [ARGS...]                 # 在一个 isolate 里跑一个模块 (runtime 的 tests/ 用)
acdert --size 1920x1080 --scale 1         # shell 报输出之前的 CSS 尺寸
acdert --launch foot --seconds 10 --stats # 起一个程序; 10 秒后停; 打印 shell 的 stats 和窗口表
```

环境变量: `ACDE_PATH`, `ACDE_DESKTOP`, `ACDE_STORAGE` (桌面的 localStorage 文件, 默认 `$XDG_CONFIG_HOME/acde/storage/<desktop>.json`,
空: 只在内存), `ACDE_REDUCED_MOTION=1/0`, `ACDE_AUTOSTART=1/0` (嵌套时起 / 不起),
`ACDE_DEBUG_DIR`, `ACDE_BUS_NAMES=1/0`, `ACDE_COLOR_SCHEME=light/dark` (见下面的配色); shell 的见「组件契约」.

**配色** (`src/appearance.ts`): 页面的 `prefers-color-scheme` 跟会话走. `ACDE_COLOR_SCHEME=light` / `dark` 定死; 没设时 Broker 读
xdg-desktop-portal Settings 的 `org.freedesktop.appearance` `color-scheme` (runtime `portal.rs` 的 `Appearance`: `ReadOne`, 不行再
`Read`; 1 是深色, 2、0 和读不到都是浅色), 起桌面之前最多等它 1 秒 (和起服务同时), 没等到先按浅色起. 每个 web 的 init 带
`dark`; 之后 portal 的 `SettingChanged` (`Appearance.watch`, 线程 `acde-appearance`) 变了时 Broker 给所有 web 发
`{type: 'colorscheme', dark}`, web 调 `Dom::set_dark` 并让 `matchMedia` 发 change. 没有会话总线 (登录页) 或没有 portal 时是浅色.

**语言** (`src/language.ts`): 页面的 `navigator.language` / `languages` 跟会话走: 按 `LANGUAGE`、`LC_ALL`、`LC_MESSAGES`、`LANG` 的顺序算
(C / POSIX 是 en-US, 带地区的再补一个只有语言的, 如 `zh-CN, zh`), Broker 起 web 时放进 init. 桌面调 `acde:session` 的
`setLanguage(tag)` (`zh-CN` 这种「语言-地区」, 别的抛 400) 换语言: 写 `$XDG_CONFIG_HOME/locale.conf` 的 `LANG=<ll>_<RR>.UTF-8`
(去掉 `LANGUAGE` 行, 别的行留着; 登录时 `/etc/profile.d/locale.sh` 读它), 改 Broker 里 JS 的环境, 再给所有 web 发
`{type: 'languages', language, languages}`: `navigator.language` / `languages` 变成新的, `window` 上发标准的 `languagechange`
(没变不发). 之后起的 web 也拿新语言. 已经在跑的原生程序、桌面服务和 acde 进程自己的环境 (之后经 shell 起的原生程序) 要等下次登录.

**减少动效**: `ACDE_REDUCED_MOTION=1` 让每个 web 的 `prefers-reduced-motion: reduce` 成立, `=0` 不成立. 没有软件渲染, 也没有
`data-acde-software` 了.

**远程桌面** (没有显示器: 服务器、虚拟机): `ACDE_BACKEND=rdp` 让 shell 离屏合成, 用 RDP 送出 (crates/shell `compositor/rdp.rs`,
服务端是 vendors/ironrdp-server). 要 `ACDE_RDP_USER` / `ACDE_RDP_PASSWORD` 和证书 (`ACDE_RDP_CERT` / `ACDE_RDP_KEY`, PEM 或 DER,
默认 `$XDG_CONFIG_HOME/agentos/rdp/{cert,key}.pem`); `ACDE_RDP_ADDR` (0.0.0.0:3390), `ACDE_SIZE` (默认 1440x900),
`ACDE_RDP_SECURITY` (tls, 或 nla: CredSSP + NTLM). 加 `--seconds N` 也是无头起整个会话、读启动标记的办法. 还没有: 应用的光标形状、
Unicode 键和剪贴板、跟着客户端改尺寸、多个客户端.

**调试运行中的会话** (`ACDE_DEBUG_DIR=<目录>`): 放进去的每个 `<name>.mjs` 由 Broker import, 默认导出被调用, 参数是 `DebugApi`
(`src/debug.ts`): `broker`, `shell` (`inject`, `stats` …), `web(name, code)` (在一个 web 里求值, 结果结构化克隆回来), `stats(reset?)`,
`sleep`, `readText`, `readDir`. 结果写到 `<name>.out`. `packaging/qemu/drive.sh` 是它的命令行.

#### 启动标记

每个 isolate 每个里程碑记一条 info 日志 (target `acde_host`): `启动: <标记> ms=<进程启动以来的毫秒>`; shell 自己的里程碑也带
`启动:` (`grep 启动:` 两种都有). Broker: `shell created`, `services starting`, `services started`, `shell <shell 的里程碑>`,
`autostart`. 每个 web: `page load started`, `desktop loaded` (window web: `loaded`), `shell running`, `first frame`.
