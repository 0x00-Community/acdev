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
> - 兼容的是标准接口, 不是 Chromium: 渲染器是自研的 (Blitz 的 fork, `vendor/blitz` 子模块, 没有 JS 引擎), 页面 JS 在 acdert 自己的 V8 里. 没有 devtools、
>   远程调试端口、浏览器外壳.
> - 现有的债 (不是先例, 新代码不许再加, 动到时往这个方向收): web 里除 fs / terminal / network / office / picker 以外的 `acde:` 模块
>   还是经 `rpc.ts` / `remote.ts` 调到 Broker (见「通信」); acde-dopame 还直接用 napi 导出.

说明都在本文件里 (没有 README, 子目录不放 AGENTS.md). full agentic.

## 是什么

acde (Agent Computer Desktop Environment) 是 Dopame 的桌面基座, 分三个仓库 (测试期间的架构, 用户定 2026-11-13):

| 仓库 (gitea AC/) | 是什么 | 产出 |
| --- | --- | --- |
| acdert (本仓库) | 通用运行时逻辑: V8、DOM、render、存储、媒体、WebGPU / WebGL 绑定; 平台特化的接口 (`src/host/src/platform.rs` 的 `Platform` / `Window`, 合成器接口) | 根包 `acdert`: rlib + `libacdert.so` + `include/acdert.h` |
| [acdebin-dbg](http://gitea.dopamine/AC/acdebin-dbg) | 跨平台调试运行时: 宿主窗口 (hostwin)、DevTools、`acde dev` 拉起的就是它; 合成器用 OpenGL / Vulkan (wgpu) 或 acgpu | 二进制 `acdebin-dbg` |
| [acdebin-system](http://gitea.dopamine/AC/acdebin-system) | Dopame OS 特化运行时: Wayland 合成器、DRM/KMS、会话、RDP、系统服务; 合成器用 acgpu | 二进制 `acdebin-system` |
| acdebin-dbg 的 `npm/` | 开发者 CLI `acde` (bun) | `acde` |

平台特化的部分只经接口进来: 前端 (acdebin-dbg / acdebin-system 的 main) 实现 `Platform` (认领窗口 surface、文件选择器、`native` 上多挂的导出、内容类型),
交给 `acdert::start` / `acdert::common`; 运行时把它放在每个事件循环上 (`rt::Loop::platform`, web 线程从 Broker 那里继承), 不用全局变量.
根包 `acdert` (仓库根的 `Cargo.toml` + `src/`) 是对外唯一的包, 前端只依赖它 (`acdert = { path = "../../../acdert" }`). 代码都在这一个包里:
`src/host` 的公开项由 `src/lib.rs` 平铺导出, 其余是公开模块 `acdert::log` / `media` / `model` / `napi` / `render` / `runtime` / `storage` / `vello` /
`webgl` / `gpu` (模块内互相引用写 `crate::render::…`); `acdert::gpu` (src/gpu) 是 acgpu 之上的设备登记 (`Gpu`) 和合成器接口, 平铺导出
acgpu 的 2D 场景类型; blitz fork 直接画进 acgpu 的场景 (用户定 2026-11-14: acgpu 接管 acde-gpu, 这个 crate 已删). feature `napi` 打开 model 的 `#[napi(object)]`. 测试在根 `tests/` (`<原模块>_<名字>.rs`, 夹具 `tests/fixtures`,
runtime 的手动检查脚本 `tests/runtime/`), Wayland 协议在 `protocol/`. crate-type 是 rlib + cdylib, cdylib 即 `libacdert.so`.
`src/ffi.rs` 是 C 接口, `build.rs` 用 cbindgen (`cbindgen.toml`, 只解析 `src/ffi.rs`) 每次构建重写 `include/acdert.h` (进 git, 随 so 发):

- 入口: `acdert_start(script, argc, argv, platform)` (script 为 NULL 即 Broker; argv 是 script 之后的参数) / `acdert_common(argc, argv, platform, &code)`
  (argv 是整条命令行, 返回是否处理了) / `acdert_version(program)` (用 `acdert_string_free` 释放) / `acdert_api_level()` / `acdert_exit(code)`.
  `platform` 为 NULL 即 `Headless`.
- `AcdertPlatform`: `ctx` + 回调表 (`claim` / `content_type` / `choose_folder` / `open_files` / `save_file` / `release`); 表按值拷进去, `ctx` 归 acdert,
  最后一个引用没了时调 `release(ctx)`; 回调可能在任意线程上来. 没给的回调走 Rust 的缺省 (claim 拒绝, 文件选择器走 portal, 内容类型无).
  选择器返回 `AcdertChoice` (CHOSEN / CANCELLED / FAILED), 路径或错误用 `acdert_strings_push` 写进给的 `AcdertStrings`.
- `claim` 收到的 `AcdertRender*` 归 C (`acdert_render_free`; `tick` / `pointer` / `scroll_at` / `commit` / `invalidate`), 成功时填 `AcdertWindow`
  (同样 `ctx` + 回调表 + `release`, 没给的回调取 trait 缺省), 失败时把原因 push 进 strings 并返回 false.
- 事件: `pump` 里 C 用 `acdert_event_init()` 得到「全部缺省」的 `AcdertEvent` (整数 -1、浮点 NaN、指针 NULL 即没有), 填好后 `acdert_events_push`.
  `set_waker` 给的 `AcdertWaker*` 归 C (`acdert_waker_wake` / `acdert_waker_free`, NULL 即清掉).
- 命令: `send` 收到 `AcdertCommand` (`kind` 决定哪些字段有意义; 指针只在回调期间有效). `READ_CLIPBOARD` 带 `AcdertReply*`, 必须恰好一次
  `acdert_reply_send` 或 `acdert_reply_free`. 还没进 C 的: `FRAME_THEME` 只有 kind, `START_DRAG` 不带拖拽图像, 帧本身 (`RenderHandle::frame`
  是 GPU scene) 拿不到, `Platform::exports` 收 V8 scope 只在 Rust 里.
- 导出表: `build.rs` 从 `src/ffi.rs` 收 `acdert_*`, so 只导出它们 (Linux `--exclude-libs,ALL` + 版本脚本, macOS `-exported_symbols_list`, MSVC `.def`);
  V8 / napi / temporal 等依赖的符号都不导出 (napi 模块的 napi_* 只给静态链接的内置模块用, 不 dlopen 外部 .node).
- 发布到 gitea.dopamine AC 组织的 cargo 源 `ac` (`.cargo/config.toml`; 读也要令牌, 匿名 401):
  `CARGO_REGISTRIES_AC_TOKEN="Bearer <令牌>" cargo publish -p <包> --registry ac`. ac 上除了 acdert 只有它不得不单独发的依赖: blitz fork 的包
  (blitz-dom / blitz-paint / blitz-traits / stylo_taffy / debug_timer, 原名), blitz 的 taffy (上游 Blitz 钉的 git 提交, `0.15.0-git.4e59968`);
  2D 场景是 acgpu 的 (acgpu 仓库自己发, 不开 `compiler`), acde-gpu 已并进 `src/gpu`. 顺序: acgpu → blitz 那五个 (在 `vendor/blitz` 里发) → acdert.
  升版本时改 `[workspace.package] version`; blitz 升版本时它自己的 `[workspace.package]`、`[workspace.dependencies]` 和这里的 `=0.3.0-beta.N` 一起改.

外部 crate 用的绑定工具在 lib 根上平铺导出 (`acdert::{string, get, set, offload, failure, current, Msg, methods!, …}`).
会话里的 shell / window / paint / supervise 已搬到 acdebin-system; vendor (只剩 blitz 子模块) 仍在本仓库, 两个前端的 `[patch]` 都指 `../acdert/vendor/blitz`.

acdert 和开发者 CLI `acde` ([acdebin-dbg](http://gitea.dopamine/AC/acdebin-dbg) 的 `npm/`)
的关系像 workerd 和 wrangler: acdert 跑桌面和应用, acde (bun) 建工程、构建、装包, `acde dev` 拉起 acdebin-dbg. 改名成 acdert 的只有程序、Arch 包和
crate; `acde:` 模块、`@dopame/acde-api`、`acde_*` 协议、`ACDE_*` 环境变量、`$XDG_*/acde/` 这些都不改. 桌面是一张网页: JS 在内嵌的 V8 里
(不用 Node), Blitz (`vendor/blitz`) 排版, vello 在 GPU 上画; 不监听端口 (RDP 后端除外). 具体的桌面由桌面包提供 (例如
[acde-dopame](https://github.com/dopame-org/acde-dopame), 发行时带上, acdert 不认识它).

两种跑法, 运行时是同一套:

| 跑法 | 命令 | 平台 | 输出 | 合成器 |
| --- | --- | --- | --- | --- |
| **会话** (Dopame OS) | `acdert --desktop <id>` (登录页起) | Linux | 屏幕 (DRM/KMS) 或 RDP | acdert 自己 (crates/shell) |
| **调试桌面** (`acde dev`) | `acdebin-dbg desktop <id \| 包目录>` | Linux / Windows / macOS, 在别人的桌面里 | **一个**宿主原生窗口, 里面合成桌面和所有窗口 | acdebin-dbg 的 crates/hostwin |
| **调试窗口** | `acdebin-dbg app <id>` | 同上 | 一个宿主原生窗口, 所选应用铺满, 关闭该应用后退出 | 同上 |

选哪种看跑的是哪个二进制: `acdebin-dbg` 一律宿主窗口, `acdert` (过渡期, 只在 Linux) 一律会话 (有 `WAYLAND_DISPLAY` / `DISPLAY` 又没设
`ACDE_BACKEND` 时合成器嵌在宿主桌面里). 会话里只支持 Wayland: 没有 Xwayland, 只会 X11 的程序跑不了.

调试桌面用桌面的模块、服务和 `acde:windows` / `acde:desktop` 事件. 调试窗口用清单授权的模块和 `acde:window` 事件.
宿主窗口的 `native.Shell` 带 `hosted: true`, acde-host `Main.session` 见到它就不算「自己的会话」: 不起 fcitx5、
不开 AT-SPI、不跑 XDG autostart、不拿会话总线名字、不记登录选的桌面. 平台上没有的能力不注入, 不给假的实现.

宿主窗口的 `app` 模式从已安装的包发现应用, 按原规则选择桌面包来加载服务和资源, 并仅启动应用页面. 用 `app <id> --desktop <桌面 id 或包目录>`
指定服务来源. 应用按清单取得能力; 需要桌面页面主动发布状态的功能在此模式下没有发布者. 应用的开发重载保留宿主窗口.

## 进程与线程

```
会话:
acdert (主进程, src/host supervise.rs)   合成器线程 (crates/shell, smithay): canvas / 窗口表 / 输入 / 外设. 没有 V8
 └─ acdert runtime (子进程, 自己的进程组)      一个 V8. 主线程: Broker isolate (web/packages/acde-host): 会话、桌面服务、窗口记录;
     │                                          经 napi `Shell` (acde_shell 连接) 管合成器; 系统接口 src/runtime (napi)
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
- **web** (src/host `web.rs` `spawnWeb`): runtime 里的一条 JS 线程 `acde` (栈 8 MiB), 自己的 isolate (堆上限 `heapMb`) 和事件循环.
  和 Broker 之间是结构化克隆的字节, 投进对方事件循环 (没有 socket). `terminate` 置停止并 `terminate_execution` (退出码 137);
  线程 panic 只结束这个 web (134, `panic: …`). 句柄带 `busyMs` (当前任务跑了多久, 判卡死) 和 `cpuMs` (`/proc/self/task/<tid>/schedstat`).
  段错误、abort 带掉整个 runtime (主进程重起它), 所以共享的 Rust 状态里不写 `unsafe`, 绑定层不 `unwrap`, 每个绑定在边界上
  `catch_unwind`.
- **一个 V8, 每个窗口一个 isolate**: 内存 (各自的堆上限)、生死 (一个死了只掉它的窗口)、CPU (每个 isolate 一个线程, 同一优先级) 各管各的.
- **注入的系统能力** (`spawnWeb` 第 7 个参数 `{app, fs, terminal, network, system, office}`, Broker `#grants`: 桌面全给, 应用按清单): fs、terminal、
  network、office 和选文件夹在各 web 里绑定同一份 Rust 对象 (src/host `fs.rs` / `terminal.rs` / `network.rs` / `office.rs` /
  `picker.rs`; 阻塞的活经 `offload.rs` 交给别的线程, promise 在这个 web 的事件循环上落定; `acde:fs` 的改动 (mkdir、copy、rename、delete、
  writeFile、revoke) 在每个 web 一条的有序队列 `acde-fs-changes` 上按调用顺序跑, 读在全进程 4 条线程的 `acde-fs-<n>` 池里跑, 这个 web 还有改动
  没做完时读也排进有序队列, 所以没等的写之后的读看得到写的结果). 限制 (fs 的 roots) 在注入时绑进去, 没给的
  `import('acde:<名字>')` 直接失败. Broker 自己只用 napi `Finder` 的 `locate` (「默认应用」), 是另一份.
  terminal 起用户的登录 shell, 在家目录: unix 是账户数据库里的 shell (`getpwuid_r` 的 `pw_shell`, 不可执行时 `$SHELL`, 再不行 `/bin/sh`), 带 `-l`, pty
  子进程 exec 前关掉 3 以上的所有 fd, 每秒从 `/proc` 报 `cwd` (只在 Linux); Windows 用 ConPTY (runtime `conpty.rs`), shell 依次取 Windows Terminal
  默认配置的 `commandline` (`settings.json`, 商店版、预览版、非打包版三处)、PATH 上的 `pwsh.exe`、Windows PowerShell、`%ComSpec%`; 子进程不继承
  任何句柄, 整棵进程树放进一个关句柄即结束的作业对象: 关终端时先关伪控制台 (shell 收到 `CTRL_CLOSE_EVENT`), 3 秒后还在就结束整个作业, 会话
  线程退出时作业句柄关闭, 后台留下的进程一并结束; 没有 `cwd` 事件, `exit` 的 `signal` 总是 null.
  network 第一次调用时连 NetworkManager; office 由 Broker 起服务时
  `sys.openOffice()` 开 (network / office / system 只在 Linux). `acde:system` (清单能力 `system`, src/host `system.rs` → runtime `system.rs`):
  这台电脑的信息 (主机名、系统、CPU、GPU、NPU、内存、开机时长、序列号)、各卷容量、时区和 NTP (经 timedated)、改时区 /
  NTP / 主机名 (经 hostnamed, 要 polkit 授权)、当前用户; 每次调用在 offload 线程上现读, 没有变化事件.
  `acde:bluetooth` (能力 `bluetooth`, src/host `bluetooth.rs` → runtime `bluetooth.rs`): BlueZ 的适配器和设备 (开关、可见、改名、
  扫描、配对 / 应答、连接、信任、屏蔽、忘记), 自己注册配对代理; `on('changed' | 'pairing')` 由 acde-host `bluetooth.ts` 包在原生 `watch` / `pairing` 上.
  登录时的开关 (`setOnLogin`: remember / on / off, 存在 `$XDG_CONFIG_HOME`) 只在自己的会话里由 Broker 调 `sys.restoreBluetooth()` 应用, 宿主窗口和登录页不碰.
  `acde:audio` (能力 `audio`, 原生名 `sound`, src/host `sound.rs` → runtime `sound.rs`): PipeWire 上的输出 / 输入设备、端口、
  声卡配置和各应用的流 (默认设备、音量、静音、平衡、端口、配置、把流挪到别的设备); `on('changed')` 由 acde-host `watched.ts` (`Watched.module`,
  只有 changed 事件的模块共用) 包在原生 `watch` 上.
  `acde:devices` (能力 `devices`, src/host `devices.rs` → runtime `devices/`): UDisks2 上的可移动驱动器 (挂载、卸载、弹出)、
  CUPS 打印机 (经 IPP: 默认打印机、暂停 / 恢复、任务和取消)、自动挂载设置 (登录时 / 插入时 / 未知设备, 每个设备单独设); 事件 `changed` / `added`
  (新插入的驱动器) 由 acde-host `devices.ts` 包在原生 `watch(type)` / `unwatch(id)` 上. 自动挂载的监视只在自己的会话里由 Broker 调
  `sys.startDevices()` 起.
  `acde:power` (能力 `power`, src/host `power.rs` → runtime `power/`): UPower 的电池、power-profiles-daemon 的模式、
  按交流 / 电池 / 低电量分组的策略设置 (空闲动作、熄屏、合盖、电源键、亮度), logind 挂起 / 休眠, 背光亮度, 充电上限; 事件 `changed` / `prompt` /
  `critical` 由 acde-host `Watched.typed` 按 `type` 分发. 系统总线连接挂在 `Power` 上. 会话里的执行 (空闲计时、熄屏、
  合盖和电源键) 要合成器配合, 见 acdebin-system.
  `acde:input` (能力 `input`, src/host `input.rs`): 合成器的 xkb 布局 / 型号 / 选项、按键重复、NumLock 和鼠标 / 触控板的 libinput 设置;
  `state()` / `set(patch)` / `on('changed')` 走前端 `Platform::input()` 给的 `Input` (acdebin-system 的会话经 acde_shell `set_input` / `input` 事件;
  acdebin-dbg 没有, 调用就抛), `catalog()` 读 xkeyboard-config 的 `rules/evdev.xml` (runtime `XkbCatalog`).
  `acde:display` (能力 `display`, src/host `display.rs`): `state()` 是前端 `Platform::display()` 给的输出表 (acde_shell `display` 事件),
  内置屏的 `brightness` 由这里用 `acde:power` 的背光补上; `configure(id, {scale})` 经 acde_shell `set_scale` (只认 1..3 的整数, 别的键还没有),
  `setBrightness(id, v)` 只对内置屏 (logind 背光), `setNightLight` 还没有. 两者都是进程内模块, 不经 Broker; Linux only. `acde:office` 的根就是调用方 `acde:fs` 的根 (#96, `OfficeService::for_web` 带上这个 web 的 `Workspace`,
  runtime `Workspace::finder_roots`): 第 1 级应用是 `private`、点名的公共位置和选的文件夹, 按 `id` 认, 不给路径; 没有 `fs` 的应用没有根. 没批准或撤销了的
  公共位置和文件夹和 `acde:fs` 一样经 `FileAccess.guard` 拒绝 403 `denied`、从 `state().roots` 去掉. `state(handle)` 按交来的文件句柄打开 (web 侧认
  `PageCalls` 登记过的句柄, 换成路径交给 runtime `OfficeCall::Open`), 文稿的 `root` 是空的, 只读句柄只能查看. 编辑器的取文件和保存回调凭签名的票据里的
  文件夹路径找文件 (`OfficeFiles::file` / `save` 不再查共享根).
- **还没做的**: 窗口 / 应用 / 会话表还在 Broker 的 JS 里 (`acde:windows` / `acde:apps` / `acde:window` / `acde:session` 经 RPC);
  桌面包服务的调用经 Broker; 外部内存 (ArrayBuffer、文档、GPU 缓冲) 不按 isolate 记账.

## 窗口模型

框架只有两个抽象: **canvas** (工作区) 和 **window**. 都是 Rust 的表项 (src/model), 不映射到 DOM / JS 对象; 窗口的内容只是客户端交的
一块缓冲, 框架不跑 JS、不持有文档. 桌面、面板、菜单都是窗口.

- **canvas**: 屏幕只有一块, canvas 可以有多个, 同时只显示一个. `rect` 是屏幕的逻辑尺寸 (也是裁剪范围), `scale` 是 HiDPI 缩放, 创建后都
  不变 (分辨率或缩放变了就重建). 每个 canvas 一个 z 列表和一个焦点.
- **window**: `{id, canvas, mode, rect (canvas 坐标, 可以超出 canvas, 超出的不画), z, content, input, grab hints, parent / modal, focus}`.
  四种模式: `fullscreen` (铺满 canvas), `free` (位置尺寸都能变), `fixed` (只能挪), `pinned` (都不变). 桌面是 z 最低的 `fullscreen`
  窗口; 面板和菜单是 `pinned`, 永远在 `free` / `fixed` 上面. 标题栏、边框、阴影是客户端的内容 (客户端画), 不是框架的概念.
  第 1 级契约里模式只管能不能挪、改尺寸 (`free` / `fixed` / `pinned`, SDK `WindowMode` 不再有 `fullscreen`); 全屏是**窗口状态**.
- **窗口状态** (src/model `state.rs`: `WindowState` + `Restore`, 宿主窗口的 `Entry.state` / `restore`, `State::change_state`): `normal`、`minimized`、
  `filled` (铺满工作区)、`fullscreen` (铺满输出); 隐藏仍是框架另一个状态. 每次变化都由运行时裁决:
  `fixed` 只能最小化, `pinned`、桌面和面板一律拒绝, 同一状态不算变化. 离开 `normal` 时记下原来的 rect, 进全屏时记下之前的状态 (`normal` 或 `filled`),
  最小化时记下之前的状态; 「回去」(`Restore::back`) 用它们, 所以 normal → filled → 全屏 → 回到 filled → normal 还是原来的 rect. 最小化的窗口不画、不命中,
  有焦点时焦点给下一个; 给它焦点 (`focus` / `show`) 就回到之前的状态. 每次变化给窗口自己发 `state {state, previous}`, 给 Broker 发
  `windowstate {window, state, previous}` (旧的 `windowfullscreen` / `windowunfullscreen` / `windowminimize` 已随第 0 级去掉). 宿主窗口的窗框按钮
  (最小化、全屏 / 还原) 由运行时直接改状态, 只有关闭交给页面. `requestMode` 只收 `free` / `fixed` / `pinned` (`fullscreen` 抛 TypeError,
  全屏用 `requestState`); 改模式时当前状态在新模式下不允许就回到 `normal`. 独立应用的窗口 (`acdert app`) 内部仍是 `fullscreen` 模式, 页面改不了.
  会话 (crates/window) 把请求映射成标准 xdg_toplevel 请求 (`set_fullscreen` / `set_maximized` / `set_minimized` / 取消), 按 configure 里的
  fullscreen / maximized 给页面发 `state`. 合成器 (crates/shell) 执行全屏和最小化: 全屏切换和 `set_minimized` 都经 `acde_shell.window_state`
  给 Broker 发 `windowstate` (和宿主窗口同一语义: 已经做完的变化); 最小化的窗口藏起 (记下之前是 `normal` 还是 `fullscreen`), 桌面 `focus` / `show`
  它时回到之前的状态并再发 `windowstate`. 页面的 `minimize()` 在会话里走自己的 `set_minimized` (Broker 经 `window.minimize` 回调页面).
  会话里 `filled`、给页面发 `minimized` 的 `state` 和 `acde:windows.requestState` 还没有 (Broker 回 501).
- **分层**: 客户端出缓冲 (dmabuf / shm + damage + opaque 区域); 合成只出计划; 呈现 (GPU / DRM / RDP) 执行. 只传句柄、只报脏区,
  框架不读像素; 客户端慢就用上一次的缓冲.
- **`CompositePlan`** (src/model `plan.rs`, shell `compositor/composite.rs`): `{damage (最多 8 块), route: Composite | Direct, layers:
  [{window, dst, clip, look, effect, redraw}]}`, 不透明的上层剔除下面. backdrop (`set_backdrop`) 只在下面的损伤碰到时重算, 呈现层 (shell
  `effects.rs`, GLES) 双 Kawase 模糊 + 圆角 + 饱和度 + 亮度, 按窗口缓存, 着色器编不出时降级. `Direct` 现在只计数, 上 plane 由 smithay 判断.
- **窗口管理** (框架裁决, 客户端只能请求): 新窗口居中、按窗口数错开 32 像素, 有父窗口的居中在父窗口上方 (不错开). 只有 `free` 改尺寸. 点进一个窗口: 拿焦点
  并提到它那一层最前, 它的子窗口 (含子窗口的子窗口, 保持原来的先后) 跟着提到它上方 (model `front_family`). 隐藏是框架状态 (不画、不命中、不拿焦点). `animate {opacity, scale, dx, dy, duration, delay, easing}` 由合成器每帧插值,
  做完发 `windowanimated`; 有 look 的窗口按画出来的位置命中.
- **焦点和模态**: 键盘只发给焦点窗口. 要把焦点给有模态子窗口 (xdg-dialog `set_modal` + `set_parent`, 或 Broker 授权时的 `parent` / `modal`) 的窗口时
  改给最上层的模态子窗口, 子窗口关掉焦点回父窗口. 指针也不发给有模态子窗口的窗口: 在它上面没有指针焦点, 按下只把焦点给模态子窗口 (不开始拖动).
- **grab** (shell `grabs.rs`): `request_grab(kind)` 在被别人拿着或框架在移窗时拒绝; 键盘 grab 同时给焦点. 收回 (发一次 `grab_lost`): 在别的窗口
  按下 (`other_window`)、Esc (`esc`, 这次 Esc 不发)、焦点被给别人 (`focus_lost`)、客户端死掉.
- **全局快捷键** (src/model `shortcut.rs`): 组合写成 `ctrl+alt+t` (键是 xkb keysym 名, 按未修饰的那层匹配, Shift 写进组合; `mod` 在 macOS 上是 `super` (⌘), 别处是 `ctrl`, 同 Dopame 桌面的写法). 作用域 session /
  desktop / app / menu, 先到先得, 冲突拒绝, session 级不可覆盖; 匹配顺序 session → 焦点窗口的 menu 级 → 焦点窗口的 app 级 → desktop. 命中的键 (连同松开) 不发给窗口, 发
  `shortcut {window: owner, key, title: 作用域}`, `key` 是这一条绑定注册时写的文字 (同一组合的 app 级和 menu 级各记各的). keyboard-shortcuts-inhibit 生效时只有 session 级还拦.
  menu 级是窗口菜单项的快捷键 (acde-host `broker/menukeys.ts`), 只在没有桌面、菜单画在窗框上时 (`framesMenus`): 应用 `setMenus` 时 Broker 给有 `onSelect`、没禁用、带 `shortcut` 的项注册
  (同一文字只给第一项; 被占的记一行 warn 跳过), 再 `setMenus` 时按差异增删, 窗口关掉时随 app 级一起忘掉. 按下时 Broker 不转发事件, 直接
  调应用窗口的 `menu` (同桌面的 `invokeMenu`), 所以应用另用 `self.shortcut()` 注册了同一组合也只跑一次 (菜单项赢). 有桌面时不绑:
  菜单归桌面管 (Dopame 的编辑器给「编辑」菜单配了 `mod+C` / `mod+V` 等, 页面自己也处理这些键, 运行时抢走它们会改变编辑器的行为).

### 协议 `acde_window` (客户端 ↔ 框架, `src/model/protocol/acde-window.xml`)

只有一种窗口角色 `xdg_toplevel` (菜单、面板、桌面都是). 标准协议管缓冲、damage、opaque / input 区域、configure、parent / modal、激活、
输入、data-device、fifo、presentation、syncobj、pointer-constraints、text-input. 扩展只带框架才能做的:

| 请求 / 事件 | 语义 |
| --- | --- |
| `request_mode(mode)` → `mode` 事件 | 请求四种模式之一, 框架裁决 (尺寸仍走 xdg configure) |
| `set_backdrop(rect, blur, saturate, brightness)` | rect 是窗口本地物理像素; 这块下面的内容由呈现层处理后再画这个窗口; 空 rect 取消 |
| `set_grab_hint(rect, edges)` | 窗口本地逻辑像素; 按下在这里时框架开始移动 (edges 空) 或改大小; 累加, 重叠处后给的优先; 空 rect 清掉全部 |
| `request_grab(kind)` / `release_grab(kind)` → `grab(granted, kind)` / `grab_lost(reason)` | 见上面 grab |
| `request_activate` | 提到最前并请求焦点 |

### 协议 `acde_shell` (Broker ↔ 合成器, `src/model/protocol/acde-shell.xml`)

只对 runtime 那条连接可见 (`can_view`). 合成器侧 shell `compositor/acde_shell.rs` (Broker 没绑上时攒最多 256 条事件), Broker 侧 shell
`link.rs` 包成 napi `Shell`, 请求和事件和下面「shell」一节的方法 / 事件一一对应 (坐标是 canvas 逻辑像素, int -1 是没有, 小数走 wl_fixed).
`exit` 是连接断了时 Broker 侧自己发的.

## 宿主窗口

宿主窗口 (crates/hostwin, `acdert app` / `acdert desktop` 在别人桌面里的那条路) 归 [acdebin-dbg](http://gitea.dopamine/AC/acdebin-dbg), 说明在它的 AGENTS.md.

## acde dev

IPC: acdert 是服务端, 在 `ACDE_DEV` 上听 (hostwin `dev.rs`, 线程 `acde-dev`, 每条连接一条 `acde-dev-conn`), acde dev 和工具 (acde 的命令、
MCP、driver) 都直连它, 中间没有转发. unix 上是 unix socket (地址和 0700 的目录由 acde dev 定好、旧 socket 它先删, acdert bind 后设 0600,
退出后 acde dev 删), Windows 上是命名管道服务端 (`FILE_FLAG_FIRST_PIPE_INSTANCE` 防别人抢先占名、`PIPE_REJECT_REMOTE_CLIENTS`、SDDL
`D:P(A;;GA;;;OW)` 只给当前用户, 接一个再开下一个实例). 这条 IPC 能在页面里求值, 所以只给自己. 一行一个 JSON. 发 `{"type":"hello","role":"dev"}`
的那条连接是 acde dev 的: 它断了 acdert 就退出, acdert 主动发的事件也只发给它; 别的 hello 忽略. Windows 上读之前先 `PeekNamedPipe`, 有数据才 `ReadFile`: 同一个同步句柄上
挂着的读会让写 (回答) 一直等着. 工程的构建结果经
`ACDE_PATH` (Windows 用 `;` 分隔) 交给 acdert, 不装进包目录; 日志就是 acdert 的 stderr.

acdert 主动发的事件 (`Shell.devEvent(json)` → hostwin `dev::event`, 写给每条 acde dev 的连接, 没有就丢; 一行
`{"type":"event","event",…}`):

- `{"type":"event","event":"devtools","web","app","window"}`: 宿主窗口里按了 F12 (#196). hostwin `App::key` 前面的
  `dev::DevtoolsKey` (只在有 `ACDE_DEV` 时开) 拦下不带修饰键的 F12: 按下推一个 `devtools` 事件给 Broker (`window` 是有焦点的窗口),
  按住的重复和松开都吞掉, 页面收不到 (宿主窗口失焦时清掉「按住」: 打开的浏览器抢走焦点, 松开常常到不了这里); 带修饰键的 F12、没有 `ACDE_DEV` 时的 F12 照常给页面. Broker 把窗口换成 web (那个窗口的 web,
  原生窗口的 owner, 都没有时桌面), `DevRequests.devtools` 发事件: `web` 是 web 名 (即 `/json/list` 的目标 id), `app` 是应用 id
  (桌面是 null), `window` 是窗口号. 按键不进页面线程, 所以页面停在断点上时 F12 也照样到. acde dev 收到后和 `acde devtools <web>`
  一样打开 DevTools (见 acde 的 `dev.ts`).

收到的消息 (`reload` / `quit` 哪条连接发都照做):

- `{"type":"reload","app"?,"hot"?}` → Broker 的 `devreload`: 有 app 时关掉它所有窗口 (不问 `beforeclose`) 再按记住的 rect 打开 (清单的 `size` 变了时按新尺寸, 中心不动, 不超出屏幕), 没有 app 时
  重起 desktop web (服务不重起). `hot: true` 时先试热替换 (下面).
- `{"type":"quit"}` (dev 连接断开也一样) → Broker 的 `quit` 事件 (结束原因 `quit`, 退出码 0; `exit` 是意外退出, 退出码 1), 照常收尾 (关页面、停后端、删 socket 目录) 后退出; 6 秒没退完
  直接 `Cmd::Exit(0)`.
- `{"type":"request","id","op",…}` (id 是数字或字符串, 只在这条连接里有意义) → id 换成进程内递增的号, 整行作为 `devrequest` 推给 Broker
  (`broker/dev.ts` `DevRequests.request`), 做完调 `Shell.devRespond`, 按号找回连接、换回原 id 写出 `{"type":"response","id","ok":true,"result"}` 或
  `{…,"ok":false,"error":"<文字>"}`, 每个请求恰好一次 (超时在工具一侧); 连接断了, 它还没回答的请求作废. `web` 参数是 web 名
  (`ledger#1048576`)、应用 id (window 号最小的那个 web) 或 `desktop`:
  - `webs` → `{webs: [{name, app, kind, window, title}]}`.
  - `devtools` → `{port}`: 这个会话的 DevTools 端点 (下面 **DevTools 端点**); 没有端点 (不是 dev 模式、端口没开成) 时回错.
  - `eval {web, code, node?, arg?}` → `{value}`: 和 `ACDE_DEBUG_DIR` 一样求值 (promise 等落定), 结构化克隆回来再 JSON (undefined 是 null, JSON 不了的回错).
    给了 `node` (render 节点 id, 即 ref 里点后面的数) 时 `code` 是一个函数的源码, 以 `(元素, arg)` 调用 (rpc `debug.evalOn`).
  - `shot {web}` → `{png: <base64>, width, height}` (`Shell.capture`, 设备像素, 桌面的含面板).
  - `snapshot` / `act` / `run` / `open {name}` / `query {selector, window?, ref?, limit?, attributes?}` → `Broker.inspect.api` 的同名方法 (「看和操作桌面」).
  - `console {web?, since?, limit?, level?}` → `{entries, next, dropped}`: 页面的 `console.*` 和没人接的错误 (`devlog.ts`, 见下), `level` 是
    log / info / warn / error / debug, 或 errors (console.error 和错误); `web` 是 web 名、应用 id 或 desktop; `since` 是上次的 `next`, `dropped`
    是 since 之后已经丢掉的条数. 条目 `{seq, time (ms, 和日志同一个零点), web, app, kind: console | error | rejection, level, text}`.
  - `network {web?, since?, limit?, failed?}` → 同样的形状, 条目 `{seq, time, web, app, id, kind: fetch | xhr | websocket | eventsource, method,
    url, requestBytes, status, statusText, responseBytes, ms, error, done}`; `failed` 只要出错的和 status ≥ 400 的.
  - `screen {path}` → `Shell.screenshot(path)` 加 `path` (绝对路径; 整个屏幕, 所有窗口合在一起).
  - `emulate {colorScheme?: light | dark | null}` → `{colorScheme, emulated}`: 所有页面 (和以后开的) 的 `prefers-color-scheme`
    (CSS 和 `matchMedia`); null 回到系统的 (portal / `ACDE_COLOR_SCHEME`). 模拟配色时系统配色的变化只记下, 回到系统时再生效.
  - `choose {folder | open | save}` (恰好给一个) → 原样回: 事先答复页面下一次的这种选择器, 不弹窗, 三种各排各的队列, null 当作用户取消.
    `folder: 绝对路径` 答 `showDirectoryPicker`; `open: [绝对路径, …]` (不空) 答 `showOpenFilePicker` / `<input type=file>`, 多于一个而这次
    不许多选时这次回错; `save: 绝对路径` 答 `showSaveFilePicker`. napi `Shell.answerFolder` / `answerOpen` / `answerSave` → hostwin 的队列,
    src/host `chooser.rs` 先取队列再弹窗, 有窗口、headless、Linux 的 portal 都一样; 会话没有这个, 回错.
  - `route {url, method?, web?, times?, status?, statusText?, headers?, body?, abort?}` → `{id}`: 让页面的 fetch / XHR 拿到假的回应, 不到应用的
    文件、后端或网络 (`devroutes.ts`). `url` 是 glob (`**` 任意, `*` 不含 `/`; `/` 开头的比路径加查询, 否则比整个 URL) 或 `{regex, flags}`;
    `body` 是 base64; `status` 200–599 (默认 200), `statusText` 默认按状态码; `abort: true | 文字` 让请求失败 (不能和回应一起给); `times` 用完就删.
    后加的先匹配. Broker 存着规则, 推给匹配 `web` 的页面 (`{type: 'devroutes'}`, 新起的页面在 `WebInit.devRoutes` 里拿); 页面按 acde-dom 的
    `observe({route})` 先问规则再走 `route()`, 带 `times` 的用一次 `port.post({devroute: id})` 给 Broker 减一 (各页面自己也减, 几个页面同时用可能多
    用一次). 不管 CORS、cookie; WebSocket / EventSource 不经它. network 的条目带 `mocked: true`.
  - `unroute {route?}` → `{removed, left}`: 删 id 是 `route` 的那条, 不给全删 (请求自己的 `id` 是请求号, 所以不叫 id).
  - `drop {files, web?, x?, y?}` → `{web, window, files}`: 模拟把这些文件 (绝对路径, 不空) 从系统拖到 web (默认 desktop) 的窗口上, `x` / `y` 是页面坐标
    (一起给, 默认页面中心), 按这一点命中 (被别的窗口盖住就落到那个窗口), 和真的系统拖放同一段 (`dndenter` + `dnddrop`); 只排进主线程就回答,
    页面收到 drop 要自己等. 会话没有, 回错.
  - `pointer {x, y}` → `{x, y}`: 把指针移到屏幕坐标 (会话是全局逻辑坐标, 宿主窗口是内容区坐标), 同真的移动 (悬停、屏幕边缘事件都照常发).
  - `clipboard {text?}` → `{text}`: 给 `text` 先写, 再读回宿主剪贴板 (napi `Shell.readClipboard` / `writeClipboard` → hostwin; headless 是进程里那份,
    有窗口是系统剪贴板); 会话没有, 回错.
  - `input {web, events}` → act 的回答: 按页面的 CSS 坐标注入一串原始输入 (`Inspect.input`, 加窗口原点和 `contentOffset` 后 `Shell.inject`):
    `{type: move | down | up | wheel, x, y, button?: left | right | middle, dx?, dy?}`、`{type: keydown | keyup, key}` (键名同 act 的 key)、
    `{type: text, text}` (走输入法提交那条路, 给焦点元素)、`{type: wait, ms}` (停 0–10000 ms, 中间按住的键和按钮不放: 游戏里按住方向键). down / up / wheel 发在它们的 x、y 上: 指针不在那里时先补一个 move (注入的按钮和滚轮只认指针所在). 先给窗口焦点; 连着的 move 之间隔 16 ms (页面的 pointermove 按帧合并), 最后等页面安静.
    act 的 click / double / right / hover 的 arg 是要按住的修饰键 (`shift`、`ctrl+shift`, 还认 `option` / `cmd`).
  - `clock {web, action, time?, ms?}` → `{installed, paused, now, performanceNow, fixed, timers}`: 接管这个页面的时间 (rpc `dev.clock`, acde-dom
    `core/clock.ts`, 和 Playwright 的 clock 一样): `install {time?}` 之后 `Date` (换成同原型的包装, `Date()` / `Date.now()` / 无参 `new Date()`
    和 `Intl.DateTimeFormat` 的无参 format / formatToParts)、`performance.now`、`Event.timeStamp`、rAF 的时间戳、Web Animations 和页面的
    `setTimeout` / `setInterval` / `requestIdleCallback` 都走虚拟时间 (照常流动, 定时器排在虚拟队列里, 一个宿主定时器叫醒最早的); `pauseAt {time}`
    跳到那时停住 (已经过了就在此刻停住、`Date` 改成那个时间, performance.now 不倒退); `fastForward {ms}` 跳过去, 到期的定时器各响一次 (间隔
    的也一次); `runFor {ms}` 一步步走, 每个定时器在它自己的时刻响 (间隔的每次都响), 每响一个让出一个任务 (微任务跟着跑); `resume`;
    `setFixedTime {time}` 钉住 `Date`; `setSystemTime {time}` 只挪 `Date`; `state`. 装了不能卸 (页面重载就没了). CSS 动画和过渡走 render 的
    时钟, 不受它管. acde-dom 和 acde-host 自己的计时 (任务队列 `queueTask`、双击判断、select 的打字跳转、`settle`、输入法、面板测量、dev
    状态恢复、GPU 计时) 用真实时间: acde-dom 导出 `hostTime` (`now` / `wallNow` / `setTimeout` / `clearTimeout`) 给宿主代码用.
  - `dialog {web, accept?, text?}` → `{web, accept}`: 事先答复这个页面下一个 `alert` / `confirm` / `prompt` (页面里按顺序排, `devdialog` 消息):
    `accept: false` 是取消, `text` 是 prompt 的回答 (不给用默认值). 没有答复时照旧 (`alert` 画在窗口里, `confirm` false, `prompt` null).
    每个对话框都记进 console (`kind: dialog`, `level: info`, 带 `dialog: {type, message, defaultValue, answered, accept, text}`).
  - `init {code, web?, once?}` → `{id}`: 页面加载前要跑的脚本 (`WebInit.devInit`, 在页面的 HTML 解析之前, 全局都在、`document` 还空),
    `web` 是 web 名或应用 id, 不给是所有页面; `once` 的只给下一个起来的页面. `uninit {init?}` → `{removed, left}`.
  - `reload {web}` → `{web}`: 和 IPC 的 `reload` 一样重开这个应用的窗口 (或重起桌面), 等它重开.
  - `resize {web, width, height}` → `{width, height}`: 页面 (不含标题栏) 改成这么大. `free` 窗口经 `Shell.place`; 铺满的 (单应用的 acde dev、
    桌面) 改宿主窗口 (`Shell.resizeScreen` → hostwin `Cmd::Resize`: headless 直接换输出尺寸, winit `request_inner_size`, Windows 还没有);
    会话里回错.
- **DevTools 端点** (只在有 `ACDE_DEV` 时, Chrome DevTools Protocol, #172): runtime 模块 `devtools/` (napi `DevTools.open()` /
  `DevTools.targets(list)`), 宿主窗口和 Linux 会话一样. Broker 建 `DevRequests` 时 `open()`: 在 `127.0.0.1` 上听系统挑的端口,
  线程 `acde-devtools`, 每条连接一条 `acde-devtools-conn`; 没有 `ACDE_DEV` 时 `open()` 回 null, 不开任何端口. 没有令牌 (#199, 同 Chrome 自己的
  调试端口): 防护见下面的 `Host` 和 `Origin`. `GET /json/version` (`Browser`、`Protocol-Version`、
  浏览器的 `webSocketDebuggerUrl`), `GET /json` 和 `/json/list` (每个目标 `{id, type, title, url, webSocketDebuggerUrl, devtoolsFrontendUrl,
  description}`), 别的 404. 目标是 Broker 的 webs 加上服务 (#193): web 的 `id` 是 web 名 (`alpha#7`, 桌面 `desktop`, 地址里按百分号编码),
  `type` 是 `page`, `title` 是 `webs` 的标题加括号里的应用 id (桌面是 `(desktop)`), `url` 是页面地址; 服务都跑在 Broker 的 isolate 里, 合成
  一个目标: `id` 是 `broker` (Broker 的 isolate 名, 它和别的 isolate 一样在 inspector 里登记), `type` 是 `service`, `title` 是
  `services: <服务名, …>`, `url` 空, 有服务在跑时才列; 后端以后定. `DevRequests` 每 250 ms 算一次 (`publish()`), 列表变了才推给
  `DevTools.targets`, 从列表里消失的目标的 WebSocket 以 1001 关掉. `webSocketDebuggerUrl` 是 `ws://127.0.0.1:<port>/devtools/page/<id>`,
  `devtoolsFrontendUrl` 是 `devtools://devtools/bundled/devtools_app.html?ws=<地址>` (不是 Chrome 给远程设备用的 `inspector.html`: 那个左边留一块投屏区, 我们不答 `Page.startScreencast`, 只剩一片空白), 但 `ws` 的值整个再百分号编码一次 (前端读它时解码一次; 目标 id 里的 `#` 在路径里本来就是 `%23`, 不再编码会被还原成 `#` 当片段丢掉), 所以 `chrome://inspect`
  里配上 `127.0.0.1:<port>` 就能发现目标并打开. 不在列表里的目标升级前回 404. WebSocket 上: `Browser.getVersion` 自己答, 别的
  方法交给 `acde_runtime::devtools::forward` 装上的 `Forward` (`attach(client)` / `message(client, text) -> bool` / `detach(client)`, 在连接
  线程上调用; `Client::target()` 是 web 名, 浏览器端点是 None; `Client::send(text)` 任意线程发一条文本帧, 连接断了回 false), 没装或它回
  false 时答 `-32601 '<method>' wasn't found`; 请求带 `sessionId` 的回答原样带回. 只收文本帧 (16 MB 以内), 二进制帧关连接;
  控制帧不超过 125 字节、不分片. 防护 (同 Chrome 的调试端口): `Host` 头只认 `127.0.0.1`、`localhost`、`[::1]` (可带端口), 别的 (含没有) 先回 400
  (防 DNS 重绑定); 然后 HTTP 和 WebSocket 请求带了 `Origin` 而不是 `devtools://devtools` 的回 403 (浏览器里的网页连本机端口时一定带自己的
  `Origin` 且改不了), 不带 `Origin` 的 (命令行工具、`acde devtools`、`chrome://inspect` 和从它打开的 DevTools) 照常. 只在 dev 模式开、只听
  127.0.0.1; 同一台机器上的其他本地用户能连到, 和 Chrome、Node 的调试端口一样; 同时最多 32 条连接, 多的接下就关; 请求头从建连起 10 秒内读完, 否则断开. `Client::send` 只把帧放进
  这个客户端的有界队列 (256 帧) 就返回, 不阻塞调用方 (页面线程也能调); 每个客户端一条 `acde-devtools-send` 线程按序写出, 套接字写超时
  10 秒; 队列满、写失败或超时都断开这个客户端.
  页面目标接到页面的 V8 inspector (#184, src/host `inspector/devtools.rs` 的 `Pages`, 第一次登记时经 `forward` 装上): dev 模式下每个 isolate
  `inspector::start` 后把 `inspector::remote()` 按 web 名登记 (`devtools::opened`), `inspector::stop` 时 `closed`. 客户端 `attach` 时在
  它的目标页面上开一个 inspector session (`Remote::connect`), 回复和通知直接 `Client::send` 回去; `message` 原样投给这个 session
  (目标还没登记时回 false, 端点答 -32601), `detach` 断开. 页面关了: 给它的客户端发 `Inspector.detached {reason: "target_closed"}` 再关
  WebSocket; 重载例外 (#202, 见下). 有 session 连着时页面事件循环不退出 (`keep_alive`).
  **断点和单步** (#194): V8 暂停 (断点、`debugger`、单步) 时调 inspector client 的 `run_message_loop_on_pause`, 页面线程在
  `inspector::paused` 里等 `Pending` 的条件变量 (每 100 ms 醒一次), 有消息就 `dispatch_posted` (V8 域和页面域都答, 页面域的处理器在
  暂停中照样跑, 不过任务末尾的钩子和微任务检查点要等继续以后); V8 的 `quit_message_loop_on_pause` (继续、单步) 让它返回. 三种情况也返回、
  页面接着跑: 最后一个客户端断开 (`extra` 空了)、页面要停 (`inspector::stop_when` 交给它的 `stopping`, web 被 terminate 时为真, 返回后
  V8 的 terminate 生效)、进程收到退出信号 (sys.rs 的信号线程先调 `inspector::release_pauses`, 之后整个进程不再暂停; Broker 的 isolate 没有
  `stopping`, 停在断点上时要靠它才能 Ctrl-C)、没有客户端时根本不进 (热重载那个 session 设了 `Debugger.setSkipAllPauses`, 所以没人连着时
  `debugger` 不停). 暂停循环在 TryCatch 里派发, 处理器抛的错记一条 warn 后清掉, 不留到继续后的页面代码里. 暂停期间不跑微任务检查点,
  所以页面这边的 `DevToolsPage` 对同步结果当场回复 (只有返回 Promise 的方法等它落定), 否则暂停时 Elements 展不开节点.
  暂停期间这个 web 的 `busyMs` 记 0, Broker 不把它当卡死. 页面在跑长任务时 DevTools 的 `Debugger.pause` 另经 `IsolateHandle::request_interrupt`
  在 JS 里插进去 (`interrupted` 只从队列里取出 `Debugger.pause` 交给 V8). 暂停时窗口停在最后一帧. 现在 V8 只答 Runtime、Debugger、Console、Profiler、HeapProfiler 等它自己的
  域. 没人接的页面错误 (`host.reportError`) 也经 `inspector::thrown` 报给 inspector (`Runtime.exceptionThrown`, 带 Error 本身, 栈在它的
  `description` 里).
  **重载不断开** (#202): Broker 让同一个 web 重来前 (`Web.terminate` 时 `reloading` 为真: `location.reload` 的 `window.reload`、单应用
  acde dev 的 `devReload`、桌面的 `devReload`) 先调 napi `DevTools.reloading(web 名)`, 端点记 10 秒 (`RELOAD_WAIT`); 期间目标留在
  `/json/list` 里, 它的客户端不因列表变化被关. 旧页面 `closed` 时 `Pages` 见到这个记号就不发 detached, 把会话挂起 (记着客户端开过的域和
  `enable` 参数, 挂起期间收到的消息排队); 同名新页面 `opened` 时清掉记号, 在新 inspector 上重新 `connect`: 开过 Runtime 的先补发
  `Runtime.executionContextsCleared`, 再按原顺序重放各域的 `enable` (负数 id, 回复不给客户端; V8 因此自己发 `executionContextCreated`,
  页面域照常进页面), 开过 Page 的用 `Page.getFrameTree` (id -1) 的回答发 `Page.frameNavigated`, 开过 DOM 的发 `DOM.documentUpdated`,
  再按序投递排队的消息. 等满 10 秒没回来按真的关闭处理 (detached 后关). 桌面里的应用经 `devReload` 是关窗再开新窗口, web 名变了, 仍是新目标.
  接回时先投 `Posted::ExpectHandler`: 新页面还没装处理器的话, 此后 2 秒内到的页面域消息先排着, 装上后在下一个任务里投给它, 2 秒还没装才答
  -32601; 别的时候 (没接回过的会话、Broker 的 isolate) 没有处理器就立即答 -32601. 挂起的会话和页面这边的排队各最多 1000 条, 多出的答
  -32000 "page is reloading".
  **页面这边答的域** (#187): `Page`、`DOM`、`CSS`、`Overlay`、`Network` (`inspector/page.rs` `DOMAINS`, 按方法名点前面的域分) 不进 V8 session,
  经同一个 `Remote` 投成 `Posted::Page`, 在页面线程上交给页面装的处理器 (`host.devtoolsHandler(fn)` → 回 frame id 即 web 名; `fn(session, text)`,
  客户端断开时 `fn(session, null)`), 处理器经 `host.devtoolsSend(session, text)` 把回复和事件发回这个客户端. 页面没装处理器时立即答 -32601 (刚从重载接回时除外, 见上).
  JS 一侧在 acde-host `devtools/`: `DevToolsPage` (只在 `ACDE_DEV` 时由 `worker.ts` 装) 按域分发, 每个客户端一份 `enabled`, 没有自己
  `enable` / `disable` 的域由它记开关, 没实现的方法答 -32601, `emit(domain, method, params)` 只发给开了这个域的客户端, `emitTo(session, …)` 只发给
  这一个; 域是 `DevToolsDomain` `{name, methods, closed?}` (`closed(session)`: 客户端断开). 已有: `Page` (`devtools/page.ts`): `getFrameTree` / `getResourceTree`, 主 frame 的 `id` 和 `loaderId` 是 web 名
  (和上下文 auxData 的 `frameId` 一样), `url` 是页面地址, `resources` 还空着. 加一个域: 在 `devtools/` 写一个 `DevToolsDomain`, 在 `worker.ts`
  `DevToolsPage.install` 的列表里加上; 域名不在 `DOMAINS` 里时再加进去 (不加就仍然交给 V8).
  `DOM` (#190, `devtools/dom.ts`, 页面一侧的取数在 `devtools/pagedom.ts`): 只读的元素树. `getDocument` / `requestChildNodes` (发 `setChildNodes`) /
  `describeNode` 的 `nodeId` 和 `backendNodeId` 都是 render 的节点 id (`WebInternals.idOf`, 和 `acde inspect` 的 ref 同一个), 只有空白的文本节点
  不列. 哪些节点展开过 (子节点发给了前端) 按客户端 session 各记一份: `getDocument` 只重置自己的, `setChildNodes` 只发给要它的 session,
  断开或 `disable` 时删掉那份, 所以几个前端各看各的、后连上的也拿得到完整的树. `enable` 或 `getDocument` 之后用页面的 `MutationObserver`
  (不让页面看到) 逐个 session 推: 父节点在它那里展开过就推 `childNodeInserted` / `childNodeRemoved`, 只是见过 (它的父节点展开过) 推
  `childNodeCountUpdated`; `attributeModified` / `attributeRemoved` / `characterDataModified` 只推给见过这个节点的 session. 最后一个客户端
  `disable` 或断开时停.
  编辑类方法 (`setAttributeValue`、`setOuterHTML`、`removeNode` ...) 回 -32000 "read only". `resolveNode` 要 V8 的 objectId, 由 `inspector/page.rs`
  `rewrite` 改写成这个客户端 V8 session 里的 `Runtime.evaluate` (表达式调页面上 `Symbol.for('acde.devtools.node')` 的查找函数, 只在 dev 时装),
  回来的 `result` 改名成 `object` (补 `subtype: 'node'`), 找不到是 -32000.
  `setInspectedNode` 也在 `inspector/page.rs` (`set_inspected`) 拦下: 用同一个查找函数拿到节点, 存成 `Global` 包进 `InspectableImpl`, 交给这个客户端
  V8 session 的 `add_inspected_object`, 控制台的 `$0` (带 `includeCommandLineAPI` 的求值) 就是它; 找不到是 -32000.
  查询和搜索 (#201): `querySelector` / `querySelectorAll` 用页面节点自己的 `querySelectorAll` (`pagedom.ts` `query`), 无效选择器回 -32000
  `'<选择器>' is not a valid selector.` (异常在 acde-host 里接住, 不进页面); 结果里前端没见过的节点, 先沿祖先自上而下给没展开过的推
  `setChildNodes` (同 `requestChildNodes`, `DomDomain.#reveal`). `performSearch` 照 Chrome: 元素名、属性名和属性值、非空白文本里含查询串
  (不分大小写; `"…"` 是整串相等; `<x` 元素名开头, `x>` 结尾, `<x>` 相等), 再并上按 CSS 选择器查到的 (选择器无效就只算文本), 按文档顺序;
  不支持 XPath. 最多留 1000 个 (多的丢掉, `resultCount` 是留下的数). 结果按客户端 session 存 (`searchId` 是 `<session>.<序号>`),
  `getSearchResults` 只认本 session 的, 区间越界回 -32000; `discardSearchResults` 或断开 (`DevToolsDomain.closed`) 时删掉.
  `Network` (#188, `devtools/network.ts` `NetworkDomain`): fetch 和 XHR. 数据来自 acde-dom 观察点的 `network` (`NetworkObserver`): `Tracked`
  只在 `recording()` 为真 (有客户端 `Network.enable`) 时把请求头、请求体、响应头和收到的每块数据交给它, 没人开时不记录也不复制. 事件
  `requestWillBeSent` / `responseReceived` / `dataReceived` / `loadingFinished` / `loadingFailed` (失败、中止 (`canceled`)、没有 network 能力
  被拒都带 `errorText`), `requestId` 是 `Tracked.id`, `loaderId` / `frameId` 是 web 名, 时间戳是 `performance.now()` 秒; `responseReceived` 的 `response.timing`
  (`ResourceTiming`): `requestTime` 是请求开始, `sendStart` / `sendEnd` 是 0 (交给传输层即发出), `receiveHeadersEnd` 是收到响应头时相对它的毫秒,
  DNS、连接、SSL、代理、worker 这些没有可靠来源的是 -1. 请求完成后整个
  响应体留着给 `Network.getResponseBody` (文字类型且是合法 UTF-8 回文字, 其余 base64; 没有的回 -32000), 每页最多 16 MiB, 超出时丢最早的;
  单个超过上限的一超过就丢掉已收的块, 不留. 有客户端中途 `Network.disable` 时丢掉进行中的记录, 之后的数据不再上报. #189 补上其余流量:
  WebSocket (`webSocketCreated`、握手请求和 101 回答、`webSocketFrameSent` / `Received` (文字 opcode 1, 二进制 2 base64)、`webSocketClosed`;
  连不上是 `webSocketFrameError` 再 closed, 不发 requestWillBeSent), EventSource (类型 `EventSource`, 每条消息 `eventSourceMessageReceived`,
  响应体不留), 页面加载的图片、样式表、字体 (类型 `Image` / `Stylesheet` / `Font`; 应用包里的文件经 `Tracked.network` 只报给 DevTools,
  dev 日志不变; 渲染器自己从应用包读的 (`<img>`、`<link rel=stylesheet>`、CSS 里的字体: render `net.rs` `LocalNet` 直接读文件, 不经 JS 加载器)
  在 dev 模式下也给加载器发一个 `served: true` 的 `Load` (没有 `done`), src/host `dom.rs` 以 `(-1, url, destination, cors, true)` 调页面的
  加载回调, acde-dom `reportServed` 在有客户端录制时按路径读出文件补报; 非 dev 模式不发). 图片取自文档的图片缓存或并入进行中的请求时不再取,
  blitz fork 经 `NetProvider::reused` 报成 served 且 `cached` (`Load.cached`, 加载回调第 6 个参数): 只报状态和按扩展名的类型, 不读文件,
  `responseReceived` 带 `fromMemoryCache: true`. `<img>` 插入文档时, 当前 `src` 已经开始取过 (成功、失败或还在取, 记在 `ElementData.image_tried`) 就不再取, 和规范一样不重发请求、
  不再触发一次 load / error (`process_added_subtree`); `src` 换了才重新取. 不在文档里的 `<img>` (`new Image()`) 设了 `src` 也加载
  并发 load / error (blitz fork `mutator.rs` `set_attribute`; render `Engine::image` 只在请求进行中时算加载中), 和浏览器一样. 因页面没有 network 能力被拒的 (`NO_NETWORK`) 在 `loadingFailed` 带 `blockedReason: "other"`.
  `Tracked` 的 `frame(sent, data)` / `message(event, data, lastId)` 交给 `NetworkObserver` 的可选同名方法; `exchange` 可以接收调用方建好的 `Tracked`.
  `CSS` (#191, `devtools/css.ts`) 和 `DOM.getBoxModel`: 取数和 `getComputedStyle` / `getBoundingClientRect` 是同一个原生接口 (`dom.computedStyleAll`,
  `dom.rect`, 经 `pagedom.ts`). `getComputedStyleForNode` 是 stylo 算出的全部值; `getBoxModel` 的 border 是 `rect` (变换后的包围盒),
  按算出的 `border-*-width` / `padding-*` 往里缩得 padding / content, 按 `margin-*` 往外扩得 margin (`auto` 当 0), `display: none` 或不是元素回 -32000.
  `getMatchedStylesForNode` 只给 inline style (元素的 `style` 声明, 没有 `styleSheetId`, 不可编辑), `matchedCSSRules` / `inherited` 留空:
  render 还没有可靠的“哪条规则命中”来源, 不编. 编辑类方法 (`setStyleTexts`、`addRule` ...) 回 -32000 read only. 每次选中都现取, 页面改了样式再选就是新的.
  `Overlay` (#192, `devtools/overlay.ts`): `highlightNode` (`nodeId` / `backendNodeId`) 调 DomNative `highlight(id)` (`-1` 去掉), 同一节点不重画;
  `hideHighlight`、`disable` 和画它的客户端断开时去掉 (别的客户端的 `hideHighlight` 也去掉页面经 objectId 画的). 只给 `objectId` 时
  `inspector/page.rs` `rewrite` 改成这个客户端 V8 session 里的 `Runtime.callFunctionOn`, 在那个对象上调页面的 `Symbol.for('acde.devtools.highlight')`
  (只在 dev 时装, 不是本页节点回 false → -32000). `setInspectMode`、`setShowViewportSizeOnResize` 等开关回 `{}` 不做事. src/host `dom.rs` 的
  `highlight` 只在有 `ACDE_DEV` 时转给 render, 别时不做事.
- **dev 日志** (只在有 `ACDE_DEV` 时): acde-dom `core/observe.ts` 的 `observe(observer)` 是页面里唯一的观察点, 没注册时零开销. `console.*`
  (照打日志之外) 报 `console(level, text)`; 有 inspector 的 dev 页面 (`host.inspected()`) 里 acde-dom 的 console 还把原参数交给 V8 自带的
  `console` (装上前的 `globalThis.console`, 同名方法, 每次一份), 由它报给 inspector (`Runtime.consoleAPICalled`, 真的 RemoteObject 和调用栈);
  V8 的 console 不打日志, 所以 dev 日志不重复; 没人接的 `error` / `unhandledrejection` (交给 `host.reportError` 的那些) 报 `error(kind, text)`
  (Error 的 stack, 别的 realm 来的按 `stack` / `name` + `message` 认; 栈和 console 文字里 `http(s)://…/x.js:行:列` 的帧, 包里有这个文件的 source map 时
  换成源码位置, 如 `src/main.js:8:9`: acde-host `devlog.ts` `SourceMaps` 读文件末尾的 `sourceMappingURL` (同源文件或 data: URL), 按文件缓存,
  map 经 host 的 `readSourceMap` 读 (src/host `dom.rs`: 页面的 `readAsset` / fetch 仍拿不到 `.map`); 没有 map 的帧原样留. 交给
  `host.reportError` 的 "page error" 日志也用换过的栈, #45); `fetch` / XHR / EventSource (都经 `exchange`, 加上本地资源和够不着的地址)
  和 WebSocket 报 `request`: start → response (WebSocket 是 101) → end (收到的字节) 或 error (中止是 `aborted`; 够不着时说清是「应用里没有这个
  文件, 也没有后端」还是「不是这个应用的地址」). 页面 (`worker.ts`) 把它们单向 `port.post` 成 `{devlog, time, …}` 给 Broker (不是 rpc,
  页面重启、崩溃了记录还在); Broker 的 `DevLog` 两种各留最后 5000 条、文字最长 16 KB, 请求按 web + id 合成一条, web 没了时还开着的记成
  `the page went away`.

**热重载** (acde 构建时不压缩, `NODE_ENV` 是 development). acde 比较构建前后的产物 (acde 仓库 `src/changes.ts`): 只有 `.css` / `.js` 变了、
HTML 去掉样式和脚本引用后一样时发 `hot: true`. Broker 给那个应用的窗口 (或桌面) 发 `devhot`, web (acde-host `devhot.ts`) 重读入口 HTML,
都能热替换才动手, 否则整页重载:

1. 样式: 新旧 HTML 的 `<style>` / `<link rel=stylesheet>` 按顺序和页面里的对上, 换文字或 `href` (加 `acde-dev=<n>` 让 render 重读).
2. JS 函数体: 内容变了的 module 脚本经 V8 inspector 的 `Debugger.setScriptSource` 换源码 (src/host `inspector/`: 有 `ACDE_DEV` 时每个
   isolate 一个 inspector session, V8 带 `--inspector-live-edit`; 性能采样 `profile.rs` 也用这个 session, 同步 `inspector::send`).
   同一个 inspector 还能开别的 session (#182, 给开发者工具用): 页面线程上 `inspector::remote()` 拿到可跨线程的 `Remote`,
   `connect(sink)` → session 号, `send(session, 协议消息 JSON)`, `disconnect(session)`. 投递进一个队列 (`Pending`, 带 Condvar,
   断点暂停时的消息循环 (#174) 也从它取), 队列由空变非空时给页面事件循环发一个任务 `dispatch_posted`, 所以页面空闲时也立刻处理;
   这些 session 的回复和通知都原样交给 `sink` (在页面线程上调用, `sink` 自己转到别的线程); 页面的上下文登记时带 auxData `{isDefault: true, type: "default", frameId: <web 名>}`,
   所以不带 `contextId` 的 `Runtime.evaluate` (DevTools 控制台默认这样发) 落在它上面. dev 模式下模块源码末尾加 `"\n;"` (`inspector::module_source`), 换源码时也加:
   V8 LiveEdit 的 diff 把文件末尾追加的代码当成没变. 改了模块顶层 (`BlockedByTopLevelEsModuleChange`)、函数在栈上、classic 脚本变了都整页重载.
   运行时自己的脚本 (`web.js`、`broker.js`) 在 DevTools 里是忽略列表里的脚本 (#184), 前端在控制台消息、异常和单步时跳过它们的帧, 位置落在页面代码上:
   dev 构建 (`scripts/bundle.mjs`) 给 `web.js.map` / `broker.js.map` 的每个源加 `ignoreList` / `x_google_ignoreList`; 没有自己 source map 的
   (正式构建) 在 dev 模式下由 `inspector/ignore.rs` 在源码末尾接一个 data: URL 的 source map, 整个文件映射到一个忽略列表里的源 `acde-runtime`.
   正式构建的文件本身不变. 前端的“自动把已知第三方脚本加入忽略列表”关掉时不起作用.
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
  清单的 `services` 里写服务名才能调 (写在 capabilities 里是校验错误). 服务名不能用系统模块的名字 (`RESERVED_NAMES`). 重活放进 `ctx.spawn(argv, {cwd, env, onLine, onExit})` 起的进程 (`child.rs`: 自己的进程组, stderr 进日志加前缀
  `[<服务名>]`, 服务关闭后 SIGTERM, 3 秒后 SIGKILL).
  桌面清单的 `services` 项可以写成 `{name, modules}`, 列出这个服务能用的外壳模块; 服务经 `ctx.import('acde:<模块>')` 拿到 `{<模块>, default}`
  (Broker 侧 `broker/access/modules.ts` `ServiceModules.module(名字, 服务名)`), 没列的拒绝并说缺哪条声明. 服务还另有 `ctx.inspect`.
  **配置里怎么写这条授权** (`acde.config.jsonc`, SDK `DesktopConfig.services`: `Record<string, string | ServiceConfig>`, `config.schema.json` 同):
  每项是模块文件, 或 `{ "module": 文件, "modules": [外壳模块] }`. 读法只有一份: `Manifest.configServices(raw)` 给出 `{name, module, modules}[]`
  或一句错误; `modules` 交给清单那条规则 `Manifest.desktopServices` 判 (文字相同: `service "clock": modules lists shell modules (…)`), 没有 `module`
  (`a service is its module or {module, modules}`)、多出别的字段 (`"shell" is not a field of a service (module, modules)`) 也是错误.
  acde 的 check / build 用它, build 把有 `modules` 的写成桌面清单的 `{name, modules}`. schema 里 `modules` 的枚举就是 `SHELL_MODULES` (测试对着).
  **服务拿到的是什么** (SDK `ServiceModuleTypes`, `ServiceContext.import` 按它定类型; 服务在 Broker isolate 里, 没有页面也没有 surface):
  `acde:windows` 是页面拿到的那一个 (`Required<AcdeWindows>`): `list()` 的行来自 `WindowRecords.rows()` (和页面的行同一个形状, 带 `state`), 调用走 `WindowCalls.windows`
  (调用者是 `WindowCalls.SERVICE`, 和桌面页面同一段检查; `launch` 的 `slot` 不算数, 服务没有窗口可嵌), `on(类型)` 收全局窗口事件 (不认识的类型抛 TypeError);
  `acde:packages` 同页面 (含 `on('changed')`); `acde:session`、`acde:desktops`、`acde:inspect`、`acde:setDefault` 同页面; `acde:desktop` 只有 `apps()` (钉面板、
  `setDoubleClick`、`setFrameTheme` 要页面或 surface, `download` / `notification` / `screenshot` / `shortcut` 事件只发给页面); `acde:permissions` 不给服务
  (`is not available to services here`). SDK 里写成 Promise 的调用在服务里也回 Promise (`ServiceModules` 包一层 async). 事件: Broker 的 `#toDesktop` 同时交给
  `ServiceModules.emit`, 每个服务一份 `Notices` (`notices.ts`, 页面的 `on` 用的也是它), 处理函数在 Broker 线程上同步跑, 抛错只记日志; 服务停了 (或没起来)
  `release(服务名)` 丢掉它的订阅.

找包的顺序: acde-host 自己 (只有品牌资源)、`ACDE_PATH`、`$XDG_DATA_HOME/acde/packages/*`、`$XDG_DATA_DIRS/acde/packages/*`, 同 id 先到先得.
外部会话 (`src/foreign.ts`): `$XDG_DATA_DIRS/wayland-sessions/*.desktop`, id `session:<文件名>` (显示名去掉 "(Wayland)", KDE 的加 "KDE");
不列 acde 自己的、`Hidden` / `NoDisplay`、程序找不到的.

**契约级别** (`apiLevel`): 每个包清单的 `acde` 字段带一个整数 `apiLevel`, 运行时的级别只在 SDK `src/runtime/level.js` 的 `API_LEVEL` 定义 (acde-host 经
`@dopame/acde-api/manifest` 读, `acdert --version` 编译时从这个文件读). 级别不同或不是正整数的包 (`Packages.refused`) 不进应用列表、
桌面列表和打开方式, 启动它的应用报 `<id>: needs level N, runtime is level M` (409, `api_level`), 选它的桌面同样报错. 没有 `apiLevel` 的包
(第 1 级之前构建的) 同样拒绝, 报 `Manifest.UNVERSIONED` (`no acde.apiLevel: ...; rebuild it with the current acde (level 1)`), 要用现在的 acde
重新构建; 校验器也把它当错误. 第 0 级 (契约级别之前的扩展期形态) 已全部去掉. acde-host 自己的包不查.
现在的契约是第 1 级.
**运行时还不是安全边界**: 按层级注入、能力和批准是契约, 不是隔离 (见「沙箱」);
第三方沙箱上线之前, 本地和开发构建的包都按开发者自己的代码运行.

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
  在屏幕上沿之外时照旧居中). 只有桌面能隐藏 / 显示 / 提前 (`acde.windows.hide` / `show` / `focus`); 应用的 `minimize` 由运行时最小化 (见「窗口状态」;
  会话里由合成器执行, 发 `windowstate`).
- **窗框**: 应用窗口 (清单 `frame` 不是 false; 桌面和面板没有) 有一条标题栏, **不在页面的文档里**: `<html>`、`innerHeight`、`100vh`、`resize`
  都只是内容区. 窗口表的 rect、grab hint、backdrop 是含窗框的整个窗口; 页面给的 `setGrabHint` / `setBackdrop` 是页面坐标, 加上窗框高再交出去,
  窗框的 hint (标题栏移动, 四边 4 px / 四角 10 px 改大小) 优先. 会话里是 crates/window `decoration.rs` 在页面 surface 上开的同步 `wl_subsurface`
  (`set_window_geometry(0, -H, W, 整高)`, 自己的画布 plane `usize::MAX`); 宿主窗口里见「宿主窗口」. 三个按钮 (样式见 render 的「窗框」, `ACDE_FRAME_STYLE`: 红绿灯或 Windows 的最小化 / 最大化 / 关闭) 按下和松开在同一个上时发
  `framebutton {key}` (`close` / `minimize` / `fullscreen` / `restore`), acde-host 调 `acde.window` 的 `close()` / `minimize()` / `requestMode`.
  标题是 `document.title` 或 `acde.window.setTitle` (没有时用 `label`), 经 surface 的 `setTitle`. 高度只在 acde-host `frame.ts` 的
  `Frame.HEIGHT` (32), 经 `claimSurface(token, {frame})` 交给 surface; 画法在 render 的 `Decoration`. 全屏时窗框照旧在. `acde:inspect` 看不到窗框
  (页面坐标加 `contentOffset`).
- **钉住的面板** (Dock、菜单栏、弹出层): 桌面页面调 `acde.desktop.pin(element, {margin?})` → `{update(), unpin()}`, 元素成为单独的 `pinned`
  窗口, 状态和 React 树还在同一个文档里. `pinned.ts` 量元素 (并上 render 报的绘制范围 `panelmove`), 要令牌 (`Shell.grant({mode: 'pinned', rect})`),
  再开一个 toplevel (crates/window `panel.rs`; 宿主窗口里是 owner 为桌面的表项), `Dom::set_panel` 让 render 单独画它 (`Frame.panels`). 输入区域只是
  元素的盒子 (`pointer-events: none` / 不可见时为空), 指针送回同一个文档; 主窗口或任一面板有焦点就算 `activate`. 元素变了 (ResizeObserver +
  MutationObserver, 700 ms 后补量) 重新量, 量不到时 `hide`. backdrop-filter 转成 `set_backdrop`.
  `pin(element, {reserve: {edge, thickness?}})` 让面板在输出的一条边上占一条 (像 layer-shell 的 exclusive zone; 不给 thickness 时是从那条边到面板远端的距离,
  跟着量的结果变), 经 surface 的 `reservePanel(id, edge, thickness)` 交给运行时. 宿主窗口 (`State::work_area`) 用输出减去显示着的面板占的边得到工作区,
  面板隐藏、挪动、改尺寸、取消钉住或输出变了时重算 (`refill`): `filled` 的窗口跟着改 rect, 全屏不管工作区; 工作区变了给 Broker 发
  `workarea {x, y, width, height}`, Broker (`broker/output.ts`) 把它放进发给每个 web 的 `screen` 消息和 `WebInit.screen.workArea`
  (`acde:window.output.workArea`). 不写 reserve 的面板什么都不占. 钉住后用句柄的 `reserve({edge, thickness?} | null)` 就地换占的边或厚度 (不用 unpin 再钉,
  工作区只变一次, 中间没有整个输出的一步; `null` 不再占, 不认识的边或负的厚度抛 TypeError). 一个宿主窗口就是一个输出; 会话里还没有工作区 (`reservePanel` 只记 debug 日志). 元素要是 stacking context, 不带祖先的裁剪和透明度.
  `acde.desktop.setDoubleClick('fill' | 'minimize' | 'none')` (SDK `DoubleClickAction`) 声明双击标题栏做什么, 随时可以再设, 下一次双击就按新的;
  不认识的值抛 TypeError. 桌面页面和声明了 `acde:desktop` 的系统应用窗口都有 (经自己的 surface 的 `setDoubleClick`, 整个宿主一份), 服务没有;
  会话里还没有 (只记 debug 日志).
  `acde.desktop.setFrameTheme(theme | null)` (SDK `FrameTheme`: `active` / `inactive` 各 `{background?, title?, line?, buttons?}`, 颜色是
  `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`; `buttonStyle: 'dots' | 'glyphs'`, `buttonSide: 'left' | 'right'`,
  `titleAlign: 'center' | 'start'`, `light: {active?, inactive?}`; 每次给的是整个主题, 不和上次的合并) 声明运行时画的标题栏的样子, 运行时照旧画、命中、拖动和双击.
  检查在 SDK `FrameThemes.parse` (`@dopame/acde-api/manifest`; 坏颜色和别的取值抛 TypeError; 不认识的键 (各层) 不再报错, 忽略并记一行 warn, #114:
  以后加的可选键在旧运行时上不出错, 但这次修改 (#114) 之前的 acdert 仍会抛, 桌面要先探测), 转成 19 个数交给 surface 的 `setFrameTheme` (整个宿主一份,
  `State.theme`). 设了就重画所有开着的有窗框的窗口 (`Msg::Theme`), 焦点变化时窗口换 `active` / `inactive` (`Msg::Active`); `null` 回到
  今天的样子. 只管合成里的窗口; 会话里还没有 (只记 debug 日志). 谁有它同 `setDoubleClick`.
  **页面不支持深色时用 `light`** (#114): 主题带了 `light` 的配色时, 页面没声明支持深色的窗口改画 `light` 那套 (缺的项用运行时默认, 不借深色主题的);
  声明了的照旧用 `active` / `inactive`. 规则同浏览器: 根元素计算后的 `color-scheme` 含 `dark`, 或根元素没写 (`normal`) 而 `<meta name="color-scheme">` 的内容含 `dark`;
  页面同时声明了 `light` 时, 还要 `prefers-color-scheme: dark` 成立 (系统是深色, 或 `emulate` 成深色) 才算深色, 也就是页面此刻画成深色时.
  **没有主题时** (单独跑的应用, 没有桌面设 `setFrameTheme`) 深色页面的窗口画运行时的深色默认 (`FrameTheme::DEFAULT_DARK`), 别的画浅色默认.
  禁用的最小化按钮按标题文字的颜色取 16% 不透明度 (深色标题栏上也看得见).
  web (acde-host `frame.ts` `Frame.followScheme`, 只给有窗框的应用窗口) 在页面载入后判断一次, 之后只在影响配色的地方变了时 (50 ms 合并一次)
  再判断: 文档节点的子节点、根元素的属性和子节点、`<head>` 的子节点, 以及 `<head>` 每个子元素的 `name` `content` `rel` `href` `media`
  `disabled` 属性和 `<style>` 的文字; 每次判断时按当前的 `<head>` 重新挂. 一个观察器都不带 `subtree`: acde-dom 只要文档里有带 `subtree`
  的观察器, 每次 DOM 变动都要取目标的全部祖先逐个查 (`mutation.ts` `interested`), 改样式会慢约 25% (#206); 也不观察 `<body>`.
  照 CSS 的规则先读根元素计算后的 `color-scheme` (每次判断读一次), 它是 `normal` 时才看 meta (应用自己切到深色时在根上写 `color-scheme: dark`, meta 还是 `light dark`); 另外监听页面 `matchMedia('(prefers-color-scheme: dark)')` 的 `change`. 结果变了才经 surface 的
  `setPageDark(dark)` 交给 hostwin (`Entry.dark_page`, `Msg::PageDark`, 画在 `Bar.dark_page`). 只经 CSSOM (`insertRule`) 改的
  `color-scheme`, 以及 `<body>` 里的 `<style>` 不触发重新判断. 回归基准 `bash scripts/dom-perf/bench.sh` (无头, 有窗框的应用里 1 万个
  节点的创建和改样式, 每边多轮中位数); 设 `BASE_ACDERT` / `BASE_APP` 时与基准版本交替跑, 任一项比值超过 `DOM_PERF_LIMIT` (默认 1.1, 即 #206 的验收线: 不超过基准版本的 110%) 退出码非零. 还没判断时当作不支持. 会话侧待实现 (会话的标题栏还没有主题).
  `acde.desktop.on('edge', fn)` (SDK `ScreenEdgeEvent` `{type: 'screenedge', edge: 'top' | 'right' | 'bottom' | 'left', entered, output}`, #113):
  指针进入、离开屏幕的一条边时各发一次 (角上是两条边各一次), 给桌面藏起菜单栏和 Dock 时用; 只发事件, 不动焦点和输入. 边的判断在 acde-model
  `ScreenEdge::touched` (离边不到 1 个逻辑像素, 且那一侧外面没有别的输出; 边的变化 `ScreenEdge::changes`). 会话: 合成器 (crates/shell `input.rs`
  `screen_edges`) 在指针移动后按所在输出算, 经 acde_shell 的 `screen_edge(output, edge, entered)` 交给 Broker, `output` 是输出名 (如 `HDMI-A-1`),
  换了输出先离开旧输出的边; 宿主窗口 (hostwin `App::moved`) 按宿主内容区算, 指针离开宿主窗口时离开所有边, `output` 是 `host`, 宿主窗口不论是否全屏都发
  (运行时不抓窗口外的输入). 两边都给 Broker 推 `edgeenter` / `edgeleave` (`key` 是边, `title` 是输出), Broker 转给桌面和声明了 `acde:desktop` 的系统应用.
  调试端点 `pointer {x, y}` 把指针移到屏幕坐标 (经 `Shell.inject` 的 `move`, 和真的移动走同一段), 用来模拟指针到边.
- **帧**: `requestFrame` 之后, 上一帧交出去就给下一帧, 两帧之间至少隔最快输出刷新周期的 0.9 倍; 页面没出新帧时退回 wl_surface 的
  frame 回调. `ACDE_WEB_FPS` 指定帧率.
- **通信**: acde-host `remote.ts` 的 `RemoteBridge` 按 Broker 给的能力建代理 (注入的能力直接用 natives), `define` 登记成内置模块
  `acde:<名字>` (`modules.rs` 用 V8 合成模块, 导出 `{<名字>, default}`). 事件不派到 `window` 上: 页面用模块上的 `on(类型, fn)` 订阅 (返回退订
  函数, 不认识的类型抛 TypeError, 文字是 `acde:<模块> has no <类型> event (<有的类型>)`; `acde:window` 也一样, `WindowSelf` 里的事件名表按 SDK `WindowEventName`
  逐个写, 少一个多一个都编不过, 另加 `shortcut`). 事件和结果都有 SDK 类型 (`types/events.d.ts`、`types/office.d.ts`): 事件按 `type` 区分 (`acde:windows` /
  `acde:launch` 的 `on(短名)` 收 `{type: 'window<短名>', window, …}`, `appschanged`、`download`、`notification`、`screenshot {path, width, height}` 或
  `{path, error}`、`shortcut {key, title: 作用域, window}`、终端的 `output` / `cwd` / `exit`); `acde.window` 的 `grab {kind, granted}`、
  `grablost {kind: 'lost', reason}`, `suspend` / `resume` 没有参数 (运行时还不发). 公共事件、请求和结果里没有 `unknown` 和 `[字段: string]: unknown`
  (SDK `test/types.test.ts` 遍历检查, 也查第 0 级的无类型重载和旧事件都不在了). 产生这些事件的地方用 `satisfies` 对 SDK 类型. 其余调用经 `rpc.ts` 到 Broker (错误原样回来, 回调函数可以跨). 本文的
  `acde.<名字>.<方法>` 指 `acde:<名字>` 导出的值.
  - **窗口状态和输出 (页面)**: `acde.window.state`、`requestState(state)` (不行就什么都不变, 没有回答)、`on('state', {state, previous})`.
    状态由运行时决定, 页面没请求的变化 (桌面最小化、窗框按钮、给最小化的窗口焦点) 也发 `state`, 页面必须照事件更新自己, 不能只记自己请求过什么.
    `acde.window.output` 是窗口所在输出的 `{width, height, scale, workArea}` (逻辑像素), 变了发 `on('output')`; 合成的桌面里所有窗口一样
    (Broker 的 `screen` 消息带上 `scale`, `WebInit.workArea` 没给时是整个输出). 窗口位置只是相对当前输出的提示, 应用接口里没有绝对屏幕坐标.
    `acde.window.hostControls` 为真时宿主 (平台) 提供窗口控件, 页面应藏起自己的最小化 / 最大化 / 关闭按钮.
    `requestActivate` 可能被拒或变成提醒用户 (attention), `requestGrab` 可能以 `denied` 拒绝, `animate` 可能立刻做完 (照样发 `windowanimated`).
    桌面 / 系统应用经 `acde.windows.requestState(id, state)` 改任何窗口 (不认识的状态 400, 会话里 501), 收 `on('state')`; `list()` 的每一行都带 `state`
    (SDK `NativeWindow.state` 必有; web 侧 `remote.ts` 的 `WindowList.deliver` 按 `windowopen` / `windowtitle` / `windowstate` / `windowclose` 维护行再发给处理函数,
    没收到过 `windowstate` 的窗口是 `normal`, 换标题不丢状态), `acde:inspect` 的窗口 (driver 用的) 带 `state`.
  - window web: 清单给的服务和能力; `acde.window` (标题、菜单、关闭、最小化、`requestMode` / `setGrabHint` / `setBackdrop` /
    `requestActivate` / `requestGrab` / `releaseGrab`、app 级 `shortcut(combo)`; `beforeclose` 返回 false 留住窗口; `request` 是别的应用
    `acde.open(<id>, {…})` 要它打开的东西, 要对方清单的 `open` 允许, 为一个请求开的窗口把它交给第一个 `request` 处理函数, 只给一次;
    `acde.window.id` 是自己的窗口号). **系统请求** (SDK `SystemRequest`): `{kind: 'open-link', url}` 和 `{kind: 'open-file', url}`
    (`url` 是 file URL 或绝对路径). `acde.open(request)` 不写目标时运行时挑应用 (`open.ts` `Opener.request`): 链接先给清单 `schemes` 里有这个
    scheme 的应用, 再按今天的 `x-scheme-handler` 默认和原生程序, http / https 最后交给系统默认程序; 文件按 `mimeTypes` 和今天的默认. 要调用方声明
    `openFiles` (桌面不用). `acde.open(<id>, request)` 写了目标时要 `open` 允许, 目标不接受 (链接的 scheme 不在 `schemes`, 文件的类型不在
    `mimeTypes`) 时 409 `not_accepted`. 收到的请求带 `kind`: 链接是 `{kind: 'open-link', url}`, 文件保留今天的字段 (没有 `fs` 的应用
    `{kind: 'open-file', url}`, 有 `fs` 的 `{kind: 'open-file', root, path, file}`). 不带 `kind` 的 `open(<id>, {…})` 回 400 `untyped_request`.
    **私有请求** (SDK `AppRequest<K, Fields>`: 接收方声明自己收的 `kind` 和字段, `on<Task | Page>('request', …)` 按 `kind` 收窄; 和系统请求合成
    `WindowRequest`): `acde.open(<id>, {kind, …})`, 运行时只查目标清单的 `requests`
    有这个 `kind` (没有时 409 `not_accepted`, 不交给对方), 内容由接收方自己查; `open` 照旧决定能叫哪些应用. 目标没写 `requests` 就什么私有请求都不收.
    `open(<id>, request, {parent, modal})` 给新窗口一个父窗口 (`broker/family.ts`: 应用只能写自己应用的
    web 窗口, 桌面可以写任何开着的窗口; 不存在 404, 别人的 403, 不是窗口号 400); 新窗口居中在父窗口上方, 不用记住的位置; 已在运行的单例应用只收请求,
    不改父窗口. 父窗口、模态记在合成器的窗口表 (hostwin `Entry`、会话 model `Window`), `acde.inspect` 的窗口带 `parent` / `modal`;
    应用拿不到 `acde:windows`; 起原生程序和嵌进 slot 用 `acde:launch` (`start` / `embed` / `close`, 要清单的 `launch` / `slots`).
  - desktop web: 全部服务; `acde.apps` (`list` / `open`), `acde.packages` (`refresh` / `install` / `natives()` / `runNative(id)`), `acde.launch`; `acde.windows` (所有窗口, 加 `kill`、
    `invokeMenu`、`stats`、`focus` / `hide` / `show`、`animate`、session / desktop 级 `shortcut`); `acde.session`; `acde.inspect`. 另收
    `windowmenus`、`windowready`、`windowcrash {reason}`、`windowhang` / `windowresponsive`、`windowshow`.
  - 不在清单里的调用拒绝 (403, `forbidden`).
  - **按调用者层级注入** (`broker/tier.ts`): 外壳模块 (`SHELL_MODULES`: `windows`、`packages`、`session`、`desktops`、`inspect`、
    `desktop`、`setDefault`) 只给桌面页面、声明了它的桌面服务和声明了它的系统应用 (与某个已安装桌面同包的应用); 应用模块 (`APP_MODULES`: `launch`、
    `apps` 只有 list / open、`open`、`openPath`、`handlers`、`window`) 给所有应用. 声明外壳模块的第三方应用启动时拒绝 (403, `shell_module`).
    没给的模块经 `host.refuseModule` 记下原因, import 时报模块名和缺的声明. 哪个模块要哪条声明只在 SDK `Manifest.importRule(name, app, origin)`
    (`{allowed, missing, reason, unverified}`, app 为 null 是桌面; acde-host 的 `Tiers` / `CapabilityCheck` 和 acde 的检查都用它).
    **服务的命名空间** (不是系统模块的名字): 运行时按服务名授权, 应用列了 `clock` 就拿到这个服务 `api` 的每个键 (`DesktopServices.start` 把每个键记到服务名上,
    `ServiceCalls.#allowed` 先把命名空间换成服务名再查 `app.services`), 而命名空间是工厂函数的返回值, 静态规则看不到. 所以规则是: 名字在 `app.services` 里 → 许;
    不在但应用列了别的服务 → 许, `unverified` 带一句说明 (`acde:timer resolves only if the service <应用> lists ("clock") provides the "timer" namespace`,
    acde 把它打成 `note:`); 一个服务都没列 → 拒绝, `missing` 是 null (缺的是提供它的那个服务的名字, 规则不知道), 原因让人写服务的名字
    (`acde:timer is not a system module; if a desktop service provides it, list that service's name in the services of <应用>`; 拼错的模块名也落在这里), 不再让人把命名空间当服务名写进去
    (那样应用要求一个不存在的服务, 启动时 `needs "timer" (service not running)`). 别的名字 `unverified` 都是 null. 新的 `acde:packages` (refresh / install / natives / runNative)
    和 `acde:launch` (`start` 要 `launch`, `embed` 要 `slots`, `close` 只关自己起的窗口: 按窗口的 pid 认 `start` 起的, `embed` 走 claim) 桌面也有.
    系统应用拿到 `acde:windows` 时也收全局窗口事件 (`Tiers.listens`). **窗口列表从 Broker 的记录起头**: 桌面页面和收全局窗口事件的系统应用起来时, `WebInit.windows`
    带上当时所有窗口的行 (`broker/records.ts` `WindowRecords.rows()`: 嵌进 slot 的不算; `{id, appId, title, web?, state}`, `state` 是记录按 `windowstate` 事件记下的),
    web 侧的 `WindowList` 从这些行开始再按事件维护, 所以晚起的系统应用 `list()` 和桌面一样全. 桌面页面 (重) 起时补发的 `windowopen` / `windowmenus` 只发给新的桌面页面,
    不再发给正开着的系统应用. 每个包都按这里注入 (没有 `apiLevel` 的包根本不加载).
    SDK 类型分层: `@dopame/acde-api/app` 只声明应用层, `@dopame/acde-api/shell` 再加外壳层; 包根声明全部.
- **原生应用** (`launcher.ts`, 只有桌面和声明了 `packages` 的系统应用能调): `acde.packages.natives()` 列可见的 `.desktop` (`{id, name, comment, icon (绝对路径, 按 hicolor /
  breeze / Adwaita 找), keywords, wmClass}`, 缓存到 applications 目录的 mtime 变了), `runNative(id)` 用 `gio launch` 起.
- **应用清单** (`acde.apps`, 解析 acde-host `apps.ts`, 校验 acde-api `validate.ts`): `id`、`label`、`icon`、`entry` (默认导出 `WindowApp` 的
  模块, 或 HTML)、`capabilities` (只放系统能力: `SYSTEM_CAPABILITIES` 加外壳模块; 不认识的名字和服务名都是错误)、
  `optional` (capabilities 里可以缺的几项, 每项也要在 capabilities 里)、`services` (用到的桌面服务名, 不能是 `RESERVED_NAMES`)、
  `mimeTypes`、`schemes` (打开哪些 URL scheme 的链接, 小写不带冒号, 不能是 `file`)、`requests` (接受哪些私有请求, 小写词, 不能是 `open-file` / `open-link`)、`heapMb` (默认 256, 最小 32)、`size` (页面尺寸, 默认 800x600, 窗框另算; 单应用模式的主窗口铺满宿主窗口, 设了 `size` 时它是宿主窗口内容区的初始尺寸, 见「坐标」)、`multiple`、`frame` (默认 true)、`backend`.
- **必需与可选能力** (`broker/access/capabilities.ts` `CapabilityCheck`, 由 `Launchable` 用): 声明的能力 (capabilities 和 services) 默认都是
  必需的, 逐个查状态: `available`、`not-declared`、`unsupported` (平台表不支持或运行时没开起来, 如 fs 的 Finder、office)、`service-not-running`、
  `shell-only` (第三方应用的外壳模块), 要批准的能力 (见「批准」) 另有 `not-asked` (还没问过用户)、`asking` (提示已经弹出, 在等回答)、`denied` (用户拒绝或撤销);
  要批准的能力只有批准了才是 `available`. `reason` 是这个状态的一句话 (`not asked for yet`、`waiting for the user's answer`、`denied by the user` …).
  必需的既不是 `available` 也不是批准的那几种状态 (`not-asked` / `asking` / `denied`, 使用时才问, 被拒只让调用失败) 时应用不进 `acde:apps` 列表和打开方式, 启动报
  `<label> needs "network" (not available on Windows host windows); list it in "optional" to run without it` (平台缺的系统能力写出平台和运行方式,
  #148; 404 `unsupported_app`; 有服务没在跑时 503 `service_not_running`, 原因照 `reason`).
  `acde dev` 重载时新清单要的能力不可用: 记一行这个错误, 开着的窗口留在旧版本, 会话不退出, 改好清单再存就照常重载. 可选的照常启动;
  声明了但不可用的 fs / terminal / network / office 在 import 时报原因.
- **平台支持表** (SDK `src/runtime/platforms.js` 的 `PLATFORM_SUPPORT` / `platformSupport(platform, mode)`, 从包根和 `/manifest` 导出, 运行时、acde 的
  平台检查和本文都以它为准): 按 `process.platform` × 运行方式 (`session` Linux 会话、`desktop` 完整桌面的宿主窗口、`standalone` 单应用宿主窗口) 给
  `unsupported` (不支持的能力) 和窗口特性 `window.backdrop` (`full` / `approximated` / `unsupported`). 现在: Linux 宿主窗口缺 `slots`; Windows 缺
  network、office、camera、microphone、slots; macOS 缺 network、office、slots; 窗口背景滤镜都是 `full`. Linux 会话和 macOS 的行没有实测.
- **`acde:capabilities`** (总是注入所有 web, 桌面和应用窗口都有, 服务没有; 类型 `AcdeCapabilities`): `level` (SDK 的 `API_LEVEL`)、`platform`、`mode`、`window`
  (窗口特性)、`get(name)` / `list()` (所有系统能力、`WEB_CAPABILITIES` 加声明的服务, `{name, kind, state, reason, optional}`)、`request(name)` (状态是 `not-asked` / `asking`
  时经 rpc 问用户, 已经在问的并进同一个提示, 回答之后的状态; 别的直接回当前状态, 不问). 快照在 web 起来时由 Broker 算好放进 `WebInit.tier.capabilities`, 之后 Broker 发 `permit`
  消息更新 (`{capability, approval, status}`): 提示弹出时 (`Permissions.ask` 调 `changed(…, 'asking')`) 变 `asking`, 回答或撤销后变 `available` / `denied`, `get` 和 `list` 都跟着变.
  应用按状态做事: `not-asked` 调 `request`, `asking` 等, `denied` 告诉用户, `available` 直接用.
- **批准** (`broker/access/approval/permissions.ts` `Permissions`, SDK `APPROVAL_CAPABILITIES`): **仅 `camera`、`microphone` 需要用户同意** (用户决定 2026-11-11, 同浏览器:
  第一次 `getUserMedia` 时问), 可撤销; 其余能力 (`launch`、`slots`、`terminal`、`network`、`fs.roots` 点名的公共位置、自己的窗口、能力查询、列出和打开应用、
  按类型打开、桌面服务、`office`) 声明即有, 不问 (#146).
  系统应用 (和任一已装桌面同包) 不问. 启动时不问, 必需的和可选的一样 (同浏览器): 第一次 `getUserMedia` 或 `acde:capabilities` `request(name)` 时问,
  是同一个提示 (`reason: 'request'`); 回答「否」、还没答或撤销都只让这些调用失败 (`NotAllowedError` / 403), 应用照常启动、照常在列表里
  (`CapabilityCheck.missing` 不把 `not-asked` / `asking` / `denied` 算缺); 平台不支持的不问, 照旧按 unsupported 拒绝. 没批准的模块不定义, 批准后 web 收 `permit` 再定义, `load()` 拿得到.
  **没批准时的话按当时的状态说** (`Permissions.approval` 四态 `granted` / `not-asked` / `asking` / `denied`, 文字只在 `Permissions.reason`; Broker 自己的 `permit` 仍是
  `granted` / `denied` / `ask` 三态, 管该不该问): import 报 `acde:terminal: "terminal" is not asked for yet; ask for it with acde:capabilities request("terminal")`、
  `… is waiting for the user's answer` 或 `… is denied by the user` (`Permits.reason`, 一个模块有几道门时 (`acde:launch` 的 `launch` / `slots`) 每道没批准的各说一句;
  状态变了 `RemoteBridge.permit` 重新 `refuseModule`, 所以拒绝之后的 import 说的是拒绝); 调用报 `AcdePermissionError` (403, 带 `capability`),
  `code` 是 `denied`、`not_asked` 或 `asking`, 文字是 `<label>: ` 加同一句: `acde:fs` / `acde:office` 里还没问过的公共位置 (`FileAccess.guard`)、
  `acde.launch` / `acde.windows.launch` (`Approvals.allow`)、撤销后的 terminal / network 都走这里 (camera / microphone 走标准接口: `getUserMedia` 自己弹提示, 见「摄像头和麦克风」). 决定按应用持久 (`$XDG_CONFIG_HOME/acde/permissions.json`, `{"<app>:<能力>": "granted" | "denied"}`, 不看 `ACDE_STORAGE`);
  拒绝也记 (不影响列表), 桌面收 `appschanged` (`acde:apps` 的 `on('changed')`): 每次决定变了 (`Approvals` 的 `changed`) 都经
  `broker/listing.ts` `AppListing.changed()` 比一次, 列表和桌面上次拿到的 (桌面页面起来时、`list()` 的结果或上一次事件) 不一样才发; `refreshApps` 也走它 (清单变了一定发). 撤销 (`revoke`) 删掉记录: 这一次运行里当作拒绝 (同一次运行不问第二次), 下次运行再问. 撤销后的调用报同样的
  403 `denied`: Broker 侧 (`acde.launch` / `acde.windows.launch`) 当场查, web 侧 terminal / network 的模块和 camera / microphone 的 capture 经
  `broker/access/approval/permits.ts` `Permits` 包一层. 外壳模块 `acde:permissions` (桌面和声明它的系统应用): `pending()`、`answer(id, allow)`、`list(app?)`、
  `revoke(app, capability)`、`on('prompt' | 'answered')` (`permissionprompt {id, app, label, capability, reason: 'request'}`、
  `permissionanswered {id, app, capability, allowed}`). 用户选给应用的文件夹 (#86) 也在 `list` 里: 每个一行 `{app, label, capability: 'fs.folder-<令牌>',
  decision: 'granted', folder: {label, exists}}` (只给文件夹名, 不给路径; Broker 经 napi `Finder.folders(app)` 读授权文件), `revoke(app, 'fs.folder-<令牌>')`
  经 `Finder.revokeFolder` 删掉授权 (回有没有删到) 并给这个应用的 web 发 `permit` 拒绝: 它离开 `roots()`, 以它为 root 的调用 403 `denied` (`FileAccess.guard`).
  进程里所有 `Workspace` 和 `Finder` 共用一份授权 (`fs/mod.rs` 的 `GRANTS`), 撤销对正在运行的 web 立刻生效. 页面里已有的这个文件夹的句柄活到页面结束;
  同一个页面撤销后再选同一个文件夹, `acde:fs` 仍报 `denied` 到页面重开. 开发、无头和 driver 照常问: dev 请求 `permissions` (待答和已有决定)、`answer {prompt, allow}`、`revoke {app, capability}` (#95, 和 `acde:permissions.revoke` 同一份记录和效果,
  回 `{app, capability, revoked}`, 没有决定过的回 `revoked: false`; 桌面和 `acdert app` 都能用)
  给 acde 用 (driver、MCP, 和命令行的 `acde permissions` / `allow` / `deny` / `revoke`); 每个提示记一行 info (`waits for the user to allow … answer it with acde allow or acde deny, …`: 这一行出现在 `acde dev` 的输出里, 是没有对话框的会话里用户和 agent 知道该做什么的地方), 没人答就一直等, 不自动批准.
  **单应用模式的原生对话框** (`acdert app`, 宿主窗口; `broker/access/approval/dialog.ts` `ApprovalDialogs`, 由 `broker/approvals.ts` 接上): 提示同时交给宿主的
  `approve(title, message)` (hostwin `Cmd::Approve`, Windows 是 `platform/win32/approve.rs` 的 `MessageBoxW`, 以宿主窗口为 owner, 是 / 否, 默认否),
  一次只开一个, 其余排队; 答案经 `Permissions.answer` 写进同一份 `permissions.json`, 和桌面答的一样. driver 或别处先答了, Broker 调
  `dismissApproval` 关掉还开着的对话框 (它不算回答), 排队的直接丢掉. macOS 是宿主窗口上的 `NSAlert` sheet (`system/approve.rs`, 「Don't Allow」在前、是默认,
  「Allow」), `dismissApproval` 经 `NSOperationQueue.mainQueue` 回主线程 `endSheet` (`NSModalResponseAbort`, 回 null); Linux 是 `org.freedesktop.Notifications`
  的常驻通知 (urgency critical, 不过期), 带 `deny` / `allow` 两个动作, 关掉或点了别处回 null, `dismissApproval` 调 `CloseNotification`; 通知服务没有
  `actions` 能力、没有会话总线或 5 s 内不应 (`CALL_TIMEOUT`, 只管方法调用, 不管等用户) 时回 null. headless 没有对话框 (`approve` 回 null); 回 null 的提示照旧等 driver 或 `acde allow` / `acde deny`.
  `devReload` 对主窗口用 `Launchable.app` 重新查一遍 (应用没了、级别不对、平台不支持、服务没在跑各报各的话), 查不过时结束会话, 那行错误是
  `Launchable.ended`: `acdert app <id>: <原因>`. **`acdert app` 里以前的拒绝会再问一次** (`PermissionsHost.asksAgain`, 单应用模式为真): 记录里是
  `denied`、这一次运行还没问过的能力, `permit` 当作 `ask`, 问的时候删掉旧记录并记一行 `was denied … in an earlier run: asking again`; 这一次运行里答了「否」照旧不问第二次.
  单应用模式是开发者点名要跑这个应用, 又没有桌面的权限界面; 不这样的话拒绝一次之后这个应用在 `acde dev` 里再也问不到, 而 `acde revoke` 要有会话才能用, 只剩手改 `permissions.json`. 桌面和会话里记下的拒绝照旧有效.
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
- **样式表和别的子资源** (`<link rel=stylesheet>`、`<img>`、`@font-face`、CSS 背景图): 应用包里的文件 render 直接读盘; 读不到的 http / https /
  `blob:` 地址 render 的 `Loader` 发到页面线程, 经页面的网络栈取 (acde-dom `core/resources.ts` `loadResource`: 和 `fetch` 同一套路由、代理、
  证书、重定向, `acde network` 里是 `image` / `stylesheet` / `font`). 规则按 destination 照浏览器: 图片和样式表 no-cors (不带 `Origin`, body 照用),
  字体 cors; 样式表要 2xx 的 `text/css`, 图片不看状态码; 失败在 console 报 `Failed to load resource: <url>: <原因>`. `<link crossorigin>` 是 CORS
  请求 (空值和别的值不带凭据, `use-credentials` 带), 没过 CORS 检查算失败; 改 `crossorigin` 和改 `href` / `rel` 一样重取.
  `document.fonts` 列的是各表的 `@font-face` (acde-dom `fontFaceTexts`, 内部读 render 的规则, 跨源 (opaque) 的表也算, 像浏览器), 页面读这种表的 `cssRules` 仍是 `SecurityError`.
  - `<link>` 的 `load` / `error`: blitz fork 给每个 link 记它当前这一次取 (`SheetLoad`, 连同表里 `@import` 的表, 都答了才算完), render 的
    `take_loaded` 把取完的 link 和图片一起报, `sheetState` 说成败. 成了 (取到并进了 stylist) 派 `load`; 取不到、状态码或类型不对、`@import` 的表有
    一个没取到派 `error` (已取到的规则照样生效, 和 Chrome 一样). `href` 又变了或 link 离开了文档, 先前那次的答复丢掉, 不派事件; 换 `href` 时旧表留到新的
    答复来. 页面这边由 `deliverLoads` (`dom/media.ts`) 派: 每帧一次, 另外 link 接进文档、这三个属性变了、解析的 HTML 里有 `<link`、远程样式表答了
    之后各排一个 0 ms 定时器 (`dom/env.ts` `loads.expect`), 不等帧 (没人看的窗口不出帧). 没有包装对象的 link 只在有 `onload` / `onerror` 属性时才建.
    `<img>` 接进文档时同样排一次 (#204): 克隆体插入时取图 (常是命中缓存, 插入当时就结束), 任务结束只提交不出帧, 不排就等不到它的 `load`.
  - `link.sheet` / `document.styleSheets`: 取完才有 `CSSStyleSheet` (`ownerNode`、`href`、`media.mediaText`), 每次取完是新对象; 在取和失败时
    `sheet` 是 null. 响应对页面不透明的表, `cssRules` / `rules` / `insertRule` / `deleteRule` 抛 `SecurityError`. 透不透明由取这张表的那次
    请求定, 不看 link 现在的属性 (改了 `crossorigin` / `href`, 新表到之前手上还是旧表, 旧表的结论不变): `loadResource` 在响应头到的时候判,
    不是 CORS 请求而且请求地址或重定向后的最终地址有一个不同源就是不透明 (中间跳过别的源、首尾都同源的不算), 随 `loaded(id, bytes, opaque)`
    交给 render (`Load::finish_opaque` → `NetHandler::opaque`), blitz fork 记在这张表上 (`sheet_sources`, 连同取它的地址即 `sheet.href`, 和带来
    它的那次请求的 id). `CSSStyleSheet` 对象建的时候按这个 id (`sheetSerial`) 绑定到这一张表: `link.sheet` 在 id 变了时给新对象; 旧对象和从它
    拿走的 `cssRules` 每次读都核对 id, link 换了表之后读到的是空 (不会读到后来那张表的规则), 往里 `insertRule` 只改它自己. 包里的文件、`data:`、`blob:`、同源后端和过了 CORS 检查的可读写. `replaceSync` / `replace` 只给
    `new CSSStyleSheet()` 造的表, `<style>` / `<link>` 的表是 `NotAllowedError`.
  - `<link>` / `<style>` 的 `media` 属性是表的 media list: 不匹配的表照取、照派 `load`、`sheet` 照有, 只是不生效; 改属性不重取.
  - 没做: `window` 的 `load` 不等样式表和图片; `link.disabled`、备用样式表 (`title`)、`CSSImportRule.styleSheet`、`MediaList` 的成员 (只有
    `mediaText` / `length`); `<img crossorigin>` 仍按 no-cors 取.
- **本地资源的类型** (acde-dom `core/net/index.ts` `TYPES`): 应用包里的文件经 `fetch` / XHR 读到时按扩展名给 `Content-Type`, 只列页面加载要的类型
  (HTML、脚本、样式、JSON、wasm、字体、图片、音视频), 固定、和系统无关; 别的 (文稿、表格、压缩包、`.md` …) 是 `application/octet-stream` (#106).
  用户文件的类型不走这张表, 走宿主系统 (`env.fileType`, #98).
- **浏览器接口 → 窗口** (acde-host `webapp.ts` / `pagecalls.ts` / `downloads.ts`): `window.close()` / `location.reload()` 关闭 / 重启这个 web;
  `localStorage` / `sessionStorage` 见「网页存储」; `alert` 画在窗口里 (`confirm` / `prompt` 返回 false / null; acde dev 里能事先答复, 见
  「acde dev」的 `dialog`. 页面可以等用户回答的模态对话框还没有);
  外部链接交给浏览器应用 (宿主窗口里要 slots 的浏览器应用跑不了, 不打开, 见「默认应用」), 下载存进下载目录 (桌面收 `on('download')`); 打开 / 保存文件的选择器见「文件」的「打开和保存文件」; 隐藏 / 显示是 `visibilitychange`;
  `screen.*` 是主输出的逻辑尺寸; `navigator.userAgent` / `platform` 在所有宿主上都报 Linux (`X11; Linux x86_64` / `Linux x86_64`, Broker 的 `UserAgent`,
  经 `WebInit.navigator`), 产品段是 `acdert/<真实版本>`. 运行时对应用呈现统一的 Linux 环境: 交互语义一律照 Linux (编辑快捷键是 Ctrl;
  页面若看到 `MacIntel`, 编辑器库会把快捷键改绑到 Command, 同一窗口里就有两套规矩), 跨宿主一致.
  需要宿主系统信息的应用以后由 `acde:` 模块单独提供, 不从 `navigator` 猜.
- **`<select>`** (https://html.spec.whatwg.org/#the-select-element): 选中状态在 render (`dom/select.rs`), 每个 option 自己记 selectedness
  和 dirtiness (`Form.selected` / `dirty`, 没设过时跟 `selected` 属性), 照规范: 没有 `multiple` 时选中一个就清掉别的、插入选中的 option
  也清掉别的、两个以上留最后一个, 显示大小为 1 时一个都没选就选第一个没禁用的 (插入、删除、`selected` / `multiple` / `size` 属性变了、
  `option.selected = …` 之后); `selectedIndex = …` 不再补选; 表单 reset 回到属性. list of options 只算直接的 option 和 optgroup 里的
  (`dom.options`). option 的 `:checked` 跟 selectedness. 显示: 下拉框 (显示大小 1) 画第一个选中项的文字和箭头, 宽是最宽的选项;
  列表框 (`multiple` 或 `size` > 1) 每个 option 和 optgroup 标签一行 (组里的缩进), 高 `size` 行 (`multiple` 默认 4), 能滚,
  选中行底色 (有焦点蓝底白字, 没有灰底); 列表框的 option 有盒子 (`getBoundingClientRect` 是它那一行, `elementFromPoint` / 鼠标事件
  落在 option 上, 和 Chrome 一样), 下拉框的 option 是 0×0. 交互 (acde-dom `dom/select.ts`): 下拉框按下 (mousedown 没被取消) 打开
  选项列表, 拖到一项松开或再点一项选中、发 `input` 和 `change`, 点外面或 Esc 关掉不改; 列表打开时指针和键盘只给它 (Tab 选中当前项再
  照常移焦点), 上下 / Home / End / PageUp / PageDown 移高亮, Enter / 空格选中, 打字跳到开头相同的项. 关着有焦点时上下左右 / Home /
  End / PageUp / PageDown / 打字直接改选中项, 空格、Alt+上下、F4 打开. 列表框按下选中那行, `multiple` 时 Ctrl 切换、Shift 从锚点选到
  这行, 键盘同理 (Shift 扩展, Ctrl+上下只移光标, Ctrl+空格切换). 焦点移走、窗口失活、隐藏、改大小时关掉列表. `showPicker()`: 禁用时
  `InvalidStateError`, 下拉框打开列表 (不查 transient activation: acde-dom 还没有用户激活的模型). 选项列表由 render 画在帧的最上面 (不在
  文档里, `Engine.picker`, 每帧按 select 的位置重排: 下面放得下放下面, 否则放空间大的一边并截短、能滚), 所以出不了窗口; 滚轮在列表上
  滚列表, 在外面先关掉列表.
- **`<input type=range>`** (https://html.spec.whatwg.org/#range-state-(type=range)): 值的净化在 render (`dom/values.rs` `RangeValue`, `value` 和
  `set_value` 都过它): min 默认 0、max 默认 100 (比 min 小时取 min)、step 默认 1 (`any` 不对齐)、无效值取中点, 夹到范围里再按 step 从 min 起
  四舍五入对齐 (按 min / step 的小数位数用整数算, 和浏览器的十进制结果一样, 不出 1.8000000000000003), 超出 max 时取不超过 max 的最大一档;
  `min` / `max` / `step` 改了时重新净化已有的值. 画 (blitz-paint `draw_range`, `SpecialElementData::RangeInput(比例)`): 灰色轨道、左边一段和
  圆形滑块用文字颜色 (和复选框、单选框同一个 `accent_color`), 默认 `appearance: auto` (render 的 UA 样式表),
  `appearance: none` 时不画; 默认 129 × 16. 交互 (acde-dom `dom/rangeinput.ts`): 按下 (没被取消) 按指针位置设值并跟着拖, 每次变发 `input`, 松开时和按下时不同发 `change`;
  有焦点时 左 / 下 减一档、右 / 上 加一档、PageUp / PageDown 十分之一、Home / End 到两头, 各发 `input` 和 `change`.
- **XML 文档和命名空间** (render `xml.rs` / `serialize.rs` 的 `XmlSerializer`, acde-dom `dom/namespaces.ts`): `DOMParser` 的 `application/xml`、
  `text/xml`、`application/xhtml+xml`、`image/svg+xml` 用自己的 XML 解析器 (XML 1.0 + Namespaces 1.0): 良构检查 (标签配对、只有一个根、属性
  不重复 (按原名和按命名空间 + 本地名)、名字字符、`--` / `]]>`、未声明的前缀、`xml` / `xmlns` 前缀的约束), 实体 (五个预定义的、字符引用、
  内部子集的一般实体 (替换文本按内容再解析, 不许递归, 展开上限 16 MB / 32 层)、外部实体不读; DOCTYPE 的公共标识是 HTML 规范列的那几个
  XHTML / MathML 的就认 HTML 的命名字符引用; 有外部子集或参数实体引用且不是 standalone 时未声明的实体跳过, 否则是错), 换行规范化, 属性值
  空白规范化. 不良构时文档只有一个 `parsererror` 元素 (命名空间 `http://www.mozilla.org/newlayout/xml/parsererror.xml`, 文字是原因和行列).
  结果是 `Document` (接口照规范, `createDocument` 的才是 `XMLDocument`), `contentType` 是给的类型, URL 是页面的. 节点有 `CDATASection` 和
  `ProcessingInstruction` (render 里是带标记的文本 / 注释节点, `Ids.cdata` / `Ids.pis`, 同 doctype 的做法). 元素和属性带任意命名空间和前缀
  (`Ns::Other`, `namespace_uri` / `prefix` / `attributes_ns` / `*_attribute_ns`), `createElementNS` / `setAttributeNS` / `createAttributeNS`
  照规范 validate and extract (`InvalidCharacterError` / `NamespaceError`), `lookupNamespaceURI` / `lookupPrefix` / `isDefaultNamespace` 照
  locate a namespace. 每个节点有所属文档 (`Ids.owners`, 只记不是页面文档的, `Ids.documents` 记 DOMParser / `createDocument` /
  `createHTMLDocument` / `new Document()` 的文档和类型): 插入时 adopt 到父节点的文档, `importNode` / `adoptNode` 改, `ownerDocument` 跟着;
  属性名和 `getElementsByTagName` 只在 HTML 文档里的 HTML 元素上转小写, `tagName` 同理. XML 文档里元素的 `innerHTML` / `outerHTML` 用 XML
  序列化 (require well-formed, 不良构抛 `InvalidStateError`), 赋值用 XML 片段解析 (上下文元素的命名空间声明都在作用域里, 出错 `SyntaxError`).
  `XMLSerializer` 照 DOM Parsing 的 XML 序列化 (命名空间前缀表、`ns1` 生成前缀、空元素 `/>`), 和 WPT 记的浏览器行为一致的几处: 去掉没有命名空间的
  `xmlns` 属性、命名空间相同的元素也保留显式的 `xmlns=""`、属性的命名空间没声明过时总是生成新前缀. WPT 2026-11-09 macOS: `domparsing`
  147 → 277 / 2369 (`DOMParser-parseFromString-xml-parsererror` 23 / 23、`XMLSerializer-serializeToString` 29 / 33、实体、CDATA、往返全过;
  剩下的大多是 `innerHTML` 的 Trusted Types、`createContextualFragment`、`positional-methods` 那批和 iframe); `dom/nodes` 3066 → 4114 / 6112
  (62 个文件变好, 没有变差的; `createElementNS`、`createDocument`、`*NS` 的属性和集合、处理指令、选择器大小写).
- **按名字和序号取成员** (WebIDL 的 legacy platform object, acde-dom `dom/legacy.ts` 的 `legacy(shape)` 出 Proxy 的 handler, 照规范的
  [[GetOwnProperty]] / [[DefineOwnProperty]] / [[Delete]] / [[OwnPropertyKeys]]): 序号是可枚举的自有属性, 名字是不可枚举的
  (`Object.keys` 只有序号, `in` 和 `getOwnPropertyNames` 有名字), 没有 setter 的写入失败 (严格模式抛 TypeError), `preventExtensions` 失败.
  - `HTMLCollection` (`document.forms.login`、`getElementsByTagName('input').title`、`children`、`select.options`、表格的 `rows` / `cells` /
    `tBodies`, 这三个现在是活的 `HTMLCollection`): 按文档顺序第一个 id 等于名字、或 HTML 元素的 `name` 等于名字的元素 (`namedItem` 同一段,
    一遍扫完); 自有属性和原型上的成员优先 (`length`、`item` 还是自己的).
  - `HTMLFormControlsCollection` (`form.elements`, 同一个对象; 不含 `<input type=image>`): 一个匹配给元素, 几个给活的 `RadioNodeList`
    (现在是 `NodeList` 的子类, `value` 读写选中的单选钮). `fieldset.elements` 是 `HTMLCollection`.
  - `Window` (named access, #170): `Window.prototype` 和 `EventTarget.prototype` 之间是一个 Proxy (`window.ts` `namedProperties`, 规范的
    WindowProperties): id 等于名字的元素 (原生 id 表, `getElementById`), 没有再找 `name` 等于名字的 `embed` / `form` / `img` / `object`.
    `window.box` 和裸名字 `box` 都能取到, 每次现查 (删除、改 id 立刻生效); 全局对象的自有属性、`Window.prototype` 的成员和 `let` / `const`
    声明优先; 不可枚举. 几个同名元素时只给第一个 (规范给 `HTMLCollection`), 不管 iframe 的 `name`.
  - `HTMLFormElement` (`[LegacyOverrideBuiltIns]`): `form[0]`、`form.title`. 先找它的 listed 元素 (不含图片按钮), 没有再找它里面的 `img`,
    都没有再查 past names map (元素改名后旧名字仍然指它, 元素不再属于这个表单时去掉); 名字盖过原型上的成员 (`<input name="submit">` 之后
    `form.submit` 是那个 input), 只有自有属性排在名字前面. 写入照普通对象走原型上的 setter (`form.action = …` 仍然改属性).
    表单的包装对象是 Proxy (`realm.ts` `exotic` 在构造时换上, 登记进包装表的就是它), 所以 **acde-dom 自己的代码不许从可能是表单的
    包装对象上按名字读成员**: 用 id 调原生接口, 或 `realm.ts` 的 `inner(node, 'parentNode')` (从原型读, receiver 还是这个对象; 页面加的
    自有属性也挡不住它). 测试 `test/named.test.ts` 最后一条给表单放上和每个成员同名的控件, 和没重名的表单逐项对照.
    每次按名字读表单是一次查表: 文档有改动 (`version` 变了) 后第一次读某个名字做一次 `querySelectorAll` (只在这个表单里; 页面出现过
    `form` 属性之后 (`flags.formAttributes`, 和 `inlineHandlers` 一样从标记和 `setAttribute` 记下) 才另查整个文档里 `form=<id>` 的控件),
    之后同一个名字不再调原生接口 (`test/cost.test.ts`: React 挂 500 个 input 的表单, 每次 append 一次查询).
  - `HTMLSelectElement` / `HTMLOptionsCollection`: `select[i]`、`select[i] = option` (null 是删掉, 超出长度先补空的 option, 不是
    `HTMLOptionElement` 抛 TypeError)、`length = n`.
  - 还没有: `document.<name>` 和 `window.<id>` (Document / Window 的具名属性)、`element.attributes.<name>` (`NamedNodeMap`)、
    `classList[0]` (`DOMTokenList`)、`map.areas`; 解析器给的 form owner (错位嵌套时 `img` 和控件属于哪个表单) 不记, 一律按最近的
    祖先 `form` 和 `form` 属性算.
- **通知**: `Notification` 转给桌面 (`on('notification')`); 桌面没在显示时 (调试窗口) 由宿主窗口发系统通知 (hostwin `system/notify.rs`). 页面给的文字
  当不可信数据: macOS 用 `osascript -l JavaScript -e <固定脚本>`, 文字只经环境变量 `ACDE_NOTIFY_*` 传 (放进 argv 会被当成选项); Linux 走
  `org.freedesktop.Notifications` (body 只在服务端报 `body-markup` 时转实体). Windows 没有系统通知 (宿主 `Shell` 不绑定 `notify`): 平台表 win32
  `standalone` 的 unsupported 里有 `notifications` (SDK `WEB_CAPABILITIES`: 不用在清单里声明的网页能力, `acde:capabilities` 照样列出, 不能当服务名),
  这时页面的 `Notification.permission` 是 `denied`、构造后发 `error` (`PageCalls` 不装 `env.notify`), Broker 的 `notify` 回 501 `unsupported`.
  Windows 完整桌面照常转给桌面.
- **声音**: `Audio` / `AudioContext` (acde-dom `src/audio/`, src/host `audio/`): 解码 (symphonia) 和混音 (每个 web 一个 48 kHz 立体声 f32
  `Mixer`, 线程 `acde-audio`) 到处一样. 输出: Linux PipeWire (`output.rs`); macOS / Windows cpal 默认设备 (`output_cpal.rs`, 用设备当前的采样率,
  Hermite 重采样, 设备要 f32). 3 秒没声音关流; 没有设备 (或 `ACDE_AUDIO=null`) 按墙上时间渲染丢掉.
  - **空间化** (`PannerNode` / `AudioListener`, src/host `audio/spatial.rs`): 方位角、仰角、三种距离模型、声锥和 `equalpower` 照规范
    §6 的算法 (参数在一个 quantum 里变时逐样本算, 不变时每 quantum 算一次), 单元测试对着 Chrome 的 `OfflineAudioContext` 输出 (2e-5 内).
    和规范伪代码不同、照 Chrome 的一处: 声锥用「声源指向听者」的方向 (正对听者的声源增益是 1). 监听者是每个 context 一个隐藏的图节点
    (`Kind::Listener`, 9 个参数, 第一次读 `context.listener` 时建), 排序时每个 panner 排在它后面; 还没建时用规范的默认值.
    `HRTF` 不是实测的冲激响应 (仓库里没有 HRTF 数据库): 球形头模型 (Brown & Duda 1998), 每只耳朵一个分数延迟 (Woodworth 公式, 头半径
    0.10 m; 8 抽头加窗 sinc, 多 4 个样本的固定延迟) 和一个头影滤波器 (一极一零), 外加一个后方衰减; 各方向的宽带电平和耳间时差按 Chrome
    (IRCAM 数据) 的白噪声测量标定 (`EAR_LEVELS` / `REAR_LEVELS`, 测试里 ±0.05、±3 个样本). 没有耳廓的仰角线索. 照规范 HRTF 下参数按 k-rate,
    每 quantum 算一次, 增益、延迟和滤波系数在 quantum 内线性过渡 (不出拉链声); 立体声输入左进左耳、右进右耳 (和 Chrome 一样不交叉).
    输入变静时清掉延迟线和滤波器状态. `BiquadFilterNode`、`ConvolverNode`、`DynamicsCompressorNode`、`WaveShaperNode`、`DelayNode` 还没渲染
    (输入原样通过, 第一次用时 warn 一次).
- **视频** (src/media `acde-media`): 用系统的框架解码, 不随包带编解码器 (用户定, 2026-11-09; acdert 闭源, 不链接 GPL 的 ffmpeg).
  - `Player::open(bytes)` 探出 `Info {duration, width, height, audio, video}`, 每个轨一条读线程 (`acde-video` / `acde-video-audio`) 各自往
    有界队列里解: 视频 RGBA 帧 (领先 4 帧), 音频 48 kHz 立体声 f32 交错 (领先半秒). 两个轨分开读, 不会一个轨满了卡住解封装器让另一个轨饿死.
    `seek(t)`: 清队列, 两条线程都停下后由最后一条重启解码器. 消费方拉: `take_audio` (混音器线程)、`frame_at(t)` (取到时间的最后一帧,
    更早的丢掉)、`first_frame` (等第一帧, 给海报帧和尺寸).
  - Linux `gst.rs`: 先按开头的字节认容器 (MP4 / QuickTime 的 `ftyp`、Matroska / WebM 的 EBML、Ogg), 自己放解封装器
    (`qtdemux` / `matroskademux` / `oggdemux`), 不让 GStreamer 自己挑: 自动挑会把 HLS / DASH 播放列表之类交给会去取别的 URL (含 `file://`)
    的元素. 再保险一层: 管道里加进任何 Source 类或读 URI 的元素 (`deep-element-added`) 就整个拒绝. `giostreamsrc` 读内存里的字节
    (`GMemoryInputStream`, 能随机读) → 解封装器 → 一个 `multiqueue` (一个轨空了它会给另一个轨多存, 两个轨交错远也不卡死) → 每个轨一个
    `decodebin3` (只剩解析和解码) → 视频 `videoconvert ! videoflip video-direction=auto ! videoconvert` 成 RGBA (旋转标签在这里转正), 音频
    `audioconvert ! audioresample` 成 F32LE 48 kHz 立体声, 各进一个 `appsink` (不按时钟, 最多 2 个缓冲). 解封装器发 `no-more-pads`、
    预滚完、要的轨都接上才报 Info. seek 是 FLUSH | ACCURATE, 目标前的帧和样本丢掉. 运行时要 gst-plugins-base / gst-plugins-good (MP4、WebM 解封装, Opus, VP8 / VP9) 和
    gst-plugin-va (硬解); H.264 / AAC 的软解是 gst-libav (经 Arch 的 GPL ffmpeg), Arch 包里是可选依赖.
  - macOS `apple.rs`: `AVURLAsset` 带 `AVURLAssetReferenceRestrictionsKey = ForbidAll` 开 (文件里引用别的文件或 URL 一律不跟), 不许走
    网络; 数据由 `AVAssetResourceLoader` 代理 (`AcdeMediaLoader`) 从内存按字节范围给, `AVAssetReader` 解出
    BGRA 帧 (拷出时换成 RGBA, 按轨道的 `preferredTransform` 转 90 / 180 / 270 度) 和 LPCM; 每个输出各自一把锁; seek 是取消旧的
    reader 按时间范围新建. AVFoundation 只认 MP4 / QuickTime: WebM 在 macOS 上打不开 (Safari 自己解析 WebM, 这里没有).
  - `<video>` (acde-dom `dom/media.ts` `HTMLVideoElement`, src/host `audio/mod.rs` `openVideo` / `present`, `audio/video.rs`): 和
    `<audio>` 共用 `HTMLMediaElement` 和混音器. `openVideo` 在线程 `acde-video` 里开 `Player`、等第一帧, 再把 `VideoSound` 交给这个 web 的
    混音器 (`Cmd::AddMedia`, 混音器的 `MediaSource`): 有声音时媒体时间跟着放出去的声音走 (解码跟不上就停在那里等), 没声音或声音轨先完了
    按混音器的时间走, 到 `duration` 就结束 (`ended`). 帧在页面的动画帧里交 (`presentVideos`, 在播或刚 seek 的视频才要帧): `present`
    取到媒体时间为止的最后一帧 (seek 后先交新位置的第一帧, 看 `Player::epoch`), 写进每个视频一张的 `GpuImage` (`Gpu::write`, 渲染时
    vello 按 generation 拷), 交给 render `Dom::video_image`: 节点的画面 (帧像素坐标, blitz 按 `object-fit` / `object-position` 放进内容框,
    UA 样式 `object-fit: contain`) 加固有尺寸 (`set_video_size`, 变了重排; 没有帧时是 300×150). `videoWidth` / `videoHeight` 在
    `loadedmetadata` 时就有; 之后帧尺寸变了发 `resize` (`readyState` 是 `HAVE_NOTHING` 时不发, 照标准). `canPlayType` 按 `acde_media::TYPES`
    (平台能开的容器). 换源 / 去掉 `src` 清掉画面 (`clearVideo`); 播放器释放 (`Player` 的 drop) 在单独线程里停解码器, 不卡混音器和 JS.
  - 解析出来的 (`loadPage`、`innerHTML` / `outerHTML` / `insertAdjacentHTML`) 和克隆出来的 (`cloneNode` / `importNode`) `<video>` /
    `<audio>` 有 `src` 或 `<source>` 就自己开始加载 (标准: 设了 `src` 就跑加载算法), `preload="none"` 且没有 `autoplay` 时发 `loadstart` 和
    `suspend` 后停在 `NETWORK_IDLE`, 等 `play()` 再取. 还没有: 海报图 (`poster`)、`seeked` 等到新位置的帧画出来再发、文字轨、MSE.
  - 帧现在在 CPU 内存里, 送进 GPU 要上传一次; 硬解的零拷贝 (Linux dmabuf、macOS IOSurface) 还没有.
- **设备的标准接口** (acde-dom `src/device/`, src/host `device.rs`, 每个 web 都有的原生 `device`): 系统的状态只经 web 标准接口给网页,
  改设置的不在这里 (标准里没有, 那些归 `acde:power` 等模块). `navigator.getBattery()` (Battery Status): Linux 上读 UPower 的 DisplayDevice
  (runtime `battery.rs`), 属性变了经 PropertiesChanged 推给同一个 `BatteryManager` 并发 `chargingchange` / `levelchange` / `chargingtimechange` /
  `dischargingtimechange`; 没有电池、没有 UPower 或别的平台按规范给接着电源的默认值 (charging true, level 1, chargingTime 0, dischargingTime Infinity).
  每个 navigator 只有一个 BatteryManager, `getBattery()` 回同一个 promise.
  `navigator.wakeLock.request('screen')` (Screen Wake Lock, 只在 Linux; 别处没有 `navigator.wakeLock`): runtime `wakelock.rs` 拿 logind 的
  `idle` inhibitor (acdebin-system 的电源策略认它) 外加会话总线上 `org.freedesktop.ScreenSaver.Inhibit` (GNOME / KDE 宿主桌面认它), 两个都拿不到就
  NotAllowedError; 页面不可见时请求被拒, 变成不可见时放掉所有锁并发 `release`.
  `IdleDetector` (Idle Detection, 只在 Linux): runtime `idle.rs` 读 logind 会话的 `IdleHint` / `IdleSinceHintMonotonic` / `LockedHint` 并跟着
  PropertiesChanged; `userState` 是 idle 当且仅当会话标了空闲且已空闲到 threshold (不到就定时补算), `screenState` 看 LockedHint. 空闲提示由桌面写给
  logind (acdebin-system 的合成器、宿主桌面的会话管理器), 所以比 threshold 更早的空闲要等桌面先标. 授权是审批能力 `idleDetection` (清单声明,
  `IdleDetector.requestPermission()` 弹 acde 的批准提示, `permissions.query({name: 'idle-detection'})` 看它); threshold 小于 1 分钟 TypeError.
- **摄像头和麦克风** (`getUserMedia`; src/media `capture/`, src/host `capture.rs` / `audio/live.rs`, acde-dom `src/media/stream.ts`):
  - 权限: 清单 `capabilities` 写了 `camera` / `microphone` 的应用才拿得到 (Broker `#grants` → web 的 grant →
    `natives.capture` 只装给有的 web, 桌面两个都有); 没写的: `getUserMedia` `NotAllowedError`、`enumerateDevices` 不列这一类、
    `navigator.permissions.query` 是 `denied`. 写了的第三方应用还要用户批准 (见「批准」), **标准接口照浏览器的样子带出这一步**
    (`broker/access/approval/permits.ts` `Permits.capture(native, access)`, web 起来时包在 `natives.capture` 外面; acde-dom 只认
    `CaptureNative` 上两个可选成员 `request(kind)` / `onPermission(cb)`, 不知道批准是什么):
    - `navigator.permissions.query({name: 'camera'})`: 批准了 → 系统的状态 (`granted` / `prompt` / `denied`); 还没问或正在问 (`not-asked` /
      `asking`) → `prompt`; 被拒、撤销、平台没有这项能力 (`WebInit.tier.capabilities` 里是 `unsupported`) → `denied`. 批准状态一变
      (`Permits.set`, 不管是 `getUserMedia`、`acde:capabilities` `request()` 还是桌面 / `acde allow` / `revoke` 引起的) `PermissionStatus` 发 `change`.
    - `getUserMedia`: 先照旧选设备和模式 (`denied` 当场 `NotAllowedError`; 选不出来 `NotFoundError` / `OverconstrainedError`, 都不问人), 选好后对要的每一类
      调 `request`: 状态是 `prompt` 时经 rpc `capabilities.request` 弹批准提示 (和 `acde:capabilities` `request()` 同一个, `reason: 'request'`, 已经在问的并进去),
      答应了才开设备, 拒绝 (或问不成) 是 `NotAllowedError: Permission denied`, 不开设备. 音频和视频都要时先问 `microphone` 再问 `camera`, 一个一个来,
      前一个被拒就不问后一个. 必需的 `camera` / `microphone` 启动前已经问过, 到这里是 `granted`, 不再问.
    - `enumerateDevices`: 没批准的一类只给一个空 id / 空 label 的条目 (和系统没答应时一样, `Permits.#listed`); `getUserMedia` 内部选设备时看得到全部.
    - 没批准时 `open` 被拒 (撤销之后的 `applyConstraints` 重开设备会走到): 错误消息以 `NotAllowedError: ` 开头 (页面得到 `NotAllowedError`), 仍带
      `code` / `capability`.
    - 还没有: 撤销之后已经在用的轨道不会 `ended` (它开着的设备照常出数据), 只是不能再开新的.
    批准之后还有系统的询问: macOS TCC (`AVCaptureDevice requestAccess`, 第一次 `getUserMedia`
    时弹; acdert 二进制的 `__TEXT,__info_plist` 段带 `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`, 见 src/host
    `build.rs`; 从终端起时 TCC 记在终端名下); Linux 本机程序直接读 PipeWire / V4L2, 没有系统询问. acde 自己不画询问框 (批准提示由桌面或 `acde allow` 答).
    `navigator.permissions` 是真的 `Permissions` / `PermissionStatus`.
  - 设备 (`acde_media::capture`): Linux 用 GStreamer `DeviceMonitor` (`Audio/Source`、`Video/Source`, PipeWire / V4L2 提供者, 去掉
    输出的 monitor), 打开用设备自己的元素 (`create_element`), 摄像头按选中的模式 (设备 caps 和宽高帧率的交集) 解成 RGBA, 麦克风转成
    48 kHz 立体声 f32; macOS 用 `AVCaptureDeviceDiscoverySession` 和 `AVCaptureSession` (视频 BGRA → RGBA, 音频 LPCM f32), 会话在自己的
    线程里开关, 每 250 ms 看设备还连着没有. 摄像头只留最新一帧 (带序号), 麦克风写进 2 秒的环, 每个读者 (`Tap`) 从它创建时开始读, 落后太多跳到
    最近. 设备没了 / 出错 (`on_end`) → 这个设备的轨道都 `ended`. `deviceId` / `groupId` 是按应用加盐的散列, 跨应用对不上.
  - 页面 (`stream.ts`): `getUserMedia` 照标准的 SelectSettings 选设备和模式 (必需的 exact / min / max 过滤, `advanced` 依次收窄, ideal 按
    fitness distance 取最小), 都不行 `OverconstrainedError` (带 `constraint`); 选好后才问系统, 再开. 支持的约束: deviceId、groupId、
    facingMode、resizeMode (只有 `none`: 不缩放, 只给设备原生的模式)、width、height、aspectRatio、frameRate、sampleRate (48000)、
    sampleSize (32)、channelCount、echoCancellation / autoGainControl / noiseSuppression (只有 false: 不做处理). 同一设备的轨道
    (clone) 共用一个打开的源, 最后一个 `stop()` 才关; `applyConstraints` 要换模式时重开设备, 只换这个轨道. `enumerateDevices` 返回
    `InputDeviceInfo` (`getCapabilities`), 系统还没答应的一类只给一个空 id / 空 label 的条目 (标准的隐私规则).
  - 播放: `video.srcObject = stream` (`audio` 元素只放声音) → `openStream`: 画面每个动画帧取摄像头的最新一帧 (和 `<video>` 文件一样进
    `GpuImage`), 声音是混音器里的 `LiveSound` (没有声音轨时只走时钟, `currentTime` 照样走); 时长 `Infinity`, 不能 seek, `currentSrc` 是
    空串; 轨道 `enabled = false`: 画面黑、声音静; 轨道结束 / 换源时重开, 流里没有活的轨道了发 `ended`. Web Audio
    `createMediaStreamSource` (图里的 `Kind::Stream` 节点, 读 id 最小的音频轨, 轨道停用 / 结束时断开). 实时读取保持 20 ms 左右的延迟,
    积压超过 100 ms 就丢掉旧的.
  - 测试: `ACDE_CAPTURE=fake` 换成假设备 (像 Chrome 的 fake media device): 一个麦克风 (440 Hz, 0.25) 和一个摄像头 (320x240 / 640x480 /
    1280x720 @30, 蓝底 `#2080e0` 上一条每秒扫过的白条), 同一 group; `acde_media::capture::fake::unplug` 模拟拔掉. Linux 上没有摄像头时可以
    `gst-launch-1.0 videotestsrc is-live=true ! video/x-raw,format=I420,width=640,height=480,framerate=30/1 ! pipewiresink mode=provide
    "stream-properties=props,media.class=Video/Source,media.role=Camera"` 做一个 PipeWire 摄像头.
  - 还没有: `devicechange` (不监视插拔)、`getDisplayMedia` (录屏)、`MediaRecorder`、`createMediaStreamDestination`、回声消除等处理、
    `resizeMode: crop-and-scale`、轨道的 `mute` / `unmute` (系统暂停时).
- **网页存储** (src/storage `acde-storage`, src/host `storage.rs`, acde-dom `src/storage/`): 所有 web 都是同一个进程里的线程, 存储按
  **分区**放在进程里共享: 每个应用一个 (`app-<id>`), 每个桌面一个 (`desktop-<id>`), 登录页 `greeter` (只在内存). Broker 在 `#spawn` 时把
  `{key, dir, legacy}` 作为 grant 交给 web (acde-host `storage.ts` `StoragePlaces`), Rust 用 `Lease` 引用分区, 最后一个 web 退出时写盘并放掉;
  进程退出前 `acde_storage::flush_all()`. 目录 `$ACDE_STORAGE/<key>/` (默认 `$XDG_DATA_HOME/acde/storage`), 文件是 SQLite (rusqlite 自带的,
  WAL, 坏了挪成 `.bad-<毫秒>` 再从空的开始, 打不开就只在内存里, 都打 warn).
  - `localStorage`: 同一应用的所有窗口共用一份 (`LocalArea`, 内存里的表是准的, 改动由 `acde-storage` 线程按顺序批量写进
    `localstorage.sqlite3`); 键和值按 UTF-16 存 (单独的代理项原样保留); 配额 5 MiB, 按键和值的 UTF-16 码元数算, 超了 `setItem` 抛
    `QuotaExceededError` 且不改; 别的窗口改了发 `storage` 事件 (`StorageEvent`, `url` 是改的那个页面当时的地址, `storageArea` 是
    `localStorage`), 改的窗口自己不收. 命名属性照 WebIDL: 原型上有的名字 (`key`、`length` …) 不当成条目, 赋值一律存. 老版本的
    `$XDG_CONFIG_HOME/acde/storage/app-<id>.json` / `<desktop>.json` 在第一次建库时导入, 改名成 `.json.imported` (只在没设 `ACDE_STORAGE` 时).
  - `sessionStorage`: 每个 web 自己的, 只在内存, 配额同上; `location.reload()` 重起 web, 不保留 (标准里同一个浏览上下文要保留, 是缺口).
  - **IndexedDB** (src/storage `idb/`, src/host `idb.rs`, acde-dom `src/storage/idb/`): 分工是 Rust 管「谁先谁后」和数据, JS 管
    标准的语义.
    - Rust: 每个分区一条 `acde-idb` 线程 (`mod.rs` `serve`), 上面每个数据库一个 `Worker` (`database.rs`), 一个 SQLite 文件
      `indexeddb/<n>.sqlite3` (没有连接、事务和排着的请求时关掉文件, 内存分区的不关), 名字和版本在
      `indexeddb/catalog.sqlite3` (内存分区在 `:memory:` 和表里). 线程数和打开的文件数不随页面开的数据库个数涨. Worker 里排: 打开 / 删除的队列 (版本变了先给别的连接发 `versionchange`,
      它们都回 `acknowledge` 后还有没关的就给请求发 `blocked`, 都关了才升级或删)、事务调度 (作用域重叠且有一方要写时按创建顺序等;
      SQLite 同一时刻只有一个写事务, 所以不重叠的写事务也排队, 标准允许)、执行操作 (写操作各包一个 SAVEPOINT, 失败只撤这一条)、
      提交 / 回滚. 只读事务不开 SQLite 事务, 和正在写的事务作用域不重叠, 读不到它没提交的东西. 键是 JS 编好的字节, BLOB 按 memcmp
      比较就是 IndexedDB 的键序 (`records (store, key)`、`index_records (idx, key, pk)`, 都 WITHOUT ROWID); 值是结构化克隆的字节;
      store / index 的 id 由 JS 定 (升级里新建的 store 马上就要被后面的请求引用). 连接、事务、请求的 id 是 `(web, 本地号)`, web 退出时
      `owner_gone` 关掉它的连接、回滚它的事务.
    - JS (`idb.ts`, `keys.ts`): 键 → 字节 (数字 / 日期是保序的 f64, 字符串按 UTF-16 码元、二进制按字节, 0 转义, 数组以 0 结尾; 类型
      标签 数字 < 日期 < 字符串 < 二进制 < 数组; 数组的代理对象不是键, 用 `host.isProxy` 认), 键路径、生成键注入、多值索引、
      `IDBKeyRange`、全部参数检查和异常 (顺序照规范, 文字照 Chromium). 公开的 `IDB*` 类只有 IDL 里的成员 (`test/storage.test.ts` 逐个
      对), 逻辑在模块里的 `Connection` / `Txn` / `StoreCore` / `IndexCore` / `CursorCore`, 公开对象用 symbol 键指过去.
      - 请求先排在 `Txn.queue`, 收到 `started` (带键生成器的当前值) 后按顺序发给 Rust. 一条请求的索引集合在**发出请求时**定下 (后面的
        `createIndex` / `deleteIndex` 也按顺序在 Rust 里执行). 往自增的 store 写时, 等这个 store 前面的写都有了结果才发 (`inflight`),
        失败就把生成器退回去 (失败的 `add` 不占号, 和浏览器一样); 生成器的新值随 `put` 写在 SAVEPOINT 里, 一起成功或撤销, 用到
        2^53 以后是 `Infinity` (再生成就是 ConstraintError).
      - `createIndex` 读出已有记录、算索引键、`indexEntries` 写进去, 期间后面的请求停在 JS 里 (`pause`), 保证它们看到填好的索引;
        唯一约束不满足就中止升级事务.
      - 游标不在 Rust 里留状态: 每一步带上位置 (键 + 主键) 和目标重新查. `cursor.update` 只克隆一次.
    - 事务的「活跃」: 新建和派发 success / error / upgradeneeded 时活跃. IndexedDB 的事件用 `fireFromTask` (`core/event.ts`) 派发: 和浏览器
      一样每个监听器之后跑一次微任务检查点 (`host.runMicrotasks`), 再做规范的「清理 IndexedDB 事务」(`hooks.checkpoint`: 这个检查点里
      `db.transaction()` 新建的事务失活; 升级事务不算). 派发完马上失活; 任务末尾 (`endTask` → `idbTaskEnded`) 再看没有没回来的请求
      就自动提交. 所以用 promise 包 IndexedDB 的库 (idb 等) 和浏览器行为一样. 监听器抛错 (`listenerThrows`; `handleEvent` 不能调用也算)
      在事务还活跃时中止它; 显式 `commit()` 之后的 error 事件没被取消仍然中止 (Chromium 的行为), 抛错不中止. `commit()` 等所有请求的
      事件都派发完才发给 Rust. `versionchange` 的回答 (`acknowledge`) 也放到任务末尾, 监听器里 `await` 之后再 `close()` 不算 blocked.
      升级事务 `abort()` 之后同步看还在跑, 到发 `abort` 事件的那个任务才清掉 (`complete` 之前清掉).
    - 值的克隆: `host.serialize` / `deserialize` (V8 ValueSerializer). 平台对象是宿主对象 (acde-dom `core/clone.ts` `serializable`: 原型上的
      `CLONE` 方法给出 `[种类, 字段…]`, `host.cloneHooks` 登记): Blob、File、FileList、ImageData、DOMPoint(ReadOnly)、DOMRect(ReadOnly)、
      DOMQuad、DOMMatrix(ReadOnly). V8 反序列化时不许跑 JS, 所以 `read_host_object` 先放占位对象, 读完后交给 JS `reviveAll` 换成真的
      对象 (Map / Set 也照顾到). `EventTarget` / `Event` (含 DOM 节点、window) 克隆抛 `DataCloneError`; 克隆时 getter 抛的错原样抛出
      (`cloneFailure`). `structuredClone` / `postMessage` 也走这条路, `transfer` 里的 ArrayBuffer 克隆后 detach (MessagePort 照旧不转移).
    - 测试: `cargo test --release -p acde-storage` (调度、版本变更、回滚、游标), acde-dom `test/idb-keys.test.ts` (键序)、
      `test/storage.test.ts`. WPT 的 IndexedDB 用临时的包 (`apps` 的 entry 指向生成的页面, assets 挂 `/resources/`、`/IndexedDB/`、
      `/common/`、`/interfaces/`; `/resources/WebIDLParser.js` 是 `resources/webidl2/lib/webidl2.js`), `acdert app` headless 逐个跑
      (`.any.js` 只跑 window 那份, 有 `variant` 的用 `history.replaceState` 换查询串), 页面用 `add_completion_callback` 把结果打进日志后
      `window.close()`. 2026-11-09 macOS: 1332 / 1384 个子测试过. 没过的都是别的缺口: Web Worker、跨 realm (iframe)、bfcache、
      SharedArrayBuffer (要 COOP / COEP)、Storage Buckets、要 WPT 服务器的 (`content.py`); `idlharness` 112 / 207, 没过的是整个 acde-dom
      的绑定形状 (方法和属性不可枚举、事件处理属性在原型上读不抛 TypeError、构造函数的 `length`), 不是 IndexedDB 自己的.
  - **配额**: IndexedDB 和私有文件系统现在不按 `estimate()` 的 quota 拒绝写入 (不会抛 `QuotaExceededError`), 是缺口; 页面本来就能经
    `sys` 写任意文件 (见「沙箱」), 所以这不是安全边界的问题, 是和浏览器行为的差别.
  - **cookie** (`document.cookie`, 同源请求的 `Cookie` / `Set-Cookie`): 解析在 acde-dom `core/backend.ts`, 存在分区的 `CookieJar`
    (src/storage `cookies.rs`): 同一应用的窗口共用; 有 `Expires` / `Max-Age` 的写进 `cookies.sqlite3`, 会话 cookie 只在进程里
    (acdert 退出就没了, 和浏览器关掉一样); 按路径长、再按创建先后排; 脚本碰不到 `HttpOnly`.
  - **Cache API** (`caches`, `Cache` / `CacheStorage`, acde-dom `storage/cache.ts`, src/storage `caches.rs`, src/host `caches.rs`):
    `caches.sqlite3`, 每个缓存一行 (按创建先后), 条目存请求的 URL (含 `#片段`)、方法、请求头, 回应的 status / statusText / type / url /
    redirected (JSON)、回应头和整段 body. 匹配在 Rust 里照规范的「request matches cached item」: 比的时候去掉片段, `ignoreSearch` 再去掉
    查询串; `Vary` 逐个头比请求头 (`*` 不匹配); 非 GET 除非 `ignoreMethod`. `put` / `add` / `addAll` / `delete` 是一批原子操作 (先删同一请求
    的旧条目再插). `caches.delete` 只把缓存标成作废 (名字清空): 已经打开的 `Cache` 对象照旧能用, 下次打开分区时清掉. 每个 web 的 Cache API
    调用经同一条 `acde-caches` 线程按调用顺序执行 (`offload::Queue`), 所以 `Promise.all` 里开的几个缓存按调用顺序排. 页面 `addAll` 里重复的
    请求 (同 URL、方法, 按后者的 `Vary`) 是 `InvalidStateError`; 206、`Vary: *` 拒绝. 内存分区在内存的 SQLite 里.
    WPT `service-workers/cache-storage` 2026-11-09 macOS: 133 / 157; 没过的要 WPT 服务器 (`fetch-status.py`、`vary.py`、跨源)、Worker、
    iframe、Storage Buckets、Service Worker.
  - **`navigator.storage`** (`StorageManager`, acde-dom `storage/manager.ts`): `estimate()` 的 usage 是分区目录下文件的总大小
    (内存分区加上 localStorage), quota 是磁盘的 60% (和 Chromium 一样; `quota.rs`, unix `statvfs`, Windows `GetDiskFreeSpaceExW`);
    `persist()` / `persisted()` 都是 true (Dopame OS 不回收应用的存储). `getDirectory()` 是私有文件系统: `<分区>/opfs/` (内存分区在临时
    目录, 分区放掉时删), 经 `natives.storage.privateDirectory()` 登记进这个 web 的 `PickedFolders` 和 `pagecalls.ts` 的文件夹表,
    返回名字是 `''` 的可读写 `FileSystemDirectoryHandle`. 内存分区的私有文件夹在 `$XDG_RUNTIME_DIR` (没有时用临时目录) 下新建的
    `acde-storage-<pid>-<随机>` (0700, 已有同名的就换名字, 不复用), 进程退出时删, 读写和 `showDirectoryPicker` 的同一套. `createSyncAccessHandle` 只在 worker 里, 没有.
- **还没有**: shadow root 里的 `<style>` 不隔离 (会作用到整个文档)、XML 文档里的样式表处理指令 (`<?xml-stylesheet?>`) 和 XML 文档的渲染 (只当 DOM 用)、`DecompressionStream` / `CompressionStream`、`speechSynthesis`; `<select>` 的 `appearance: base-select` / `::picker(select)`、`<datalist>`、Storage Buckets、Web Worker、`crypto.subtle`、OffscreenCanvas、全屏和指针锁定、`:target`; 从别的主机 `import` ES 模块 (`modules.rs`; `blob:` 和 `data:` 模块可以: `compile_graph` 经 `host.setModuleSource` 登记的 acde-dom `moduleSource` 同步取文字, 只认 JavaScript MIME 类型, 和 fetch 走同一个 `inline`).
- **后端** (acde-host `backend.ts`, unix): PATH 上有 `bun` 就 `bun --preload acde-listen.js server.js`, 否则 `node --import <acde-listen.js 的 file: URL> server.js`
  (Node ≥ 22.3; `ACDE_RUNTIME=node` (acde dev 按工程的运行时设) 时先找 node, 没有再 bun; 两样都没有不起, 打一行 warn; 同一份构建产物两边都能跑, 见 acde 的「和 acdert 的契约」), 第一个窗口打开时起, 最后一个关掉时停 (SIGTERM 进程组,
  3 秒后 SIGKILL), 一分钟内第 4 次崩溃后不再起. `child.rs` 起: 自己的会话和进程组, 环境从零建 (`ACDE_APP_ID` / `ACDE_APP_DATA` /
  `ACDE_APP_SOCKETS` / `PORT` / `NODE_ENV=production` + 会话的 HOME、PATH、LANG 等), 工作目录 `$XDG_DATA_HOME/acde/apps/<id>/`, 输出前缀
  `[<app>#backend]`, `PR_SET_PDEATHSIG` (子进程都由 `acde-fork` 线程 fork). preload 把 listen 换成 unix socket (`<acde 的运行时目录>/<acdert 的 pid>/<id>/`, acde 的运行时目录是 `sys/os.ts` `ownRuntimeDir`: 有 `XDG_RUNTIME_DIR` 或在 Linux 上是那里的 `acde/`, 别处 `$TMPDIR/acde-<uid>` 本身就是 acde 的, 不再套一层 (macOS 的 `TMPDIR` 很长, 104 字节里每个字都要省; 这样应用 id 能比 0.0.9 长 4 个字): 每个会话一份, acde dev 和 acde test 同时跑
  同一个应用不再互相删 socket; 应用的后端停了删它的目录, Broker 关闭时删整个 pid 目录, 第一次起后端时扫掉进程已不在的 pid 目录;
  `<端口>.sock` 的路径超过 `sun_path` (macOS 104 字节, Linux 108) 时不起, 打一行 warn. Linux 上没有 `XDG_RUNTIME_DIR` 时用
  `/run/user/<uid>`; `sys.pid` 给出 acdert 的 pid; 只扫纯数字的目录, 同一处的 `acde/` (旧布局、`exec`) 不动), 指定端口的 UDP bind 拒绝; 原生扩展开的端口管不到.
- **后端的代理变量** (runtime `proxy::backend_variables`, Broker 经 `sys.proxyEnv()` 并进后端环境, 各平台都有): 会话设了
  `http_proxy` / `https_proxy` / `all_proxy` 中任何一个, 就原样传 `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` 这几个变量 (unix 上大小写
  两种名字各自照传, Windows 环境变量名不分大小写, 用大写名). 一个都没设时给平台的手动代理, 和页面用的同一份系统设置: Windows 是用户
  Internet 设置的手动代理和绕过列表 (`WinHttpGetIEProxyConfigForCurrentUser`), macOS 是系统配置的 HTTP / HTTPS / SOCKS 代理和例外列表
  (`CFNetworkCopySystemProxySettings`); HTTP 代理给 `http://h:p`, Windows 的 `socks=` 给 `all_proxy=socks4a://h:p`, macOS 的 SOCKS 给
  `socks5h://h:p`; unix 上大小写两种名字都设. `no_proxy` 是会话的 `no_proxy` 加上系统的例外再加 `localhost,127.0.0.1,::1` (页面那边环回地址也永远直连);
  例外换成 `no_proxy` 的写法: `*.x` → `.x`, `192.168.*` → `192.168.0.0/16`, `169.254/16` → `169.254.0.0/16`, 其他带通配符的、带协议的、
  Windows 的 `<local>` 和 macOS 的“排除简单主机名”没有对应写法, 不给. 配置脚本和自动发现 (Windows 设了配置脚本, macOS 开了自动配置或
  自动发现) 是按 URL 回答的, 变量表达不了, 这时后端不得到系统代理; Windows 只开“自动检测设置”时照样给手动代理 (和页面在 WPAD 没找到时一致).
  每次起后端时读, 改了系统设置后新起的后端生效. Linux 没有系统来源, 只有会话的变量.
- **Windows 后端契约** (2026-11-09 定, 运行时实现在 src/host `backends/` 和 runtime `channel/`; acde 的「和 acdert 的契约」写同一份, 两边一起发版). 不变量: 后端运行期间没有 TCP 监听、没有命名管道,
  套接字文件只有 SYSTEM 和当前用户能开; macOS / Linux 不变. argv、`ACDE_RUNTIME` 选 bun / node、环境从零建、一分钟 4 次崩溃上限、首窗起末窗停都同上.
  - **两种模式**: node 走**通道模式** (Node 在 Windows 上不能用文件系统 AF_UNIX, 命名管道的默认安全描述符给 Everyone / 匿名读、也接受远端打开);
    bun 走**套接字模式** (和 unix 一样, `Bun.serve` 语义完整). 环境: 通道模式 `ACDE_APP_CHANNEL=fd`, 不设 `ACDE_APP_SOCKETS`; 套接字模式
    `ACDE_APP_SOCKETS=<本代目录>` 加 `ACDE_APP_CONTROL=fd`, 不设 `ACDE_APP_CHANNEL`. 其余变量同 unix.
  - **进程**: `CreateProcessW`, 每个后端一个自己的作业对象 (关闭即终止, 后端派生的子进程一起在里面), 只显式继承列出的句柄
    (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`). 两种模式都另建两根匿名管道, 经 CRT 的 `lpReserved2` 交成子进程的 fd 3 (子进程读) 和 fd 4 (子进程写);
    单向匿名管道两根, 因为双工管道要有名字. 通道模式上面跑全部帧; 套接字模式只跑控制帧 (SHUTDOWN, 帧格式同下), 数据走 AF_UNIX. 运行时一侧一条线程阻塞写、一条阻塞读, 和 ntex 的 `IoStream` 之间只经互斥锁和 waker.
    Broker 用的原生接口多两个只在 Windows 有的: `sys.spawnBackend(argv, {cwd, env, prefix, app, mode, preload}, onExit)` (两种模式都用它, mode 是
    `'channel'` / `'sockets'`; 传输变量和 `SystemRoot`、`TEMP`、`LOCALAPPDATA` 等 Windows 程序要的变量由运行时补) 和 `sys.stopBackend(pid, ms)`.
    acde-host `backend.ts` 有它们就走这条路, node 是通道模式, bun 是套接字模式. acdert 退出时 `child::stop_all` 终止还在的后端并删本代目录;
    等待线程正在收尾的后端 (末窗关闭先发了 SHUTDOWN, 进程刚退出, 目录可能还要重试删除) 也等它收尾完 (`FINISHING` 锁) 再退出, 不留目录.
  - **通道帧** (大端): `type u8 | stream u32 | length u32 | payload`, 头 9 字节, payload 最多 64 KiB. 类型: OPEN 1 (运行时开一条流, payload 是
    u16 逻辑端口, 即 `listen(P)` 的 P)、DATA 2 (字节, 运行时按 16 KiB 分块)、FIN 3 (这一方向写完, 半关闭)、RST 4 (中止这条流, payload 是 UTF-8
    原因)、WINDOW 5 (payload u32, 给对方追加的信用字节数)、SHUTDOWN 6 (流号 0, 无 payload, 运行时请后端优雅退出). 流号由运行时分配, 不复用;
    每条流每个方向初始信用 256 KiB, 发 DATA 扣信用, 收方把数据交出去后发 WINDOW 补回. 不认识的类型忽略; 不存在的流上的 DATA / FIN 回 RST;
    P 上没有登记 server 时预加载回 RST. 两端都在 FIN 排空后才算关闭, RST 只用于中止. 流量控制在运行时一侧按 ntex 的读写高低水位.
  - **预加载 (acde 的 `acde-listen.js`)**: 通道模式把每个 OPEN 交给 `listen(P)` 登记的 server 当一条连接 (HTTP 和 WebSocket 升级都走它), 不真正监听;
    读 fd 3 用专用循环, 不长期占公共线程池. 套接字模式和 unix 一样把 `listen(P)` / `Bun.serve` 换成 `<ACDE_APP_SOCKETS>\<P>.sock`
    (Bun 1.4.4 在 Windows 上 `Bun.serve({unix})` 和 `node:http` 的 `listen(路径)` 都建 AF_UNIX 套接字, 不是命名管道), 有 `ACDE_APP_CONTROL=fd`
    时读 fd 3 上的控制帧. 预加载不改目录的 ACL.
    支持通道的 `acde-listen.js` 含字符串 `acde-listen-channel/1`; 运行时起 node 前查这个标记, 没有就不起, 打 warn
    `not started: acde-listen.js does not support the Windows channel (built by an older acde: acde build it again)`.
  - **套接字目录**: 每一代 (每次起, 含崩溃后重起) 新建一个短目录 `<base>\<运行时 pid>.<6 位随机十六进制>`, base 是 `$XDG_RUNTIME_DIR\acde\b`,
    没设时用户临时目录下的 `acde\b` (`std::env::temp_dir()`, 即 `GetTempPath2W`: `%TMP%` / `%TEMP%`, 一般是 `%LOCALAPPDATA%\Temp`). 建目录时就带上受保护的 DACL (不先建后改): 只有 SYSTEM 和当前用户, 完全控制, 对象和容器继承, 关闭从上级继承
    (SDDL `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;<用户 SID>)`); 套接字文件继承它 (实测 `D:AI(A;ID;FA;;;<用户>)(A;ID;FA;;;SY)`). AF_UNIX 路径最多
    108 字节 (`sun_path`, UTF-8, 含结尾 NUL): 运行时用 `65535.sock` 算最长路径, 超了不起并打 warn. 停止后删掉本代目录; 运行时第一次起后端前删掉
    base 下 pid 已不在的目录 (崩溃留下的). 被杀的 Bun 会留下套接字文件, 同一路径再 `Bun.serve` 是 `EADDRINUSE`, 所以每代用新目录.
    不用 `%LOCALAPPDATA%` 本身: 从 MSIX 打包应用 (例如 Claude 桌面版) 派生的进程 (含经 `Start-Process` / `cmd /c start` 再起的) 写
    `%APPDATA%` / `%LOCALAPPDATA%` 时被重定向到 `Packages\<包>\LocalCache`, 在那里建的 AF_UNIX 套接字连不上 (Bun 自己的客户端也一样);
    临时目录不被重定向. 实测 (2026-11-10): 普通进程 (不在包环境里) 两处都能连, 包环境里只有临时目录能连.
  - **运行时连接**: 套接字模式和 unix 同一段: `fetch.rs` 的 `ntex::rt::unix_connect` (Windows 上 ntex 的 IOCP 反应器用 socket2 建 AF_UNIX
    再 `ConnectEx`), 不用线程桥接; `Dial::check` 接受 Windows 的绝对路径. 通道模式经通道开流. web 初始化参数: 套接字模式照旧给 `sockets`
    (只表示有后端, 值是 base), 通道模式不给 `sockets`, 给 `channel: true` (`AppBackends.webInit`). Windows 上两种 web 都按 `init.app.id` 拨
    `Dial::App`, 运行时的登记表 (runtime `channel::register`, 每代一个 `Route::Channel` / `Route::Sockets(本代目录)`) 给出当前一代, 所以重起后换了
    目录的 Bun 也能接上. 两种模式没就绪或拒绝连接时都重试 10 秒
    (通道: 还没注册; 套接字: `NotFound` / `ConnectionRefused`, 后者也是残留套接字的错误 10061), 新一代起来后接上.
  - **停止**: 两种模式都在 fd 3 上发 SHUTDOWN (预加载停止接受新连接、让在途请求做完、关 server 后退出), 等 3 秒 (`STOP_MS`), 然后终止作业对象
    (旧预加载不读控制帧, 就是等满 3 秒再终止). 后端退出时注销这一代的通道 / 目录, 上面还没完的流失败.
- **路由**: 页面的 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` 都由这个 web 自己的线程发 (src/host `backend.rs` 的 `natives.backend`,
  每个 web 都有 → runtime `fetch.rs` `FetchClient`: ntex 的 HTTP / WebSocket 客户端, I/O 在 `acde-rt` 线程; acde-dom `core/net/index.ts` 的 `route`). 去哪:
  - 同源非资源路径、有后端时的 `localhost:<port>` (和 127.0.0.1、[::1]、0.0.0.0) → 自己应用的 unix socket (`Dial::Socket`, `init.sockets`; 没出现或
    拒绝连接时重试 10 秒). 没有后端的 web 同源非资源路径失败, `localhost` 走下面的网络.
  - 别的主机 (`Dial::Url`, http / https / ws / wss) → 宿主的网络: 系统 DNS, TCP, https / wss 用 `http.rs` 的 `tls()` (只给 http/1.1 的 ALPN,
    验证证书和主机名). 不自动解压 (不发 `Accept-Encoding`).
  - 代理 (runtime `proxy/`): 契约照 Linux, 设了 `http_proxy` / `https_proxy` / `all_proxy` (大小写都认, 小写优先) 中任何一个就只看环境变量,
    各平台都一样; 没设时问平台: Windows 是用户的 Internet 设置 (WinHTTP: 自动检测 WPAD 和配置脚本按 URL 问
    `WinHttpGetProxyForUrl`, WPAD 没找到后 5 分钟内不再问; 没有答案时用手动代理和它的绕过列表, `<local>`、通配符), macOS 是系统配置
    (CFNetwork, 例外列表由它处理, PAC 在 `acde-proxy` 线程的 run loop 上跑, 最多 10 秒), Linux 没有别的来源. `no_proxy` (名字含子域、
    IP、CIDR、`:端口`、`*`) 对系统设置也生效; localhost 和环回地址、应用后端永远直连. 求代理可能阻塞 (WPAD、PAC), 在 `acde-proxy` 线程上做.
    经代理时自己建隧道: HTTP 代理一律 `CONNECT host:port` (http 也是, 代理看不到请求本身; 主机名由代理解析), 或 SOCKS4a / SOCKS5
    (主机名交给代理); https / wss 再在隧道上和目标做 TLS (SNI 和校验用目标主机). 经代理的连接不进连接池 (每个请求一条). 按列表顺序试
    (PAC 的 `PROXY a; DIRECT`), 都失败时错误里写出每个代理和原因. 不支持: 代理认证 (407 原样报错)、`https://` 代理、Linux 桌面环境的代理设置.
  - 和浏览器一样的规则 (页面的源是 `http://acde.local`): 跨源请求带 `Origin`、`Referer: http://acde.local/`、`User-Agent`、`Accept-Language`;
    CORS (acde-dom `core/cors.ts`): 简单请求之外先发 `OPTIONS` 预检 (不缓存), 回答要 2xx 且允许这个源、方法和头 (`*` 只在不带凭据时算,
    `Authorization` 不归 `*`); 响应没有允许这个源 (带凭据时还要 `Access-Control-Allow-Credentials: true`) 就是网络错误 (`TypeError`, `cause`
    以 `CORS:` 开头); 页面只看得到安全名单里的响应头和 `Access-Control-Expose-Headers` 列的. `Request.mode`: `no-cors` 只许 GET / HEAD / POST
    和安全名单里的头, 回不透明响应 (status 0, type `opaque`, 没有头和 body); `same-origin` 不许跨源. 重定向照常跟 (每跳都查 CORS, 换到第三个源后
    `Origin: null`). 跨源请求不带也不存 cookie (所有主机对 `acde.local` 都是第三方, 和 Safari 拦第三方 cookie 一样); 同源 (后端) 的 cookie 照旧.
  - 被禁的请求头 (Host、Cookie、Origin、Referer、Accept-Encoding、`Sec-*`、`Proxy-*` …) 页面设了也不发. 同步 XHR 只给本地资源.
  - body (acde-dom `core/net/index.ts` `Body`): 读 body (`text()` 等) 用流的 reader 读完且不放锁 (规范的 fully read), 之后 `body.locked` 是 true;
    null body 读了不算 `bodyUsed`. `Response.clone()` 保留 `error` / `opaque` 的 status 0 和 type. URL 带用户名或密码的 `Request` 抛 TypeError.
  - 经典 `<script src>` 从别的主机取时不查 CORS (和浏览器一样, 不带 `crossorigin` 的脚本照样执行): `page.ts` 经 `core/net/` 的内部 `scriptSource`, 不是页面能用的接口.
- **语音输入** (runtime `src/voice/`, Linux): `listen(onEvent)` 从 PipeWire 默认输入录 16 kHz 单声道, 连豆包输入法的流式识别 (非官方接口,
  身份存 `$XDG_STATE_HOME/acde/doubao-ime.json`). 事件 `partial {text}`、结束时恰好一个 `final` 或 `error`; `stop(id)` 等定稿 (最多 10 秒), 60 秒自动停,
  新的 `listen` 取消上一个. 日志 target `acde_runtime::voice` (识别出的文字不进日志). 没有麦克风时用 PipeWire 的 `module-pipe-source` 喂 PCM.

## 文件 (`acde:fs`)

页面的 `acde:fs` 是 src/host `fs.rs` 绑的 `natives.fs`, 实现在 runtime `fs/` (`Workspace` → `WorkspaceFs`), 类型 acde-api `AcdeFs`.
第一个参数是 root (`roots()` 里某项的 `id`; 下面按路径的根 `id` 就是 `path`), 第二个是相对路径: 绝对路径、`..` 出 root、经符号链接出 root 都拒绝 (`WorkspaceFs::resolve`),
root 本身不能替换或删. Finder 的根: 桌面文件夹、下载 (`XDG_DOWNLOAD_DIR` 或 `~/Downloads`, 存在时)、`~/agentos-work` (存在时), 加上用户授给
这个应用的文件夹. 根列表每个 web 缓存 (#143, runtime `fs/access/cache.rs` `RootCache`, 存在 `Workspace` 上): `roots()` 每次重建并刷新缓存; 别的调用用缓存,
授权变了 (任何应用的授予或撤销, `Grants::changes`) 或超过 2 秒就重建; 调用点名的根 (`FsCall::targets`) 在缓存里找不到时, 先重建再执行;
只读调用 (`FsCall::reads`) 失败后, 若缓存里的根不见了或重建结果不同, 用新列表重试一次; 写操作进了文件系统后失败不重试 (避免 copy / rename / delete 执行两次), 所以根文件夹刚被删时的写操作在缓存过期 (2 秒) 前直接报错.
列表内容和顺序与不缓存时一致, 只省掉每次调用都查环境变量、建桌面 / 私有文件夹、对每个根 `is_dir`. Windows 上隐藏和系统属性的文件按隐藏文件算. 运行时不记 Finder 看到哪里 (`state()` / `place()` 随 #69 移除, 由文件管理器自己记).

**应用的根** (#66; runtime `fs/access/files.rs` `Files`, Broker `broker/access/files.ts` `FileAccess`): 所有应用 (系统应用也是) 的 root 是不透明的标识, 不是路径:
`private` (本应用的私有数据文件夹 `$XDG_DATA_HOME/acde/files/<应用 id>`, 没设时 `$HOME/.local/share/...`, 第一次用时建), 公共位置名 (SDK `SHARED_PLACES`:
`desktop`、`documents`、`downloads`、`music`、`pictures`、`videos`, 按 XDG 用户目录 `XDG_<名>_DIR` / `user-dirs.dirs`; Windows 没设时用对应的已知文件夹
`SHGetKnownFolderPath`, `path.rs` `known_folder`), 选择的文件夹是 `folder-<路径 SHA-256 前 16 位十六进制>` 的令牌. `fs: true` 只给 `private` 和用户选给它的文件夹;
公共位置要在 `fs.roots` 里点名 (校验器: 不是这六个名字就是错误, `agentos-work` 不算;
末段是位置名的路径如 `~/Downloads` 提示改写位置名, 别的提示用户选的文件夹) 并经批准 (见「批准」). `roots()` 回
`{id, label, source: 'private' | 'place' | 'granted', mode, reason, exists, place?}`, 只有点名了公共位置的系统应用另带 `path`; 别的应用拿不到绝对路径,
`locate` / `openPath` 报 403 `EACCES`. 没批准或撤销了的位置: web 侧 (`FileAccess.guard`, 经 `Permits`)
把它从 `roots()` 里去掉, 以它为 root 的调用 reject 403 `denied` (`AcdePermissionError`). `fs.revoke(令牌)` 收回选择的文件夹, `acde:permissions` 也列出和收回它 (见「批准」). Broker 交给 web 的授权是
`fs: {places, paths}` (src/host `web.rs` → `Workspace::files`). 下面按路径的根只给桌面页面.

**拖放和打开请求的句柄** (#68): 用户交给应用的文件和文件夹是标准的 `FileSystemHandle`, 页面拿不到路径.
- 系统拖放: `dnddrop` 的 `files` 里每个路径 (acde-host `dnd.ts` `DragDrop`, 链接和别的类型跳过): 不超过 64 MiB 的普通文件进 `dataTransfer.files` (内容在 drop 时读进来),
  每个文件和文件夹在 `items` 里是 `kind: 'file'` 的一项, `getAsFileSystemHandle()` 给只读句柄 (`createWritable` / 新建 / 删除是 `NotAllowedError`,
  `queryPermission({mode: 'readwrite'})` 是 `prompt`). 和 Chromium 不同: 文件夹和超过 64 MiB 的文件不在 `files` 里, 那一项的 `getAsFile()` 是 null, 只能用句柄.
  页面自己的 `DataTransfer` 和页面发起的拖动 (没有 `files`) 的项没有句柄, `text/uri-list` 里的 `file:` 也不再变成 `File`.
  `dataTransfer.items` 同浏览器按下标取 (`items[i]`, 活的, 越界是 `undefined`, 同一项每次是同一个对象), 也能迭代; 下标经 acde-dom `events.ts` 的代理.
  `items.clear()` 同规范移除全部项 (字符串、文件和句柄项), `clearData()` 只清字符串. 没有拖放数据存储的只读 / 受保护模式, 页面拿到的列表一律可写.
- `File.type`: 拖放的 `File`、句柄的 `getFile()`、`<input type=file>` 和 `showOpenFilePicker` 的文件都按名字取类型, 和选应用用的同一套
  (`mimedb.ts` `FileTypes.byName`: Windows 是扩展名登记的 `Content Type`, 别处是 shared-mime-info 的 globs; 见「默认应用」的「文件的类型」),
  acde-host `PageCalls` 把它设成 acde-dom 的 `env.fileType`. 系统不知道的是空字符串, 同浏览器. 不按内容猜 (浏览器也只看名字).
- 打开请求: `Opener` 给接收方的 `request` 带内部的 `entry: {path, kind, writable}` (要选中文件时是所在文件夹加 `file` 名字), 接收方的 web (`remote.ts`
  `WindowSelf`) 把它换成 `handle` 再交给页面, `entry` 不进页面. 来源可写 (`mode` 有属主写位; Windows 只读属性) 时句柄可写. `FileAccess.view` 是 `handle` 的
  应用 (第三方应用, 和只有 `fs: true` 的系统应用) 只拿 `{kind, handle, file?}`; 点名了公共位置的系统应用和没有 `fs` 的系统应用拿 `url` 加 `handle`;
  按路径的 `{root, path, file}` 加 `handle` 只给桌面页面.
- 选择器: `showOpenFilePicker` 的文件只读 (只读属性) 时句柄是只读的, 别的可写; `showSaveFilePicker` 可写; `showDirectoryPicker` 照 `mode`.
- 句柄怎么登记: 文件记在这个页面的 `PageCalls` (和打开选择器选中的文件一起; 整读整写走 acde-host `sys/fs`, 同时经 `natives.picker.allowFile` 记进
  这个 web 的 `PickedFolders`, 只认这一个路径, 大文件的按需读和分块写走它), 文件夹经 `natives.picker.adopt` (src/host
  `picker.rs` `adopt`) 进这个 web 的 `PickedFolders`, 读写和选的文件夹一样不出这个文件夹、不跟随链接. acde-dom 经 `WebInternals.handles` (`of` / `picked` /
  `transfer`) 造句柄、认句柄、往 `DataTransfer` 里放; 页面自己 `new FileSystemFileHandle(...)` 造不出能读的句柄 (`PageCalls` 只认登记过的路径).
- 交出去: 应用的 `acde.apps.open({kind: 'open-file', handle})` (或 `open(appId, …)`) 在 web 里把 `handle` 换成 `held: {path, kind, writable}`, 只认这个页面登记过的句柄
  (否则 `TypeError`), 页面自己给的 `held` / `entry` 丢掉. Broker (`Opener.request`) 按 `held` 的路径打开, 交给系统默认程序时调用方的根加上这个文件所在的文件夹; 交出的是只读句柄时接收方也只拿到只读句柄.
  这样第 1 级应用能把拖进来的、选中的、别人交给它的文件交给别的应用打开; 私有文件夹和公共位置里的文件还没有句柄 (要先经选择器).

工作区内的相对路径用 `/` 分隔. Windows 上拒绝反斜杠、数据流分隔符、保留设备名和以空格或点结尾的名称;
判断解析后的路径是否在 root 内时按系统路径组件比较.

Windows 的 `XDG_DESKTOP_DIR` 和 `XDG_DOWNLOAD_DIR` 支持盘符绝对路径及普通 UNC 文件共享路径, 可用 `/` 或 `\` 分隔.
`$HOME` 可用两种分隔符展开. 设备路径、逐字路径、IPC 共享、相对路径和指向用户主目录的覆盖项使用默认目录 `%USERPROFILE%\<名>`.
没设 (或为空) 时按路径的根和第 1 级公共位置一样用系统已知文件夹 (`known_folder`), 桌面挪进 OneDrive 时不再新建 `%USERPROFILE%\Desktop`.

**失败**: reject 一个 `Error` (`AcdeFsError`), 字段来自 runtime `failure.rs` 的 `Failure`: `message` 人读的英文, `status`, node 风格的 `code`:

| `code` | `status` | 什么时候 |
| --- | --- | --- |
| `EINVAL` | 400 | 参数不对、出 root、类型不对、符号链接 |
| `EACCES` | 403 | 清单没给这个 root、系统不让 |
| `ENOENT` | 404 | 不存在 |
| `EEXIST` | 409 | 已经有了 |
| `ECONFLICT` | 409 | 打开之后被改了 / 没了 (`expectedModifiedMs` / `ifModifiedMs` / `ifVersion` 对不上) |
| `ENOTEMPTY` | 409 | 删非空的文件夹 |
| `EFBIG` | 413 | 超过上限 |
| `EILSEQ` | 400 | `readText` 读到的不是 UTF-8 |
| `ENOSPC` | 507 | 磁盘满 |
| `EIO` | 500 | 别的 (细节进日志) |

`code` 由造 `Failure` 的地方定 (`exists` / `conflict` / `with`), 否则按 status; io 错误按 `io::ErrorKind` 映射 (unix 上另认 ELOOP).
系统拒绝 (Windows 的拒绝 ACE、只读属性) 在写入、新建、mkdir、copy、rename、删除和解析路径 (`WorkspaceFs::resolve` 取 realpath) 时都是 403 `EACCES`;
拒绝 `W` 也拒绝了 `SYNCHRONIZE`, 连打开文件夹都失败, 所以那个文件夹的列出也是 403. 父目录不存在仍是 400 `EINVAL`. 只有
`acde:fs` 是这个形状; napi `Finder.locate` 的 message 照旧是失败的 JSON.

调用: `roots` / `list` / `preview` (文字最多 256 KiB) / `download` / `mkdir` / `rename` / `delete` / `locate` / `openPath` / `revoke`, 和文件级的
(#69 移除了 `write` (用 `writeFile`)、`desktop()` (用 `list`)、`state()`、`place()` 和 `copyIn` (用 `copy` 和句柄)):

- `list(root, path, hidden)` → `{root, path, entries, truncated, skipped?}`: `hidden` 默认 false, 不列隐藏项 (点开头的名字, Windows 另加隐藏或系统属性; #149, 之前默认列出), 给 true 才列; 先排好 (文件夹在前, 区域排序规则) 再截到 5000 条 (`truncated`);
  名字不是合法 UTF-8 (Windows UTF-16) 的项跳过, `skipped` 是个数 (没有时不出现); 目录句柄的列出同样跳过这些名字.
- `download(root, path)` → `{name, contentType, data: Uint8Array}`: runtime 只回名字和内容 (`FsReply::File`), `contentType` 由 web 侧 `fsmodule.ts` `FsModule.typed`
  (`worker.ts` 把 `natives.fs` 包上它再交出去) 按名字从 `FileTypes.system().byName` 取, 和 `File.type` 同一个库 (见「默认应用」的「文件的类型」:
  `.md` 是 `text/markdown`); 系统不认识的名字是 `application/octet-stream`.
- `stat(root, path)` → `FinderEntry & {path}` (lstat; 普通文件多带 `version`).
- `readText` → `{text, modifiedMs, size, version}` (最多 64 MiB, BOM 原样留), `readBytes` → `{data: Uint8Array, modifiedMs, size, version}`.
  `version` 是不透明字符串 (`fs/save.rs`: 大小、完整修改时间、文件编号 (unix dev + inode, Windows 卷序号 + 文件索引)), 只用来比相等,
  不保证跨机器、跨平台可比; 同一毫秒里的两次写、FAT 的 2 秒精度、改系统时间都分得开.
- `writeFile(root, path, data, {create: 'always' | 'new' | 'never', ifModifiedMs, ifVersion, mkdirs})` → `FinderEntry` (带写后的 `version`):
  替换已有文件是先在同一文件夹写临时文件 (`.<名字>.<uuid>.acde-save`), fsync, 再原子替换 (unix `rename` 后 fsync 文件夹, 保留权限、尽量保留属主;
  Windows `ReplaceFileW`, 保留属性和 ACL), 中途出错原文件不动、临时文件删掉; 文件夹不让新建文件 (建临时文件 `EACCES`) 时退回在原文件上截断写入,
  结果带 `inPlace: true`, 这时没有崩溃安全. 新文件直接写 (0644). `ifModifiedMs` (毫秒) 和 `ifVersion` 任一对不上都是 409 `ECONFLICT`, 不能和
  `create: 'new'` 一起用 (`EINVAL`). 目录句柄的 `createWritable().close()` 同样原子替换. 选项对象经 JSON 交给 runtime, 类型不对 `EINVAL`.
- `mkdir(root, path, {recursive})`: recursive 从 root 起逐级建, 已是文件夹算成功.
- `copy(fromRoot, fromPath, toRoot, toDir)` → `FinderEntry & {path}` (#67, runtime `fs/copy.rs`): 在本应用可用的两个 root 之间复制, 两边各是 root 加相对路径,
  不传绝对路径. 原生复制文件和文件夹 (流式, 不限大小), 名字被占用时照 `numbered` 编号 (`a 2.txt`、`project 2`), `path` 是在目标 root 里的相对路径.
  两个 root 都要在本应用的 root 里 (按路径的根两边都过清单检查), 否则 403 `EACCES`; 没批准的公共位置 403 `denied`; 源是 root 本身、`..` 或经链接 /
  联接出 root (源或目标)、源本身是链接、文件夹里有链接 (先整棵查一遍, 复制中途变成链接也停, 删掉已复制的部分)、把文件夹复制进它自己, 都是 `EINVAL`.

**大文件** (#75, runtime `fs/ranged.rs`): `readText` / `readBytes` / `writeFile` 和整读整写仍限 64 MiB. 更大的文件主路径是标准接口:
句柄的 `getFile()` 超过 64 MiB 时给按需读的 `File` (acde-dom `core/blob.ts` `RangedSource`), `slice()` 不读, `stream()` 每次读 4 MiB,
`text()` / `arrayBuffer()` 才整读; 打开时记下 `version`, 之后文件变了读是 `NotReadableError` (同 Chromium). 按需读的 `Blob` 在同步用到字节的地方
(`structuredClone` / `postMessage`、`fetch` / XHR 的请求体、表单的 multipart、`blob:` URL、IndexedDB、WebSocket 发送) 是 `NotReadableError`, `FileReader` 照常.
`createWritable()` 开一个写入 (`keepExistingData` 先把原内容复制进去), `write` 按位置写进同一文件夹的临时文件 (`.<名字>.<uuid>.acde-part`,
每块最多 16 MiB, 大的数据和按需读的 `Blob` 分块写), `seek` 只移位置, `truncate` 截断或补零, `close()` 提交: fsync 后和 `writeFile` 一样原子替换
(unix 保留权限和属主, Windows `ReplaceFileW`; 原来没有这个文件时不覆盖地改名), `abort()` 删掉临时文件. 写的位置超过当前长度时中间补零, 同
`FileSystemWritableFileStream.write({position})`. 文件夹不让建临时文件时是 `EACCES`, 不退回原地写. 同一个流的操作按调用顺序排队, 一次失败后流的操作都 reject.

`acde:fs` 的底层调用 (根和路径的规则同上): `readRange(root, path, offset, length, {ifVersion}?)` → `{data, offset, size, modifiedMs, version}`
(`size` 是整个文件的; 一次最多 16 MiB, 超过 413 `EFBIG`; 超出文件末尾的部分不返回; `ifVersion` 对不上 409 `ECONFLICT`);
`openWrite(root, path, {keepExistingData, create, ifVersion, mkdirs}?)` → `{id, size}`; `writeChunk(id, offset, data)`; `truncateWrite(id, size)`;
`commitWrite(id)` → `FinderEntry` (带 `version`); `abortWrite(id)`. `create` 同 `writeFile`, 在提交时再查一次 (`new` 时文件已有是 `EEXIST`, `never` 时没了是 `ENOENT`);
给了 `ifVersion` 时打开和提交时都比, 中途别人改了是 `ECONFLICT`, 临时文件删掉、原文件不动. 偏移、长度和大小是非负整数, 否则 `EINVAL`.
限制 (`Writes`, 每个 web 一份): 同时最多 16 个写入 (再开是 `EINVAL`); 加长文件前查剩余空间, 写完剩不到 256 MiB 时 507 `ENOSPC`;
10 分钟没有操作的写入自动放弃 (`acde-fs-writes` 线程每 30 秒查一次; 之后用这个 `id` 是 `EINVAL`); web 结束 (关页面、崩溃) 时放弃它全部的写入;
进程被杀留下的 `.acde-part` 在下次在同一文件夹开写入时删掉超过 20 分钟没改的. 写入的调用和 `writeFile` 一样进这个 web 的改动队列, `readRange` 走读的线程池.

打开文件一律不跟随符号链接 (unix `O_NOFOLLOW | O_NONBLOCK`, 不会卡在 FIFO 上; Windows `FILE_FLAG_OPEN_REPARSE_POINT` 再查是不是链接).
读写、建、删、改名都先打开父文件夹 (`fs/beneath.rs` `Dir`) 再对其中的名字操作, 检查和使用之间换掉中间文件夹也出不了 root: Linux `openat2`
(`RESOLVE_BENEATH`, root 内的链接照常可走, 出 root 是 `EXDEV` → `EINVAL`), 之后经 `/proc/self/fd/<fd>/<名字>` 和 `renameat2(RENAME_NOREPLACE)`;
Windows 打开父文件夹 (不给 `FILE_SHARE_DELETE`, 开着时改不了名、删不掉), 用 `GetFinalPathNameByHandleW` 查最终路径在 root 里 (不分大小写), 改名用不带
`MOVEFILE_REPLACE_EXISTING` 的 `MoveFileExW`; 其他 unix (macOS) 还是先 `canonicalize` 再按路径用 (没验证). 改名不会覆盖同时出现的同名项 (`EEXIST`).

**拖放不再授权** (#69): 系统拖放只交给页面 `File` 和只读句柄, 不记一次性授权, 也不往 `text/uri-list` / `text/plain` 里放绝对路径;
Linux 会话 (`crates/window` `drop_performed`) 有本地文件时同样去掉这两项, 路径只经 `Event.files` 交给页面宿主.

**选文件夹和授权**: 标准的 `showDirectoryPicker(options?)` → `FileSystemDirectoryHandle` (acde-dom `dom/picker.ts`, 参数校验和错误照 Chromium,
取消或没有选择器是 `AbortError`, `requestPermission` 不弹窗; handle 只活到页面结束). 链路: acde-dom 的
`env.files` → src/host `picker.rs` 绑的 `natives.picker` (不是 `acde:` 模块). 选择器在 `acde-picker` 线程上开, 先取 `choose` 事先给的答复
(src/host `chooser.rs`, 三种选择器都在这里定去哪): Linux 是 portal
FileChooser (`directory: true`), macOS 是 hostwin 主线程上的 `NSOpenPanel` sheet, Windows 是 `SHBrowseForFolderW`. handle 的读写在 runtime
`fs/picked.rs` `PickedFolders` (每个 web 一份, 只在内存, 选中的文件夹当 root; 新建 `O_EXCL | O_NOFOLLOW`; 整读整写一个文件最多 64 MiB, 更大的见「大文件」).
Windows 选择器返回盘符或 UNC 绝对路径, 内存句柄和持久授权使用同一路径规则. `bash scripts/check-directory-picker.sh` 用预设选择结果验收.
用户选中的文件夹同时授给调用的应用 (`acde:fs` 多一个 root `{source: 'granted', label}`, 文件夹没了是 `mode: 'unavailable'`):
默认的只读选择给只读网页句柄和只读的 root (`mode: 'read_only'`, 能列出和读, 写入、新建、mkdir、rename、删除、复制进去都是 403 `EACCES`,
检查在 `WorkspaceFs` 的各写入函数和 `copy` 开头的 `FinderRoot::writable`); `mode: 'readwrite'` 的选择提示明确读写授权, root 可写.
同一个文件夹再被读写地选中就升成可写, 只读选择不会把可写的降级. 记在 `$XDG_STATE_HOME/acde/grants/<应用 id>.json`
(`{roots, readOnly?}`, `readOnly` 是 `roots` 里只读的那些; runtime `fs/access/grants.rs`; `ACDE_STORAGE` 为空时只在内存); 桌面选的不授.
`fs.revoke(rootPath)` 收回, `acde:permissions` 同样列出和收回只读的. Broker 起 web 时 grants 带应用 id, `web.rs` 给 `Workspace::scoped(roots, app)` 和 `natives.picker`.

**打开和保存文件**: `showOpenFilePicker` / `<input type=file>` / `showSaveFilePicker` (acde-dom `dom/picker.ts`、`dom/forms.ts`) → `env.files.open` /
`save` → acde-host `pagecalls.ts` 的页面调用 `open` / `save` → Broker `#fileChooser()` 的 `native.FileChooser` 的 `openFile({title, multiple,
directory, filters})` / `saveFile({title, name, filters})`, filter 是 `{name, globs, mimes}` (页面的 `types` / `accept` 换来的), 回路径列表 / 路径
或 null (取消). 选中的文件只给这个页面读写 (`pagecalls.ts` 记着). 没有 `FileChooser` 时打一行 warn, 页面得到 `AbortError` / `cancel`.
- 会话: runtime `portal.rs` 的 napi `FileChooser` (portal 的 `OpenFile` / `SaveFile`).
- 宿主窗口: src/host `hostnative.rs` 换上自己的 `FileChooser`, 在 `acde-chooser` 线程上走 `chooser.rs`: 先取 `choose` 的答复; Linux 有窗口时
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
- **文件的类型** (`MimeTypes.of`, 按名字的部分在 `mimedb.ts` `FileTypes`): 用各平台自己登记的类型, 运行时不带扩展名表, 也不用 mime-db
  这类面向浏览器的库 (决定, 2026-11-10). 系统不知道的类型就是未知 (`''`), 不猜, 由用户选应用.
  - Windows (有 `sys.contentType`): 按最后一个扩展名 (小写, `a.tar.gz` 是 `.gz`) 取系统登记的 `Content Type` (`HKEY_CLASSES_ROOT\.<ext>`,
    hostwin `system/assoc.rs` 用 `AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_CONTENTTYPE)`, 原生调用, 不起子进程), 原样用它:
    `.csv` 可能是 `application/vnd.ms-excel`, `.zip` 是 `application/x-zip-compressed`; `.md` `.py` `.rs` `.yaml` 一般没有, 就是未知.
    不问 gio、`file`, 也不读 shared-mime-info.
  - Linux / macOS: 先问 `gio info` (Linux). 它给不出 MIME 时 (macOS 的 gio 回 UTI, 或没有 gio) 按 shared-mime-info 的
    `mime/globs2` 匹配文件名 (`mimedb.ts`; XDG 数据目录, macOS 另加 Homebrew / MacPorts 的 `share/mime`; 每个进程读一次; `__NOGLOBS__` 照规范):
    完整文件名先于通配, 再比权重、模式长度、区分大小写的优先. 打平时用 `file --mime-type`: 它是候选之一就用它, 否则挑和它一样是不是文本
    (`text/*` 或经 `subclasses` 到 `text/plain`) 的那个, 和 gio 用 magic 消歧义一样. 一个也没匹配上用 `file`, 再不行是
    `application/octet-stream`. 这样 macOS 的宿主窗口和 Dopame OS 得到同样的类型 (`.md` 是 `text/markdown`, 不是 `file` 说的 `text/plain`).
    数据库不进包 (shared-mime-info 是 GPL), 没有时打一行 warn (macOS 提示 `brew install shared-mime-info`), 类型只来自 `file`.
  - 测试 `acde-host/test/mimedb.test.ts` (注入的注册表读取, 不碰真的注册表).
- **这个平台上跑不了的应用不选** (Broker `#runsHere`): 宿主窗口里没有 slots (嵌原生窗口只在 Linux 会话里), 要 `slots` 的应用 (如
  Dopame 的浏览器) 不当默认应用、不进 `handlers`, 页面的外部链接也不交给它 (打一行 warn, 不开只会报错的空窗口). 它们也不在
  `acde.apps.list()` 和 `appschanged` 里 (Dock、搜索、设置看不到); `launch` / `acde.open(<id>)` 和指定 `app` 的 `openPath` 回
  `{status: 404, code: 'unsupported_app'}` (页面的 `navigator.platform` 总是 Linux, 看不出宿主和有没有 slots, 所以靠这个 code). Linux 会话不变.
- **Windows 的打开方式** (宿主 `Shell.fileHandlers` / `Shell.openWith`, hostwin `system/assoc.rs`; Opener 经 `FileAssociations`): Windows 上不读 `.desktop`,
  原生程序是系统给这个扩展名登记的处理程序 (`SHAssocEnumHandlers(ASSOC_FILTER_RECOMMENDED)`, 即资源管理器「打开方式」里的那些), 每项 `{id: IAssocHandler::GetName
  (程序全路径或打包应用的 id), label: GetUIName, icon: data:image/png (GetIconLocation, 可执行文件里的图标经 SHDefExtractIconW 画成 32 px,
  打包应用的 `@{…}` 经 SHLoadIndirectString 取 logo 的 PNG), default}`; 系统默认 (名字等于 `ASSOCSTR_EXECUTABLE` 或 `ASSOCSTR_APPID`) 在 `handlers()` 里标
  `system: true`, 只读不写 (不调 `MakeDefault`). `handlers(路径)` 回 `{mime, association, handlers}`: acde 应用照旧按清单 `mimeTypes` 匹配, 类型未知时
  列出所有声明了文件类型的 acde 应用 (只收 `inode/directory` 的除外) 和这个扩展名的原生程序; `association` 是记住选择用的键, Windows 上是扩展名
  (小写 `.md`), 没有扩展名时是类型. 用户的选择由运行时记: `setDefault('.md', 应用 id 或程序 id)` 写 `$XDG_CONFIG_HOME/acde-extensions.list`
  (格式同 mimeapps.list, 键是扩展名), 原生程序只能按扩展名记且必须是登记过的; 选 acde 应用时按扩展名或 MIME 都行. 选应用的顺序: 扩展名的选择 →
  MIME 的选择 → 清单 `mimeTypes` 的第一个 → 交给系统默认 (下一条) → `no_app` (由桌面弹自己的打开方式). 用原生程序打开: 先过 `Finder.admit`
  (同下), Rust 再做和交给系统同样的路径检查 (绝对、非设备路径、无 `..`、非命名流、普通文件), 但不限扩展名 (用户为这个文件选的这个程序),
  重新枚举确认它是这个扩展名登记的处理程序, 经 `IAssocHandler::Invoke` (文件的 `IDataObject` 来自 `IShellItem::BindToHandler(BHID_DataObject)`)
  在 `acde-open` 线程上打开 (先 `CoInitializeEx`). `openPath({app: 程序 id})` 点名原生程序只给桌面 (和 `acdert open`) 以及点名了公共位置的系统应用 (能 `locate` 的那些, `OpenCaller.paths`, #115;
  文件仍要在它的根里), 别的应用点名回 403 `refused`;
  记住的选择对所有调用方都生效. headless 照样检查, 只打一行 info 不打开. 测试 `acde-host/test/open/windows.test.ts` (注入的关联读取).
- **macOS / Windows 的宿主窗口交给系统默认程序** (没有 XDG 的 `.desktop`, `natives()` 是空的): 没有记住的选择、没有能用的 acde 应用、也没有指定 `app`
  时, `Opener.open` 经宿主 `Shell.openDefault(目标)` (只在这两处注入; hostwin `system/handoff.rs`, 在 `acde-open` 线程上做, promise 落定)
  交给系统: Windows `ShellExecuteW` (动词 `open`, 线程上先 `CoInitializeEx`), macOS `/usr/bin/open <目标>` (不经 shell). 回
  `{kind: 'native', id: 'system'}`. 只有两种目标:
  - http / https 链接: `Opener` 先用 `URL` 规范成 `href`; Rust 再要求小于 8 KiB、只有可见 ASCII、没有 `"` `\` `<` `>` `` ` `` 和空白、有主机
    (挡掉往浏览器命令行里塞参数). 别的 scheme (`file:`、`javascript:`、`ms-settings:`、`mailto:` …) 不交.
  - 文件: 不是文件夹、不是 `select`, 先过 napi `Finder.admit(path, roots, owner)` (runtime `fs/access/admit.rs`): 把路径和调用方能用的根都按真实路径
    解析 (`canonicalize`, 跟随联接和链接) 后, 文件必须落在其中一个根里, 交给系统的是解析后的路径 (去掉 `\\?\`); 不在的回 `outside_roots`.
    调用方能用的根: 桌面、`acdert open` 和系统总线 (`openFromBus`) 是全部 Finder 根; 应用是清单 `fs` 的 roots (`fs: true` 是全部 Finder 根,
    没有 `fs` 是空的) 加上授予它的文件夹, 和它的 `acde:fs` 一样 (每次重读授权文件); 第 1 级的应用是私有文件夹、批准了的点名位置 (`OpenCaller.places`,
    Broker 按当前的批准滤过) 和选的文件夹 (napi `Finder.admit` 第 4 个参数, runtime `Workspace::admit_with`), 交来的文件所在的文件夹也算 (#110).
    所以根里的联接指向根外时也被拒绝.
    Rust 再要求绝对路径、不是设备 / 逐字路径
    (`\\?\`、`\\.\`)、不带 `..`、Windows 上不是命名流 (组件里有 `:`)、`symlink_metadata` 是普通文件 (链接不交), 扩展名在
    `handoff.rs` `EXTENSIONS` 里 (PDF、图片、音视频、纯文本 / Markdown / CSV / JSON、新版 Office (`.docx` `.xlsx` `.pptx`) 和 OpenDocument).
    可执行文件、脚本、快捷方式 (`.exe` `.bat` `.ps1` `.js` `.lnk` `.url` `.hta` `.docm` …) 一律不交. 也不交 (决定, 2026-11-10): 旧版 Office
    (`.doc` `.xls` `.ppt`, 能带宏)、`.html` `.htm` `.svg` (在浏览器里跑本地脚本)、`.rtf` (能嵌 OLE 对象). 选的是收窄类型, 不是给下载补
    Mark of the Web: acde 的下载和应用自己写的文件都没有 `Zone.Identifier`, 交给 Office 时不进受保护视图, 收窄对所有来源都成立.
    Windows 不关区域检查 (文件本来带的 Mark of the Web 照旧提示).
  - Rust 拒绝 (`code: 'refused'`) 或系统打不开 (`failed`) 都回 `no_app`, 文字带原因. 系统找不到默认程序时 Windows 弹它自己的「打开方式」.
  - 安全边界: 只有 `Opener.open` 这条路 (桌面、有 `openFiles` 的应用、`acdert open`), 靠能力、调用方的根和上面的过滤限范围.
    **不要求用户手势**: acde-dom 还没有用户激活 (user activation) 模型, 有 `openFiles` 的应用不经点击也能交出去; acde-dom 有了激活模型后,
    应用发起的交出要求一次有效的激活 (桌面和 `acdert open` 不要求). 页面自己的导航 (`<a>`、`location`、`window.open` 到 http(s)) 是页面可控的,
    不交给系统. headless (`ACDE_HEADLESS`) 照样检查, 只打一行 info 不打开. Linux (会话和宿主窗口) 不注入, 行为不变.
- **交给应用**: 应用收 `request` (和 `acde.open` 同一个事件), 窗口提前 (桌面收 `windowshow`); 请求带 `handle` (见「文件」的「拖放和打开请求的句柄」),
  按路径的根的拿 `{root, path, file}` (`fs.locate`), 能看路径的拿 `{url}`, 第 1 级的第三方应用只有 `handle`. 不在任何根里的文件交给原生程序 (`gio launch`), 没有就报 `outside_roots` (宿主窗口也不交给系统).
- **改默认**: `acde.setDefault(mime, 应用)` 写 `$XDG_CONFIG_HOME/acde-mimeapps.list` (只在 `XDG_CURRENT_DESKTOP=acde` 下生效; Windows 见上,
  扩展名的选择写 `acde-extensions.list`). `acde.handlers(路径)` 列能打开它的应用, `association` 是给 `setDefault` 的键.
- `acdert applications <目录> [--package <包目录>]` 给有 `mimeTypes` 的应用写 `acde-<app>.desktop` (`Exec=acdert open --app <app> %U`,
  `NoDisplay`, `OnlyShowIn=acde;`) 和 `acde-mimeapps.list`.
- 总线名字只在自己的会话里拿 (`ACDE_BUS_NAMES=1/0` 强制), 允许被替换; 不装 D-Bus activation 文件.

## 看和操作桌面 (`acde:inspect`)

给 agent 用: 不截图, 把屏幕变成文字的语义树, 按 ref 点击、输入、按键. 只有桌面 (`acde.inspect`) 和桌面包的服务 (`ServiceContext.inspect`) 拿得到.

- **网页的树** (render `Dom::semantics(root, limit)`, `dom/semantics.rs`): 节点 `{id, role, name?, value?, states?, level?, rect, children?}`, id 是
  render 的节点 id, 所以 ref 跟着 DOM 节点走: 节点活着 (连在文档上, 或断开了但页面还拿着) 就不变, 移动、改文字、改属性、列表重排都不变,
  不按遍历顺序编号; 重绘时换成了新节点 (`innerHTML`、不带 key 的列表重建) 才是新 ref (节点 id 不复用), 旧 ref 回 `element N is gone`.
  测试 `src/render/tests/semantics.rs`. 角色按 `role` 属性 / 标签 (HTML-AAM: 有名字的 `<section>` 是 `region`, `<output>` 是 `status`), 都没有但 `cursor: pointer` 的是 `clickable`; 名字按 aria / label (可被 label 的元素: input、select、textarea、button、meter、output、progress, `<label for>` 或外面套的 `<label>`, 先于子元素文字) / alt / 文字, 最多
  120 字 (同一元素里相邻的文字节点按原文接起来, 只在原文边界有空白时隔一个空格: JSX 的 `{n}%` 是 `100%`); 剪掉不可见的子树 (`display: none`、`aria-hidden="true"`、`inert`、`opacity: 0`、`visibility` 不是 `visible`、滚到可见范围外的),
  没有角色名字状态的展开; 每个父节点最多 60 个子节点, 全树最多 limit (默认 600). `semantics(root, limit, offscreen, invisible)`: `invisible`
  时留下透明和 `visibility: hidden` 的元素, 自己或祖先 `opacity: 0` 的标 `transparent`, `visibility` 不可见的标 `invisible` (透明的照样能点,
  不可见的点不到); `display: none`、`aria-hidden`、`inert` 照样剪. `<select>`: 下拉框是
  `combobox` (值是选中项的文字, `collapsed` / `expanded`, 打开时子节点是列表里看得见的 `option`, rect 是列表里那一行), 列表框是 `listbox`
  (子节点是看得见的行).
- **web 侧** (`pageinspect.ts`): `tree(root, limit, offscreen, invisible)` (`offscreen` 时不剪掉滚到可见范围外的子树, `invisible` 时留下透明和
  `visibility: hidden` 的, 见上)、`query(selector, within,
  limit)` (`querySelectorAll`, 每个元素再用 `semantics(id, 1, true)` 取它自己的角色名字状态, 没有语义的给 `generic` 和 aria-label / title / 文字,
  加 `tag` 和 `visible`: 有大小、不是 hidden / display:none / 透明)、`point(id)` (元素可点的一点: 先 `scrollIntoView`, 在中心和四个四分点上 `hitTest`, 全被挡时报挡住的
  元素; 元素已经不在文档里 (被移除, 或节点已释放) 时各个调用都回 `element N is gone`, 没有盒子或 `visibility` 不是 visible 的回 `the element is not displayed`, 不拿旧位置去 `hitTest` (那样报出来的是「被别的元素挡住」); 打开的下拉列表里的 option 用 `pickerOptionRect` 那一行的中心)、`type(id, text, replace)` (走输入法提交那条路 `Host.insertText`)、`select(id, values)` (元素自己、祖先或里面的 `<select>`; 按 value
  再按文字找选项, 禁用的回错, 单选给多个回错; 设好后发 `input` 和 `change`)、`focus(id)`, 坐标加 `contentOffset`.
- **Broker** (`inspect.ts`): 窗口 ref `w0` (桌面)、`w1` …, 元素 `w3.12`, 窗框上的菜单 `w3.m1` (第 1 个菜单) 和 `w3.m1.2` (它的第 2 项, 分隔线也占号):
  有窗框菜单的窗口, 树的最前面是 `menubar [w3.m]`, 下面每个菜单一个 `menuitem` (`expanded` / `collapsed`), 打开的那个下面列出它的项 (快捷键是 value,
  `disabled` / `checked` / `focused`). act 菜单 `click` / `hover` 是在菜单名中心发真的指针事件; act 一项时菜单没开就先点开 (别的菜单开着时移过去),
  等列表画出来再点那一行, 禁用的项不点. acde 的 driver 不用改: `getByRole('menuitem', { name })` 找到这些节点, 点它们走同一个 act. `snapshot({window?, ref?, all?, diff?, limit?, find?, tree?, offscreen?})` →
  `{text, windows, trees}`: 列出焦点窗口 (或指定的) 的树 (`all` 列全部没最小化的窗口, 并留下透明和 `visibility: hidden` 的元素).
  `text` 是固定的英文格式, 不随系统语言变 (页面给的名字和值原样): 窗口从上到下一行一个, `- window "Notes" [app=notes] [focused] [w1]`
  (桌面是 `- desktop`, 标记依次是 `app=`、`native`、`focused`、`minimized`、不是 `free` 的模式、窗口状态 `filled` / `fullscreen` (和模式相同时只写一次)), 列了树的窗口下面缩进两格一行一个节点
  `- button "Save" [pressed] [w1.52]` (角色是 ARIA 名, 状态见上), 后面跟括号里的说明 (`(empty)`、`(N more outside the visible area; …)`、
  `(too many elements, …)`); `find` 只给名字或值含这段文字的元素和祖先, 一个都没有时最后一行是 `(no element contains "…"…)`; `diff`
  只给变了的行 (`+` / `~` / `-` 后跟节点行, `(no changes)`), 变化超过六成整个重列 (`(many changes, listing everything)`), 窗口表没变时
  第一行是 `(windows unchanged)` 且只列有树的窗口. act / run / open / query 的文字和错误也是英文. `act(ref, action, arg)` → `{ok, text}`: 做完等页面安静
  (200 ms 没有 DOM 变化, 最多 3 秒; 原生窗口 0.4 秒), 窗口表或焦点变了先等新焦点窗口安静. `run(steps)` 依次做, 失败就停. 动作: click /
  double / right / hover / scroll 按 `point` 的屏幕坐标经 `Shell.inject` 发 (被盖住时先提前目标窗口; 桌面钉住的面板盖着的地方只算被更上层的钉住窗口挡住, #111); type / settext 走 web 的 `type`;
  key (`"ctrl+a backspace"`, acde-host `keys.ts` 的 `chordCodes`) 先 focus 再注入: 空格分开的每段先全部解析, 有认不出的就整串不发并报出这些段;
  可打印字符直接写 (`7 . 5 * 2`), 美式键盘上要 Shift 的符号 (`*`、`+`、`(` …) 和大写字母自动加 Shift, 也认 `plus` / `multiply` / `minus` 等名字, `ctrl++` 是 Ctrl 加 `+`; select (arg 是选项的值或文字, 多选给列表) 走 web 的 `select`; drag (arg 是目标 ref, 元素或窗口,
  可以在别的窗口) 在源上按下、量目标 (`point`, 可能滚动; 目标被别的窗口盖住时松开并回错)、分 10 步每步 16 ms 移过去再松开, 页面的指针拖动和
  HTML5 拖放 (也跨窗口) 都靠它. 窗口 ref 能 focus / restore / minimize / close / key. `open(name)` 按 id、名字找应用或原生程序起它. `query({selector, window?, ref?, limit?, attributes?})` →
  窗口 ref 还能 fill / fullscreen (`setState` 设成 `filled` / `fullscreen`), restore 把这两种设回 `normal`; 桌面和铺满宿主的窗口不行.
  `{window, count, nodes}`: 在窗口 (默认焦点窗口) 或某个元素下按 CSS 选择器找, 节点是 `InspectMatch` (`InspectNode` 加 `tag`、`visible`, 给了
  `attributes` (最多 20 个属性名) 再加 `attributes: {名字: 值或 null}`), ref
  能直接给 act (不在语义树里的元素也行: `point` 按 render 节点 id 找元素).
- **不在屏幕上的窗口** (`inspect.ts` 的 `Inspect.#offScreen`, 只有这一处): `windows` 里每个窗口的 `state` 是运行时的窗口状态 (宿主窗口的行自带;
  会话的行没有, 取 Broker 按 `windowstate` 记在窗口记录上的), `hidden` 为真表示它不在屏幕上: 被 `windows.hide()` 藏起, 或状态是 `minimized`
  (`act <窗口> minimize`、`requestState`、窗框按钮、页面的 `minimize()`). 宿主窗口里最小化不动隐藏标记, 以前 inspect 只看隐藏标记, 这样最小化的窗口
  没有 `[minimized]`, `all` / `find` 照列它的内容, 它还被算成盖着下面的窗口 (点桌面回 `covered there by …; minimize or close it first`).
  `[minimized]` 标记、`all` / `find` 跳过谁、默认列哪个窗口、点名它时的 `(minimized; act restore on it to see its elements)`、谁盖着谁 (`#cover`)
  都只看 `hidden`; `query` 照样在它的页面里找 (CSS 选择器不管显示与否), 但每个节点的 `visible` 为假. 指针动作 (click / double / right / hover / scroll, drag 的两端) 落在这样的窗口上回 `ok: false`
  `w1 is minimized; act restore on it first` (drag 的目标是 `cannot drop: w1 is minimized; …`, 在源上按下之前就查), 什么都不注入: 以前按它最小化前的位置点下去, 点到的是
  下面的窗口, 还回 `clicked …`. focus / type / settext / key 先给窗口焦点, 运行时给最小化的窗口焦点就是让它回到之前的状态. `restore` (和窗口的 `focus`)
  先取消隐藏再给焦点, 两条路离开屏幕的窗口都回来.
- **原生窗口** (runtime `atspi.rs`, napi `Accessibility`, Linux 会话): 读 AT-SPI2. 起服务时把 `org.a11y.Status.IsEnabled` 设成 true; GTK3 总上报,
  Qt 要开关为 true 且在真的显示平台上. `tree(pid, title, limit)` 按 pid 找应用、按标题挑顶层窗口, 角色规范成 ARIA 风格; act 先试 AT-SPI 的
  Action / EditableText / GrabFocus, 不行按坐标. 检查 `src/runtime/tests/atspi-check.sh`.

## 组件契约

改接口先改这里.

### render (`src/render`, Rust 接口)

- `Document::new(width, height, scale, &Options {base_url, resources: [Resource {prefix, dirs}], default_lang, verify_paint, svg_text_path,
  dark, name})`: 尺寸是物理像素. 同源资源按最长前缀在 dirs 里找, `file:` 直接读盘, 不联网, 读不到回空. `Document` 发句柄:
  `dom()` (JS 线程)、`handle()` (出帧方).
- 线程: 文档由 JS 线程和 `acde-render` 线程共用 (一把锁).
- DOM: `Dom` 实现 acde-dom 的 `DomNative` (契约 `web/packages/acde-dom/src/native.ts`, 同名 snake_case). 节点 id 是 u32 不复用, `<html>` 是 0;
  查询是 CSS 像素; 错误说明以 DOMException 名字开头. 改了文档还没 `Dom::commit` 时 render 不出帧, 期间的指针和滚动在 commit 时按顺序放回.
  连在文档上的节点一直活着, 断开的子树有 JS 包装 (pin) 才活; 包装对象连着时强引用, 断开变 WeakRef, 回收时 unpin (acde-dom `realm.ts`).
  `hit_test` 返回节点 id (坐标是视口的, 整页滚动过也对: blitz 的 `hit` 要页面坐标, `element_from_point` 加上视口的滚动); `metrics` 对根元素照 CSSOM View 给: `clientWidth` / `clientHeight` 是视口的大小 (不是内容的), `scrollWidth` / `scrollHeight` 不小于视口 (acde-dom 的 `scrollIntoView` 靠这个判断整页能不能滚); `caret_rect` / `caret_from_point` / `text_rects` (偏移是 UTF-16). `<select>`: `options` / `option_selected` /
  `set_option_selected` / `selected_index` / `set_selected_index` / `reset_select` / `list_box_option_at`; 选项列表 `open_picker` /
  `close_picker` / `picker_state` (`[select 或 -1, 高亮的选项序号或 -1, 一页几行]`) / `picker_option_at` (-2 在列表外, -1 在列表里但不是
  选项) / `picker_option_rect` / `set_picker_active`; 列表画在 `Frame.plane` 的最后. `Dom::highlight(id)` (`NONE` 去掉, DevTools 的高亮, #192,
  `engine/highlight.rs`): 每帧按当时的布局在整页 (含选项列表) 之上画这个元素的 margin / border / padding / content 四块 (CSS 像素的
  `getBoundingClientRect` 当 border 盒, 按 taffy 的 margin / border / padding 宽度外扩内缩, 颜色是 Chrome 的默认半透明配色), 所以滚动、
  缩放和布局变化都跟着走; 元素不在文档里、`display: none` 或不是元素时不画. 改了就标脏并叫醒出帧线程, 不需要 `Dom::commit`. `scroll_at` 落在打开的列表上时滚列表, 落在外面先关掉它.
- 出帧 (物理像素): `RenderHandle {tick(now_ms), frame(), scroll_at, pointer, commit, invalidate, set_waker}`. CSS 动画的时钟是单调墙上时间,
  tick 只对齐到 vblank. `Frame {plane, panels, size, animating, commit, trace}`: plane 是整页 (含画布背景, 不含面板); `panels` 是
  `Dom::set_panel` 钉住的元素 `Panel {id, size, plane, extent}`. `Plane {drawing, layers, damage, damage_rects (最多 8 块), bounds}`;
  layers 是有 backdrop-filter / filter 时切成的段, 每段 `{drawing, bounds, backdrop, filter}` (`Drawing` 出 `scene` / `scene_for`): backdrop 先处理画布上已画的那块再画这段, filter
  先画进临时纹理再合成. 光栅化方 (acgpu 的回退) 做 filter 的 drop-shadow、模糊、颜色矩阵, backdrop 的模糊和所有颜色函数 (`Backdrop::effect`:
  按顺序合成一个颜色矩阵, 几个 blur 按平方和开方合并); backdrop-filter 里的 drop-shadow 不做; 只切最外层: 已有 filter 的元素里面再有 filter / backdrop-filter 时不做 (#46);
  这两种同一组滤镜只记一次 warn (最多记 64 组).
  窗口之间的毛玻璃 (`setBackdrop`、面板的 `backdrops`) 仍只带 blur / saturate / brightness.
- 模糊 (acgpu `Composer`、shell `effects.rs`) 是降采样 / 升采样链, 几层、采样偏移多大由 acde-model `Blur::of(sigma)` 一处决定
  (也给出窗口之间毛玻璃的取样外扩 `margin`): 偏移在约 0.5–1.3 之间连续调 (一层时从 0 起, 五层时最多到 2), 强度随 sigma 连续变,
  近似同 sigma 的高斯 (`SPREAD` 是 DX12 上量出的每档方差, `tests/vello_compose.rs` 按相位平均量边缘的展宽对照); sigma 小于约
  0.96 px 时一层不偏移, 再按 `mix` 和原图混合. sigma 为 0 不模糊 (drop-shadow、backdrop 只拷一份). shell 的 GLES 链不做 `mix`.
- `Dom::capture(id, scale)`: 单独录一个元素 (拖动图标), 单边超过 2048 缩小; JS 拿 `picture` 编号 (`dom.rs`, 每个 web 留最后一个).
- canvas 2D (acde-dom `dom/canvas.ts` 编成命令流, `Dom::canvas`): 要像素的都在 GPU 上 (render `gpu.rs`, 用 `acdert::gpu::Gpu::publish` 登记的设备):
  超过 20000 条命令 (`ACDE_CANVAS_MAX_COMMANDS`) 画成纹理再接着记, canvas 当图片源是 `GpuImage`, `shadowBlur` 用 `blur.wgsl`,
  `getImageData` / `toDataURL` 同步读回. 提交都拿 `Gpu::submit_lock`. `drawImage` 一张 SVG 的 `<img>` 时按它的自然尺寸画成场景
  (blitz-paint `svg_picture`, 和 `<img>` 同一画法). `ctx.filter`: acde-dom 解析 `<filter-value-list>` (无效的值不改, 长度只认 px),
  命令 14 送效果 (blur、brightness、contrast、grayscale、hue-rotate、invert、opacity、saturate、sepia、drop-shadow; url() 不支持);
  有滤镜时每次绘制先把它的范围 (加上效果外扩, 裁到画布) 画进一张图, acgpu `Offscreen::filtered` 依次做 (`blur.wgsl` 的
  `blur_rgba` 全通道模糊、`matrix.wgsl` 颜色矩阵、drop-shadow 是 alpha 模糊再垫在下面), 再画回去; 阴影还按没滤过的形状算.
- `createImageBitmap` / `ImageBitmap` (acde-dom `dom/bitmap.ts`): 把 `<img>`、`Blob`、`ImageData`、canvas、`ImageBitmap` 画进一个不挂在文档上的
  2D 画布, 支持裁剪矩形、`resizeWidth` / `resizeHeight`、`imageOrientation: 'flipY'`、`premultiplyAlpha` (WebGL 上传时按它, 不看
  `UNPACK_FLIP_Y_WEBGL` / `UNPACK_PREMULTIPLY_ALPHA_WEBGL`); `<video>` 来源报 `NotSupportedError`. 2D `drawImage` 和 WebGPU 外部拷贝收它.
- 选项 `default_lang` (默认 zh-Hans)、`dark` (事后用 `set_dark` 改, 都只改
  viewport, 媒体查询和 `matchMedia` 跟着变). `semantics(root, limit, offscreen, invisible)`: offscreen 时不按可见范围剪, invisible 见「看和操作桌面」. `<iframe>` 不加载
  (`skip_iframe_content`), 只是空盒子. 增量录制见 vendor/blitz; `ACDE_PAINT_VERIFY=1` 每帧再整页录一次比对 (测试用). 图片缓存最多 256 张 /
  64 MB. 所有入口 `catch_unwind`.
- 窗框 (`decoration.rs`): `Decoration::scene(&Bar {title, width, height, scale, style, fullscreen})` → 物理像素的场景 (背景 #f4f2f7; `FrameStyle::Mac`:
  左边三个 12 px 圆点 (关闭 / 最小化 / 全屏), 标题居中截断; `FrameStyle::Windows`: 右边三个 46 px 宽的按钮 (最小化 / 最大化 / 关闭, 1 px 线画的图标,
  `fullscreen` 时最大化换成还原), 标题靠左截断; 没有悬停效果). `FrameStyle::current()`: `ACDE_FRAME_STYLE` (`mac` / `windows`), 没设或别的值时
  Windows 上的单应用是 `Windows`, 别处是 `Mac` (宿主窗口给出完整桌面时 `FrameStyle::follow_session`, 跟 Linux 会话一样). `Bar::button_at(x, y)` 是按钮命中, `FrameStyle::grab_hints` 是标题栏 (按钮区外) 和四边四角的 hint. 测试 `tests/decoration.rs`.
  `Bar.theme` (`FrameTheme`: `active` / `inactive` 两组 `FrameColors {background, title, line, buttons}`, RGBA, 没给的用默认; 失焦的组没给的项用
  有焦点的; `style` / `side` (`ButtonSide`) / `align` (`TitleAlign`) 没给时按 `Bar.style`: `Mac` 是左边、居中, `Windows` 是右边、靠左) 和
  `Bar.active` 只改样子; 按钮放在哪一边时命中和 `FrameTheme::grab_hints` 跟着换边. `buttons` 给圆点上色 (不给是红黄绿), 给图标上色 (不给是标题色).

### shell (`crates/shell`, napi 类 `Shell`)

完整的 Wayland 合成器 (smithay), 自己的线程 (calloop). 上机 DRM/KMS + libinput, 无显示器用 RDP 后端 (`ACDE_BACKEND=rdp`).

- 协议: xdg-shell / xdg-dialog / xdg-decoration (回 client-side)、`acde_window`、linux-dmabuf v4、wl_drm、syncobj、presentation、fifo /
  commit-timing、viewporter、fractional-scale、pointer-constraints / relative-pointer / gestures、data-device、xdg-activation、cursor-shape、
  wlr-layer-shell、ext-session-lock、idle、text-input-v3 + input-method-v2 + virtual-keyboard、keyboard-shortcuts-inhibit、xdg-output.
  第三方的 popup 和 layer-shell surface 在表里是 `pinned`. maximize 不理.
- Broker 侧: `Shell.broker()`; `onEvents(cb)` / `pump()`; `grant({desktop?, window?, mode?, rect?, size?, parent?, modal?})` → `{window, token}` (随机 64 位令牌,
  客户端在 `acde_window.bind` 里交回一次; `parent` / `modal` 在窗口绑上时写进窗口表, 客户端自己的 xdg parent 优先); `release`、`place`、`windows()`、`animate`、`shortcut` / `unshortcut`
  (冲突抛错)、`focus`、`hide`、`close`、`quit` (等合成器线程拆完, 最多 3 秒)、`socketName`、`launch(argv, {cwd, env})`、`stats(reset?)`、
  `screenshot(path)`、`inject(...)`.
- web 侧: `claimSurface(token, {frame?})` (src/host `webnative.rs` → crates/window `Surface::claim`: 连上合成器、开 toplevel、bind 令牌;
  一条 `acde-window` 线程管 Wayland 和光栅化) 给出 surface: `pump`、`wait()` (队列非空时落定)、`waitThen(cb)` (队列非空时在一个新任务里调 cb, 不在微任务里: acde-host `Host.run` 每轮取一批输入就是一个任务, 输入事件经 acde-dom `Input` 用 `fireFromTask` 派发, 每个监听器后跑微任务检查点, React 的离散事件在下一个按键前就提交; 原先循环 `await wait()` 之后都在微任务里, 检查点不生效, 连按三次只算一次)、`requestFrame`、`setClipboard`、
  `readClipboard()`、`startDrag(data, icon?)`、`setTitle`、`setImeArea`、`window`、`hosted`、`contentOffset`.
- 事件 (`Event`, 坐标逻辑像素, button / code 是 evdev 码). 给 surface 的: `pointermove` / `pointerdown` / `pointerup` / `wheel` /
  `pointerleave`、`keydown` / `keyup {code, key}`、`imepreedit` / `imecommit` (宿主窗口)、`activate` / `deactivate`、`framebutton {key}`、
  `frame {time}`、`resize {width, height, scale}` (页面的物理像素, 已减去窗框)、`dndenter` / `dndmove` / `dndleave` / `dnddrop {x, y, data}`
  (data 是类型 → 文本, 松手时已读好)、`dragend {button}` (1: 放到了别的窗口上)、`grab` / `grablost`. 给 Broker 的: `output`、`windowopen` /
  `windowclose` / `windowtitle` (原生窗口)、`windowstate {window, state, previous}`、`windowactivate`、`windowanimated`、
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
- **网页优先在 GPU 上画, 没有 GPU 时回退 CPU** (用户定 2026-11-13): 没有 vello_cpu; `acdert::gpu::adapters` 真 GPU 排前, CPU 类型的设备 (lavapipe)
  排最后, 只有它时用它 (虚拟机 / VNC, 慢). 什么设备都没有时网页图层不可用 (日志 `web layer unavailable`), 页面不出帧.
  合成器自己 (GLES) 不在此列.
- **用 acgpu 的类型和回退, 不带专用驱动** (用户定 2026-11-14): 依赖 acgpu 不开 `compiler` (没有 MLIR / 驱动), 只开 `fallback-vulkan`, 即只经标准图形接口
  (wgpu), 每个 OS 只编一个后端: Windows DX12、Linux Vulkan、macOS Metal (`acdert::gpu::BACKEND`). 2D 场景 (`PaintScene` / `Scene` / `RenderCommand` /
  `Filter`, blitz-paint 和 render 直接画进它) 和渲染器 (`Vello` / `Raster` / `Composer` / `Device` / `Offscreen` / `GpuImage`, Linux 上 dma-buf 画布导入和
  sync_file) 都是 acgpu 的; src/gpu 的 `Gpu` (设备登记, 唯一一份) 包着 acgpu 的 `Shared`; Xe3 驱动只在 acdebin-system 的 paint 里用 (`PageRaster`); crates/paint
  只剩线程、GBM 画布、损伤和区域、把帧拆成 `Part` (`plane.rs`).
- Windows DX12 的着色器编译器是静态链接的 DXC (wgpu `static-dxc`, mach-dxcompiler 的预编译库): 不用 FXC (FXC 编的 vello 着色器约 10 秒后
  `DXGI_ERROR_DEVICE_REMOVED`), 不用 dxcompiler.dll.
- 原生应用经 linux-dmabuf v4 零拷贝, 全屏且格式合适时直扫; pre-commit 钩子等 syncobj acquire point 或 dmabuf 的读 fence. 缺口: presentation
  不是硬件时间戳, 没有 tearing-control 和 VRR.
- 网页图层 (会话): vello 画进 web 自己 GBM 分配的 linear dmabuf, sync_file 落定后 commit. 光栅化线程 `acde-web` 一次一帧, CPU 编码和 GPU 执行
  重叠, 挪窗口不重新光栅化, 闲 2 秒放掉中间纹理. 两套 vello 着色器都在会话开始时编好 (#109): 光栅化线程自己的 (`vello warm-up`) 和
  页面画布、阴影、截图用的进程级 `Offscreen` (src/render `gpu.rs`, 进程里第一个光栅化线程起来时 (`Once`, 进程里可能有多个 `Raster`) 在 `acde-warm` 线程里 `gpu::warm()`, 日志 `offscreen vello warm-up`),
  不再等第一个用到画布或阴影的窗口打开时才编, 编的时候还拿着全进程一把 `Offscreen` 锁. 宿主窗口 (Windows、macOS、Linux 宿主) 同样在
  `hostwin/src/app.rs` 的 `run` 里 `Gpu::publish` 之后起 `acde-warm` 线程预编这套 `Offscreen` 着色器.
- 帧预算: 120 fps 下每帧 8 ms. 盯 acde-dom `test/cost.test.ts` / `test/caches.test.ts`、shell / DomNative 的 `stats`、`drive.sh perf`; 提交里写测到的数.
- WebGPU (`navigator.gpu`, 只在 Linux): src/host `webgpu/`, 跑在光栅化线程的设备上; 回调由 `acde-gpu-poll` 线程非阻塞轮询 (每帧路径上不用
  `poll(Wait)`, 它拿着 snatch 读锁会卡住别的线程的提交). WebGL 也只经 wgpu, 见下一节.

### WebGL (`src/webgl` `acde-webgl`, acdert `webgl.rs`, acde-dom `webgl/`)

WebGL 1 和 2 在每个 OS 上都有 (Windows 没验过), 是 wgpu 上的一台 GL 状态机, 用 `Gpu::shared()` 那台设备 (和画布、页面共用), 不用 ANGLE、不用系统 OpenGL.

- **分层**: acde-dom `webgl/index.ts` 是标准的 `WebGLRenderingContext` / `WebGL2RenderingContext` 和 WebGL 对象 (`WebGLBuffer` …), 只管参数换算、
  对象包装和扩展对象; 状态、校验和 GL 错误都在 acde-webgl 的 `Context` (Rust, 不依赖 V8, 能单测); acdert `webgl.rs` 把它绑成 `natives.webgl`
  (每个 canvas 一个 `Context`, 调用的第一个参数是上下文编号). `getError` 同步, 所以每个调用自己校验; 会失败的 wgpu 调用 (建纹理 / 渲染缓冲 /
  绘制缓冲 / 管线 / 绑定组、提交) 都在错误范围 (`Context::scoped`) 里, 失败时报 GL 错误 (`OUT_OF_MEMORY` / `INVALID_OPERATION`) 并记日志.
- **着色器**: GLSL ES 1.00 / 3.00 经 `src/glsl` 的 WebGL 方言 (`Frontend::parse_webgl`, 见「vendor」一节末尾) 变成 naga IR, 直接交给 wgpu
  (`ShaderSource::Naga`). `compileShader` 只解析校验, `linkProgram` 按两个着色器重新解析一遍: attribute 位置 (`bindAttribLocation` / layout / 依次)、
  varying 按名字配位置、不活跃的 attribute 和对面没有的 varying 降成普通全局. 活跃与否 (`getActiveUniform` 等) 按 `live.rs` 从语句往回追的表达式算.
  每个阶段的散 uniform 是一个 uniform 块 (第 0 组, 顶点 0、片元 1, 动态偏移; std140, 但 matCx2 按 WGSL 的自然布局, bool 存成 uint);
  采样器拆成纹理和采样器两个全局 (第 1 组), uniform 块也在第 1 组. 拿常量下标的采样器数组可以, 循环下标不行 (编译错误).
- **坐标**: 顶点着色器出口把 y 取反、z 从 [-w, w] 换到 [0, w], 所以纹理和帧缓冲里第 0 行是 GL 的最下面一行: 视口、剪裁、`gl_FragCoord`、
  `readPixels`、拷贝都和 GL 一样, 正反面反过来 (GL 的 CCW 是 wgpu 的 `Cw`), 只有把绘制缓冲交给页面时翻一次 (`read.rs` `present`).
- **录制**: 绘制攒进渲染通道 (`pass.rs`), 目标、需要排序的上传 (缓冲 / 纹理在本次提交里已经被用过时走编码器拷贝, 否则 `queue.write_*`)、
  读回、换帧时结束. 散 uniform、常量 attribute、生成的索引放在每个通道一块数据缓冲里. 管线按 (程序、绑定、顶点格式、图元、混合 / 深度 /
  模板 / 剪裁状态、目标格式) 缓存, 绑定组按资源身份缓存. 清屏能用加载操作就用 (整幅、掩码全开), 否则画一个全屏三角形.
- **wgpu 没有的**: TRIANGLE_FAN / LINE_LOOP 和 8 位索引在 CPU 上展开 (ELEMENT_ARRAY 缓冲留一份 CPU 副本, 也用来算索引范围); 非归一化整数当
  float、3 个分量的 8 / 16 位、打包的 2_10_10_10、divisor > 1 的顶点数据由计算着色器 (`helpers.rs` `CONVERT`) 转成 32 位四分量; 不对齐的
  `bufferSubData` 用按字节拷贝的计算着色器; GL 缓冲在 wgpu 那边多留 256 字节尾巴 (Metal 按整个步长检查最后一个顶点). RGB / LUMINANCE / ALPHA
  和 565 / 4444 / 5551 存成 RGBA8, 上传时在 CPU 上展开. 写 `gl_PointSize` 的程序另链一份点变体: 非索引、非实例的 `POINTS` 每点画一个
  实例 (6 个顶点), 属性按实例步进 (`ALIASED_POINT_SIZE_RANGE` [1, 1024]). 多重采样的深度经 `blitFramebuffer` 由 frag_depth 解析 (模板不解析).
- **画布**: 默认帧缓冲是 RGBA8 (`antialias` 时 4 倍多重采样), `alpha: false` 时不写 alpha. 绘制缓冲在渲染那一步 (`frame`, 2D 画布刷新之前)
  交成 canvas 的 `GpuImage` (`Dom::canvas_image`), `preserveDrawingBuffer: false` 时下一次绘制先清; 2D `drawImage` 一个 WebGL canvas 前先交.
  `toDataURL` / `toBlob` / WebGPU 外部拷贝读交出去的图. 纹理来源: `ImageData`、`<img>` (位图按 CPU 字节、SVG 在 GPU 上画)、2D canvas、
  `<video>` 的帧、WebGL / WebGPU canvas、`ImageBitmap` (render `Dom::image_pixels`), GPU 上的来源经 blit 着色器翻转 / 预乘写进去.
- **查询和同步**: 遮挡查询每个绘制一个查询位, 提交后映射回读; fence 等 `on_submitted_work_done`. 两者都要在结束它们的任务之后才可用 (acde-dom 按任务计数).
- **还没有**: transform feedback (`beginTransformFeedback` 报 `INVALID_OPERATION`)、`PIXEL_PACK_BUFFER` / `PIXEL_UNPACK_BUFFER` 上传和读回、
  `EXT_disjoint_timer_query`、带数据上传到 depth24 / depth32f (只有 depth16 能写)、copyTexImage 到 LUMINANCE / ALPHA 不换算、模板的 blit 解析、
  索引或实例化的宽点 (一个像素)、uniform 里的 bool 数组和含 bool 的结构、std140 块里的 matCx2、着色器校验比 ANGLE 宽松 (隐式转换照
  GLSL 4.x), origin-clean (跨源图片能读出来, 和 2D canvas 一样还没有), 上下文丢失后不恢复 (`restoreContext` 什么也不做).
- **检查**: `cargo test --release -p acde-webgl` (着色器翻译、渲染、uniform、查询、多重采样、宽点); `ACDE_WEBGL_SHADERS=<目录>` 时再把目录里
  `name_NNN.vert` / `name_NNN+1.frag` 一对对链接并生成 MSL / SPIR-V / HLSL (three.js 0.187 的 36 个程序是从 Chrome 里拦 `shaderSource` 得到的).
  2026-11-12 three.js (标准 / 物理 / Phong / Lambert / Toon / Matcap / 法线 / 深度材质、三种阴影、实例化、变形、蒙皮、点、线、精灵、
  EffectComposer + UnrealBloomPass + 4 倍多重采样的半浮点目标、PNG / SVG / 2D canvas 纹理) 和 pixi 8.23 在 macOS (Metal) 和 .234 (Vulkan)
  上逐个物体和 Chrome 对比一致.

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
D3D12 调试层 (要装「图形工具」可选功能). 没有: 通知、WebGPU、network / office / 语音. 依赖里不要 winapi
(fslock、async-dnssd 现在是 crates.io 原版, 经 v8 / sspi 会带进 winapi).

编好 acdert 和网页宿主后, 在有 GPU 的机器上用 `bash scripts/check-standalone.sh` 验证独立应用启动、重载、退出和服务清理.
脚本以无窗口模式运行, 测试包和日志写到 `logs/standalone.*`.

Windows 上用 `bash scripts/check-backends.sh` 验收应用后端 (见「Windows 后端契约」). 测试包 (`scripts/backends/`) 有 Node、Bun 两个带后端的应用和一个旧预加载的;
预加载从并排检出的 acde (`../acde/src/listen.ts`, 或设 `ACDE_SRC` / 直接给成品 `ACDE_LISTEN`) 现场打包. 每个后端: 页面跑 GET、带体 POST、分块、8 个并发、
2 MiB 双向、WebSocket 文本和二进制 (Bun 另有 1 MiB 消息和发布订阅); acdert、后端和后端的子进程没有 TCP 监听、UDP 端点、名字带它们 pid 的新命名管道;
Bun 的本代目录在默认 base 下, DACL 读回只有 SYSTEM 和当前用户, 启动时扫掉了预先放的残留目录; 杀后端后重起、子进程一起没了、旧目录删了、场景再跑一遍
(WebSocket 重连); 经 Broker 停止 3 秒内 (SHUTDOWN) 结束、子进程和目录没了; 关窗后 acdert 退 0, 进程和本代目录都不在. 旧预加载的 node 不起, 打 warn.
不设 `XDG_RUNTIME_DIR` (环境里有就沿用). 结果写到 `logs/backends.*/report.json`. 第二个本地账户打不开套接字目录这一项要手工验证, 脚本不做.

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
acdert --version                          # 发行版本和契约级别: acdert 0.0.5 (contract level 1)
acdert --help                             # 用法 (main.rs 直接回, 不起 V8); 不认的选项: 一行原因加一行用法到 stderr, 退出 2
acdert doctor [--json]                    # 自检: 宿主文件、GPU (真画一帧)、Linux 的显示; 有错误退出 1 (见下)
acdert sessions DIR --package PKG         # 给包的每个桌面写 acdert-<id>.desktop
acdert applications DIR --package PKG     # 「默认应用」的 desktop entry 和 acde-mimeapps.list
acdert open [--app ID] PATH|URI...        # 在运行中的会话里打开
acdert run FILE [ARGS...]                 # 在一个 isolate 里跑一个模块 (runtime 的 tests/ 用)
acdert --size 1920x1080 --scale 1         # shell 报输出之前的 CSS 尺寸
acdert --launch foot --seconds 10 --stats # 起一个程序; 10 秒后停; 打印 stats 和窗口表
```

**`acdert doctor`** (`doctor.rs`, main.rs 直接分派, 不起 V8 也不起 Broker): 查这台机器上 `acdert app` / `acdert desktop` 起得来要的东西,
给 `acde doctor` 用 (acde 看 `acdert --help` 里有没有 `acdert doctor` 判断支不支持, 不按版本号). 每项 `ok` / `warn` / `error`, 可带一条 `fix`:
- `host` (宿主文件): `web::app_dir()` (和起 Broker 同一个函数) 里有没有 `broker.js` 和 `web.js`; 缺了是错误, fix 按设没设 `ACDE_APP` 分两种.
- `gpu`: 和宿主窗口同一条路打开设备 (`acdert::gpu::Gpu::open`, 不认 CPU 适配器, 找不到时的原因和提示就是 `no_adapter` 那句), 再用 `Offscreen` 经 vello
  画一张 16x16 的纯色图、回读中心像素和画的颜色比 (每通道差 ≤ 2). 所以着色器编译 (Metal / DXC / Vulkan)、提交、回读都走过一遍. 在 `acde-doctor`
  线程上做, 30 s 没结果算错误 (驱动挂住时不卡死), 回读是 doctor 自己要的像素, 不在 GPU 硬约束的禁止之列.
- `display` (只在 Linux): 和 `session()` 同一个判断 (`main.rs` 的 `outer()`: `WAYLAND_DISPLAY` / `DISPLAY` / `ACDE_HEADLESS`); 都没有时是警告:
  这时 `acdert app` / `desktop` 不开宿主窗口, 而是去试着起 DRM 会话 (按 `session()` 的分支读出来的, 没在共用的机器上实测抢屏), fix 是 `acde dev --headless` 或在图形会话里跑.
不查的: 视频解码器 (只影响 `<video>`, 不影响起得来)、存储目录 (位置由 JS 的 `places.ts` 定, Rust 这边重算一份会分叉)、缺动态库 (那时 acdert 自己就起不来,
由 acde 从 stderr 读出原因). 输出: 第一行 `acdert <版本> (contract level N): <exe>`, 每项一行 `<状态> <标题>: <内容>`, 有 fix 时下一行 `fix: …`;
`--json` 是一个对象 `{acdert, level, platform, exe, checks: [{id, title, status, summary, fix}]}` (`fix` 可为 null), stdout 上只有它.
有 `error` 退出 1, 否则 0; 不认的参数一行原因加用法, 退出 2.

环境变量: `ACDE_PATH`、`ACDE_DESKTOP`、`ACDE_STORAGE` (网页存储的根目录, 默认 `$XDG_DATA_HOME/acde/storage`, 空: 只在
内存, 见「网页存储」)、`ACDE_AUTOSTART=1/0`、`ACDE_DEBUG_DIR`、`ACDE_DEBUG` (启动失败时 stderr 打整个调用栈; 不设、空或 `0` 时只打一行 `acde: <message>`, 不带 `Error:`, 和 acde 的 `Output.debug` 同一条规则)、`ACDE_BUS_NAMES=1/0`、`ACDE_COLOR_SCHEME=light/dark`、`ACDE_SIZE`、
`ACDE_DEV`、`ACDE_HOST_DUMP`、`ACDE_HOST_FAULT`、`ACDE_HEADLESS=1`、`ACDE_SCALE` (headless 的缩放)、`ACDE_AUDIO=null`; shell 的见上.

- **配色** (`appearance.ts`): `ACDE_COLOR_SCHEME`, 否则 portal 的 `org.freedesktop.appearance` `color-scheme`, 变了发给所有 web (`matchMedia` 发 change).
  **语言** (`language.ts`): 按 `LANGUAGE` / `LC_ALL` / `LC_MESSAGES` / `LANG`; 都没设时用系统的首选语言 (sys `languages()`, hostwin `system/languages.rs`:
  Windows `GetUserPreferredUILanguages`、macOS `NSLocale.preferredLanguages`, Linux 读系统区域 `/etc/locale.conf` 或 `/etc/default/locale`, #147);
  还是没有时 `en-US` (acde-dom 的默认同样是 `en-US`). `acde:session` 的 `setLanguage(tag)` 写 `locale.conf` 并发 `languagechange`.
  运行时自己的文字跟着页面语言 (acde-host `language.ts` `HostStrings`, 中文或英文, 别的语言用英文): `acde:fs` / `acde:office` 的根的 `label`
  (runtime 给英文, web 侧按 `source` / `place` 换: 应用数据、桌面、文档…; 选的文件夹用文件夹名不换), 文件夹 / 打开 / 保存选择器的标题.
- **远程桌面**: `ACDE_BACKEND=rdp` 离屏合成用 RDP 送出 (shell `compositor/rdp.rs`). 要 `ACDE_RDP_USER` / `ACDE_RDP_PASSWORD` 和证书
  (`ACDE_RDP_CERT` / `ACDE_RDP_KEY`, 默认 `$XDG_CONFIG_HOME/agentos/rdp/{cert,key}.pem`); `ACDE_RDP_ADDR` (0.0.0.0:3390)、`ACDE_SIZE`
  (默认 1440x900)、`ACDE_RDP_SECURITY` (tls / nla). 还没有: 光标形状、Unicode 键和剪贴板、跟着客户端改尺寸、多个客户端.
- **调试运行中的会话** (`ACDE_DEBUG_DIR=<目录>`): 放进去的 `<name>.mjs` 由 Broker import, 默认导出拿 `DebugApi` (`debug.ts`: `broker`、`shell`、
  `web(name, code)`、`webs()`、`stats(reset?)`、`sleep`、`readText`、`readDir`), 结果写到 `<name>.out`. `ACDE_DEV` 设了时 web 的 debug eval 也开.
- **启动标记**: 每个里程碑一条 info (target `acde_host`) `startup: <标记> ms=<进程启动以来>`: Broker `shell created` / `services starting` /
  `services started` / `shell <里程碑>` (合成器的 `first commit` / `first vblank` / `first native window`) / `autostart`; 每个 web `page load started` / `desktop loaded` (或 `loaded`) / `shell running` / `first frame`.

## 发版

本仓库不发二进制, 也不往 pkgs.dopame.ai 上传东西 (用户定, 2026-11-14): 调试运行时 (acdebin-dbg 的二进制)、页面资源 (`acde-host-<版本>.tar.gz`, 由
本仓库 `web/packages/acde-host` 的 `build:release` 打)、SDK (`acde-api-<版本>.tar.gz`, `web/packages/acde-api` 的 `build`)、acde 命令行和安装器, 由
acdebin-dbg 的 `.github/workflows/release.yml` 一次发到 `pkgs.dopame.ai/acde/<版本>/`, 它在 `acdert_commit` (缺省本仓库 main) 检出本仓库. 所以
发版时本仓库的版本号 (根 `Cargo.toml` 的 `workspace.package.version` 与 `web/packages/*/package.json`) 要和 acdebin-dbg 的一起改: 它的 `plan` 要求
SDK 版本等于发布的版本. 以前在 `pkgs.dopame.ai/acdert/<版本>/` 的 0.0.9 及更早的版本还留在那里.

Rust 包发到 cargo 源 ac 是手动的, 见本文件开头「发布到 gitea.dopamine AC 组织的 cargo 源」那条的顺序 (`cargo publish --registry ac`, 从 HEAD 导出的干净副本发).

## 日志和计时

Rust 一律 `log` 的宏, `src/log` (`acde-log`) 装 env_logger: `RUST_LOG` 追加在默认的 `warn,acde=info,…` 后面; 每行
`<进程启动以来的毫秒> <级别> <线程名> <target>: <内容>`; 写 stderr 在 `acde-log` 线程上 (积压超过 8 MB 丢掉并记数), 退出和 panic 时
`acde_log::flush()`. smithay 的 tracing 进同一个 logger. JS 的 `console.*` 是 target `js`; acde-host 用 `log.ts` 的 `Log` (`Log.clock()` 和
`acde_log::now_ms()` 同一个零点).

页面错误 (`host.rs` `reportError`, 兜底 `rt.rs`) 每行以 isolate 名开头 (`[files#1048576] page error: …`); 不是 Error 的值写「类型 + 值」, 补上
`thrown at` / `rejected at:` 的位置.

计时是 debug 级、target `perf::<段>`, `RUST_LOG=perf=debug` 打开. `packaging/qemu/perf-log.sh [日志]` 按种类汇总 (次数、ms 的 p50 / p95 / max).

| target | 哪里 | 一行是 |
| --- | --- | --- |
| `perf::latency` | crates/window | 输入到上屏: `<kind> owner= ms=`, 分段 `queue` `js` `render` `raster` `present` |
| `perf::task` | src/host | 事件循环里超过 8 ms 的任务: `task ms= hook=`, V8 自己的 `v8` |
| `perf::frame` | render | `<web> commit= resolve= paint= finish= ms=`, 面板的 `panel <id> commands= damage ms=` |
| `perf::raster` | crates/paint、crates/window、hostwin | `job surfaces= wait= record= ms=`, `surface owner= ms=` |
| `perf::layers` | hostwin `present.rs` | 有 layers 的页面 / 面板: `window= region= layers=重画的/全部 ms=` |
| `perf::compose` | shell | `<输出> elements= ms=`, `rdp elements= rects= ms=`, `plan inputs= layers= damage= route=`, `backdrop window= w= h= blur= ms=` |
| `perf::rpc` | acde-host | web 侧 `call <服务>.<方法> error= ms=`, Broker 侧 `serve …` |

`perf::latency` 来自 `acde_log::Trace`: 进队列 → JS 取走 → commit → 出帧 → 光栅化完 → vblank.

JS 热点: `ACDE_PROFILE_DIR=<目录>` 让每个 isolate 开 V8 采样 profiler (`profile.rs`, 250 µs), 每 `ACDE_PROFILE_SECONDS` (默认 30) 秒和结束时写
`<名字>-<n>.cpuprofile`; `bun packaging/qemu/profile-top.mjs [--top N] [--callers 函数名] 文件...` 汇总. 原生调用的时间多半记在调用它的 JS 函数上.

## 协作规则

- 闭源 (用户定, 2026-11-08): 自己的代码是专有的 (根目录 `LICENSE`), package.json 写 `"license": "UNLICENSED"`, Cargo.toml 不写 `license`
  (都 `publish = false`), 不发 npm 包 (SDK 只以 pkgs 上的归档发布), 仓库和 release 不公开. `vendor/` 和 src/napi 保留上游的许可证文件和版权行.
- Rust 和 TypeScript 代码不写注释, 要说明的写进本文件. 例外: 版权和许可证行 (src/napi 的 Deno 版权)、工具指令 (`/// <reference>`,
  `@ts-expect-error`)、`vendor/` 改动处的 `acrender:` (blitz fork 里) / `acde:` 标记. derive 要读的文字写成属性.
- 几个会话共用工作区和 git index: 只改自己负责的路径, 别人没提交的文件先等. 提交一律 `git commit -- <自己的路径>`, 推前 `git show --stat HEAD`
  和 `git log origin/main..HEAD` 看一眼. `git add` / `git rm` 之后立刻提交.
- 仓库在内网 Gitea (`origin` = `ssh://git@gitea.dopamine:2333/AC/acdert.git`, 网页 `http://gitea.dopamine/AC/acdert`), GitHub 的
  `dopame-org/acdert` 是镜像 (远端 `gh`). `origin` 配两个 pushurl (先 Gitea 再 GitHub), `git push origin` 一次推两边; 新检出照这样配:
  `git remote add gh git@github.com:dopame-org/acdert.git`, `git config --add remote.origin.pushurl <Gitea 地址>`, 再 `--add` 一次 GitHub 地址.
  发版仍在 GitHub Actions 上跑 (见「发版」); Cargo.toml / package.json / PKGBUILD 里的仓库地址照旧写 GitHub (npm 的 trusted publishing 认它).
- 不 force push, 不 amend / rebase 已推送的提交. 提交信息英文, Conventional Commits, 每行不超过 72 字符, 正文写原因和验证情况 (性能数字注明
  负载), 不加 Co-Authored-By.
- 改 `crates/shell`、`src/render`、`vendor/blitz` 或 `web/` 的提交, 先在这棵树编出来的 acdert (或并排 acdebin-dbg) 上起一次, 提交信息里写验了
  什么、没验什么. 汇报时分开写「已验证 / 未验证」.
- 系统调用走 rustix, 不直接依赖 libc; rustix 没有的用专门的 crate (signal-hook、jiff). 按平台的代码用 `#[cfg]` / `cfg_select!`, 先用 std.
- 依赖版本只写主版本号 (`log = "0"`, `wgpu = "30"`), 用最新的; 例外是 `[patch.crates-io]` 换成 `vendor/` 的 crate 和配套的 (blitz-*、stylo*、
  parley、html5ever、cssparser) 用 `=` 钉住.
- `Cargo.lock` 不进 git (`.gitignore`): 依赖按 Cargo.toml 解析到最新. 改了依赖, 提交前 `cargo build --release -p acdert` 必须通过; clippy 要过.
  本地留下的 `Cargo.lock` 不会自己跟上: 拉取之后先 `cargo update` (或删掉它) 再编. workspace 的版本号一变, cargo 会重新解析这些 crate 的依赖,
  只写主版本号的 0.x 依赖 (`rand = "0"`、`sha2 = "0"`、`hmac = "0"`) 会落到旧锁里已有的老版本上, 只在 Linux 编的 `voice`、`office` 就编不过
  (`rand::rng` 找不到, `Hmac<Sha256>` 的 trait 对不上); macOS 和 Windows 不编这两个模块, 看不到这个错.
  `web/bun.lock` 进 git, 改依赖时放在同一个提交里.
- 诊断用 `log` 的宏, 不用 `eprintln!` (测试、命令行输出除外).
- Rust 代码提交前 `cargo fmt --all` (根目录 `rustfmt.toml`: 宽 160, `use_small_heuristics = "Max"`; `vendor/` 不在 workspace 里, 不碰).

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/host` | `acdert` lib (外加过渡期的 Linux 会话可执行文件): 内嵌 V8 (rusty_v8), 每个 isolate 的事件循环 (`rt.rs`), 模块加载 (`modules.rs`), web 线程 (`web.rs`), DOM 绑定 (`dom.rs`), 注入的能力, 声音, inspector, 主进程 (`supervise.rs`, Linux), 自检 (`doctor.rs`) |
| `crates/shell` / `crates/window` / `crates/paint` | 会话 (Wayland 合成器、会话里 web 的 Wayland 客户端和光栅化) 已搬到 [acdebin-system](http://gitea.dopamine/AC/acdebin-system), 说明在它的 AGENTS.md |
| `src/render` | Blitz 包成的渲染引擎 (`Document` / `Dom` / `RenderHandle`), 窗框 `Decoration`. `Dom` 在 `dom.rs` (结构、加锁读写的辅助、小工具) 和 `dom/`: `types.rs` (`NodeType` / `Ns` / `Viewport` / `Quad`)、`values.rs` (控件种类、数值字符串、`RangeValue`)、`dom_tree.rs` / `dom_view.rs` (`Dom` 的公开方法: 树、属性、文本、选择器 / 表单、几何、样式、图片、样式表、画布)、`engine_tree.rs` / `engine_state.rs` (`Engine` 上对应的实现: 节点与树操作、解析、属性 / 控件值、焦点选区、滚动、图片状态、innerText)、`select.rs`、`semantics.rs` |
| `src/gpu` | 设备层: 共享设备 `Gpu` (包着 acgpu 的 `Shared`; WebGPU / WebGL / video / canvas 图都在它上面), 接口 `Compositor` (前端在发布 `Gpu` 时用 `Gpu::set_compositor` 装上) 交出 `Offscreen` (render 画 canvas、滤镜、阴影、截图用); 平铺导出 acgpu 的 2D 场景 (`Scene` / `PaintScene` / 滤镜)、`Part` / `Pass` / `Content`、`Px` / `Backdrop` / `Shadow` / `Effect`、`GpuImage` |
| `src/vello` | `acde-vello`: 合成器的 vello / wgpu 实现 (`VelloCompositor`, `Offscreen`, `Composer`, 会话的 `Raster`); acdebin-dbg 和会话用它. acgpu 实现以后也放本仓库 |
| `src/webgl` | `acde-webgl`: wgpu 上的 WebGL 1 / 2 (见「WebGL」). 检查: `cargo test --release -p acde-webgl` |
| `src/runtime` | 系统接口 (napi 导出 + 注入用的 Rust 对象). 异步执行器 `rt.rs`: `acde-rt` 线程上的 ntex System (不用 tokio, TLS 用 OpenSSL). 检查: `cargo test -p acde-runtime` (含真 pty / Windows 伪控制台上的终端、unix socket 上的 HTTP / WebSocket)、`ime-check.sh`、`portal-check.sh`、`atspi-check.sh` (经 `tests/run.sh`) |
| `src/model` | canvas / 窗口表、计划、快捷键、shell 事件 (`Event` / `Inbox`)、`acde_window` / `acde_shell` 协议 |
| `src/log` | `acde-log`: 日志和计时 |
| `src/media` | `acde-media`: 解码音视频, 读摄像头和麦克风 (Linux GStreamer, macOS AVFoundation; 见「视频」「摄像头和麦克风」). 检查: `cargo test --release -p acde-media` (`tests/fixtures` 是 ffmpeg 命令行生成的 1 秒小片段; `tests/capture.rs` 用假设备; `tests/devices.rs` 里 `--ignored` 的列出 / 读真设备、在 macOS 上问权限) |
| `src/storage` | `acde-storage`: 网页存储的分区和 SQLite (见「网页存储」). 检查: `cargo test --release -p acde-storage` |
| `src/napi` | rusty_v8 实现的 Node-API (napi8), 让 `#[napi]` 导出在 Broker 里可用. 改自 Deno `ext/napi` 0.191.0 (MIT, LICENSE-MIT), 去掉了用不到的入口 |
| `web/packages/acde-host` | acdert 的 JS: Broker 和每个 web 的宿主, 包发现, 桌面服务, 登录页 |
| `web/packages/acde-dom` | web 里的浏览器全局对象和 DOM |
| `web/packages/acde-api` | `@dopame/acde-api`: SDK (唯一对外发布的 JS 包) |

### web/packages

Bun workspace (`bun install`, `bun run build`, `bun run typecheck`, `bun run test`; 测试是 `bun test`, 没有 Node).

- **acde-api**: 入口在 `src/` 顶层 (`index`、`app.d.ts` / `shell.d.ts`、`vite`、`validate.ts`), `src/types/` 是接口声明, `src/modules/` 是 `acde:*` 模块声明, `src/runtime/` 是运行时的 JS. `API_LEVEL` (`src/runtime/level.js`, 契约级别, 包根和 `./manifest` 都导出)、`load(name)` (`src/runtime/load.js`: `import('acde:<name>')` 的默认导出, 拿不到时是 null; 说明符带 `@vite-ignore` 等)、
  `@dopame/acde-api/vite` (build 时 `acde:*` 留作外部模块, dev 时换成会 reject 的替身); 声明 `types/` 的 `manifest.d.ts` / `service.d.ts` / `page.d.ts` (加 `events.d.ts`、`office.d.ts`) /
  `config.d.ts` (+ `config.schema.json`) 和 `modules/`; `src/validate.ts` (导出 `./manifest`) 是清单校验和 `ICON_NAMES`, 测试
  `test/validate.test.ts`. acde 仓库用 `file:../acdert/web/packages/acde-api`, acde-dopame 拷一份 (`scripts/sync-acde-api.sh`).
  发布的 SDK 归档不是这个目录: 它的 package.json 是 `"private": true`, 防止把源码发出去. `bun run build` (`scripts/build.mjs`)
  生成 `dist/`, 归档打包的是 `dist/`: `.js` / `.ts` 用 esbuild 压缩 (标识符也压, 没有 source map,
  不留注释), `validate.ts` 的声明由 tsc 生成成 `validate.d.ts`, `./manifest` 改指向 `validate.js` / `validate.d.ts`; 手写的 `.d.ts` 和
  `config.schema.json` 原样拷贝 (对外接口); 去掉 `private` / `scripts` / `devDependencies`; `LICENSE` 是根目录 `LICENSE` 的版权段
  (不含第三方那段). 构建最后检查 `dist/`: 有 `.map`、非 `.d.ts` 的 `.ts`、`sourceMappingURL` / `sourcesContent` 或意料外的文件就失败.
  esbuild 装在 web 根的 devDependencies: 放在 acde-api 自己的 devDependencies 里, bun 会把它装进用 `file:` 引用它的 acde.
- **acde-dom**: 经 `DomNative` / `GpuNative` / `AudioNative` / `HostNative` (`src/native.ts`) 调 src/host, 打进 acde-host 的 `dist/web.js`.
  编辑只有 `dom/editing.ts` 一份. 文本框 (`<input>` 文本类型和 `<textarea>`) 各有一份编辑历史 (`dom/history.ts`): 键盘、粘贴、剪切、输入法提交和 execCommand 的改动
  记成一步, 连续打字 (含换行) 和连续的同向删除合成一步, 选区或值在中间变过就另起一步; 快捷键 Ctrl / Cmd+Z 撤销, Ctrl / Cmd+Shift+Z 和 Ctrl / Cmd+Y
  重做, 先发可取消的 `beforeinput`, 再发 `input` (inputType `historyUndo` / `historyRedo`, data 为 null), 恢复值和那一步的选区; execCommand('undo' / 'redo')
  不发 beforeinput, queryCommandEnabled 看有没有可撤销 / 重做的一步. 脚本把值改成别的 (value、defaultValue、setRangeText、表单 reset) 丢掉这份历史,
  赋同样的值不丢 (React 受控组件). 还没有: contenteditable 的撤销, 拖放文字进文本框.
  测试在 happy-dom 的 MockDom 上跑. 布局类的读 (rect、metrics、计算样式) 缓存到下一次写入、下一个指针事件 / 帧 / 滚动, 或这个任务结束 (CSS 过渡和动画在 render 线程上跑, JS 不知道, 下一个任务要重新读). Web Animations
  (`dom/animation.ts`): 关键帧变成 `@keyframes acde-animation-<n>` 规则加元素内联的 `animation-*`, 由 render 跑; 时间、事件、`finished` 在 JS
  里按 host 的时钟; 近似: easing 作用在每段关键帧上、endDelay 只算进结束时间、没有 composite.
  SVG 几何 (`dom/svg.ts`, `dom/svgbox.ts`): `getBBox` 的基本图形和容器按属性在 JS 里算, 文字、图片、use 这类没有几何的子元素取 render
  画出来的框 (`rect` 经 `svg_box`) 换回元素的用户坐标; `SVGTextContentElement` 的 `getComputedTextLength` / `getSubStringLength` /
  `getNumberOfChars` 按 xml:space 默认规则整理文字, 用计算出的字体 `measureText` 量前进宽度, 加上 letter-spacing.
  popover 和模态 dialog (`dom/popover.ts`): `showPopover` / `hidePopover` / `togglePopover` 按 HTML 发 `beforetoggle` (打开时可取消) 和排队的
  `toggle`, auto / hint popover 打开时关掉栈里不是它祖先的 auto popover, manual 不动; 文档上按下 (pointerdown, capture) 关掉不含落点的 auto
  popover, Escape 关最上面的 auto popover 或请求关闭最上面的模态 dialog (`requestClose`); 按钮和 `input` 的 `popovertarget` /
  `popovertargetaction` 在激活时做 (表单里的提交 / 重置按钮仍先提交 / 重置), `popoverTargetElement`; 状态经 `dom.setOpenState` 给 render.
  还没有: popover 的 hint 栈单独管理、焦点回到调用者、`::backdrop`.
  CSS 动画和过渡的事件 (`dom/cssevents.ts`): 页面第一次给这 8 种事件 (或 webkit 前缀的 4 种) 加监听或 on 处理器之后, 每帧 `takeAnimationEvents`
  (render 先把样式算到最新), 在元素上发 `AnimationEvent` / `TransitionEvent` (冒泡, 不可取消, 伪元素的发在宿主元素上带 `pseudoElement`);
  Web Animations 自己的 `acde-animation-<n>` 关键帧不发. 还有动画在跑或刚有事件就再要一帧; 改了 DOM 的任务结束时也要一帧, 好让新开始的动画被看到.
  还没有: 只有 webkit 前缀监听时改发旧名 (DOM 的 legacy event types), `getAnimations()` 里的 CSS 动画.
  用指针选文字 (`dom/textselect.ts`, `Input` 调): 左键按下 (pointerdown / mousedown 都没取消) 在 `caretFromPoint` 处折叠选区, 先发可取消的
  `selectstart`; 按住移动时把焦点端扩到指针处; 第二次按下 (500 ms、5 px 内) 选一个词 (`Intl.Segmenter`, 中文按词典分词), 第三次选所在
  块 (向上找到 `display` 不是行内的祖先), 拖动时按同样的粒度扩展; Shift 按下从原锚点扩展. 按在表单控件、按钮、label、可编辑区域、链接、
  图片、`draggable` 元素或 `user-select: none` 上不动选区.
- **acde-host**: 测试 `bun test` (只测不碰原生接口的模块, 如 `mimedb.ts`). esbuild 打成 `dist/broker.js` (`src/main.ts`, Broker) 和 `dist/web.js` (`src/worker.ts`, 每个 web). release 构建 (`build:release`, `dist-release/`) 的压缩、混淆、泄漏检查见「发版」. 基准 `bash scripts/release-perf/bench.sh` (Windows, 无头, 每边 5 轮中位数): 加载到 `shell running` 开发 1106 ms、release 941 ms; DOM 和布局负载 95 ms 对 107 ms; 纯 JS 负载 29.3 ms 对 29.4 ms. 多一层字符串数组混淆时加载慢约 470 ms, 所以预设不用它. 打包开着 `keepNames`: 有静态块的类会被 esbuild 改名 (`class _Blob`), 不留名字的话 `Blob.name`、`Object.prototype.toString` 都是错的. 文件按本文的章节命名
  (`broker.ts`、`worker.ts` / `host.ts`、`remote.ts` / `rpc.ts`、`inspect.ts`、`devhot.ts` …); `sys/` 是原生接口的 node 风格包装.
  `broker/` 是从 Broker 拆出的部分, 每块经一个小的宿主接口 (`…Host`) 拿 Broker 的私有状态: `types.ts` (Broker 的接口和窗口记录)、`web.ts`
  (`Web`: 一个 web 的线程和 rpc, 它的授权、环境变量和 403)、`dev.ts` (`DevRequests`: acde dev 的请求、假回应规则、找 web)、`preferences.ts`
  (配色和减少动态, 含模拟)、`records.ts` (`WindowRecords`: 窗口表、原生窗口的事件、应用的窗口位置)、`approvals.ts` (`Approvals`: 批准的接线, `acde:permissions` / `acde:capabilities` 的调用、给 web 的 `permit`; 决定文件和日志由 Broker 经 `ApprovalsHost` 给)、`listing.ts`
  (`AppListing`: 桌面知道的应用列表, 变了发 `appschanged`); `calls/` 是 web 经 rpc 来的调用: `apps.ts` (`acde.apps` / `acde.packages`)、`windows.ts` (`acde.windows` /
  `acde.launch` / `acde.window`)、`page.ts` (页面调用和钉住的面板)、`services.ts` (交给 web 的服务形状、内置和桌面包服务的调用)、`desktops.ts`
  (`acde.desktops`); `access/` 是谁能用什么: `tier.ts` (按调用者层级的模块)、`family.ts` (打开窗口时的父窗口)、`launchable.ts` (应用能不能
  在这里起: 找不到 404 / 级别不对 409、缺系统服务 503、宿主窗口里要 slots 404、第三方声明外壳模块 403; 列表只给能起的)、`modules.ts`
  (桌面服务 `ctx.import` 拿到的外壳模块和它们的事件)、`capabilities.ts` (必需与可选能力), `access/approval/` 是批准: `permissions.ts` (决定)、`permits.ts` (web 侧的守卫)、
  `dialog.ts` (单应用模式的原生对话框). `broker.ts` 留着会话循环和 web 的起停. `greet/` 是登录页,
  `brand/` 的 `mark.mjs` / `art.mjs` 是 agentos 仓库 `branding/` 的原样拷贝 (只在那边改).

## vendor

依赖来自 crates.io, 加上两处 git: `vendor/blitz` 是子模块 (GitHub `Jabberwocky238/blitz`, fork 自 DioxusLabs/blitz), blitz 的 taffy
照上游 Blitz 钉 DioxusLabs/taffy 的 git 提交 `4e59968`. 根 `Cargo.toml` 用 `[patch.crates-io]` 把 blitz-* 换成子模块里的. 克隆后 `git submodule update --init`; 打包 (acdebin-system 的 PKGBUILD) 和 CI 也取子模块.
小补丁不留: stylo、parley、fontique、vello、taffy、libseat-sys、fslock、async-dnssd 都用 crates.io 原版 (servo 版 stylo 没有的 `@container`、
`accent-color`、`field-sizing`、`prefers-reduced-motion` 和 SVG 的 `pointer-events` 取值随之没有).

| 目录 | 上游 |
| --- | --- |
| `blitz` (子模块) | DioxusLabs/blitz main `fb297a38` 上接我们的提交: 只留 blitz-dom / blitz-paint / blitz-traits / stylo_taffy / debug_timer (`MIT OR Apache-2.0`) |

blitz fork 和上游结构的不同: HTML 解析用 src/render 自己的 html5ever TreeSink; `build_inline_layout_into` 在 `layout/inline/build.rs`; `paint_scene`
先录进 acgpu 的 `Scene` 再回放 (没有 anyrender, 它的 SVG 画法成了 blitz-paint 的 `svg.rs`); blitz-dom 重新导出 `taffy`. 验证: 在
`vendor/blitz` 里 `cargo clippy --workspace --all-targets`、`cargo check -p blitz-dom --no-default-features`、
`cargo test -p blitz-dom -p blitz-paint`、`cargo clippy -p blitz-paint --all-targets --features scrollbars`; 再 `cargo test --release -p acde-render`
(加 `ACDE_PAINT_VERIFY=1` 再一遍).

**blitz-paint**

| 文件 | 改了什么 |
| --- | --- |
| `cache.rs` (新), `render.rs` `record` / `ensure` / `flatten`, `lib.rs` `paint_scene_cached` / `paint_scene_reference` | 增量录制: 按绘制边界 (根、stacking context、裁剪 / 滚动容器、图片、SVG、canvas、大列表的块级子元素) 缓存片段, `Dep::holds` 核对后复用, 帧按引用展开成 `Piece`; 表单控件和 iframe 每帧重录; LRU; 整页录制给 verify |
| `render.rs` `render_element_part` `border_box` | 边框盒在元素自己的坐标里 (否则挪过的片段不能复用) |
| `text.rs` `embolden` | 合成粗体: 字体没有要求的那么粗的字面 (fontique 的 synthesis `embolden`) 时照 Skia (Chrome) 加粗轮廓: 9 px 以下是字号的 1/24, 36 px 以上 1/32, 中间线性, 每边一半; 上游只有 `font-embolden` 那种给所有字都加的苹果式描粗 |
| `layers.rs`, `render.rs`, `render/background.rs`, `render/box_shadow.rs` | `push_layer` / `maybe_with_layer` 代替 `LayerManager` (上游超过 1024 层丢裁剪), 不建多余的裁剪路径 |
| `debug_overlay.rs` (删) | 去掉 devtools 叠加层和 euclid |
| `lib.rs` `paint_element` | 只画一个元素和子树, 不带祖先的变换 / 透明 / 裁剪 (拖动图标) |
| `lib.rs`, `render.rs` `flatten` / `render_element`, `cache.rs` `reuse` | `pinned` 元素 (面板) 不进帧, 单独展开返回 |
| `render.rs` `draw_canvas_background`, `render/background.rs` | 根 (或 body) 的整个背景铺满画布 |
| `render.rs` `draw_canvas_picture`, `cache.rs` `is_boundary` | `<canvas>` 画 2D 图, canvas 是绘制边界 |
| `render.rs`, `text.rs` | 行内元素按行画 padding / border / 圆角背景 |
| `render.rs` `draw_text_input_text` | 空输入框画 placeholder |
| `render/form_controls.rs` `draw_input` | 复选框和单选框: `appearance: none` 时不画控件 (元素自己的边框、背景、`::before` 照常); 选中时填文字颜色 (原版 stylo 没有 `accent-color`), 勾按和白色的对比度 (低于 3 用深色); 没选中的复选框边框是文字颜色 |
| `render/form_controls.rs` `draw_select` / `draw_picker`, `lib.rs` `paint_select_picker` | `<select>`: 下拉框的选中项文字和箭头, 列表框的行 (只画看得见的); 打开的选项列表 (render 画在帧的最上面) |
| `render/box_shadow.rs` | spread 加到圆角; 偏移和模糊乘缩放; 透明内阴影只跳过自己; 内阴影第一个在最上; 不模糊的内阴影一次填充 (padding box 加反向的洞, 重合的边抵消; 先填再 DestOut 挖洞时两条边落在同一像素里会剩一条淡线, xterm.js 的竖线光标) |
| `render/box_shadow.rs`, `render.rs` (滚动偏移、`draw_svg`), `render/background.rs` | 偏移在元素自己的坐标里加 |
| `render/border.rs` `draw_outline` | outline 沿中线、`outline-offset`、dashed / dotted、圆角、在内容之后、乘 opacity |
| `render.rs` `draw_svg` / `draw_simple_svg` / `draw_svg_tree` / `draw_svg_image` | 画 simple SVG 的命令; usvg 树相对元素画再放置; 没有 `viewBox` 的内联 `<svg>` 不拉伸到盒子: 用户单位就是 CSS px, 从内容框左上角画 (上游把 usvg 按内容包围盒定的尺寸拉满盒子, 偏大且偏移; 图片的 SVG 照旧拉伸, 浏览器给图片合成 viewBox); 背景和遮罩层 (`render/background.rs`) 也画 simple SVG 的命令 (图片加载时简单的 SVG 只留根元素的壳, 原先背景、`mask-image` 里的图标、下拉箭头一律不画) |
| `svg.rs` `mask_clips` / `filter` / `layered`, blitz-dom `serialize.rs` 写 `mask-type` (呈现属性也收) | 遮罩: 只有一条纯色无描边路径时按它裁剪, 不透明度是 alpha 遮罩的填充不透明度 / 亮度遮罩的颜色亮度乘它; 别的遮罩只裁到遮罩区域 (vello 没有遮罩层). 滤镜: 从 SourceGraphic 接起来的高斯模糊、drop shadow、颜色矩阵 (Figma 导出的透明 feFlood + feBlend 前缀放过) 变成合成器的滤镜层, 在组的用户坐标里; 别的原语整组不滤. 已知: 合成器里滤镜层外面的非矩形裁剪 (遮罩路径) 只按包围矩形裁 (同 #46 一类), Vite logo 的模糊光晕会溢出闪电形状, 在遮罩矩形内; canvas / 离屏里滤镜层不做 (vello 忽略) |
| `text.rs` `stroke_text` / `Ellipsis` / `draw_ellipsis_marker`, `render.rs` `ellipsis` | `text-overflow: ellipsis` 和 line-clamp 的 "…" (`Ellipsis.end` 是 frame 的内容盒宽, 已经是设备像素, 不再乘 scale) |
| `render/gradient.rs` | 色标位置按规范; 超出渐变线的色标: 线性拉长, 径向 / 锥形夹回 |
| `render.rs` `fieldset_frame` / `element_cx`, `render/border.rs` `draw_border`, `cache.rs` `visit` | fieldset 的框从 legend 中线开始, 边框在 legend 后留空; legend 算进片段依赖 |
| `render.rs` 开头 | `scrollbars` 下补 `Color` / `Stroke` 的 import |

**blitz-dom**

| 文件 | 改了什么 |
| --- | --- |
| `node/element.rs` `SpecialElementData::RangeInput`, blitz-paint `render/form_controls.rs` `draw_range` / `accent_color` | `<input type=range>` 画轨道和滑块 (`appearance: none` 时不画); 复选框、单选框和滑块都用 `accent_color` (文字颜色) |
| `mutator.rs` `set_attribute` | 不在文档里的 `<img>` 设 `src` 也取图 (HTML 的 update the image data; `new Image()` 预加载): 上游在文档外不做任何特殊处理, 图一直不来; render 的 `image_state` 也不再把文档外的图一律当作加载中, 取不到就报失败 |
| `layout/mod.rs` textarea / 文本类 `<input>` 的叶子布局, `document.rs` `with_text_input` | textarea 排完版把文字的高度 (加上下内边距) 算进 `scrollable_overflow_rect`, `scrollHeight` 是整段文字 (聊天输入框按它长高; 上游只有 rows 那么高) |
| `document.rs` `svg_with_document_refs`, `node/svg.rs` `missing_local_refs`, `node/serialize.rs` `write_svg_raw` | usvg 只在它解析的那份 SVG 里找 `<use href="#id">` / `url(#id)`; 页面常把 `<symbol>`、渐变放在另一个 `<svg>` (藏起来的雪碧图): 这份里没定义的 id 按文档找到 SVG 元素, 抄进 `<defs>`, 再找它引用的; 没算过样式的 (在 `display: none` 的 `<svg>` 里) 按原属性写 |
| `document.rs` `svg_box`, `node/serialize.rs` `write_svg_marked` / `SVG_BOX_ID`, `stylo.rs` SVG 呈现属性 | 内联 SVG 里的元素没有布局盒: `svg_box` 把所在的最外层 `<svg>` 再序列化一次, 目标元素包进 `<g id="__acrender_box">`, 交 usvg 解析 (文字排成路径), 取这个组在画布上的包围盒, 按画的时候的变换 (`SvgImageData::inline_viewport_transform`) 放进内容框, 换成内容框的比例; render 的 `rect` / `clientRects` 按 `<svg>` 的内容框换成页面坐标 (getBoundingClientRect, 和 acde-dom 里 getBBox 的文字、图片、use 部分). `font-size="20"` 这样不带单位的呈现属性按用户单位补 `px` (CSS 的 font-size 不收纯数字, 原先这一条被丢掉, 计算样式回到页面字号) |
| `stylo.rs` `match_non_ts_pseudo_class`, `assets/default.css` | `:popover-open` / `:modal` 看元素状态 (由 render `Dom::set_open_state` 设, 上游一律 false), `:open` 是 `details` / `dialog` 有 `open`; popover 的 UA 样式 (定位、边框) 搬出 Gecko 的 pref, 没有 top layer, `:popover-open` 和 `dialog:modal` 给最大 z-index 代替 |
| `has.rs` (新), `document.rs` 打开 `layout.css.has-selector.enabled` / `snapshot_node_and`, `mutator.rs` `set_attribute` / `clear_attribute` / `remove_node` / `remove_and_drop_all_children` / `add_children_to_parent`, `stylo.rs` `each_custom_state` | `:has()` (上游在 servo 里关着, 选择器不解析). 快照失效只看元素自己和右边的选择器, `:has()` 的锚在左边 (祖先、前面的兄弟), 所以状态变化、属性变化 (class / id / 其他属性名, 新旧值都算)、插入和移除前各调一次 Stylo 的 `RelativeSelectorInvalidator` (照 Gecko glue 的 `MaybeInvalidateRelativeSelector*`): 改之前调, 不带快照, 找到的锚记 restyle 并把祖先标脏; 样式里没有 `:has()` 时属性那条直接返回. `each_custom_state` 原是 `todo!()` (失效时会走到), 没有自定义状态, 什么也不做 |
| `animation_events.rs` (新), `stylo.rs` `resolve_stylist_pass`, `document.rs` `take_animation_events` / `has_css_animations` | 推进 CSS 动画和过渡时记事件 (animationstart / iteration / end / cancel, transitionrun / start / end / cancel; elapsedTime 照 Servo 的 `script/animations.rs`, 取到微秒): 上游 Servo 在 script 里发, Blitz 没有. 第一次 `take_animation_events` 之后才记, 最多攒 4096 个; 离开文档的元素上没结束的动画和没结束的过渡记 cancel, 已结束的动画被样式去掉不记 |
| `node/node.rs` `NodeFlags::IN_XML_DOCUMENT`, `stylo.rs` `is_html_element_in_html_document` | 上游写死 `true` (类型选择器和属性名全按小写比); 改成 HTML 命名空间且所属文档不是 XML 文档 (这个标记由 src/render 在 adopt 时设). SVG 的 `linearGradient` 这类名字在 HTML 文档里也按原样比 |
| `layout/damage.rs` `propagate_damage_flags` | 内联 `<svg>` 后代的损伤只重建这个 `<svg>`, 往上只传 REPAINT |
| `mutator.rs` `set_attribute` / `clear_attribute` / `restyle_for_attribute`, `document.rs` `snapshot_attribute` | 只影响选择器的属性只重算元素自己 (快照让后代失效; 有 `:has()` / nth-of 时重算父子树); 值没变直接返回 (`value`、`style` 和 `<img>` 的 `src` / `srcset` 除外: 同值也照常处理, `<img>` 会重新加载) |
| `mutator.rs` `set_attribute` / `load_image` / `process_added_subtree`, `node/element.rs` `ElementData.image_tried` / `image_loads`, `document.rs` 取图失败和 `apply_loaded_image`, blitz-traits `net.rs` `NetProvider::reused` | `<img>` 不在文档里时设 `src` 也加载 (上游只在文档里加载); 插入文档时当前 `src` 已经开始取过 (成功、失败或还在取) 就不再取 (克隆体没取过, 插入时取); 取自图片缓存或并入进行中的请求时调 `reused` 让提供者照样上报; 每次取图结束 (取到、失败、取自缓存) `image_loads` 加一, render `take_loaded` 按它每次结束报一次 (页面各触发一次 load / error, 和浏览器一样), 不再只在状态变了时报 |
| `node/simple_svg.rs`, `svg.rs`, `element.rs`, `layout/construct.rs` | 基本图形 + 纯色的 SVG 直接转 kurbo 路径, 不经 usvg (`<text>` 和嵌套 `<svg>` 走 usvg; `svg_text_only`; `ACRENDER_SVG_PATH=1` 打印) |
| `node/serialize.rs` `svg_source`, `assets/default.css` | 序列化内联 SVG 时写进算好的样式和字体, CSS 几何算成属性; 后代的 CSS `transform` / `translate` / `rotate` / `scale` (类、动画) 按视口算成矩阵写进 `transform` 属性, 盖过原属性 (根 `<svg>` 的随它的盒子画). SVG 元素 (除最外层 `<svg>`) 的 `transform-origin` 默认 `0 0`, 同 Firefox; 内联 `<svg>` 默认 `overflow: hidden` (同 Chrome / Firefox 的 UA 样式), 画出盒子的内容被裁掉; `color` / `fill` / `stroke` (和替换 currentColor 的值) 写成 sRGB 的 `rgb()` / `rgba()`, 超出色域的截到边上: usvg 不认 `oklch()`、`lab()`、`color-mix()` 等 (Tailwind 4 的调色板全是 oklch, 图标原先看不见或成了黑色) |
| `node/svg.rs` `external_uses` / `inline_external_uses`, `document.rs` `svg_with_sprites`, `net.rs` `SvgSpriteHandler` | 内联 SVG 里指向别的文件的 `<use href="icons.svg#id">` (#152; usvg 只认同一文档里的): 文件经 net provider 取一次 (按去掉片段的 URL 记, 取不到不重试), 到了把等它的 `<svg>` 重建; 序列化后把目标元素原样抄进根下的 `<defs>`, 改成 `acde-sprite-<n>-<id>`, `<use>` 指向它. 只抄目标元素本身, 它再引用文件里别的 id 不跟 |
| `stylo.rs` `synthesize_presentational_hints_for_legacy_attributes`, `SVG_PRESENTATION` | SVG 的呈现属性 (fill / stroke / opacity / font-* 这 18 个, 和序列化写回的一样) 按 CSS 解析成 PresHints: `stroke="var(--x)"` 能解析, `getComputedStyle` 也读得到; 含 `url(` 的值不映射 (照旧原样交给 usvg) |
| `util.rs` `parse_svg_image` / `parse_svg_with` | 按源文本缓存 usvg 解析 (512 条); 没有 `<text>` 用空字体库 |
| `net.rs` `ImageHandler::parse` / `best_icon_entry`, `Cargo.toml` image 的 `ico` 特性 | ICO / CUR 图片 (#203; 上游没开 `ico`, favicon 报错): 照浏览器取面积最大的一项, 同样大时取色深最大的 (image crate 自己先比色深), 抄成只有这一项的 ICO 再交给 image 解 (PNG 和 BMP 项都认); CUR 的项里第 4–7 字节是热点, 只按面积比, 抄出来写成 1 个平面、色深 0 (image 遇到超过 256 的值会报错); `ico` 带上 `bmp`, 单独的 BMP 图片也能解了 |
| `util.rs` `FONT_DB`, `document.rs` `svg_fonts` | fontdb 的通用字族用 fontique 选的; SVG `<text>` 能用 @font-face |
| `webkit_compat.rs` (新), `document.rs`, `net.rs`, `node/element.rs`, `cssom.rs` | 解析前改写 `-webkit-line-clamp` / `-webkit-box` / `-webkit-inline-box` |
| `layout/inline/*.rs`, `node/text.rs` | ellipsis 另排一个 "…"; line-clamp 截到第 N 行 |
| `node/inline_edge.rs` (新), `layout/inline/build.rs` / `layout.rs` | 有边距的行内元素两端各放一个零高行内盒 |
| `layout/construct.rs` `flush_inline_pseudos_recursive` | 按子元素自己的 display 决定是否往下走 |
| `resolve.rs` `needs_layout` / `resolve_layout_children`, `layout/damage.rs` | 没有布局损伤不跑 taffy; 只走有构造损伤的子树; hover 有变化才刷新 |
| `layout/inline/layout.rs` | min / max-content 宽度缓存; shrink-to-fit 断行宽度放宽 0.01 |
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
| blitz-traits `net.rs` `NetHandler::destination` / `cors` / `failed` / `opaque`, blitz-dom `net.rs` `SheetLoad` / `SheetLoadState`, `document.rs` `fetch_linked_stylesheet` / `unload_linked_stylesheet` / `stylesheet_load` / `take_settled_stylesheets` / `stylesheet_source` / `media_list_of` / `update_stylesheet_media`, `mutator.rs` | 请求带 destination 和 `crossorigin` 的 CORS 设置; 取不到 (`failed`) 和空响应分开, 上游都当空表; 响应不透明 (`opaque`) 时记在 link 的表上, 连同取它的地址. `<link>` 的取表挪到 `BaseDocument`: 每个 link 记当前这一次取和它 `@import` 的表还差几个没答, 都答了报一次成败; 不是当前这次的答复丢掉 (上游后到的旧答复会盖掉新表); 取失败时去掉旧表; link 离开文档、没了 `href` 或 `rel` 里没了 `stylesheet` 时表和这次取一起去掉 (上游只在删 `href` 时去, 没有表就 panic); `rel` / `crossorigin` 变了也重取. `<link>` / `<style>` 的 `media` 属性是表的 media list (上游一律空 list), 改了即时生效 |
| `document.rs` `repair_after_panic` | panic 后去掉对已删节点的引用, 全部标脏 |
| `layout/damage.rs` `repaint_inline_root` / `clear_damage_and_dirty_flags` | 行内元素的损伤让 inline root 重画; `display: none` 子树的构造损伤留着 |
| `document.rs` `physical_unrounded_geometry` | 只减包含块的滚动偏移 |
| `layout/fieldset.rs` (新), `layout/mod.rs`, `layout/construct.rs`, `node/node.rs`, stylo_taffy `wrapper.rs` | fieldset 是 flow-root; rendered legend 是块级的直接布局子节点, 居中压在上边框上, 上边框占 max(边框宽, legend 高); 不建匿名 content box. 不做竖排、`align`、百分比定高 |
| `layout/list.rs` | outside 的列表标记按 `white-space: pre` 排 |
| `assets/default.css` | `::placeholder` 54% currentcolor; 表单控件默认黑字; `select` 是 inline-block, 列表框 (`[multiple]` / `[size]`, `size` 是 0 / 1 的除外) 纵向能滚 |
| `document.rs` `element_from_point` | 命中测试前加上视口的滚动偏移 (`hit` 从根元素的盒子算起, 是页面坐标): 上游整页滚动之后 `elementFromPoint` 回的是滚动前那个位置上的元素 |
| `resolved_style.rs` `css_supports_condition` / `css_supports_declaration` | `CSS.supports(条件)` 和 `CSS.supports(属性, 值)` 交给 stylo 的 `@supports` 求值; 两个参数的那种属性名要原样是标识符 (先过 `Declaration::parse`: stylo 的 `Declaration::eval` 对不是「标识符 + 冒号」开头的文字会 panic), 值里不许 `!important` |
| `node/select.rs` (新), `layout/select.rs` (新), `layout/construct.rs`, `layout/mod.rs`, `node/element.rs` `SpecialElementData::Select` | `<select>` 是叶子: 构造时按 list of options 给每个 option 和 optgroup 标签排一行 (select 的字体, 组标签加粗), 选中看 option 的 `CHECKED` 状态 (嵌入方设); 下拉框宽是最宽的标签加箭头, 高一行; 列表框高 `size` 行, `scrollable_overflow_rect` 含全部行; `SelectPicker` 是打开的列表的几何 |
| `scrolling.rs` `clamp_scroll_offsets`, `resolve.rs`, `document.rs` `scrolled_nodes` | 布局后把超出新滚动范围的偏移拉回来 (节点和视口; CSSOM View), 只看偏移不是 0 的节点; 上游内容变短后一直停在末尾之外, 顶上空着又滚不回去 |
| `layout/damage.rs` `propagate_damage_flags`, `document.rs` `rebuild_select` | select 下面有损伤 (option 的文字、属性、状态) 时重建它; 样式看不出的变化 (selectedness) 由嵌入方 `rebuild_select` |
| `assets/default.css`, `node/node.rs` `has_native_appearance`, `layout/construct.rs`, `layout/mod.rs`, `layout/damage.rs` | 复选框和单选框默认 `appearance: auto`, 不带 input 的边框、内边距和背景 (控件的边框盒仍是 20px / 18px); `appearance: none` 时是普通的盒子: 不当叶子、`::before` / `::after` 照常构造和排版, `appearance` 变了重建盒子 |
| 删掉的 | `events/`、`form.rs`、`debug.rs`、devtools、parallel-construct、`<canvas src=数字>`、CSS 光标、custom-widget |

**src/webgl `src/glsl`**: naga 30.0.1 的 GLSL 前端整个搬进来 (原 `front/glsl`, MIT OR Apache-2.0), 跑在 crates.io 原版 naga 的公开接口上
(naga 私有的几样在 `glsl/compat.rs` 重写); 改动处加 `acde:` 注释. 加的是 WebGL 方言 (`Frontend::parse_webgl`、`WebGlOptions`: `front/glsl` 的 `Frontend::parse_webgl`、`WebGlOptions`: ES 1.00 / 3.00、attribute / varying、组合采样器拆开 (数组按常量下标、采样器参数带隐藏的采样器参数)、散 uniform 成块、`gl_FragColor` / `gl_FragData` / int `gl_VertexID`、矩阵 attribute 按列、出口翻 y 改 z、宽点、丢掉的接口变量), 另外 `const in` 参数、`modf`、精度语句接受采样器、嵌套深度上限 128 (表达式和语句; 深的源码报错而不是栈溢出)、数组层数 / 采样器数组长度的上界.
std140 下比步长窄的 scalar / vec2 数组元素包进 16 字节的结构体 `acde_padded { value }` (`offset::PADDED`), 取元素时自动接上 `.value`,
webgl 枚举 uniform 时 (`shader.rs` `unpadded`) 解开这层; 这样各后端 (MSL 没有自己的数组步长) 都保持 std140 布局, 不用改 naga 后端.

## src/render 的已知问题和测试数据

- canvas 的 `createPattern` 在第一次用时才取来源的位图 (规范是创建那一刻).
- vello 0.11 没有图片的场景把图集当 1x1 重建、已上传的图片画空; 每个场景垫一块 1x1 渐变绕开 (acgpu `Vello::render`), 升级 vello 时看
  上游修了没有.
- `ACDE_PAINT_VERIFY=1` 下机器忙时 `tests/damage.rs` 偶发等帧超时, 单独重跑都过.
- `tests/fixtures/replay/*.ops.gz` 是旧 acde-host 的 DOM 操作流 (`tests/replay.rs` 回放, 格式见它), `svg/*.svg` 是简单 SVG 的对比用例, 元素的特殊渲染
  在 `tests/elements.rs`. `release_keeps_memory_flat` 只在 Linux 上跑.
