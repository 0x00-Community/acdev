# acdert

> **第一原则: 不许在任何层次上魔改 web 接口.**
>
> - web 接口 (DOM、`window`、`fetch`、`localStorage`、事件、Web Audio、WebGPU …) 和浏览器**完全兼容**: 行为、签名、事件、错误都照标准.
>   不给标准对象加私有方法 / 字段 / 事件, 不改标准语义. 做不到的就是缺口, 记成「还没有」, 不拿长得像的私有版本顶替.
> - **全局只有两个**: `window` (web 兼容) 和 `globalThis` (node 兼容). 没有 `acde` 全局, 不往全局上挂非标准的东西.
> - 系统能力只有一个入口: `acde:` 内置模块, 照 `node:fs` 的写法导入 (`import { fs } from 'acde:fs'`、`import self from 'acde:window'` …;
>   类型在 SDK `@dopame/acde-api`). 清单的 capabilities 决定能导入哪些, 没开的导入直接失败. 「魔改」只许发生在 `acde:` 这一层.
> - **`acde:` 模块是进程内注入, 不是 RPC**: 像 workerd 的 binding, 直接注入页面所在的 V8 isolate, 调用直接进 Rust 原生实现, 不经 socket /
>   IPC / 别的进程代办.
> - 兼容的是标准接口, 不是 Chromium: 渲染器是自研的 (Blitz 分叉 acrender, 没有 JS 引擎), 页面 JS 在 acdert 自己的 V8 里. 没有 devtools、
>   远程调试端口、浏览器外壳.
> - 现有的债 (不是先例, 新代码不许再加, 动到时往这个方向收): web 里除 fs / terminal / network / office / picker 以外的 `acde:` 模块
>   还是经 `rpc.ts` / `remote.ts` 调到 Broker (见「通信」); acde-dopame 还直接用 napi 导出.

说明都在本文件里 (没有 README, 子目录不放 AGENTS.md). full agentic.

## 是什么

acde (Agent Computer Desktop Environment) 是 Dopame 的桌面基座. acdert 是它的运行时, 和开发者 CLI [acde](https://github.com/dopame-org/acde)
的关系像 workerd 和 wrangler: acdert 跑桌面和应用, acde (bun) 建工程、构建、装包, `acde dev` 拉起 acdert. 改名成 acdert 的只有程序、Arch 包和
crate; `acde:` 模块、`@dopame/acde-api`、`acde_*` 协议、`ACDE_*` 环境变量、`$XDG_*/acde/` 这些都不改. 桌面是一张网页: JS 在内嵌的 V8 里
(不用 Node), Blitz (`vendors/acrender`) 排版, vello 在 GPU 上画; 不监听端口 (RDP 后端除外). 具体的桌面由桌面包提供 (例如
[acde-dopame](https://github.com/dopame-org/acde-dopame), 发行时带上, acdert 不认识它).

两种跑法, 运行时是同一套:

| 跑法 | 命令 | 平台 | 输出 | 合成器 |
| --- | --- | --- | --- | --- |
| **会话** (Dopame OS) | `acdert --desktop <id>` (登录页起) | Linux | 屏幕 (DRM/KMS) 或 RDP | acdert 自己 (crates/shell) |
| **调试桌面** (`acde dev`) | `acdert desktop <id \| 包目录>` | Linux / Windows / macOS, 在别人的桌面里 | **一个**宿主原生窗口, 里面合成桌面和所有窗口 | crates/hostwin |
| **调试窗口** | `acdert app <id>` | 同上 | 一个宿主原生窗口, 所选应用铺满, 关闭该应用后退出 | 同上 |

选哪种 (crates/acdert `main.rs`): macOS / Windows 一律宿主窗口; Linux 上 `app` / `desktop` 在别人的桌面里 (有 `WAYLAND_DISPLAY` /
`DISPLAY`, 或设了 `ACDE_HEADLESS`; 没设 `ACDE_BACKEND`) 走宿主窗口, 别的是会话. 会话里只支持 Wayland: 没有 Xwayland, 只会 X11 的程序跑不了.

调试桌面用桌面的模块、服务和 `acde:windows` / `acde:desktop` 事件. 调试窗口用清单授权的模块和 `acde:window` 事件.
宿主窗口的 `native.Shell` 带 `hosted: true`, acde-host `Main.session` 见到它就不算「自己的会话」: 不起 fcitx5、
不开 AT-SPI、不跑 XDG autostart、不拿会话总线名字、不记登录选的桌面. 平台上没有的能力不注入, 不给假的实现.

宿主窗口的 `app` 模式从已安装的包发现应用, 按原规则选择桌面包来加载服务和资源, 并仅启动应用页面. 用 `app <id> --desktop <桌面 id 或包目录>`
指定服务来源. 应用按清单取得能力; 需要桌面页面主动发布状态的功能在此模式下没有发布者. 应用的开发重载保留宿主窗口.

## 进程与线程

```
会话:
acdert (主进程, crates/acdert supervise.rs)   合成器线程 (crates/shell, smithay): canvas / 窗口表 / 输入 / 外设. 没有 V8
 └─ acdert runtime (子进程, 自己的进程组)      一个 V8. 主线程: Broker isolate (web/packages/acde-host): 会话、桌面服务、窗口记录;
     │                                          经 napi `Shell` (acde_shell 连接) 管合成器; 系统接口 crates/runtime (napi)
     ├─ web desktop (线程 `acde` + isolate)     桌面页面: render 文档 + 光栅化 (crates/paint) + Wayland 客户端 (crates/window)
     └─ web <app>#<窗口> (线程 + isolate)        每个应用窗口一个, 只拿清单允许的 `acde:` 模块
原生程序                                        普通 Wayland 客户端

宿主窗口:
acdert (一个进程)   主线程: 平台事件循环 (Windows win32, 别处 winit); `acde` 线程 (栈 64 MiB): Broker;
                    每个 web 一条 JS 线程 + 一条出帧线程 `acde-host-<id>`; `acde-compose` 合成到宿主窗口的 surface
```

- **主进程** (`Supervisor`): 定好 `WAYLAND_DISPLAY` 后建一对 socketpair, 起 `acdert runtime <同样的参数>` (`ACDE_SHELL_FD` 是继承下来的
  那头, napi `Shell.broker()` 接过去; 没有这个变量时在自己进程里起合成器). 合成器等 runtime 发来第一条消息才起 (`desktops`、交出会话
  这些不碰 DRM 的路径不起). SIGINT / SIGTERM / SIGHUP 转给 runtime; runtime 正常退出时主进程停合成器、用它的退出码退出; 被别的信号
  杀掉 (崩溃) 时新建一条 `acde_shell` 连接重起它, 60 秒内最多 3 次. runtime 设了 PDEATHSIG.
- **web** (crates/acdert `web.rs` `spawnWeb`): runtime 里的一条 JS 线程 `acde` (栈 8 MiB), 自己的 isolate (堆上限 `heapMb`) 和事件循环.
  和 Broker 之间是结构化克隆的字节, 投进对方事件循环 (没有 socket). `terminate` 置停止并 `terminate_execution` (退出码 137);
  线程 panic 只结束这个 web (134, `panic: …`). 句柄带 `busyMs` (当前任务跑了多久, 判卡死) 和 `cpuMs` (`/proc/self/task/<tid>/schedstat`).
  段错误、abort 带掉整个 runtime (主进程重起它), 所以共享的 Rust 状态里不写 `unsafe`, 绑定层不 `unwrap`, 每个绑定在边界上
  `catch_unwind`.
- **一个 V8, 每个窗口一个 isolate**: 内存 (各自的堆上限)、生死 (一个死了只掉它的窗口)、CPU (每个 isolate 一个线程, 同一优先级) 各管各的.
- **注入的系统能力** (`spawnWeb` 第 7 个参数 `{app, fs, terminal, network, office}`, Broker `#grants`: 桌面全给, 应用按清单): fs、terminal、
  network、office 和选文件夹在各 web 里绑定同一份 Rust 对象 (crates/acdert `fs.rs` / `terminal.rs` / `network.rs` / `office.rs` /
  `picker.rs`; 阻塞的活经 `offload.rs` 各起一条线程, promise 在这个 web 的事件循环上落定). 限制 (fs 的 roots) 在注入时绑进去, 没给的
  `import('acde:<名字>')` 直接失败. Broker 自己只用 napi `Finder` 的 `locate` (「默认应用」), 是另一份.
  terminal (只在 unix) 的 pty 子进程 exec 前关掉 3 以上的所有 fd; network 第一次调用时连 NetworkManager; office 由 Broker 起服务时
  `sys.openOffice()` 开 (network / office 只在 Linux).
- **还没做的**: 窗口 / 应用 / 会话表还在 Broker 的 JS 里 (`acde:windows` / `acde:apps` / `acde:window` / `acde:session` 经 RPC);
  桌面包服务的调用经 Broker; 外部内存 (ArrayBuffer、文档、GPU 缓冲) 不按 isolate 记账.

## 窗口模型

框架只有两个抽象: **canvas** (工作区) 和 **window**. 都是 Rust 的表项 (crates/model), 不映射到 DOM / JS 对象; 窗口的内容只是客户端交的
一块缓冲, 框架不跑 JS、不持有文档. 桌面、面板、菜单都是窗口.

- **canvas**: 屏幕只有一块, canvas 可以有多个, 同时只显示一个. `rect` 是屏幕的逻辑尺寸 (也是裁剪范围), `scale` 是 HiDPI 缩放, 创建后都
  不变 (分辨率或缩放变了就重建). 每个 canvas 一个 z 列表和一个焦点.
- **window**: `{id, canvas, mode, rect (canvas 坐标, 可以超出 canvas, 超出的不画), z, content, input, grab hints, parent / modal, focus}`.
  四种模式: `fullscreen` (铺满 canvas), `free` (位置尺寸都能变), `fixed` (只能挪), `pinned` (都不变). 桌面是 z 最低的 `fullscreen`
  窗口; 面板和菜单是 `pinned`, 永远在 `free` / `fixed` 上面. 标题栏、边框、阴影是客户端的内容 (客户端画), 不是框架的概念.
- **分层**: 客户端出缓冲 (dmabuf / shm + damage + opaque 区域); 合成只出计划; 呈现 (GPU / DRM / RDP) 执行. 只传句柄、只报脏区,
  框架不读像素; 客户端慢就用上一次的缓冲.
- **`CompositePlan`** (crates/model `plan.rs`, shell `compositor/composite.rs`): `{damage (最多 8 块), route: Composite | Direct, layers:
  [{window, dst, clip, look, effect, redraw}]}`, 不透明的上层剔除下面. backdrop (`set_backdrop`) 只在下面的损伤碰到时重算, 呈现层 (shell
  `effects.rs`, GLES) 双 Kawase 模糊 + 圆角 + 饱和度 + 亮度, 按窗口缓存, 着色器编不出时降级. `Direct` 现在只计数, 上 plane 由 smithay 判断.
- **窗口管理** (框架裁决, 客户端只能请求): 新窗口居中、按窗口数错开 32 像素, 有父窗口的在父窗口上方. 只有 `free` 改尺寸. 点进一个窗口: 拿焦点
  并提到它那一层最前. 隐藏是框架状态 (不画、不命中、不拿焦点). `animate {opacity, scale, dx, dy, duration, delay, easing}` 由合成器每帧插值,
  做完发 `windowanimated`; 有 look 的窗口按画出来的位置命中.
- **焦点和模态**: 键盘只发给焦点窗口. 要把焦点给有模态子窗口 (xdg-dialog `set_modal` + `set_parent`) 的窗口时改给最上层的模态子窗口, 子窗口关掉
  焦点回父窗口. 指针不拦.
- **grab** (shell `grabs.rs`): `request_grab(kind)` 在被别人拿着或框架在移窗时拒绝; 键盘 grab 同时给焦点. 收回 (发一次 `grab_lost`): 在别的窗口
  按下 (`other_window`)、Esc (`esc`, 这次 Esc 不发)、焦点被给别人 (`focus_lost`)、客户端死掉.
- **全局快捷键** (crates/model `shortcut.rs`): 组合写成 `ctrl+alt+t` (键是 xkb keysym 名, 按未修饰的那层匹配, Shift 写进组合). 作用域 session /
  desktop / app, 先到先得, 冲突拒绝, session 级不可覆盖; 匹配顺序 session → 焦点窗口的 app 级 → desktop. 命中的键 (连同松开) 不发给窗口, 发
  `shortcut {window: owner, key, title: 作用域}`. keyboard-shortcuts-inhibit 生效时只有 session 级还拦.

### 协议 `acde_window` (客户端 ↔ 框架, `crates/model/protocol/acde-window.xml`)

只有一种窗口角色 `xdg_toplevel` (菜单、面板、桌面都是). 标准协议管缓冲、damage、opaque / input 区域、configure、parent / modal、激活、
输入、data-device、fifo、presentation、syncobj、pointer-constraints、text-input. 扩展只带框架才能做的:

| 请求 / 事件 | 语义 |
| --- | --- |
| `request_mode(mode)` → `mode` 事件 | 请求四种模式之一, 框架裁决 (尺寸仍走 xdg configure) |
| `set_backdrop(rect, blur, saturate, brightness)` | rect 是窗口本地物理像素; 这块下面的内容由呈现层处理后再画这个窗口; 空 rect 取消 |
| `set_grab_hint(rect, edges)` | 窗口本地逻辑像素; 按下在这里时框架开始移动 (edges 空) 或改大小; 累加, 重叠处后给的优先; 空 rect 清掉全部 |
| `request_grab(kind)` / `release_grab(kind)` → `grab(granted, kind)` / `grab_lost(reason)` | 见上面 grab |
| `request_activate` | 提到最前并请求焦点 |

### 协议 `acde_shell` (Broker ↔ 合成器, `crates/model/protocol/acde-shell.xml`)

只对 runtime 那条连接可见 (`can_view`). 合成器侧 shell `compositor/acde_shell.rs` (Broker 没绑上时攒最多 256 条事件), Broker 侧 shell
`link.rs` 包成 napi `Shell`, 请求和事件和下面「shell」一节的方法 / 事件一一对应 (坐标是 canvas 逻辑像素, int -1 是没有, 小数走 wl_fixed).
`exit` 是连接断了时 Broker 侧自己发的.

## 宿主窗口 (crates/hostwin)

`acde-hostwin` 是调试模式的「合成器」: **一个**宿主原生窗口, 里面按窗口表合成桌面、应用窗口和面板. 对 acde-host 的接口和会话一样
(Broker 的 `native.Shell.broker()` 换成 hostwin 的 `Shell`, crates/acdert `hostnative.rs`; web 的 `claimSurface` 拿到 hostwin 的
`Surface`, crates/acdert `surface.rs` 是两种的 enum).

- **结构**: 平台层 (`platform.rs` 的 `Handler` / `HostEvent` / `Cmd`) 只有两个: `platform/win32.rs` (Win32: 窗口、IMM32、剪贴板、`WM_DROPFILES`、
  `SHBrowseForFolderW`、`IFileOpenDialog` / `IFileSaveDialog`、per-monitor DPI v2) 和 `platform/host_winit.rs` (macOS / Linux, winit + arboard; macOS 的选文件夹、打开和保存文件是 `chooser.rs`). `app.rs`:
  命中、拖动、焦点、快捷键、注入. `shell.rs`: 窗口表 (`State` / `Entry`, 层序 desktop < free / fixed < pinned, 再按 z). `present.rs`: 每个 web
  一条出帧线程 `acde-host-<id>`, vello 把页面和面板画进各自的纹理; `compose.rs`: `acde-compose` 线程按层贴到宿主 surface (AutoVsync).
  页面 / 面板的 plane 有 layers (backdrop-filter、filter) 时走 `Presenter::layered`, 照 `acde_gpu::Raster::draw_pass` 用 `Composer` 做
  backdrop、投影、模糊和颜色矩阵 (Raster 要 dmabuf, 只在 Linux): 画进一张草稿纹理, 最后一次提交里整张拷进页面纹理 (分几次提交直接画,
  合成线程会读到只铺了底色的半成品). 这条路出的是预乘 alpha, vello 直接画的是非预乘: `Page.straight` 标明, 合成器按预乘混合, 非预乘的
  先在着色器里乘上 alpha.
- **窗口之间的毛玻璃**: 钉住的面板里 backdrop-filter 最大的那块 (同 window crate 的 `Panel::backdrops`) 和页面的 `acde.window.setBackdrop`
  (窗口本地物理像素, 加窗框高度) 记在 `Entry.backdrop`. 合成器先把各层画进一张离屏画布, 画到带 backdrop 的层之前调 `Composer::backdrop`
  模糊画布上已经画好的部分, 最后把画布贴到 surface; `screenshot` 读的也是这张画布.
- **面板挪位置等内容**: `placePanel` 的新 rect 先挂在 `Entry.pending`, 出帧线程画出这个尺寸 (差 1 px 以内) 的面板后才换上
  (`State::place_when_drawn`; 已经画好了就立刻换). 不然新位置先生效、旧内容 (相对旧原点画的) 贴过去一帧, Dock 放大时整条往旁边跳一下.
- **GPU**: `gpu.rs` 只开 `acde_gpu::BACKEND` 一个后端 (Windows DX12、macOS Metal、Linux Vulkan), 不要 CPU 设备; `WGPU_VALIDATION` /
  `WGPU_DEBUG` 照 wgpu 的环境变量. 所有 `surface.configure` 和提交都拿 `acde_gpu::Gpu::submit_lock`.
- **坐标**: 宿主窗口的内容区就是「屏幕」(`output`: `ACDE_SIZE`, 否则主显示器的 90% × 85%, 最大 1440 × 900), 窗口表的 rect 是它里面的
  逻辑坐标. 宿主窗口改尺寸 / 换缩放时桌面和全屏窗口跟着改, 发 `output`.
- **输入**: 平台事件变成 evdev 码 (`keys.rs`) 和逻辑坐标. 按下命中最上面的窗口 (`State::hit`; 面板按 input 区域, 落到 owner), 给它焦点、提前,
  之后的移动和抬起都发给它 (隐式 grab); 按在 grab hint 上由 hostwin 自己拖动 / 改大小. 键先过快捷键表再发给焦点窗口; 宿主窗口失焦只发
  `deactivate`. 输入法是 `imepreedit` / `imecommit` 事件 (Windows: `WM_IME_COMPOSITION`, 上屏只发 commit, 只有在组字时结束才发空预编辑表示取消);
  候选框位置: 宿主窗口没有 fcitx, acde-host 的 `TextEntry` 用 `InputMethod.area` 把光标矩形交给 `setImeArea`, Windows 上同时设 IMM 的
  组字 / 候选窗口并回答 `WM_IME_REQUEST` 的 `IMR_QUERYCHARPOSITION` (微软拼音这类 TSF 输入法只问它). 拖进来的文件: 指针下的窗口收 `dndenter` + `dnddrop`, 同时记下这个窗口应用的一次性 copyIn 授权 (见「文件」);
  (`text/uri-list` 和 `text/plain`). 页面发起的拖动 (`startDrag`, acde-host `DragSource` 在页面里起的 HTML5 拖放带了数据时): 页面里的
  dragover / drop 由 `DragSource` 自己按指针做, hostwin (`App` 的 `data_drag`, `Cmd::StartDrag`) 只管别的窗口: 按住左键时才接 (否则回
  `dragend {button: 0}`), 指针移到别的 web 上发 `dndenter` (类型) / `dndmove`, 离开发 `dndleave`; 在别的窗口上松手发 `dnddrop` (数据) 再给源
  `dragend {button: 1}`, 不发 `pointerup`; 在源窗口里或没有窗口处松手照常发 `pointerup`. 数据来自页面, 不记 copyIn 授权 (页面不能替用户担保
  文件). 没有拖动图标.
- **窗框在页面外**: 应用窗口 (清单 `frame` 不是 false) 的 rect 含窗框, 页面拿到 rect 减去窗框的高 (`State::content`). 出帧线程
  (`present.rs` `framed`) 把 render 的 `Decoration` 场景和下移了窗框高度的页面画进同一张纹理, 合成器只看到一层. 命中在窗框上
  (`Hit.bar`) 时页面收不到指针 (收 `pointerleave`); 三个按钮按下和松开在同一个上时发 `framebutton`; 标题栏 (按钮区外) 移动、四边 4 px /
  四角 10 px 改大小, 由 `Entry::grab_hints` 和页面的 hint (下移窗框高度) 合成, 窗框的优先. `contentOffset` 是 `[0, H]`, 输入法候选框也加 `H`.
- **注入** (`Shell.inject`): `Cmd::Inject` 到主线程, 和真输入走同一段代码 (命中、拖动、快捷键); 注入的修饰键和真的合起来匹配; 按键带 US 布局
  的字符 (`keys::us_text`). 中文等走 `acde:inspect` 的 `type`, 不经注入.
- **别的**: `capture(window)` (出帧线程读回这个窗口的页面纹理编 PNG, 最多等 10 秒), `screenshot(path)` (合成线程按窗口表把所有页面
  画进一张离屏的 `Rgba8Unorm` 纹理, 读回编 PNG 写到 path, 回 `{width, height}`, 和会话的 `Shell.screenshot` 同一个接口; 最多等 10 秒),
  `notify` (`notify.rs`: macOS osascript, Linux `org.freedesktop.Notifications`, Windows 没有), `devRespond`, `screen`, `shortcut`, `windows`,
  `launch`. `animate` 直接回 `windowanimated`, `requestGrab` 一律授予. 宿主窗口的关闭按钮发 `windowcloserequest`:
  桌面的结束会话. `ACDE_HOST_DUMP=<目录>` 让合成器在画面停下 300 ms 后把整个合成结果读回写成 `screen.png` (和 `screenshot` 同一段).
- **不显示 (`ACDE_HEADLESS=1`)**: 平台层在运行时二选一 (`platform.rs`: `Host` 是 trait, `Proxy` 是 enum; 原生的 win32 / winit 和
  `platform/headless.rs`). headless 不开窗口: 主线程只收 `Cmd` (`Exit` 时退出), 屏幕是 `ACDE_SIZE` (否则 1440 × 900) 乘 `ACDE_SCALE`
  (0.5–4, 默认 1), 起来就算宿主窗口有焦点. 合成器没有 surface: 不出画面、不数 `frames`, 但页面照常出帧 (出帧线程的节奏不靠宿主窗口),
  `capture` / `screenshot` / `ACDE_HOST_DUMP` 照常读回. 注入和真窗口走同一段 (`App::inject`). 只在 headless 下不同的: 剪贴板是进程里的一份
  (不碰系统剪贴板), 选文件夹、打开和保存文件没有事先的答复 (`choose`) 时回错 (Linux 的 headless 也不问 portal), 系统通知只写一行 info 日志 (不弹出), 标题和输入法区域不做. 仍然要 GPU (「GPU 与性能」: 网页只在
  GPU 上画, 不认 lavapipe): 能在有 Metal 的 macOS 机器 (含 GitHub 的 macOS runner, 没验) 或有 GPU 的 Linux / Windows 上无人值守地跑, 不能在
  没有 GPU 的 Linux CI 上跑. Linux 上设了它就算「在别人的桌面里」, 不要 `WAYLAND_DISPLAY` / `DISPLAY`.
- **系统能力**: fs、选文件夹、声音、剪贴板到处都有; 打开 / 保存文件在 Linux (portal)、macOS (`NSOpenPanel` / `NSSavePanel`) 和 Windows (Common Item Dialog, `platform/win32/dialog.rs`) 有; terminal 和应用后端的 unix socket 只在 unix; network、office、runtime 的 IME、语音、
  WebGPU 只在 Linux. OpenSSL 在 macOS / Windows 上静态编进去 (`vendored`), 它不带根证书: runtime `http.rs` 的 `tls()` 在那两处从系统证书库
  (Keychain / Windows 证书存储, rustls-native-certs) 读进来; Linux 用系统的 OpenSSL 和它的证书目录. Windows 的证书库是按需下载的
  (第三方根证书要等系统自己的 TLS 第一次用到才进库), 所以 Windows 上 OpenSSL 校验失败时 (`system_trusts`) 再把对方的证书链交给
  `CertGetCertificateChain` + `CertVerifyCertificateChainPolicy` (SSL 策略, 带主机名) 验一次, 它会下载缺的根证书; 两边都不认才拒绝.
  页面联网的 TLS 握手超时是 30 秒 (`tls_config`, ntex 默认 5 秒, 走代理的慢站点握不完).

## acde dev

IPC: acdert 是服务端, 在 `ACDE_DEV` 上听 (hostwin `dev.rs`, 线程 `acde-dev`, 每条连接一条 `acde-dev-conn`), acde dev 和工具 (acde 的命令、
MCP、driver) 都直连它, 中间没有转发. unix 上是 unix socket (地址和 0700 的目录由 acde dev 定好、旧 socket 它先删, acdert bind 后设 0600,
退出后 acde dev 删), Windows 上是命名管道服务端 (`FILE_FLAG_FIRST_PIPE_INSTANCE` 防别人抢先占名、`PIPE_REJECT_REMOTE_CLIENTS`、SDDL
`D:P(A;;GA;;;OW)` 只给当前用户, 接一个再开下一个实例). 这条 IPC 能在页面里求值, 所以只给自己. 一行一个 JSON. 发 `{"type":"hello","role":"dev"}`
的那条连接是 acde dev 的: 它断了 acdert 就退出; 别的 hello 忽略. Windows 上读之前先 `PeekNamedPipe`, 有数据才 `ReadFile`: 同一个同步句柄上
挂着的读会让写 (回答) 一直等着. 工程的构建结果经
`ACDE_PATH` (Windows 用 `;` 分隔) 交给 acdert, 不装进包目录; 日志就是 acdert 的 stderr.

收到的消息 (`reload` / `quit` 哪条连接发都照做):

- `{"type":"reload","app"?,"hot"?}` → Broker 的 `devreload`: 有 app 时关掉它所有窗口 (不问 `beforeclose`) 再按记住的 rect 打开 (清单的 `size` 变了时按新尺寸, 中心不动, 不超出屏幕), 没有 app 时
  重起 desktop web (服务不重起). `hot: true` 时先试热替换 (下面).
- `{"type":"quit"}`.
- `{"type":"request","id","op",…}` (id 是数字或字符串, 只在这条连接里有意义) → id 换成进程内递增的号, 整行作为 `devrequest` 推给 Broker
  (`broker.ts` `#devRequest`), 做完调 `Shell.devRespond`, 按号找回连接、换回原 id 写出 `{"type":"response","id","ok":true,"result"}` 或
  `{…,"ok":false,"error":"<文字>"}`, 每个请求恰好一次 (超时在工具一侧); 连接断了, 它还没回答的请求作废. `web` 参数是 web 名
  (`ledger#1048576`)、应用 id (window 号最小的那个 web) 或 `desktop`:
  - `webs` → `{webs: [{name, app, kind, window, title}]}`.
  - `eval {web, code}` → `{value}`: 和 `ACDE_DEBUG_DIR` 一样求值 (promise 等落定), 结构化克隆回来再 JSON (undefined 是 null, JSON 不了的回错).
  - `shot {web}` → `{png: <base64>, width, height}` (`Shell.capture`, 设备像素, 桌面的含面板).
  - `snapshot` / `act` / `run` / `open {name}` / `query {selector, window?, ref?, limit?, attributes?}` → `Broker.inspect.api` 的同名方法 (「看和操作桌面」).
  - `console {web?, since?, limit?, level?}` → `{entries, next, dropped}`: 页面的 `console.*` 和没人接的错误 (`devlog.ts`, 见下), `level` 是
    log / info / warn / error / debug, 或 errors (console.error 和错误); `web` 是 web 名、应用 id 或 desktop; `since` 是上次的 `next`, `dropped`
    是 since 之后已经丢掉的条数. 条目 `{seq, time (ms, 和日志同一个零点), web, app, kind: console | error | rejection, level, text}`.
  - `network {web?, since?, limit?, failed?}` → 同样的形状, 条目 `{seq, time, web, app, id, kind: fetch | xhr | websocket | eventsource, method,
    url, requestBytes, status, statusText, responseBytes, ms, error, done}`; `failed` 只要出错的和 status ≥ 400 的.
  - `screen {path}` → `Shell.screenshot(path)` 加 `path` (绝对路径; 整个屏幕, 所有窗口合在一起).
  - `emulate {colorScheme?: light | dark | null, reducedMotion?: boolean | null}` → `{colorScheme, emulated, reducedMotion}`: 所有页面 (和以后
    开的) 的 `prefers-color-scheme` / `prefers-reduced-motion` (CSS 和 `matchMedia`); null 回到系统的 (portal / `ACDE_COLOR_SCHEME` /
    `ACDE_REDUCED_MOTION`). 模拟配色时系统配色的变化只记下, 回到系统时再生效.
  - `choose {folder | open | save}` (恰好给一个) → 原样回: 事先答复页面下一次的这种选择器, 不弹窗, 三种各排各的队列, null 当作用户取消.
    `folder: 绝对路径` 答 `showDirectoryPicker`; `open: [绝对路径, …]` (不空) 答 `showOpenFilePicker` / `<input type=file>`, 多于一个而这次
    不许多选时这次回错; `save: 绝对路径` 答 `showSaveFilePicker`. napi `Shell.answerFolder` / `answerOpen` / `answerSave` → hostwin 的队列,
    crates/acdert `chooser.rs` 先取队列再弹窗, 有窗口、headless、Linux 的 portal 都一样; 会话没有这个, 回错.
  - `route {url, method?, web?, times?, status?, statusText?, headers?, body?, abort?}` → `{id}`: 让页面的 fetch / XHR 拿到假的回应, 不到应用的
    文件、后端或网络 (`devroutes.ts`). `url` 是 glob (`**` 任意, `*` 不含 `/`; `/` 开头的比路径加查询, 否则比整个 URL) 或 `{regex, flags}`;
    `body` 是 base64; `status` 200–599 (默认 200), `statusText` 默认按状态码; `abort: true | 文字` 让请求失败 (不能和回应一起给); `times` 用完就删.
    后加的先匹配. Broker 存着规则, 推给匹配 `web` 的页面 (`{type: 'devroutes'}`, 新起的页面在 `WebInit.devRoutes` 里拿); 页面按 acde-dom 的
    `observe({route})` 先问规则再走 `route()`, 带 `times` 的用一次 `port.post({devroute: id})` 给 Broker 减一 (各页面自己也减, 几个页面同时用可能多
    用一次). 不管 CORS、cookie; WebSocket / EventSource 不经它. network 的条目带 `mocked: true`.
  - `unroute {route?}` → `{removed, left}`: 删 id 是 `route` 的那条, 不给全删 (请求自己的 `id` 是请求号, 所以不叫 id).
  - `clipboard {text?}` → `{text}`: 给 `text` 先写, 再读回宿主剪贴板 (napi `Shell.readClipboard` / `writeClipboard` → hostwin; headless 是进程里那份,
    有窗口是系统剪贴板); 会话没有, 回错.
- **dev 日志** (只在有 `ACDE_DEV` 时): acde-dom `core/observe.ts` 的 `observe(observer)` 是页面里唯一的观察点, 没注册时零开销. `console.*`
  (照打日志之外) 报 `console(level, text)`; 没人接的 `error` / `unhandledrejection` (交给 `host.reportError` 的那些) 报 `error(kind, text)`
  (Error 的 stack, 别的 realm 来的按 `stack` / `name` + `message` 认); `fetch` / XHR / EventSource (都经 `exchange`, 加上本地资源和够不着的地址)
  和 WebSocket 报 `request`: start → response (WebSocket 是 101) → end (收到的字节) 或 error (中止是 `aborted`; 够不着时说清是「应用里没有这个
  文件, 也没有后端」还是「不是这个应用的地址」). 页面 (`worker.ts`) 把它们单向 `port.post` 成 `{devlog, time, …}` 给 Broker (不是 rpc,
  页面重启、崩溃了记录还在); Broker 的 `DevLog` 两种各留最后 5000 条、文字最长 16 KB, 请求按 web + id 合成一条, web 没了时还开着的记成
  `the page went away`.

**热重载** (acde 构建时不压缩, `NODE_ENV` 是 development). acde 比较构建前后的产物 (acde 仓库 `src/changes.ts`): 只有 `.css` / `.js` 变了、
HTML 去掉样式和脚本引用后一样时发 `hot: true`. Broker 给那个应用的窗口 (或桌面) 发 `devhot`, web (acde-host `devhot.ts`) 重读入口 HTML,
都能热替换才动手, 否则整页重载:

1. 样式: 新旧 HTML 的 `<style>` / `<link rel=stylesheet>` 按顺序和页面里的对上, 换文字或 `href` (加 `acde-dev=<n>` 让 render 重读).
2. JS 函数体: 内容变了的 module 脚本经 V8 inspector 的 `Debugger.setScriptSource` 换源码 (crates/acdert `inspector.rs`: 有 `ACDE_DEV` 时每个
   isolate 一个 inspector session, V8 带 `--inspector-live-edit`). dev 模式下模块源码末尾加 `"\n;"` (`inspector::module_source`), 换源码时也加:
   V8 LiveEdit 的 diff 把文件末尾追加的代码当成没变. 改了模块顶层 (`BlockedByTopLevelEsModuleChange`)、函数在栈上、classic 脚本变了都整页重载.
3. 整页重载保留状态 (所有 reload): 关窗口前问旧页面要快照 (`dev.state`, 最多 0.5 秒, `devstate.ts`): 表单值、滚动位置、焦点和选区, 元素按 id
   或 `nth-child` 路径认; 新页面加载完在 0 / 50 / 200 / 600 / 1500 ms 各放回一次, 值经原型上的 setter 写再发 `input` / `change`.

## 桌面包

桌面包是一个目录, `package.json` 的 `acde` 字段 (类型 acde-api `manifest.d.ts`):

```json
"acde": {
  "desktops": [{ "id": "dopame", "name": "Dopame", "entry": "dist/ui/desktop/index.html", "services": ["assistant"] }],
  "apps": [{ "id": "term", "label": "终端", "icon": "term", "entry": "/ui/terminal/term.js", "capabilities": { "terminal": true } }],
  "assets": { "/ui/": ["dist/ui"] },
  "services": [{ "name": "assistant", "module": "dist/services/assistant.js" }]
}
```

- **desktops**: `entry` 是包里的 HTML, 满屏在所有窗口后面; 桌面拿全部 `acde:` 模块. `heapMb` 默认 1024, 最小 32.
- **apps**: 见「应用清单」. **assets**: 同源 URL 前缀 → 包里的目录.
- **services**: 在 Broker isolate 里跑的 ES 模块, 默认导出 `ServiceFactory` (只用 `ServiceContext` 和 web 标准接口). 随桌面起停; 应用要在
  capabilities 里写服务名才能调. 重活放进 `ctx.spawn(argv, {cwd, env, onLine, onExit})` 起的进程 (`child.rs`: 自己的进程组, stderr 进日志加前缀
  `[<服务名>]`, 服务关闭后 SIGTERM, 3 秒后 SIGKILL).

找包的顺序: acde-host 自己 (只有品牌资源)、`ACDE_PATH`、`$XDG_DATA_HOME/acde/packages/*`、`$XDG_DATA_DIRS/acde/packages/*`, 同 id 先到先得.
外部会话 (`src/foreign.ts`): `$XDG_DATA_DIRS/wayland-sessions/*.desktop`, id `session:<文件名>` (显示名去掉 "(Wayland)", KDE 的加 "KDE");
不列 acde 自己的、`Hidden` / `NoDisplay`、程序找不到的.

**启动哪个桌面**: `--desktop <id|包目录>`, 否则 `ACDE_DESKTOP`, 否则上次进的 (`$XDG_STATE_HOME/acde/desktop`; `--greeter` 和 `app` /
`desktop` 子命令不记), 否则第一个 acde 桌面, 否则第一个外部会话. `acdert app` 没有桌面时用空的 (`Packages.bare`).
桌面经 `acde.desktops.choose(id, remember)` 换桌面.

**交出会话**: 选中外部会话时写交接文件 `$XDG_RUNTIME_DIR/acde/exec` (第一行是单引号引起来的 argv, 之后 `XDG_CURRENT_DESKTOP` /
`XDG_SESSION_DESKTOP` / `XDG_SESSION_TYPE=wayland` / `DESKTOP_SESSION`), 退出码 3; 会话入口 `/usr/bin/acdert` 读它并 `exec`.

**登录页** (`acdert --greeter`, greetd 的 greeter, acde-host `greet/`): 选账户、桌面、输密码; 会话是 `/usr/bin/acdert --desktop <id>` (外部会话是
它的 Exec 加那四个变量). 每个账户上次的桌面记在 `$XDG_STATE_HOME/acde/greeter.json` (greeter 的状态目录是 `/var/lib/acde/greeter`). 别的显示管理器用
`acdert sessions` 生成的 `acdert-<id>.desktop`.

## desktop web / window web

每个 web 有自己的 DOM、CSS、JS 堆、render 文档和 surface.

- **渲染 (会话)**: 每个 web 一个 xdg_toplevel, 自己光栅化 (crates/paint, 三块轮转的 GBM 画布), 经 linux-dmabuf 交给合成器. 窗口 id:
  桌面 0, web 窗口从 `1<<20` 起 (Broker 发), 和原生窗口同一空间. 应用窗口先是居中的 `free` 窗口, 页面尺寸是清单的 `size` (默认 800x600),
  Broker `grant` 时加上窗框的高 (`Frame.windowSize`), 整个窗口不超过屏幕.
- **输入**: 合成器按 z 找到指针下的窗口; crates/window 转成 shell 事件; 滚轮的默认滚动和 :hover 在 render 线程上. pointermove 对齐到帧
  (acde-host `host.ts`: 只留最新的, 下一个 `frame` 或别的事件前才派发).
- **记住位置** (`src/places.ts`): 窗口没了时合成器发 `windowgone`, Broker 按应用 id 记最后的 rect (全屏的记进全屏之前的) 到
  `$XDG_STATE_HOME/acde/windows.json` (`ACDE_STORAGE` 为空时只在内存); 下次打开且没有别的窗口开着时摆回 (露出屏幕不到 48 像素或标题栏
  在屏幕上沿之外时照旧居中). 只有桌面能隐藏 / 显示 / 提前 (`acde.windows.hide` / `show` / `focus`); 应用的 `minimize` 只是给桌面发
  `windowminimize`.
- **窗框**: 应用窗口 (清单 `frame` 不是 false; 桌面和面板没有) 有一条标题栏, **不在页面的文档里**: `<html>`、`innerHeight`、`100vh`、`resize`
  都只是内容区. 窗口表的 rect、grab hint、backdrop 是含窗框的整个窗口; 页面给的 `setGrabHint` / `setBackdrop` 是页面坐标, 加上窗框高再交出去,
  窗框的 hint (标题栏移动, 四边 4 px / 四角 10 px 改大小) 优先. 会话里是 crates/window `decoration.rs` 在页面 surface 上开的同步 `wl_subsurface`
  (`set_window_geometry(0, -H, W, 整高)`, 自己的画布 plane `usize::MAX`); 宿主窗口里见「宿主窗口」. 三个按钮按下和松开在同一个上时发
  `framebutton {key}` (`close` / `minimize` / `fullscreen` / `restore`), acde-host 调 `acde.window` 的 `close()` / `minimize()` / `requestMode`.
  标题是 `document.title` 或 `acde.window.setTitle` (没有时用 `label`), 经 surface 的 `setTitle`. 高度只在 acde-host `frame.ts` 的
  `Frame.HEIGHT` (32), 经 `claimSurface(token, {frame})` 交给 surface; 画法在 render 的 `Decoration`. 全屏时窗框照旧在. `acde:inspect` 看不到窗框
  (页面坐标加 `contentOffset`).
- **钉住的面板** (Dock、菜单栏、弹出层): 桌面页面调 `acde.desktop.pin(element, {margin?})` → `{update(), unpin()}`, 元素成为单独的 `pinned`
  窗口, 状态和 React 树还在同一个文档里. `pinned.ts` 量元素 (并上 render 报的绘制范围 `panelmove`), 要令牌 (`Shell.grant({mode: 'pinned', rect})`),
  再开一个 toplevel (crates/window `panel.rs`; 宿主窗口里是 owner 为桌面的表项), `Dom::set_panel` 让 render 单独画它 (`Frame.panels`). 输入区域只是
  元素的盒子 (`pointer-events: none` / 不可见时为空), 指针送回同一个文档; 主窗口或任一面板有焦点就算 `activate`. 元素变了 (ResizeObserver +
  MutationObserver, 700 ms 后补量) 重新量, 量不到时 `hide`. backdrop-filter 转成 `set_backdrop`. 元素要是 stacking context, 不带祖先的裁剪和透明度.
- **帧**: `requestFrame` 之后, 上一帧交出去就给下一帧, 两帧之间至少隔最快输出刷新周期的 0.9 倍; 页面没出新帧时退回 wl_surface 的
  frame 回调. `ACDE_WEB_FPS` 指定帧率.
- **通信**: acde-host `remote.ts` 的 `RemoteBridge` 按 Broker 给的能力建代理 (注入的能力直接用 natives), `define` 登记成内置模块
  `acde:<名字>` (`modules.rs` 用 V8 合成模块, 导出 `{<名字>, default}`). 事件不派到 `window` 上: 页面用模块上的 `on(类型, fn)` 订阅 (返回退订
  函数, 不认识的类型抛 TypeError; 类型见 acde-api `page.d.ts`). 其余调用经 `rpc.ts` 到 Broker (错误原样回来, 回调函数可以跨). 本文的
  `acde.<名字>.<方法>` 指 `acde:<名字>` 导出的值.
  - window web: 清单给的服务和能力; `acde.window` (标题、菜单、关闭、最小化、`requestMode` / `setGrabHint` / `setBackdrop` /
    `requestActivate` / `requestGrab` / `releaseGrab`、app 级 `shortcut(combo)`; `beforeclose` 返回 false 留住窗口; `request` 是别的应用
    `acde.open(<id>, {…})` 要它打开的东西, 要对方清单的 `open` 允许, 为一个请求开的窗口把它交给第一个 `request` 处理函数, 只给一次);
    `acde.windows` 只管它自己 `launch({slot: true})` 起的原生程序 (要清单的 `slots`).
  - desktop web: 全部服务; `acde.apps` (`list` / `launch` / `open` / `natives()` / `runNative(id)`); `acde.windows` (所有窗口, 加 `kill`、
    `invokeMenu`、`stats`、`focus` / `hide` / `show`、`animate`、session / desktop 级 `shortcut`); `acde.session`; `acde.inspect`. 另收
    `windowmenus`、`windowready`、`windowcrash {reason}`、`windowhang` / `windowresponsive`、`windowshow`.
  - 不在清单里的调用拒绝 (403, `forbidden`).
- **原生应用** (`launcher.ts`, 只有桌面能调): `acde.apps.natives()` 列可见的 `.desktop` (`{id, name, comment, icon (绝对路径, 按 hicolor /
  breeze / Adwaita 找), keywords, wmClass}`, 缓存到 applications 目录的 mtime 变了), `runNative(id)` 用 `gio launch` 起.
- **应用清单** (`acde.apps`, 解析 acde-host `apps.ts`, 校验 acde-api `validate.ts`): `id`、`label`、`icon`、`entry` (默认导出 `WindowApp` 的
  模块, 或 HTML)、`capabilities` (fs [可限 roots]、terminal、office、launch、slots、open、openFiles、session、desktops, 其余键是服务名)、
  `mimeTypes`、`heapMb` (默认 256, 最小 32)、`size` (页面尺寸, 默认 800x600, 窗框另算)、`multiple`、`frame` (默认 true)、`backend`.
  `icon` 是 `ICON_NAMES` (`@dopame/acde-api/manifest`, 和 Dopame art 引擎 `APPS` 的名字一致, 加名字两边一起改) 之一, 或 assets 下以
  `.svg` / `.png` 结尾的同源 URL; 运行时原样交给桌面 (`acde.apps.list()`、`windowopen` 的 `icon`).
- **沙箱**: 每个 web 是独立的 isolate, 页面和 acde-host 的 web.js 在同一个 realm. ⚠ 这不是安全边界: 页面碰得到宿主给 web 的原生接口
  (`sys`: 环境变量、读写文件、spawn), 能 import `file:` 模块; 系统调用级的沙箱 (Landlock / seccomp) 还没加.
- **内存和生命周期**: 堆超了只停这个 web (窗口的发 `windowcrash {reason: 'memory'}`, 桌面的重起). 关闭先问 `beforeclose` (3 秒不答就关),
  再停线程、放掉 surface, 它起的原生窗口一起关. 当前任务超过 5 秒报 `windowhang`, 回到循环报 `windowresponsive`, 桌面可以 `kill`.
  desktop web 停了 Broker 重起它 (一分钟最多 3 次). 隐藏的窗口不出帧、画布放掉; 隐藏久了丢弃还没有.
- **调试**: 每个 web 有名字 (`files#1048576`, 也是事件循环和日志里的名字); 运行中的会话用 `ACDE_DEBUG_DIR` 和 `packaging/qemu/drive.sh`.

## 网页应用 (清单, 浏览器接口, 后端)

工程、构建和 `acde dev` 是 acde 仓库的事 (`acde new / check / build / install / dev`, 框架识别、模板、listen preload). 本仓库对外只发 SDK
`@dopame/acde-api`. 运行时只认构建出来的包: 清单 `package.json`、`web/`、`backend/server.js` 和 `backend/acde-listen.js` (把每个
`listen(P)` 换成 `<sockets>/P.sock`).

**校验只有一份**: acde-api `src/validate.ts` 的 `Manifest`: `Manifest.app` 是 Broker 用的, `Manifest.check` 另加工具才查的 (资源目录、entry 和图片
落不落在 assets 下、id 重复、不认识的 capability 和 icon).

- **入口**: `entry` 是 HTML (当文档加载, 地址 `http://acde.local/`, 应用目录同时挂在 `/`), 或以 `/` 结尾 (后端渲染: 装好后端传输后
  `fetch(init.url)` 取 HTML; `page.ts` `PageSource.served`). `backend: {entry, port?}` (默认 3000).
- **脚本**: classic `<script>` (含 `src`, 先读本地资源, 没有再经后端取; 非 async 的按文档顺序在 DOMContentLoaded 前执行)、`type="module"`、
  `type="importmap"` (`modules.rs` 解析说明符时用: `imports` / `scopes`, 精确或 `/` 结尾前缀匹配, 多个合并先到先得).
- **浏览器接口 → 窗口** (acde-host `webapp.ts` / `pagecalls.ts` / `downloads.ts`): `window.close()` / `location.reload()` 关闭 / 重启这个 web;
  `localStorage` 每个应用一个文件 (`$XDG_CONFIG_HOME/acde/storage/app-<id>.json`); `alert` 画在窗口里 (`confirm` / `prompt` 返回 false / null);
  外部链接交给浏览器应用, 下载存进下载目录 (桌面收 `on('download')`); 打开 / 保存文件的选择器见「文件」的「打开和保存文件」; 隐藏 / 显示是 `visibilitychange`;
  `screen.*` 是主输出的逻辑尺寸.
- **通知**: `Notification` 转给桌面 (`on('notification')`); 桌面没在显示时 (调试窗口) 由宿主窗口发系统通知 (hostwin `notify.rs`). 页面给的文字
  当不可信数据: macOS 用 `osascript -l JavaScript -e <固定脚本>`, 文字只经环境变量 `ACDE_NOTIFY_*` 传 (放进 argv 会被当成选项); Linux 走
  `org.freedesktop.Notifications` (body 只在服务端报 `body-markup` 时转实体); Windows 还没有.
- **声音**: `Audio` / `AudioContext` (acde-dom `src/audio/`, crates/acdert `audio/`): 解码 (symphonia) 和混音 (每个 web 一个 48 kHz 立体声 f32
  `Mixer`, 线程 `acde-audio`) 到处一样. 输出: Linux PipeWire (`output.rs`); macOS / Windows cpal 默认设备 (`output_cpal.rs`, 用设备当前的采样率,
  Hermite 重采样, 设备要 f32). 3 秒没声音关流; 没有设备 (或 `ACDE_AUDIO=null`) 按墙上时间渲染丢掉.
- **还没有**: indexedDB、Web Worker、`crypto.subtle`、OffscreenCanvas / createImageBitmap、全屏和指针锁定、`:target`; `<img>` / CSS / 字体从别的主机取 (render 只读本地资源, 见「render」)、从别的主机 `import` ES 模块 (`modules.rs`).
- **后端** (acde-host `backend.ts`, unix): PATH 上有 `bun` 就 `bun --preload acde-listen.js server.js`, 否则 `node --import <acde-listen.js 的 file: URL> server.js`
  (Node ≥ 22.3; `ACDE_RUNTIME=node` (acde dev 按工程的运行时设) 时先找 node, 没有再 bun; 两样都没有不起, 打一行 warn; 同一份构建产物两边都能跑, 见 acde 的「和 acdert 的契约」), 第一个窗口打开时起, 最后一个关掉时停 (SIGTERM 进程组,
  3 秒后 SIGKILL), 一分钟内第 4 次崩溃后不再起. `child.rs` 起: 自己的会话和进程组, 环境从零建 (`ACDE_APP_ID` / `ACDE_APP_DATA` /
  `ACDE_APP_SOCKETS` / `PORT` / `NODE_ENV=production` + 会话的 HOME、PATH、LANG 等), 工作目录 `$XDG_DATA_HOME/acde/apps/<id>/`, 输出前缀
  `[<app>#backend]`, `PR_SET_PDEATHSIG` (子进程都由 `acde-fork` 线程 fork). preload 把 listen 换成 unix socket (`$XDG_RUNTIME_DIR/acde/apps/<id>/`),
  指定端口的 UDP bind 拒绝; 原生扩展开的端口管不到.
- **路由**: 页面的 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` 都由这个 web 自己的线程发 (crates/acdert `backend.rs` 的 `natives.backend`,
  每个 web 都有 → runtime `fetch.rs` `FetchClient`: ntex 的 HTTP / WebSocket 客户端, I/O 在 `acde-rt` 线程; acde-dom `core/net.ts` 的 `route`). 去哪:
  - 同源非资源路径、有后端时的 `localhost:<port>` (和 127.0.0.1、[::1]、0.0.0.0) → 自己应用的 unix socket (`Dial::Socket`, `init.sockets`; 没出现或
    拒绝连接时重试 10 秒). 没有后端的 web 同源非资源路径失败, `localhost` 走下面的网络.
  - 别的主机 (`Dial::Url`, http / https / ws / wss) → 宿主的网络: 系统 DNS, TCP, https / wss 用 `http.rs` 的 `tls()` (只给 http/1.1 的 ALPN,
    验证证书和主机名). 不经系统代理, 不自动解压 (不发 `Accept-Encoding`).
  - 和浏览器一样的规则 (页面的源是 `http://acde.local`): 跨源请求带 `Origin`、`Referer: http://acde.local/`、`User-Agent`、`Accept-Language`;
    CORS (acde-dom `core/cors.ts`): 简单请求之外先发 `OPTIONS` 预检 (不缓存), 回答要 2xx 且允许这个源、方法和头 (`*` 只在不带凭据时算,
    `Authorization` 不归 `*`); 响应没有允许这个源 (带凭据时还要 `Access-Control-Allow-Credentials: true`) 就是网络错误 (`TypeError`, `cause`
    以 `CORS:` 开头); 页面只看得到安全名单里的响应头和 `Access-Control-Expose-Headers` 列的. `Request.mode`: `no-cors` 只许 GET / HEAD / POST
    和安全名单里的头, 回不透明响应 (status 0, type `opaque`, 没有头和 body); `same-origin` 不许跨源. 重定向照常跟 (每跳都查 CORS, 换到第三个源后
    `Origin: null`). 跨源请求不带也不存 cookie (所有主机对 `acde.local` 都是第三方, 和 Safari 拦第三方 cookie 一样); 同源 (后端) 的 cookie 照旧.
  - 被禁的请求头 (Host、Cookie、Origin、Referer、Accept-Encoding、`Sec-*`、`Proxy-*` …) 页面设了也不发. 同步 XHR 只给本地资源.
  - 经典 `<script src>` 从别的主机取时不查 CORS (和浏览器一样, 不带 `crossorigin` 的脚本照样执行): `page.ts` 经 `net.ts` 的内部 `scriptSource`, 不是页面能用的接口.
- **语音输入** (runtime `src/voice/`, Linux): `listen(onEvent)` 从 PipeWire 默认输入录 16 kHz 单声道, 连豆包输入法的流式识别 (非官方接口,
  身份存 `$XDG_STATE_HOME/acde/doubao-ime.json`). 事件 `partial {text}`、结束时恰好一个 `final` 或 `error`; `stop(id)` 等定稿 (最多 10 秒), 60 秒自动停,
  新的 `listen` 取消上一个. 日志 target `acde_runtime::voice` (识别出的文字不进日志). 没有麦克风时用 PipeWire 的 `module-pipe-source` 喂 PCM.

## 文件 (`acde:fs`)

页面的 `acde:fs` 是 crates/acdert `fs.rs` 绑的 `natives.fs`, 实现在 runtime `fs/` (`Workspace` → `WorkspaceFs`), 类型 acde-api `AcdeFs`.
第一个参数是 root (`roots()` 里某项的 `path`), 第二个是相对路径: 绝对路径、`..` 出 root、经符号链接出 root 都拒绝 (`WorkspaceFs::resolve`),
root 本身不能替换或删. Finder 的根: 桌面文件夹、下载 (`XDG_DOWNLOAD_DIR` 或 `~/Downloads`, 存在时)、`~/agentos-work` (存在时), 加上用户授给
这个应用的文件夹. Windows 上隐藏和系统属性的文件按隐藏文件算. 最后看的位置记在 `$XDG_STATE_HOME/acde/finder-place.json`.

工作区内的相对路径用 `/` 分隔. Windows 上拒绝反斜杠、数据流分隔符、保留设备名和以空格或点结尾的名称;
判断解析后的路径是否在 root 内时按系统路径组件比较.

Windows 的 `XDG_DESKTOP_DIR` 和 `XDG_DOWNLOAD_DIR` 支持盘符绝对路径及普通 UNC 文件共享路径, 可用 `/` 或 `\` 分隔.
`$HOME` 可用两种分隔符展开. 设备路径、逐字路径、IPC 共享、相对路径和指向用户主目录的覆盖项使用默认目录.

**失败**: reject 一个 `Error` (`AcdeFsError`), 字段来自 runtime `failure.rs` 的 `Failure`: `message` 人读的英文, `status`, node 风格的 `code`:

| `code` | `status` | 什么时候 |
| --- | --- | --- |
| `EINVAL` | 400 | 参数不对、出 root、类型不对、符号链接 |
| `EACCES` | 403 | 清单没给这个 root、系统不让 |
| `EPERM` | 403 | `copyIn` 的来源不在本应用可用的文件夹内又没有拖放授权, 或打开时被换掉 |
| `ENOENT` | 404 | 不存在 |
| `EEXIST` | 409 | 已经有了 |
| `ECONFLICT` | 409 | 打开之后被改了 / 没了 (`expectedModifiedMs` / `ifModifiedMs` 对不上) |
| `ENOTEMPTY` | 409 | 删非空的文件夹 |
| `EFBIG` | 413 | 超过上限 |
| `EILSEQ` | 400 | `readText` 读到的不是 UTF-8 |
| `ENOSPC` | 507 | 磁盘满 |
| `EIO` | 500 | 别的 (细节进日志) |

`code` 由造 `Failure` 的地方定 (`exists` / `conflict` / `with`), 否则按 status; io 错误按 `io::ErrorKind` 映射 (unix 上另认 ELOOP). 只有
`acde:fs` 是这个形状; napi `Finder.locate` 的 message 照旧是失败的 JSON.

调用: `list` / `preview` (文字最多 256 KiB) / `write` (最多 384 KiB, `expectedModifiedMs` 是字符串或 `'new'`) / `mkdir` / `rename` / `remove` /
`copyIn` …, 和文件级的:

- `stat(root, path)` → `FinderEntry & {path}` (lstat).
- `readText` → `{text, modifiedMs, size}` (最多 64 MiB, BOM 原样留), `readBytes` → `{data: Uint8Array, modifiedMs, size}`.
- `writeFile(root, path, data, {create: 'always' | 'new' | 'never', ifModifiedMs, mkdirs})` → `FinderEntry`: 写在原文件上 (打开不截断 → fstat
  比较 → 截断写入 → fsync, inode 和权限不变), 新文件 0644. 选项对象经 JSON 交给 runtime, 类型不对 `EINVAL`.
- `mkdir(root, path, {recursive})`: recursive 从 root 起逐级建, 已是文件夹算成功.

打开文件一律不跟随符号链接 (unix `O_NOFOLLOW | O_NONBLOCK`, 不会卡在 FIFO 上; Windows `FILE_FLAG_OPEN_REPARSE_POINT` 再查是不是链接).

**`copyIn` 的来源** (`fs/copy_source.rs`): `copyIn(root, dir, source)` 的 source (绝对路径或 `file://`) 先按 realpath 解析 (跟随链接), 然后只接受两种:
(a) 落在这个应用能用的某个根里 (清单的 roots 或 granted 文件夹, 同 `acde:fs` 的 `roots()`); (b) 等于宿主为这个应用记下的一次性拖放授权 (`acde_model::drop_grant`,
绑定应用 id 和规范路径, 5 分钟内未用就过期, 第一次成功的 copyIn 消耗它, 失败则归还; 授权只管 copyIn, 不管直接读). 其余一律 403 / `EPERM` (和系统拒绝的 `EACCES` 分开, 页面据此提示没有权限导入这个文件), 目标文件夹的检查不变.
打开来源后再比对它的最终路径 (Windows `GetFinalPathNameByHandleW`, Linux `/proc/self/fd`), 中途被换成链接的来源被拒绝; macOS 等 unix 只在打开前后重新解析, 较弱, 未验证.
拖放授权由宿主窗口的共用拖放入口 (`crates/hostwin/src/app.rs` `dropped`, Windows `WM_DROPFILES` 与 macOS/Linux winit 都经它) 记入. 应用 id 是 claimSurface 时该 web 的
spawn 参数 (`grants.app`, Broker 决定), 桌面没有应用 id, 记在桌面名下. Linux 会话的拖放 (`crates/window` 的 `drop_performed`) 同样在发 `dnddrop` 前按 `text/uri-list` 记下授权, 应用 id 经 `Surface::claim` 传给窗口线程.

**选文件夹和授权**: 标准的 `showDirectoryPicker(options?)` → `FileSystemDirectoryHandle` (acde-dom `dom/picker.ts`, 参数校验和错误照 Chromium,
取消或没有选择器是 `AbortError`, `requestPermission` 不弹窗; handle 只活到页面结束). 链路: acde-dom 的
`env.files` → crates/acdert `picker.rs` 绑的 `natives.picker` (不是 `acde:` 模块). 选择器在 `acde-picker` 线程上开, 先取 `choose` 事先给的答复
(crates/acdert `chooser.rs`, 三种选择器都在这里定去哪): Linux 是 portal
FileChooser (`directory: true`), macOS 是 hostwin 主线程上的 `NSOpenPanel` sheet, Windows 是 `SHBrowseForFolderW`. handle 的读写在 runtime
`fs/picked.rs` `PickedFolders` (每个 web 一份, 只在内存, 选中的文件夹当 root; 新建 `O_EXCL | O_NOFOLLOW`, 一个文件最多 64 MiB).
Windows 选择器返回盘符或 UNC 绝对路径, 内存句柄和持久授权使用同一路径规则. `bash scripts/check-directory-picker.sh` 用预设选择结果验收.
默认只读选择只给只读网页句柄. `mode: 'readwrite'` 的选择提示明确读写授权, 用户选中的文件夹同时授给调用的应用
(`acde:fs` 多一个 root `{source: 'granted', label}`, 文件夹没了是 `mode: 'unavailable'`), 记在
`$XDG_STATE_HOME/acde/grants/<应用 id>.json` (runtime `fs/grants.rs`; `ACDE_STORAGE` 为空时只在内存); 桌面选的不授. `fs.revoke(rootPath)`
收回. Broker 起 web 时 grants 带应用 id, `web.rs` 给 `Workspace::scoped(roots, app)` 和 `natives.picker`.

**打开和保存文件**: `showOpenFilePicker` / `<input type=file>` / `showSaveFilePicker` (acde-dom `dom/picker.ts`、`dom/forms.ts`) → `env.files.open` /
`save` → acde-host `pagecalls.ts` 的页面调用 `open` / `save` → Broker `#fileChooser()` 的 `native.FileChooser` 的 `openFile({title, multiple,
directory, filters})` / `saveFile({title, name, filters})`, filter 是 `{name, globs, mimes}` (页面的 `types` / `accept` 换来的), 回路径列表 / 路径
或 null (取消). 选中的文件只给这个页面读写 (`pagecalls.ts` 记着). 没有 `FileChooser` 时打一行 warn, 页面得到 `AbortError` / `cancel`.
- 会话: runtime `portal.rs` 的 napi `FileChooser` (portal 的 `OpenFile` / `SaveFile`).
- 宿主窗口: crates/acdert `hostnative.rs` 换上自己的 `FileChooser`, 在 `acde-chooser` 线程上走 `chooser.rs`: 先取 `choose` 的答复; Linux 有窗口时
  是 portal (runtime `open_files` / `save_file`, 和 napi 同一段); 别的交给 hostwin 主线程: macOS 是挂在宿主窗口上的 `NSOpenPanel` /
  `NSSavePanel` sheet; Windows 是 `platform/win32/dialog.rs` 的 `IFileOpenDialog` / `IFileSaveDialog`, 以宿主窗口为 owner (`multiple` 是
  `FOS_ALLOWMULTISELECT`, `directory` 是 `FOS_PICKFOLDERS`, 总是 `FOS_FORCEFILESYSTEM`, 返回盘符或 UNC 绝对路径, 取消回 `None`); headless 回错.
  COM 的 vtable 在 `dialog.rs` 手写 (windows-sys 0.61 没有这些接口), 次序对照 `windows` crate 的定义, 测试覆盖选项、文件名、IShellItem 和数组.
- macOS 的类型过滤 (`chooser.rs` `content_types`): `*.ext` 按扩展名、MIME 按 MIME、`image/*` / `text/*` / `audio/*` / `video/*` 按大类换成
  UTType; 有一项换不了 (`*`、别的通配、`application/*`、不认识的 MIME) 就不限类型 (宁可多给不能少给). UTType 按类型的继承匹配: `text/plain`
  也放行 Markdown, 和 Linux 上 shared-mime-info 的子类型一样. 保存面板不按 filters 限扩展名 (GTK 的保存对话框也只拿它筛显示的文件),
  建议的名字原样填进去.
- Windows 的类型过滤 (`dialog.rs` `specs`), 同 Chromium 的 `accept`: 过滤器有 `*.ext` 扩展名时只按扩展名映射成 `SetFileTypes`, 同一过滤器里的 MIME 忽略
  (`types: [{accept: {'image/png': ['.png']}}]` 只显示 .png). 只有没有扩展名的过滤器 (只有 MIME) 退回 All files, 因为 Windows 没有完整的 MIME 到扩展名表;
  一项扩展名换不了 (`*`、`report-*`、含 `;`) 也整体退回 All files, 不藏起页面接受的文件 (宁可多给不能少给, 和 macOS 同一规则).
- 验收: 无头 `bash scripts/file-chooser/check-file-chooser.sh` 用 `choose` 的预设答复 (`answerOpen` / `answerSave`) 检查打开多选、取消、无答复时失败、
  保存写入句柄、保存取消. 真对话框: `pwsh -NoProfile -ExecutionPolicy Bypass -File D:\Projects\AgentComputer\acdert\scripts\file-chooser\real-dialog-acceptance.ps1`
  (有界面的桌面, 会打开真的打开/保存对话框). 它用 dev 管道 (`ACDE_DEV`) 点探针页面的按钮、读结果行, 用 UI Automation 找到宿主窗口拥有的对话框
  (文件名框的值不对外暴露, 所以路径经剪贴板 Ctrl+V 贴进去, 确认 Enter, 取消 Esc; 每次按键前核对前台窗口是对话框, 否则不输入), 检查列表项和保存结果, 截图和
  `summary.json` 写到 `logs/file-chooser-real.<时间戳>`. 人工探针 (`scripts/file-chooser/manual-file-chooser.ts`) 仍可用, 不带参数时新建
  `logs/manual-file-chooser.<时间戳>`; 它的 `--prepare-only` 只生成环境.

## 默认应用

一个入口 `Opener.open(路径或 URI, {app?, select?})` (acde-host `open.ts`, runtime `bus.rs`), 四条路进来: `acde.openPath` (桌面和有 `openFiles`
的应用)、会话总线的 `org.freedesktop.FileManager1` (`ShowFolders` / `ShowItems` / `ShowItemProperties`)、`org.dopame.Acde1.Open`
(`acdert open [--app <id>] <路径|URI>...`, 没有会话时退出码 3)、原生程序的 xdg-open (经装的 desktop entry 回到 `acdert open`).

- **选应用**: 类型 (文件夹 `inode/directory`; 链接 `x-scheme-handler/<scheme>`; 文件见下) → 按 XDG
  MIME Applications 规范读 mimeapps.list (每个目录先读 `acde-mimeapps.list`), `acde-<app>.desktop` 指 acde 应用; 没设过的用清单 `mimeTypes`
  写了它的第一个应用 (全名先于 `type/*`), 再没有用原生程序.
- **文件的类型** (`MimeTypes.of`): 先问 `gio info` (Linux). 它给不出 MIME 时 (macOS 的 gio 回 UTI, 或没有 gio) 按 shared-mime-info 的
  `mime/globs2` 匹配文件名 (`mimedb.ts`; XDG 数据目录, macOS 另加 Homebrew / MacPorts 的 `share/mime`; 每个进程读一次; `__NOGLOBS__` 照规范):
  完整文件名先于通配, 再比权重、模式长度、区分大小写的优先. 打平时用 `file --mime-type`: 它是候选之一就用它, 否则挑和它一样是不是文本
  (`text/*` 或经 `subclasses` 到 `text/plain`) 的那个, 和 gio 用 magic 消歧义一样. 一个也没匹配上用 `file`, 再用扩展名表. 这样 macOS 的
  宿主窗口和 Dopame OS 得到同样的类型 (`.md` 是 `text/markdown`, 不是 `file` 说的 `text/plain`). 数据库不进包 (shared-mime-info 是 GPL),
  没有时打一行 warn (macOS 提示 `brew install shared-mime-info`), 类型会和 Dopame OS 不一样. 测试 `acde-host/test/mimedb.test.ts`.
- **macOS / Windows 的宿主窗口没有原生程序** (没有 XDG 的 `.desktop`): `natives()` 是空的, 要交给原生程序的那几条路回 `no_app` /
  `outside_roots`, 和没装原生程序的 Dopame OS 一样, 不转给宿主系统的应用.
- **交给应用**: 应用收 `request` (和 `acde.open` 同一个事件), 窗口提前 (桌面收 `windowshow`); 有 `fs` 的拿 `{root, path, file}`
  (`fs.locate`), 没有的拿 `{url}`. 不在任何根里的文件交给原生程序 (`gio launch`), 没有就报 `outside_roots`.
- **改默认**: `acde.setDefault(mime, 应用)` 写 `$XDG_CONFIG_HOME/acde-mimeapps.list` (只在 `XDG_CURRENT_DESKTOP=acde` 下生效).
  `acde.handlers(路径)` 列能打开它的应用.
- `acdert applications <目录> [--package <包目录>]` 给有 `mimeTypes` 的应用写 `acde-<app>.desktop` (`Exec=acdert open --app <app> %U`,
  `NoDisplay`, `OnlyShowIn=acde;`) 和 `acde-mimeapps.list`.
- 总线名字只在自己的会话里拿 (`ACDE_BUS_NAMES=1/0` 强制), 允许被替换; 不装 D-Bus activation 文件.

## 看和操作桌面 (`acde:inspect`)

给 agent 用: 不截图, 把屏幕变成文字的语义树, 按 ref 点击、输入、按键. 只有桌面 (`acde.inspect`) 和桌面包的服务 (`ServiceContext.inspect`) 拿得到.

- **网页的树** (render `Dom::semantics(root, limit)`, `dom/semantics.rs`): 节点 `{id, role, name?, value?, states?, level?, rect, children?}`, id 是
  render 的节点 id (ref 跨次稳定). 角色按 `role` 属性 / 标签, 都没有但 `cursor: pointer` 的是 `clickable`; 名字按 aria / label / alt / 文字, 最多
  120 字; 剪掉不可见的子树, 没有角色名字状态的展开; 每个父节点最多 60 个子节点, 全树最多 limit (默认 600).
- **web 侧** (`pageinspect.ts`): `tree(root, limit, offscreen)` (`offscreen` 时不剪掉滚到可见范围外的子树, 不可见的照样剪)、`query(selector, within,
  limit)` (`querySelectorAll`, 每个元素再用 `semantics(id, 1, true)` 取它自己的角色名字状态, 没有语义的给 `generic` 和 aria-label / title / 文字,
  加 `tag` 和 `visible`: 有大小、不是 hidden / display:none / 透明)、`point(id)` (元素可点的一点: 先 `scrollIntoView`, 在中心和四个四分点上 `hitTest`, 全被挡时报挡住的
  元素)、`type(id, text, replace)` (走输入法提交那条路 `Host.insertText`)、`select(id, values)` (元素自己、祖先或里面的 `<select>`; 按 value
  再按文字找选项, 禁用的回错, 单选给多个回错; 设好后发 `input` 和 `change`)、`focus(id)`, 坐标加 `contentOffset`.
- **Broker** (`inspect.ts`): 窗口 ref `w0` (桌面)、`w1` …, 元素 `w3.12`. `snapshot({window?, ref?, all?, diff?, limit?, find?, tree?, offscreen?})` →
  `{text, windows, trees}`: 先列窗口, 再列焦点窗口 (或指定的) 的树, 一行一个节点 `- button "新建文件夹" [pressed] [w1.52]`; `find` 只给名字或
  值含这段文字的元素和祖先; `diff` 只给变了的行 (`+` / `~` / `-`), 变化超过六成整个重列. `act(ref, action, arg)` → `{ok, text}`: 做完等页面安静
  (200 ms 没有 DOM 变化, 最多 3 秒; 原生窗口 0.4 秒), 窗口表或焦点变了先等新焦点窗口安静. `run(steps)` 依次做, 失败就停. 动作: click /
  double / right / hover / scroll 按 `point` 的屏幕坐标经 `Shell.inject` 发 (被盖住时先提前目标窗口); type / settext 走 web 的 `type`;
  key (`"ctrl+a backspace"`) 先 focus 再注入; select (arg 是选项的值或文字, 多选给列表) 走 web 的 `select`; drag (arg 是目标 ref, 元素或窗口,
  可以在别的窗口) 在源上按下、量目标 (`point`, 可能滚动; 目标被别的窗口盖住时松开并回错)、分 10 步每步 16 ms 移过去再松开, 页面的指针拖动和
  HTML5 拖放 (也跨窗口) 都靠它. 窗口 ref 能 focus / restore / minimize / close / key. `open(name)` 按 id、名字找应用或原生程序起它. `query({selector, window?, ref?, limit?, attributes?})` →
  `{window, count, nodes}`: 在窗口 (默认焦点窗口) 或某个元素下按 CSS 选择器找, 节点是 `InspectMatch` (`InspectNode` 加 `tag`、`visible`, 给了
  `attributes` (最多 20 个属性名) 再加 `attributes: {名字: 值或 null}`), ref
  能直接给 act (不在语义树里的元素也行: `point` 按 render 节点 id 找元素).
- **原生窗口** (runtime `atspi.rs`, napi `Accessibility`, Linux 会话): 读 AT-SPI2. 起服务时把 `org.a11y.Status.IsEnabled` 设成 true; GTK3 总上报,
  Qt 要开关为 true 且在真的显示平台上. `tree(pid, title, limit)` 按 pid 找应用、按标题挑顶层窗口, 角色规范成 ARIA 风格; act 先试 AT-SPI 的
  Action / EditableText / GrabFocus, 不行按坐标. 检查 `crates/runtime/tests/atspi-check.sh`.

## 组件契约

改接口先改这里.

### render (`crates/render`, Rust 接口)

- `Document::new(width, height, scale, &Options {base_url, resources: [Resource {prefix, dirs}], default_lang, verify_paint, svg_text_path,
  reduced_motion, dark, name})`: 尺寸是物理像素. 同源资源按最长前缀在 dirs 里找, `file:` 直接读盘, 不联网, 读不到回空. `Document` 发句柄:
  `dom()` (JS 线程)、`handle()` (出帧方).
- 线程: 文档由 JS 线程和 `acde-render` 线程共用 (一把锁).
- DOM: `Dom` 实现 acde-dom 的 `DomNative` (契约 `web/packages/acde-dom/src/native.ts`, 同名 snake_case). 节点 id 是 u32 不复用, `<html>` 是 0;
  查询是 CSS 像素; 错误说明以 DOMException 名字开头. 改了文档还没 `Dom::commit` 时 render 不出帧, 期间的指针和滚动在 commit 时按顺序放回.
  连在文档上的节点一直活着, 断开的子树有 JS 包装 (pin) 才活; 包装对象连着时强引用, 断开变 WeakRef, 回收时 unpin (acde-dom `realm.ts`).
  `hit_test` 返回节点 id; `caret_rect` / `caret_from_point` / `text_rects` (偏移是 UTF-16).
- 出帧 (物理像素): `RenderHandle {tick(now_ms), frame(), scroll_at, pointer, commit, invalidate, set_waker}`. CSS 动画的时钟是单调墙上时间,
  tick 只对齐到 vblank. `Frame {plane, panels, size, animating, commit, trace}`: plane 是整页 (含画布背景, 不含面板); `panels` 是
  `Dom::set_panel` 钉住的元素 `Panel {id, size, plane, extent}`. `Plane {drawing, layers, damage, damage_rects (最多 8 块), bounds}`;
  layers 是有 backdrop-filter / filter 时切成的段, 每段 `{drawing, bounds, backdrop, filter}` (`Drawing` 出 `scene` / `scene_for`): backdrop 先处理画布上已画的那块再画这段, filter
  先画进临时纹理再合成. 光栅化方 (acde-gpu) 做 backdrop 的 blur / saturate / brightness 和 filter 的 drop-shadow、模糊、颜色矩阵, 别的滤镜忽略.
- `Dom::capture(id, scale)`: 单独录一个元素 (拖动图标), 单边超过 2048 缩小; JS 拿 `picture` 编号 (`dom.rs`, 每个 web 留最后一个).
- canvas 2D (acde-dom `dom/canvas.ts` 编成命令流, `Dom::canvas`): 要像素的都在 GPU 上 (render `gpu.rs`, 用 `acde_gpu::Gpu::publish` 登记的设备):
  超过 20000 条命令 (`ACDE_CANVAS_MAX_COMMANDS`) 画成纹理再接着记, canvas 当图片源是 `GpuImage`, `shadowBlur` 用 `blur.wgsl`,
  `getImageData` / `toDataURL` 同步读回. 提交都拿 `Gpu::submit_lock`.
- 选项 `default_lang` (默认 zh-Hans, 选 CJK 地区变体)、`reduced_motion`、`dark` (事后用 `set_reduced_motion` / `set_dark` 改, 都只改
  viewport, 媒体查询和 `matchMedia` 跟着变). `semantics(root, limit, offscreen)`: offscreen 时不按可见范围剪. `<iframe>` 不加载
  (`skip_iframe_content`), 只是空盒子. 增量录制见 vendors/acrender; `ACDE_PAINT_VERIFY=1` 每帧再整页录一次比对 (测试用). 图片缓存最多 256 张 /
  64 MB. 所有入口 `catch_unwind`.
- 窗框 (`decoration.rs`): `Decoration::scene(&Bar {title, width, height, scale})` → 物理像素的场景 (背景 #f4f2f7, 三个 12 px 圆点, 标题居中截断);
  `Bar::button_at(x, y)` 是按钮命中. 测试 `tests/decoration.rs`.

### shell (`crates/shell`, napi 类 `Shell`)

完整的 Wayland 合成器 (smithay), 自己的线程 (calloop). 上机 DRM/KMS + libinput, 无显示器用 RDP 后端 (`ACDE_BACKEND=rdp`).

- 协议: xdg-shell / xdg-dialog / xdg-decoration (回 client-side)、`acde_window`、linux-dmabuf v4、wl_drm、syncobj、presentation、fifo /
  commit-timing、viewporter、fractional-scale、pointer-constraints / relative-pointer / gestures、data-device、xdg-activation、cursor-shape、
  wlr-layer-shell、ext-session-lock、idle、text-input-v3 + input-method-v2 + virtual-keyboard、keyboard-shortcuts-inhibit、xdg-output.
  第三方的 popup 和 layer-shell surface 在表里是 `pinned`. maximize 不理.
- Broker 侧: `Shell.broker()`; `onEvents(cb)` / `pump()`; `grant({desktop?, window?, mode?, rect?, size?})` → `{window, token}` (随机 64 位令牌,
  客户端在 `acde_window.bind` 里交回一次); `release`、`place`、`windows()`、`animate`、`shortcut` / `unshortcut`
  (冲突抛错)、`focus`、`hide`、`close`、`quit` (等合成器线程拆完, 最多 3 秒)、`socketName`、`launch(argv, {cwd, env})`、`stats(reset?)`、
  `screenshot(path)`、`inject(...)`.
- web 侧: `claimSurface(token, {frame?})` (crates/acdert `webnative.rs` → crates/window `Surface::claim`: 连上合成器、开 toplevel、bind 令牌;
  一条 `acde-window` 线程管 Wayland 和光栅化) 给出 surface: `pump`、`wait()` (队列非空时落定)、`requestFrame`、`setClipboard`、
  `readClipboard()`、`startDrag(data, icon?)`、`setTitle`、`setImeArea`、`window`、`hosted`、`contentOffset`.
- 事件 (`Event`, 坐标逻辑像素, button / code 是 evdev 码). 给 surface 的: `pointermove` / `pointerdown` / `pointerup` / `wheel` /
  `pointerleave`、`keydown` / `keyup {code, key}`、`imepreedit` / `imecommit` (宿主窗口)、`activate` / `deactivate`、`framebutton {key}`、
  `frame {time}`、`resize {width, height, scale}` (页面的物理像素, 已减去窗框)、`dndenter` / `dndmove` / `dndleave` / `dnddrop {x, y, data}`
  (data 是类型 → 文本, 松手时已读好)、`dragend {button}` (1: 放到了别的窗口上)、`grab` / `grablost`. 给 Broker 的: `output`、`windowopen` /
  `windowclose` / `windowtitle` (原生窗口)、`windowfullscreen` / `windowunfullscreen`、`windowminimize`、`windowactivate`、`windowanimated`、
  `shortcut` (转给 owner)、`windowgone {window, x, y, width, height}` (web 窗口最后的 rect, 全屏的是之前的)、`windowminsize`、`windowparent`、
  `windowcloserequest` (宿主窗口)、`devreload` / `devrequest`、`milestone`、`inputtarget` (`ACDE_DEBUG_INPUT`)、`exit`.
- 注入 `inject({type, x, y, button, dx, dy, source, code})`: `move` / `motion` (相对) / `down` / `up` / `wheel` (source `wheel` / `finger` /
  `continuous`) / `keydown` / `keyup`, 和真实输入同一条路由.
- HiDPI: 整数缩放 `floor(DPI / 96 + 0.3)` (1 到 3), `ACDE_SCALE` 指定 (可以是分数); 多块输出按逻辑宽度从左往右排. 光标一律合成进画面
  (DRM 光标平面在带 T2 的 Mac 上 2 倍缩放时出错). 环境变量 `ACDE_SOCKET`、`ACDE_RENDER_NODE`, 调试用 `ACDE_WEB_FULL` / `ACDE_WEB_POLL` /
  `ACDE_SCANOUT=0`.

### GPU 与性能 (硬约束)

- **整条链路不许 CPU 拷像素、不许 GPU 回读**. 例外: RDP 后端 (回读损坏区域)、截屏 / capture、标准接口要同步给像素的 (`getImageData` /
  `toDataURL`).
- **网页只在 GPU 上画**: 没有 CPU 光栅化, 不认 CPU 类型的设备 (lavapipe). 没有 GPU 时网页图层不可用 (日志 `web layer unavailable`), 页面不出帧.
  合成器自己 (GLES) 不在此列.
- **不依赖 acgpu, 不带专用驱动**: 只经标准图形接口 (wgpu), 每个 OS 只编一个后端: Windows DX12、Linux Vulkan、macOS Metal
  (`acde_gpu::BACKEND`). crates/gpu (`acde-gpu`) 是 2D 场景 (`PaintScene` / `Scene` / `RenderCommand` / `Filter`, blitz-paint 和 render 直接
  画进它) 和渲染器 (vello: `Vello` / `Raster` / `Composer` / `Device` / `Offscreen`, `Gpu` (设备登记, 唯一一份), `GpuImage`, Linux 上 dma-buf 画布导入和 sync_file); crates/paint
  只剩线程、GBM 画布、损伤和区域、把帧拆成 `Part` (`plane.rs`).
- Windows DX12 的着色器编译器是静态链接的 DXC (wgpu `static-dxc`, mach-dxcompiler 的预编译库): 不用 FXC (FXC 编的 vello 着色器约 10 秒后
  `DXGI_ERROR_DEVICE_REMOVED`), 不用 dxcompiler.dll.
- 原生应用经 linux-dmabuf v4 零拷贝, 全屏且格式合适时直扫; pre-commit 钩子等 syncobj acquire point 或 dmabuf 的读 fence. 缺口: presentation
  不是硬件时间戳, 没有 tearing-control 和 VRR.
- 网页图层 (会话): vello 画进 web 自己 GBM 分配的 linear dmabuf, sync_file 落定后 commit. 光栅化线程 `acde-web` 一次一帧, CPU 编码和 GPU 执行
  重叠, 挪窗口不重新光栅化, 闲 2 秒放掉中间纹理.
- 帧预算: 120 fps 下每帧 8 ms. 盯 acde-dom `test/cost.test.ts` / `test/caches.test.ts`、shell / DomNative 的 `stats`、`drive.sh perf`; 提交里写测到的数.
- WebGPU (`navigator.gpu`, 只在 Linux): crates/acdert `webgpu/`, 跑在光栅化线程的设备上; 回调由 `acde-gpu-poll` 线程非阻塞轮询 (每帧路径上不用
  `poll(Wait)`, 它拿着 snatch 读锁会卡住别的线程的提交). WebGL 还没有, 要做时也只经 wgpu.

## 构建、运行、平台

```sh
cargo build --release -p acdert                # target/release/acdert
cd web && bun install && bun run build         # packages/acde-host/dist/{broker,web}.js
../target/release/acdert desktops              # 装了哪些桌面
ACDE_PATH=<acde-dopame 的包目录> ../target/release/acdert --desktop dopame
```

`ACDE_APP` 指向直接包含 `broker.js` 和 `web.js` 的目录, 源码构建用 `web/packages/acde-host/dist` 的绝对路径. 未设置时,
acdert 先查可执行文件旁的 `app/dist`, 再查 `<exe>/../../web/packages/acde-host/dist`. 若 `CARGO_TARGET_DIR` 在别处, 显式设置 `ACDE_APP`.
验证平台: macOS 和 Windows 11 LTSC x64 (宿主窗口); Linux 的会话在有 GPU 的真机上, Linux 的宿主窗口只写不验.

**Windows**: 只出一个 x64 binary, MSVC v143 编. 要 VS 2022 17.11 以上 (MSVC 14.41+) 的 C++ 工具和 ATL 组件
(`Microsoft.VisualStudio.Component.VC.ATL`): 静态 DXC 的预编译库要新版 STL 的 `__std_*` 和 `atls.lib`, v142 链接不了, 不支持.
CRT 静态链接 (`.cargo/config.toml` 的 `+crt-static`). arm64 暂不做 (没有静态 DXC 的预编译库). `WGPU_VALIDATION=1` / `WGPU_DEBUG=1` 打开
D3D12 调试层 (要装「图形工具」可选功能). 没有: terminal、应用后端、通知、WebGPU、network / office / 语音. 依赖里不要 winapi
(见 vendors 的 fslock、async-dnssd).

编好 acdert 和网页宿主后, 在有 GPU 的机器上用 `bash scripts/check-standalone.sh` 验证独立应用启动、重载、退出和服务清理.
脚本以无窗口模式运行, 测试包和日志写到 `logs/standalone.*`.

有图形会话的 Windows 上用 `bash scripts/audit-thread-progress.sh` 复查双窗口的 JavaScript 与出帧进展. 脚本会调整并关闭自己的宿主窗口,
在 `logs/thread-audit.*` 保存运行时日志、线程采样、截图和各步骤用时.

### 命令

```sh
acdert                                    # 会话: 桌面按「桌面包」的规则选
acdert --desktop dopame                   # 那个桌面 (id 或包目录)
acdert --greeter                          # 登录页 (greetd)
acdert desktop <id|目录>                  # 调试桌面 (acde dev)
acdert app <id|目录>                      # 调试窗口: 只跑一个应用
acdert desktops                           # 装了的桌面和外部会话 (不要显示器)
acdert sessions DIR --package PKG         # 给包的每个桌面写 acdert-<id>.desktop
acdert applications DIR --package PKG     # 「默认应用」的 desktop entry 和 acde-mimeapps.list
acdert open [--app ID] PATH|URI...        # 在运行中的会话里打开
acdert run FILE [ARGS...]                 # 在一个 isolate 里跑一个模块 (runtime 的 tests/ 用)
acdert --size 1920x1080 --scale 1         # shell 报输出之前的 CSS 尺寸
acdert --launch foot --seconds 10 --stats # 起一个程序; 10 秒后停; 打印 stats 和窗口表
```

环境变量: `ACDE_PATH`、`ACDE_DESKTOP`、`ACDE_STORAGE` (桌面的 localStorage 文件, 默认 `$XDG_CONFIG_HOME/acde/storage/<desktop>.json`, 空: 只在
内存)、`ACDE_REDUCED_MOTION=1/0`、`ACDE_AUTOSTART=1/0`、`ACDE_DEBUG_DIR`、`ACDE_BUS_NAMES=1/0`、`ACDE_COLOR_SCHEME=light/dark`、`ACDE_SIZE`、
`ACDE_DEV`、`ACDE_HOST_DUMP`、`ACDE_HEADLESS=1`、`ACDE_SCALE` (headless 的缩放)、`ACDE_AUDIO=null`; shell 的见上.

- **配色** (`appearance.ts`): `ACDE_COLOR_SCHEME`, 否则 portal 的 `org.freedesktop.appearance` `color-scheme`, 变了发给所有 web (`matchMedia` 发 change).
  **语言** (`language.ts`): 按 `LANGUAGE` / `LC_ALL` / `LC_MESSAGES` / `LANG`; `acde:session` 的 `setLanguage(tag)` 写 `locale.conf` 并发 `languagechange`.
- **远程桌面**: `ACDE_BACKEND=rdp` 离屏合成用 RDP 送出 (shell `compositor/rdp.rs`). 要 `ACDE_RDP_USER` / `ACDE_RDP_PASSWORD` 和证书
  (`ACDE_RDP_CERT` / `ACDE_RDP_KEY`, 默认 `$XDG_CONFIG_HOME/agentos/rdp/{cert,key}.pem`); `ACDE_RDP_ADDR` (0.0.0.0:3390)、`ACDE_SIZE`
  (默认 1440x900)、`ACDE_RDP_SECURITY` (tls / nla). 还没有: 光标形状、Unicode 键和剪贴板、跟着客户端改尺寸、多个客户端.
- **调试运行中的会话** (`ACDE_DEBUG_DIR=<目录>`): 放进去的 `<name>.mjs` 由 Broker import, 默认导出拿 `DebugApi` (`debug.ts`: `broker`、`shell`、
  `web(name, code)`、`webs()`、`stats(reset?)`、`sleep`、`readText`、`readDir`), 结果写到 `<name>.out`. `ACDE_DEV` 设了时 web 的 debug eval 也开.
- **启动标记**: 每个里程碑一条 info (target `acde_host`) `startup: <标记> ms=<进程启动以来>`: Broker `shell created` / `services starting` /
  `services started` / `shell <里程碑>` (合成器的 `first commit` / `first vblank` / `first native window`) / `autostart`; 每个 web `page load started` / `desktop loaded` (或 `loaded`) / `shell running` / `first frame`.

## 发版

`.github/workflows/release.yml`, 三个平台各编一个 release 的 `acdert` (`cargo build --profile dist -p acdert --target <triple>`, 产物在 `target/<triple>/dist/`), 文件名是
`acdert-<target triple>[.exe]`: `aarch64-apple-darwin` (macos-15)、`x86_64-unknown-linux-gnu` (ubuntu-24.04)、`x86_64-pc-windows-msvc`
(windows-2025, 要 NASM 和 `PYTHON3`). host bundle 和平台无关, 单独打成 `acdert-host-<版本>.tar.gz` (`app/`: `dist`、`brand`、`greet`、
`package.json`, `LICENSE`), 解压到 binary 旁边 (acdert 找 `<exe 所在目录>/app/dist`). 桌面包 (Dopame) 不在里面.
- 二进制 (`dist` profile, 根 `Cargo.toml`, 继承 `release`): `debug = "line-tables-only"`、`split-debuginfo = "packed"`、`strip = "symbols"`. 发出去的 binary 不带符号.
  分离的调试信息 (Windows `acdert.pdb`、Linux `acdert.dwp`、macOS `acdert.dSYM`) 只进 `symbols-<triple>` 的 Actions artifact (保留 30 天): 不上 GitHub release, 不进 pkgs.
  本地 `release` profile 不变 (`strip = true`, 没有调试信息), `scripts/` 和基准都用它, 所以它留着.
- Windows 的 PDB 路径: `.cargo/config.toml` 的 `/PDBALTPATH:%_PDB%` 让 exe 只记 PDB 的文件名 (MSVC 本来会写完整路径). CI 的 RUSTFLAGS 另加
  `--remap-path-prefix`: cargo home、toolchain、workspace 分别映射成 `/cargo`、`/rustc`、`/src`, 去掉 registry 和 toolchain 路径里的用户名.
- 发布清单: `stage` job 用 `scripts/release/stage.sh` 按固定清单组装 (三个 binary、host tarball、LICENSE、`acde-api-<版本>.tar.gz`). `scripts/release/check-stage.sh` 拒绝清单外的
  文件, 目录, 以及 `.pdb` / `.dSYM` / `.dwp` / `.debug`; release 和 pkgs 上传前各跑一遍. release 和 pkgs 只下载 `release-stage` artifact,
  不用通配. 本地演练 `bash scripts/release/dry-run.sh`: 放进假的 symbols, 检查必须拒绝, 清单里只有五个文件.
- 缓存: build job 用 `Swatinem/rust-cache@v2` (pinned major). 带 `id-token` 的 job 不用第三方 action (`pkgs` 里的 aws-actions 是例外, 待定).
  host bundle 用 release 构建 (`bun run --filter @dopame/acde-host build:release`, 写到 `web/packages/acde-host/dist-release/`): 标识符压缩, 没有
  source map 也没有 `sourceMappingURL`, 再过一遍 javascript-obfuscator 的轻量预设 (`scripts/release-options.mjs`: 只重命名标识符和字符串数组, 不做
  控制流平坦化、死代码注入、自我保护和调试保护, 它们每个 web 线程都要付运行时代价). `scripts/check-release.mjs` 是泄漏检查: 有 map、
  `sourcesContent`、`sourceMappingURL`、`sourceURL`, 或除 `broker.js` / `web.js` 外多出文件就失败. release workflow 的 host job 用它, 并检查
  整个 artifact 里没有 `.map` / `.ts`. 开发构建 (`bun run --filter @dopame/acde-host build`, `dist/`) 不变: 可读、带 map, `acde dev` 用它.
  `LICENSE` (专有许可) 随 tarball 和 GitHub release 发布. 启动和帧的数字见下面 acde-host 一条 (`scripts/release-perf/bench.sh`).

- 推 `v*` tag: 建 GitHub prerelease, 附上三个 binary 和 host bundle. 手动触发 (`workflow_dispatch`) 只编, 不建 release.
- 同一个 tag 也传到 AWS S3 桶 `dopame-pkgs` (`pkgs` job, 三个平台和 host 都编成功才传): `acdert/<版本>/` 放三个 binary、host bundle (`app/` 和 `LICENSE`)、`LICENSE` 单独一份、`acde-api-<版本>.tar.gz` (web/packages/acde-api, 不带 test/ 和 node_modules; acde 的发版拿它打包) 和 `SHA256SUMS` (缓存一年, 不再改), `acdert/latest.json` (`{version, tag, commit, base, files}`, 不缓存) 指向最新的一版;
  下载地址 `https://pkgs.dopame.ai/acdert/<版本>/<文件>`. 传完让 CloudFront `E3ET3L14ALFOXX` 失效这两处. 凭证走 GitHub OIDC,
  不存密钥: IAM 角色 `dopame-acdert-release` 只信任本仓库的 `refs/tags/v*` (sub 是不可变形式
  `repo:dopame-org@342965929/acdert@1445550002:ref:refs/tags/v*`), 只能读写 `dopame-pkgs/acdert/*`、失效那个 distribution.
- npm 上只发 `@dopame/acde-api` (用户定, 2026-11-09; npm 组织 `dopame`), 只发压缩后的构建, 见下面 web/packages 的 acde-api. 它不做混淆 (决定, 2026-11-09:
  它的 `.d.ts` 是公共接口, 混淆只增加调试难度, 收益低). 别的包不发,
  开发者装 acde 和 acdert 走 acde 仓库的 `install.sh`. 现在关着: 只有仓库变量 `NPM_PUBLISH` 是 `true` 时才发 (没设, 打 tag 不发 npm).
  打开后, release 成功后 `npm-build` 检查 tag 和 acde-api 的版本一致、npm 上还没有这个版本,
  构建 `dist/` 交给 `npm` job; `npm` 经 trusted publishing (OIDC, npm 上配的是 `dopame-org/acdert` 的 `release.yml`) 发布, 不存 token.
  拿 `id-token: write` 的 `npm` job 只用 GitHub 自己的 action (setup-node、download-artifact), bun 等第三方的只在没有这个权限的 `npm-build` 里.
- 版本号是 `0.0.N`, 每发一次 N 加 1 (前两位保持 0): 根 `Cargo.toml` 的 `workspace.package.version` 和 `web/packages/*/package.json`
  一起改 (再 `bun install` 刷新 `web/bun.lock`), tag 是 `v0.0.N`.
- Linux 的 acdert 运行时要 libxkbcommon、gbm、libudev、libinput、fontconfig、OpenSSL 3、pipewire.

## 日志和计时

Rust 一律 `log` 的宏, `crates/log` (`acde-log`) 装 env_logger: `RUST_LOG` 追加在默认的 `warn,acde=info,…` 后面; 每行
`<进程启动以来的毫秒> <级别> <线程名> <target>: <内容>`; 写 stderr 在 `acde-log` 线程上 (积压超过 8 MB 丢掉并记数), 退出和 panic 时
`acde_log::flush()`. smithay 的 tracing 进同一个 logger. JS 的 `console.*` 是 target `js`; acde-host 用 `log.ts` 的 `Log` (`Log.clock()` 和
`acde_log::now_ms()` 同一个零点).

页面错误 (`host.rs` `reportError`, 兜底 `rt.rs`) 每行以 isolate 名开头 (`[files#1048576] page error: …`); 不是 Error 的值写「类型 + 值」, 补上
`thrown at` / `rejected at:` 的位置.

计时是 debug 级、target `perf::<段>`, `RUST_LOG=perf=debug` 打开. `packaging/qemu/perf-log.sh [日志]` 按种类汇总 (次数、ms 的 p50 / p95 / max).

| target | 哪里 | 一行是 |
| --- | --- | --- |
| `perf::latency` | crates/window | 输入到上屏: `<kind> owner= ms=`, 分段 `queue` `js` `render` `raster` `present` |
| `perf::task` | crates/acdert | 事件循环里超过 8 ms 的任务: `task ms= hook=`, V8 自己的 `v8` |
| `perf::frame` | render | `<web> commit= resolve= paint= finish= ms=` |
| `perf::raster` | crates/paint、crates/window、hostwin | `job surfaces= wait= record= ms=`, `surface owner= ms=` |
| `perf::compose` | shell | `<输出> elements= ms=`, `rdp elements= rects= ms=`, `plan inputs= layers= damage= route=`, `backdrop window= w= h= blur= ms=` |
| `perf::rpc` | acde-host | web 侧 `call <服务>.<方法> error= ms=`, Broker 侧 `serve …` |

`perf::latency` 来自 `acde_log::Trace`: 进队列 → JS 取走 → commit → 出帧 → 光栅化完 → vblank.

JS 热点: `ACDE_PROFILE_DIR=<目录>` 让每个 isolate 开 V8 采样 profiler (`profile.rs`, 250 µs), 每 `ACDE_PROFILE_SECONDS` (默认 30) 秒和结束时写
`<名字>-<n>.cpuprofile`; `bun packaging/qemu/profile-top.mjs [--top N] [--callers 函数名] 文件...` 汇总. 原生调用的时间多半记在调用它的 JS 函数上.

## 协作规则

- 闭源 (用户定, 2026-11-08): 自己的代码是专有的 (根目录 `LICENSE`), package.json 写 `"license": "UNLICENSED"`, Cargo.toml 不写 `license`
  (都 `publish = false`), 除 `@dopame/acde-api` 的压缩构建外不发 npm 包, 仓库和 release 不公开. `vendors/` 和 crates/acde-napi 保留上游的许可证文件和版权行.
- Rust 和 TypeScript 代码不写注释, 要说明的写进本文件. 例外: 版权和许可证行 (crates/acde-napi 的 Deno 版权)、工具指令 (`/// <reference>`,
  `@ts-expect-error`)、`vendors/` 改动处的 `acrender:` / `acde:` 标记. derive 要读的文字写成属性.
- 几个会话共用工作区和 git index: 只改自己负责的路径, 别人没提交的文件先等. 提交一律 `git commit -- <自己的路径>`, 推前 `git show --stat HEAD`
  和 `git log origin/main..HEAD` 看一眼. `git add` / `git rm` 之后立刻提交.
- 不 force push, 不 amend / rebase 已推送的提交. 提交信息英文, Conventional Commits, 每行不超过 72 字符, 正文写原因和验证情况 (性能数字注明
  负载), 不加 Co-Authored-By.
- 改 `crates/shell`、`crates/render`、`crates/hostwin`、`vendors/acrender` 或 `web/` 的提交, 先在这棵树编出来的 acdert 上起一次, 提交信息里写验了
  什么、没验什么. 汇报时分开写「已验证 / 未验证」.
- 系统调用走 rustix, 不直接依赖 libc; rustix 没有的用专门的 crate (signal-hook、jiff). 按平台的代码用 `#[cfg]` / `cfg_select!`, 先用 std.
- 依赖版本只写主版本号 (`log = "0"`, `wgpu = "30"`), 用最新的; 例外是 `[patch.crates-io]` 换成 `vendors/` 的 crate 和配套的 (blitz-*、stylo*、
  parley、html5ever、cssparser) 用 `=` 钉住.
- `Cargo.lock` 不进 git (`.gitignore`): 依赖按 Cargo.toml 解析到最新. 改了依赖, 提交前 `cargo build --release -p acdert` 必须通过; clippy 要过.
  `web/bun.lock` 进 git, 改依赖时放在同一个提交里.
- 诊断用 `log` 的宏, 不用 `eprintln!` (测试、命令行输出除外).
- Rust 代码提交前 `cargo fmt --all` (根目录 `rustfmt.toml`: 宽 160, `use_small_heuristics = "Max"`; `vendors/` 不在 workspace 里, 不碰).

## 目录

| 路径 | 职责 |
| --- | --- |
| `crates/acdert` | `acdert` 可执行文件: 内嵌 V8 (rusty_v8), 每个 isolate 的事件循环 (`rt.rs`), 模块加载 (`modules.rs`), web 线程 (`web.rs`), DOM 绑定 (`dom.rs`), 注入的能力, 声音, inspector, 主进程 (`supervise.rs`, Linux) |
| `crates/shell` | Wayland 合成器 (Linux 会话), napi `Shell` |
| `crates/hostwin` | `acde-hostwin`: 调试模式的宿主窗口和合成 (见「宿主窗口」) |
| `crates/render` | Blitz 包成的渲染引擎 (`Document` / `Dom` / `RenderHandle`), 窗框 `Decoration` |
| `crates/gpu` | `acde-gpu`: 2D 场景和 vello 渲染器, 每个 OS 一个 wgpu 后端 |
| `crates/paint` | `acde-paint`: 会话里 web 的光栅化线程 (帧 → GBM dmabuf), WebGPU 和 canvas 共用的设备 |
| `crates/window` | `acde-window`: 会话里 web 的 Wayland 客户端 (sctk): toplevel、dmabuf、输入、剪贴板、拖放、`acde_window`、窗框子 surface |
| `crates/runtime` | 系统接口 (napi 导出 + 注入用的 Rust 对象). 异步执行器 `rt.rs`: `acde-rt` 线程上的 ntex System (不用 tokio, TLS 用 OpenSSL). 检查: `cargo test -p acde-runtime` (含真 pty 上的终端、copyIn、unix socket 上的 HTTP / WebSocket)、`ime-check.sh`、`portal-check.sh`、`atspi-check.sh` (经 `tests/run.sh`) |
| `crates/model` | canvas / 窗口表、计划、快捷键、shell 事件 (`Event` / `Inbox`)、`acde_window` / `acde_shell` 协议 |
| `crates/log` | `acde-log`: 日志和计时 |
| `crates/acde-napi` | rusty_v8 实现的 Node-API (napi8), 让 `#[napi]` 导出在 Broker 里可用. 改自 Deno `ext/napi` 0.191.0 (MIT, LICENSE-MIT), 去掉了用不到的入口 |
| `web/packages/acde-host` | acdert 的 JS: Broker 和每个 web 的宿主, 包发现, 桌面服务, 登录页 |
| `web/packages/acde-dom` | web 里的浏览器全局对象和 DOM |
| `web/packages/acde-api` | `@dopame/acde-api`: SDK (唯一对外发布的 JS 包) |
| `packaging/arch` / `office` / `qemu` | Arch 包; ONLYOFFICE Document Server 容器脚本; 会话里驱动和测量 |

### web/packages

Bun workspace (`bun install`, `bun run build`, `bun run typecheck`, `bun run test`; 测试是 `bun test`, 没有 Node).

- **acde-api**: `load(name)` (`src/load.js`: `import('acde:<name>')` 的默认导出, 拿不到时是 null; 说明符带 `@vite-ignore` 等)、
  `@dopame/acde-api/vite` (build 时 `acde:*` 留作外部模块, dev 时换成会 reject 的替身); 声明 `manifest.d.ts` / `service.d.ts` / `page.d.ts` /
  `config.d.ts` (+ `config.schema.json`) / `modules.d.ts`; `src/validate.ts` (导出 `./manifest`) 是清单校验和 `ICON_NAMES`, 测试
  `test/validate.test.ts`. acde 仓库用 `file:../acdert/web/packages/acde-api`, acde-dopame 拷一份 (`scripts/sync-acde-api.sh`).
  npm 上的 `@dopame/acde-api` 不是这个目录: 它的 package.json 是 `"private": true`, 防止把源码发出去. `bun run build` (`scripts/build.mjs`)
  生成 `dist/`, 发布的是 `dist/` (`cd dist && bunx npm publish`, 要 2FA): `.js` / `.ts` 用 esbuild 压缩 (标识符也压, 没有 source map,
  不留注释), `validate.ts` 的声明由 tsc 生成成 `validate.d.ts`, `./manifest` 改指向 `validate.js` / `validate.d.ts`; 手写的 `.d.ts` 和
  `config.schema.json` 原样拷贝 (对外接口); 去掉 `private` / `scripts` / `devDependencies`; `LICENSE` 是根目录 `LICENSE` 的版权段
  (不含第三方那段). 构建最后检查 `dist/`: 有 `.map`、非 `.d.ts` 的 `.ts`、`sourceMappingURL` / `sourcesContent` 或意料外的文件就失败.
  esbuild 装在 web 根的 devDependencies: 放在 acde-api 自己的 devDependencies 里, bun 会把它装进用 `file:` 引用它的 acde.
- **acde-dom**: 经 `DomNative` / `GpuNative` / `AudioNative` / `HostNative` (`src/native.ts`) 调 crates/acdert, 打进 acde-host 的 `dist/web.js`.
  编辑只有 `dom/editing.ts` 一份. 测试在 happy-dom 的 MockDom 上跑. 布局类的读 (rect、metrics、计算样式) 缓存到下一次写入、下一个指针事件 / 帧 / 滚动, 或这个任务结束 (CSS 过渡和动画在 render 线程上跑, JS 不知道, 下一个任务要重新读). Web Animations
  (`dom/animation.ts`): 关键帧变成 `@keyframes acde-animation-<n>` 规则加元素内联的 `animation-*`, 由 render 跑; 时间、事件、`finished` 在 JS
  里按 host 的时钟; 近似: easing 作用在每段关键帧上、endDelay 只算进结束时间、没有 composite.
- **acde-host**: 测试 `bun test` (只测不碰原生接口的模块, 如 `mimedb.ts`). esbuild 打成 `dist/broker.js` (`src/main.ts`, Broker) 和 `dist/web.js` (`src/worker.ts`, 每个 web). release 构建 (`build:release`, `dist-release/`) 的压缩、混淆、泄漏检查见「发版」. 基准 `bash scripts/release-perf/bench.sh` (Windows, 无头, 每边 5 轮中位数): 加载到 `shell running` 开发 1106 ms、release 941 ms; DOM 和布局负载 95 ms 对 107 ms; 纯 JS 负载 29.3 ms 对 29.4 ms. 多一层字符串数组混淆时加载慢约 470 ms, 所以预设不用它. 文件按本文的章节命名
  (`broker.ts`、`worker.ts` / `host.ts`、`remote.ts` / `rpc.ts`、`inspect.ts`、`devhot.ts` …); `sys/` 是原生接口的 node 风格包装. `greet/` 是登录页,
  `brand/` 的 `mark.mjs` / `art.mjs` 是 agentos 仓库 `branding/` 的原样拷贝 (只在那边改).

## vendors

依赖只来自 crates.io 和 `vendors/` (没有 git 来源; 镜像在自己的 `$CARGO_HOME/config.toml` 里换, bun 用 `BUN_CONFIG_REGISTRY`). vendors 是直接放进
仓库的源码, 改动处加 `acrender:` (ironrdp-server、fslock、async-dnssd 是 `acde:`) 注释并同步下表, 升级上游时重打. 有 `Cargo.toml` 的末尾加空的
`[workspace]`, 根 `Cargo.toml` 用 `[patch.crates-io]` 替换上游.

| 目录 | 上游 |
| --- | --- |
| `acrender` | DioxusLabs/blitz main `fb297a38`: 只留 blitz-dom / blitz-paint / blitz-traits / stylo_taffy / debug_timer (`MIT OR Apache-2.0`) |
| `fontique` / `parley` | linebender/parley |
| `stylo` / `stylo_atoms` | servo/stylo |
| `vello` | crates.io 0.11.0 |
| `taffy` | DioxusLabs/taffy `4e59968` (Blitz 钉的提交), 未改 |
| `ironrdp-server` | Devolutions/IronRDP |
| `libseat-sys` 0.2.0 / `fslock` 0.2.1 (v8 的构建依赖) / `async-dnssd` 0.5.1 (经 sspi) | crates.io |

acrender 和上游结构的不同: HTML 解析用 crates/render 自己的 html5ever TreeSink; `build_inline_layout_into` 在 `layout/inline/build.rs`; `paint_scene`
先录进 acde-gpu 的 `Scene` 再回放 (没有 anyrender, 它的 SVG 画法成了 blitz-paint 的 `svg.rs`); blitz-dom 重新导出 `taffy`. 验证: 在
`vendors/acrender` 里 `cargo fmt --all --check`、`cargo clippy --workspace --all-targets`、`cargo check -p blitz-dom --no-default-features`、
`cargo test -p blitz-dom -p blitz-paint`、`cargo clippy -p blitz-paint --all-targets --features scrollbars`; 再 `cargo test --release -p acde-render`
(加 `ACDE_PAINT_VERIFY=1` 再一遍).

**blitz-paint**

| 文件 | 改了什么 |
| --- | --- |
| `cache.rs` (新), `render.rs` `record` / `ensure` / `flatten`, `lib.rs` `paint_scene_cached` / `paint_scene_reference` | 增量录制: 按绘制边界 (根、stacking context、裁剪 / 滚动容器、图片、SVG、canvas、大列表的块级子元素) 缓存片段, `Dep::holds` 核对后复用, 帧按引用展开成 `Piece`; 表单控件和 iframe 每帧重录; LRU; 整页录制给 verify |
| `render.rs` `render_element_part` `border_box` | 边框盒在元素自己的坐标里 (否则挪过的片段不能复用) |
| `layers.rs`, `render.rs`, `render/background.rs`, `render/box_shadow.rs` | `push_layer` / `maybe_with_layer` 代替 `LayerManager` (上游超过 1024 层丢裁剪), 不建多余的裁剪路径 |
| `debug_overlay.rs` (删) | 去掉 devtools 叠加层和 euclid |
| `lib.rs` `paint_element` | 只画一个元素和子树, 不带祖先的变换 / 透明 / 裁剪 (拖动图标) |
| `lib.rs`, `render.rs` `flatten` / `render_element`, `cache.rs` `reuse` | `pinned` 元素 (面板) 不进帧, 单独展开返回 |
| `render.rs` `draw_canvas_background`, `render/background.rs` | 根 (或 body) 的整个背景铺满画布 |
| `render.rs` `draw_canvas_picture`, `cache.rs` `is_boundary` | `<canvas>` 画 2D 图, canvas 是绘制边界 |
| `render.rs`, `text.rs` | 行内元素按行画 padding / border / 圆角背景 |
| `render.rs` `draw_text_input_text` | 空输入框画 placeholder |
| `render/box_shadow.rs` | spread 加到圆角; 偏移和模糊乘缩放; 透明内阴影只跳过自己; 内阴影第一个在最上; 不模糊的内阴影一次填充 (padding box 加反向的洞, 重合的边抵消; 先填再 DestOut 挖洞时两条边落在同一像素里会剩一条淡线, xterm.js 的竖线光标) |
| `render/box_shadow.rs`, `render.rs` (滚动偏移、`draw_svg`), `render/background.rs` | 偏移在元素自己的坐标里加 |
| `render/border.rs` `draw_outline` | outline 沿中线、`outline-offset`、dashed / dotted、圆角、在内容之后、乘 opacity |
| `render.rs` `draw_svg` / `draw_simple_svg` / `draw_svg_tree` | 画 simple SVG 的命令; usvg 树相对元素画再放置 |
| `text.rs` `stroke_text` / `Ellipsis` / `draw_ellipsis_marker`, `render.rs` `ellipsis` | `text-overflow: ellipsis` 和 line-clamp 的 "…" (`Ellipsis.end` 是 frame 的内容盒宽, 已经是设备像素, 不再乘 scale) |
| `render/gradient.rs` | 色标位置按规范; 超出渐变线的色标: 线性拉长, 径向 / 锥形夹回 |
| `render.rs` `fieldset_frame` / `element_cx`, `render/border.rs` `draw_border`, `cache.rs` `visit` | fieldset 的框从 legend 中线开始, 边框在 legend 后留空; legend 算进片段依赖 |
| `render.rs` 开头 | `scrollbars` 下补 `Color` / `Stroke` 的 import |

**blitz-dom**

| 文件 | 改了什么 |
| --- | --- |
| `layout/damage.rs` `propagate_damage_flags` | 内联 `<svg>` 后代的损伤只重建这个 `<svg>`, 往上只传 REPAINT |
| `mutator.rs` `set_attribute` / `clear_attribute` / `restyle_for_attribute`, `document.rs` `snapshot_attribute` | 只影响选择器的属性只重算元素自己 (快照让后代失效; 有 `:has()` / nth-of 时重算父子树); 值没变直接返回 |
| `node/simple_svg.rs`, `svg.rs`, `element.rs`, `layout/construct.rs` | 基本图形 + 纯色的 SVG 直接转 kurbo 路径, 不经 usvg (`<text>` 和嵌套 `<svg>` 走 usvg; `svg_text_only`; `ACRENDER_SVG_PATH=1` 打印) |
| `node/serialize.rs` `svg_source` | 序列化内联 SVG 时写进算好的样式和字体, CSS 几何算成属性 |
| `stylo.rs` `synthesize_presentational_hints_for_legacy_attributes`, `SVG_PRESENTATION` | SVG 的呈现属性 (fill / stroke / opacity / font-* 这 18 个, 和序列化写回的一样) 按 CSS 解析成 PresHints: `stroke="var(--x)"` 能解析, `getComputedStyle` 也读得到; 含 `url(` 的值不映射 (照旧原样交给 usvg) |
| `util.rs` `parse_svg_image` / `parse_svg_with` | 按源文本缓存 usvg 解析 (512 条); 没有 `<text>` 用空字体库 |
| `util.rs` `FONT_DB`, `document.rs` `svg_fonts` | fontdb 的通用字族用 fontique 选的; SVG `<text>` 能用 @font-face |
| `webkit_compat.rs` (新), `document.rs`, `net.rs`, `node/element.rs`, `cssom.rs` | 解析前改写 `-webkit-line-clamp` / `-webkit-box` / `-webkit-inline-box` |
| `layout/inline/*.rs`, `node/text.rs` | ellipsis 另排一个 "…"; line-clamp 截到第 N 行 |
| `node/inline_edge.rs` (新), `layout/inline/build.rs` / `layout.rs` | 有边距的行内元素两端各放一个零高行内盒 |
| `layout/construct.rs` `flush_inline_pseudos_recursive` | 按子元素自己的 display 决定是否往下走 |
| `resolve.rs` `needs_layout` / `resolve_layout_children`, `layout/damage.rs` | 没有布局损伤不跑 taffy; 只走有构造损伤的子树; hover 有变化才刷新 |
| `layout/inline/layout.rs` | min / max-content 宽度缓存; shrink-to-fit 断行宽度放宽 0.01 |
| `stylo.rs`, `resolve.rs` `resolve_containers`, `document.rs` | `container-type` / `@container` (用上次布局的尺寸, 最多再两遍) |
| `stylo.rs` `resolve_stylist` | 被取消的动画 / 过渡, 元素再遍历一次 |
| `stylo.rs`, `layout/construct.rs`, `node/text.rs` | placeholder 排版, `::placeholder` 按需计算 |
| `config.rs` `default_lang`, `tree.rs`, `document.rs`, `iframe.rs`, `stylo.rs` | 根没有 lang 时用默认语言 (-x-lang 继承, 传给 parley) |
| `node/node.rs` `hit_inner` | transform 不可逆的元素命中不到 |
| `config.rs` `skip_iframe_content`, `mutator.rs` `load_iframe` | `<iframe>` 不加载 |
| `document.rs` `set_canvas_picture` / `layout_canvas_text` | 存 `<canvas>` 的 2D 图; canvas 的文字排版 |
| `node/element.rs` `paint_epoch` / `repaint`, `node/text.rs` `generation`, `layout/list.rs` | 绘制缓存用的代数 |
| `document.rs` `cache_image` | 图片缓存 256 张 / 64 MB 淘汰最旧 |
| `document.rs` @font-face, `net.rs` `FontSources` | 同一字体只注册一次 |
| `document.rs` `geometry_generation`, `memory` / `MemoryStats` | 公开几何代数和内存统计 |
| `document.rs` `create_node` / `forget_layout_child` | 不记 `changed_nodes`; 删节点时从布局父节点的子节点列表去掉 |
| `mutator.rs` `flush`, `document.rs` `add_stylesheet_for_node` / `tree_order` | 跳过已删的节点; 样式表按文档顺序插进 stylist; 只有在文档里的 `<style>` 才加 |
| `document.rs` `repair_after_panic` | panic 后去掉对已删节点的引用, 全部标脏 |
| `layout/damage.rs` `repaint_inline_root` / `clear_damage_and_dirty_flags` | 行内元素的损伤让 inline root 重画; `display: none` 子树的构造损伤留着 |
| `document.rs` `physical_unrounded_geometry` | 只减包含块的滚动偏移 |
| `stylo_device.rs`, blitz-traits `shell.rs` `Viewport.reduced_motion` | `prefers-reduced-motion` |
| `layout/fieldset.rs` (新), `layout/mod.rs`, `layout/construct.rs`, `node/node.rs`, stylo_taffy `wrapper.rs` | fieldset 是 flow-root; rendered legend 是块级的直接布局子节点, 居中压在上边框上, 上边框占 max(边框宽, legend 高); 不建匿名 content box. 不做竖排、`align`、百分比定高 |
| `layout/list.rs` | outside 的列表标记按 `white-space: pre` 排 |
| `assets/default.css` | `::placeholder` 54% currentcolor; 表单控件默认黑字 |
| 删掉的 | `events/`、`form.rs`、`debug.rs`、devtools、parallel-construct、`<canvas src=数字>`、CSS 光标、custom-widget |

**其余**

| 文件 | 改了什么 |
| --- | --- |
| fontique `backend/fontconfig.rs` `SystemFonts::members` / `family_uncached` | 按第一个族名建表, 不再每族一次 `FcFontSort` |
| fontique `collection/mod.rs` `System::shared` | 系统字体只扫一次, 所有 `Collection` 共用 |
| fontique `font.rs` `mod tests` | 关掉 |
| parley `shape/mod.rs` `FontSelector::select_font` | CJK 标点只有带汉字的字体才算覆盖; Common / Inherited 的 cluster 先试前一个的字体 |
| parley `shape/mod.rs` `CjkVariant` / `shape_text` | 按 locale 换成本地区的 CJK 字族, 缓存键加地区 |
| parley `shape/mod.rs` `begin_segment` | (script, locale) 没被跟踪时按没有 locale 查 |
| stylo `stylesheets/rule_parser.rs` | `@container` 去掉 gecko 限定 (pref `layout.container-queries.enabled`) |
| stylo `servo/media_features.rs`, `device/servo.rs` | `prefers-reduced-motion` |
| stylo `servo/animation.rs` `maybe_start_animations` | 已在跑的动画名 `continue` 而不是 `return` |
| stylo_atoms `static_atoms.txt` | 加 `prefers-reduced-motion` |
| vello `scene.rs` `DrawGlyphs::draw` / `try_draw_colr` / `color_bitmaps` | 只有彩色位图代替轮廓; 只带 EBDT 的字体画轮廓 |
| ironrdp-server `transport.rs` (新), `server.rs`, `helper.rs` | tokio → ntex (FramedRead / Write、TLS 握手、`ironrdp-accept` 监听线程), TLS 用 OpenSSL; async-channel; TLS 握手 5 秒超时; 只用 NTLM |
| libseat-sys | 运行时 dlopen `libseat.so.1`, 拿不到时 `libseat_open_seat` 返回空 (没装 seatd 的机器上 acdert 照样起) |
| fslock | 用 std 的 `File::lock`, 不要 winapi |
| async-dnssd `evented/windows.rs` | winapi 换成 windows-sys |

验证: fontique `cargo test --release --features system --lib acrender`; stylo `--test geometry` / `--test compositor`; ironrdp-server 用 FreeRDP 以 tls / nla 连.

## crates/render 的已知问题和测试数据

- canvas 的 `createPattern` 在第一次用时才取来源的位图 (规范是创建那一刻).
- vello 0.11 没有图片的场景把图集当 1x1 重建、已上传的图片画空; 每个场景垫一块 1x1 渐变绕开 (acde-gpu `Vello::render`), 升级 vello 时看
  上游修了没有.
- `ACDE_PAINT_VERIFY=1` 下机器忙时 `tests/damage.rs` 偶发等帧超时, 单独重跑都过.
- `tests/fixtures/replay/*.ops.gz` 是旧 acde-host 的 DOM 操作流 (`tests/replay.rs` 回放, 格式见它), `svg/*.svg` 是简单 SVG 的对比用例, 元素的特殊渲染
  在 `tests/elements.rs`. `release_keeps_memory_flat` 只在 Linux 上跑.

## packaging/arch

`PKGBUILD` 打出 `acdert` 包 (provides / conflicts `acde-base`), 装 `/usr/lib/acdert/acdert`、`/usr/lib/acdert/app/` (acde-host 的 `dist/`、`greet/`、
`brand/`)、`/usr/lib/acdert/office-ds.sh`、会话入口 `/usr/bin/acdert` (POSIX sh)、`/usr/share/wayland-sessions/acdert.desktop`、
`/usr/lib/tmpfiles.d/acde.conf` (`/var/lib/acde/greeter`)、fcitx5 的默认 profile (Ctrl+Space 切拼音)、`acde-portals.conf` (portal 全用 GTK).
系统装的桌面包在 `/usr/share/acde/packages/`.

会话入口: 子命令直接 exec acdert; 否则跑 acdert, 异常退出重新拉起, 60 秒内第 3 次放弃 (登录页改成 `exec agreety --cmd /usr/bin/acdert`); 退出码 3 且有
交接文件时 exec 它. 输入法是 fcitx5 (原生应用走 text-input-v3, 网页走 runtime 的 `Ime`). 包从 `HEAD` 构建 (`git archive`), 版本来自 `v*` tag;
`vulkan-driver` 依赖由 GPU 自己的驱动满足 (lavapipe 不算). 构建 `makepkg -s` 或 `podman-build.sh out/`; 发版在 x86_64 Arch 和 Arch Linux ARM 上各跑
`release.sh <tag>`, agentos 仓库的 `scripts/components` 钉 tag.

## packaging/qemu

在会话所在的机器上驱动和测量 (会话带 `ACDE_DEBUG_DIR` 起). 没有 3D 的虚拟机起不来网页图层, 验收在有 GPU 的真机上.

- greetd 的 `initial_session` 只在第一次启动时跑; fcitx5 退出时写回 profile, 改它先 `kill -9`; 测试机的密码不进仓库.
- seat0 被 gdm 占着时验 DRM 后端: `sudo systemd-run --unit=acde-drm-test --uid=$USER -p PAMName=login -p TTYPath=/dev/tty7 -p StandardInput=tty-force
  <脚本>` (脚本设 `ACDE_BACKEND=drm ACDE_DEBUG_DIR=…`, 用 `timeout` 兜底), 测完 `loginctl terminate-session <id>` 再 `chvt 1`.

`drive.sh [-d DIR] [-t 秒] 命令 [参数...]` (dash): 交给 Broker 里的 `drive.mjs` 执行, 打印 JSON.

| 命令 | 做什么 |
| --- | --- |
| `keys ctrl+space n i h a o` / `type 'nihao'` | 按键 / 打字, 经 `Shell.inject` |
| `move X Y` / `click [X Y] [right]` / `drag X1 Y1 X2 Y2` / `wheel X Y DY` | 指针 (逻辑像素) |
| `eval WEB CODE` | 在 web 里求值 |
| `windows` / `launch APP` / `close WINDOW` | 窗口表; 开关窗口 |
| `stats [reset]` | shell 和每个 web 的现值 |
| `screenshot PATH` | `Shell.screenshot` |
| `perf 场景 [秒] [参数]` | `idle` / `pointer` / `drag [APP]` / `scroll [APP]` / `stress [N]` (要把 `web/packages/acde-host/tests/fixtures/stress-app` 加进 `ACDE_PATH`) / `contend [N]` / `open [APP]`; 报 `cpuPercent`、按线程名的 CPU、`rssMb`、合成帧率和 p50 / p95、每个 web 的出帧 |
