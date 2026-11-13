# acdebin-dbg

> 第一原则同 [acdert](http://gitea.dopamine/AC/acdert) 的 AGENTS.md: 不许在任何层次上魔改 web 接口; 运行时的一切 (清单、`acde:` 模块、窗口模型、
> dev IPC) 以 acdert 的 AGENTS.md 为准, 这里只写调试运行时自己的部分.

说明都在本文件里 (没有 README). full agentic. 闭源, `publish = false`. 代码不写注释.

## 是什么

acde 分三个仓库 (测试期间的架构, 用户定 2026-11-13): acdert (通用运行时 lib)、acdebin-dbg (本仓库, 跨平台调试运行时)、acdebin-system
(Dopame OS 特化运行时), 开发者 CLI `acde` 在本仓库的 `cli/` (bun, 说明在 `cli/AGENTS.md`). acdebin-dbg 产出二进制 `acdebin-dbg`: 在 Linux / Windows / macOS 的别人桌面里开宿主原生窗口,
跑一个应用 (`acdebin-dbg app <id>`) 或一个桌面 (`acdebin-dbg desktop <id|包目录>`); `acde dev` 拉起的就是它 (`acde` 先找 `ACDERT`,
再找装在旁边的、PATH 上的 `acdebin-dbg`, 最后才是旧的 `acdert`).

- 仓库根的包 `acdebin-dbg` (`src/`): 可执行文件. `main.rs` 分命令 (`doctor` 自己做, `run` / `desktops` / `sessions` / `applications` / `open` 交给
  `acdert::common`, 其余在 `acde_hostwin::run` 里起 Broker); `platform.rs` 的 `Host` 是 acdert `Platform` 的宿主窗口实现
  (surface 认领给 hostwin、`native` 上加 hostnative 的导出、Windows 的内容类型、文件选择器); `hostnative.rs` 是 `native.Shell` 等宿主窗口
  的 JS 绑定 (用 acdert lib 根上平铺导出的绑定工具); `chooser.rs` 先用 `acde dev` 预设的答案, Linux 上不是无头时走 portal
  (`acdert::Portal`), 否则用宿主窗口的原生对话框; `doctor.rs` 是 `acdebin-dbg doctor [--json]`.
- `crates/hostwin`: 宿主窗口和合成 (见下「宿主窗口」).
- 合成器: 现在直接用 acdert 的 acde-gpu (wgpu: Vulkan / OpenGL / Metal / DX12); acdert 抽出合成器接口后, wgpu (vello) 实现搬到本仓库,
  另加 acgpu 实现 (feature `acgpu`).

## 构建

acdert 要和本仓库并排检出 (`../acdert`): crate 都是 path 依赖, `[patch.crates-io]` 用 `../acdert/vendor`. `Cargo.lock` 不进 git,
拉取之后先 `cargo update`.

```sh
cargo build -p acdebin-dbg                              # target/debug/acdebin-dbg
(cd ../acdert/web && bun install && bun run build)   # acde-host 的 dist
ACDE_APP=../acdert/web/packages/acde-host/dist target/debug/acdebin-dbg doctor
```

不在安装目录里跑时要用 `ACDE_APP` 指向 acdert 的 `web/packages/acde-host/dist`. 用 `acde` (`cli/`): `ACDERT=<本仓库>/target/debug/acdebin-dbg acde dev`.

## 协作规则

- 仓库在内网 Gitea (`origin` = `ssh://git@gitea.dopamine:2333/AC/acdebin-dbg.git`). 不 force push, 不开分支、不开 worktree.
- 提交一律 `git commit -- <自己的路径>`, 英文 Conventional Commits, 不加 Co-Authored-By; 提交前 `cargo fmt --all`、clippy 要过.
- 改 `crates/hostwin` 的提交先在这棵树编出来的 acdebin-dbg 上起一次 (`ACDE_HEADLESS=1` 也行), 写清已验证 / 未验证.

## 宿主窗口

`acde-hostwin` 是调试模式的「合成器」: **一个**宿主原生窗口, 里面按窗口表合成桌面、应用窗口和面板. 对 acde-host 的接口和会话一样
(Broker 的 `native.Shell.broker()` 换成 hostwin 的 `Shell`, crates/host `hostnative.rs`; web 的 `claimSurface` 拿到 hostwin 的
`Surface`, crates/host `surface.rs` 是两种的 enum).

- **结构**: `src/` 顶层是 `lib.rs`、`app.rs`、`shell.rs`、`dev.rs`、`keys.rs`、`platform.rs` (加 `platform/`); `output/` 是出帧到合成
  (`surface.rs`、`present.rs`、`compose.rs`、`gpu.rs`), `system/` 是交给宿主系统的事 (`chooser.rs`、`notify.rs`、`handoff.rs`). 下面只写文件名.
  平台层 (`platform.rs` 的 `Handler` / `HostEvent` / `Cmd`) 只有两个: `platform/win32.rs` (Win32: 窗口、IMM32、剪贴板、`WM_DROPFILES`、
  `SHBrowseForFolderW`、`IFileOpenDialog` / `IFileSaveDialog`、per-monitor DPI v2) 和 `platform/host_winit.rs` (macOS / Linux, winit + arboard; macOS 的选文件夹、打开和保存文件是 `chooser.rs`). `app.rs`:
  命中、拖动、焦点、快捷键、注入. `shell.rs`: 窗口表 (`State` / `Entry`, 层序 desktop < free / fixed < pinned, 再按 z; `Entry.parent` / `modal`
  来自 `grant`, `raise` 把子窗口带到父窗口上方, `modal_child` 找最上层的模态子窗口, `forget` 删窗口时放开它的子窗口); `shell/pointer.rs`: 命中 (`hit`, 模态子窗口挡住父窗口) 和按下 (`press`: 拖动的边、标题区双击). `present.rs`: 每个 web
  一条出帧线程 `acde-host-<id>`, vello 把页面和面板画进各自的纹理, 节奏是宿主窗口所在显示器刷新率的 0.9 倍周期 (`pace`, 不知道时按 60 Hz); `compose.rs`: `acde-compose` 线程按层贴到宿主 surface (AutoVsync).
  页面 / 面板都走 `Presenter::layered` (没有 layers 的 plane 当成一层, `in_layers`), 照 `acde_gpu::Raster::draw_pass` 用 `Composer` 做
  backdrop、投影、模糊和颜色矩阵 (Raster 要 dmabuf, 只在 Linux): 画进每个窗口自己的草稿纹理, 最后一次提交里拷进页面纹理 (分几次提交直接画,
  合成线程会读到只铺了底色的半成品). 草稿留着上一帧: 只重画 plane 的损坏区 (被 backdrop 读到的区域并进来; 超过一半面积就整张重画), 只画
  与它相交的层 (按滤镜外扩), 只拷这块; 没有损坏就不画, 也不叫合成器重画. 这一帧要画的层装箱进 `Composer` 的层画布 (`present.rs` `pack`), 一次 vello 画完
  (`Vello::render_clipped`, 每层裁在自己的格子里), `Composer` 的 `place` / `shadow` / `filtered` 用 `at` 从格子里读; 画布 (只增不减, 页面和面板共用) 装不下才分批.
  格子按 16 px 对齐并留出投影模糊的距离: 同一批里同样 sigma 的投影共用一次对整张画布的模糊 (`Composer::blur_layers`), 相邻的投影和贴层攒成
  一个 render pass (`Composer::draw`, `Op`), 遇到 backdrop、滤镜或换批时先画掉.
  这条路出的是预乘 alpha (`Page.straight` 为 false; 为 true 的非预乘页面合成器先在着色器里乘上 alpha).
- **窗口之间的毛玻璃**: 钉住的面板里 backdrop-filter 最大的那块 (同 window crate 的 `Panel::backdrops`) 和页面的 `acde.window.setBackdrop`
  (窗口本地物理像素, 加窗框高度) 记在 `Entry.backdrop`. 合成器先把各层画进一张离屏画布, 画到带 backdrop 的层之前调 `Composer::backdrop`
  模糊画布上已经画好的部分, 最后把画布贴到 surface; `screenshot` 读的也是这张画布.
- **面板挪位置等内容**: `placePanel` 的新 rect 先挂在 `Entry.pending`, 出帧线程画出这个尺寸 (差 1 px 以内) 的面板后才换上
  (`State::place_when_drawn`; 已经画好了就立刻换). 不然新位置先生效、旧内容 (相对旧原点画的) 贴过去一帧, Dock 放大时整条往旁边跳一下.
  纹理同理: 尺寸变了要新建的页面纹理 (`present.rs` `target`) 先只记在出帧线程里, 第一帧画完并提交后才交给合成线程 (`publish`), 之前合成器继续用旧纹理.
  合成线程每收到一批消息就合成一次, 早交出去会贴上一张空纹理 (面板只剩 backdrop 模糊, 一帧).
- **GPU**: `gpu.rs` 只开 `acde_gpu::BACKEND` 一个后端 (Windows DX12、macOS Metal、Linux Vulkan), 不要 CPU 设备; `WGPU_VALIDATION` /
  `WGPU_DEBUG` 照 wgpu 的环境变量. 所有 `surface.configure` 和提交都拿 `acde_gpu::Gpu::submit_lock`.
  设备请求适配器支持的全部 WebGPU 可选特性 (`acde_gpu::webgpu_features`, #213); 打不开时按 `DeviceRequest::tiers` 依次退到不带可选特性、
  再退到 downlevel 默认限制 (保留适配器的纹理尺寸), 每档失败记 warn, 打开时 info 记是哪一档. Linux 会话 `Device::open` 用同一套档位.
  不重建设备: 设备丢失 (`gpu.rs` 的 `on_lost`) 或合成 / 出帧线程 panic (`guarded`) 时记一条 `host window: … exiting` 的 error, 经 `Cmd::Exit`
  照常退出 (丢失退 1, panic 退 101), 5 秒内没退完直接 `process::exit`. 取 surface 纹理时 Outdated / Lost 重新 configure 后当场再取一次,
  还不行或 Timeout / Occluded 时 50 ms 后再合成一次, 静止的页面不用等下一次输入. `ACDE_HOST_FAULT=outdated|lost|panic` (调试用) 让合成线程
  在第 3 次合成时把这一帧的 surface 当成过期、`acde_gpu::Gpu::destroy` 或 panic. 设备丢失后 (丢失回调或 `destroy`, `Gpu::gone`) wgpu 报的未捕获错误
  只记 debug, 不再 panic (以前出帧线程会在丢失之后多 panic 一次, 无界面时可能挂住不退出, #97).
  wgpu 在出错调用所在的线程上回调未捕获错误: 设了 `acde_gpu::set_error_sink` 的线程 (WebGPU 所在的 web) 交给当前设备的错误作用域或
  `uncapturederror`; 没设的线程 (合成、出帧、光栅化、轮询) 只记一条带线程名的 error, 不 panic (#213).
- **刷新率**: 出帧节奏跟宿主窗口所在的显示器. Win32 (`platform/win32/refresh.rs`) 在窗口挪到另一台显示器 (`WM_MOVE` / `WM_SIZE` /
  `WM_DPICHANGED` 时比 `MonitorFromWindow`) 或 `WM_DISPLAYCHANGE` 后重读这台显示器的当前模式 (`EnumDisplaySettingsW` 按设备名), 发
  `HostEvent::Refresh`; `Server::set_refresh` 变了才记进 `State.refresh` 并给每条出帧线程发 `Msg::Refresh`, 打 `host window: monitor refresh` (启动时也打一次).
  macOS / Linux (winit) 仍只在启动时读一次. 真多显示器、改刷新率还没实测.
- **坐标**: 宿主窗口的内容区就是「屏幕」(`output`: `ACDE_SIZE`, 否则主显示器的 90% × 85%, 最大 1440 × 900), 窗口表的 rect 是它里面的
  逻辑坐标. 单应用模式 (`acdert app`) 的主窗口清单设了 `size` 时, Broker 把它放进带 `host: true` 的那次 grant, `Shell::grant` 对第一次这样的
  grant 发 `Cmd::HostSize`: 宿主窗口还是 `normal` 时把内容区改成这个逻辑尺寸 (Win32 `frame.rs` `resize`: 按窗口 DPI 加上系统边框, 不超出
  所在显示器的工作区, 在工作区里居中, 改完由 `WM_SIZE` 报; winit `request_inner_size`: 它回 `Some` 时 (Wayland 总是, 之后不再发 `Resized`)
  `Host::set_size` 把这个尺寸交回, `App` 当场按它 `resized`, 不然合成器和屏幕留在默认尺寸), 之后照常 `output`. 设了 `ACDE_SIZE` 时以它为准不改; 宿主窗口先按默认尺寸
  显示, Broker 发出 grant 后才改. 没设 `size` 的照旧. headless 不改 (屏幕只看 `ACDE_SIZE`). 宿主窗口改尺寸 / 换缩放时桌面和全屏窗口跟着改 (`State::resize`), 工作区跟着重算: 变了就把 `workarea` 和 `output` 一起交给 Broker
  (`Inbox::push_all`, 同一批取走; 以前只发 `output`, 按 `size` 改过尺寸的单应用窗口 `output.workArea` 还是开窗时的 1361 × 835). Broker (`Outputs.take`) 把一批事件里对输出的改动
  合成一条 `screen` 再发给 web, 页面的 `on('output')` 只收到一次、尺寸和工作区对得上. web 的文档先按 Broker 给的 800 × 600 建, `claimSurface` 时
  (crates/host `webnative.rs`, hostwin `Surface::size`) 立刻换成窗口表里这个窗口的内容尺寸, 在页面脚本运行之前; 不然加载期间
  (`Host.run` 开始 pump 之前) 页面一直是 800 × 600. 出帧线程起来后照常发一次 `resize`.
- **输入**: 平台事件变成 evdev 码 (`keys.rs`) 和逻辑坐标. 按下命中最上面的窗口 (`State::hit`; 面板按 input 区域, 落到 owner; 窗口有模态子窗口时 `Hit.blocked`, 只激活模态子窗口, 指针、滚轮、拖放都不给它), 给它焦点、提前,
  之后的移动和抬起都发给它 (隐式 grab); 按在 grab hint 上由 hostwin 自己拖动 / 改大小. 滚轮发 `wheel` 给指针下的窗口, 同时交给它的出帧线程
  (`Msg::Scroll` → `RenderHandle::scroll_at`) 做默认滚动, 和会话里 crates/window 一样; 指针的位置也交给它 (`Msg::Pointer` →
  `RenderHandle::pointer`, 离开是 -1, -1), CSS 的 `:hover` 才跟着变. 键先过快捷键表再发给焦点窗口; 宿主窗口失焦只发
  `deactivate`. 面板不单独拿焦点: 给面板焦点 (`State::focus_target`) 落到它的 owner, 面板每次放置时的重新显示也不抢焦点, 所以焦点在桌面页面和它的面板之间
  移动时桌面页面不收 `deactivate` (不发 `blur`). 输入法是 `imepreedit` / `imecommit` 事件 (Windows: `WM_IME_COMPOSITION`, 上屏只发 commit, 只有在组字时结束才发空预编辑表示取消);
  候选框位置: 宿主窗口没有 fcitx, acde-host 的 `TextEntry` 用 `InputMethod.area` 把光标矩形交给 `setImeArea`, Windows 上同时设 IMM 的
  组字 / 候选窗口并回答 `WM_IME_REQUEST` 的 `IMR_QUERYCHARPOSITION` (微软拼音这类 TSF 输入法只问它). 拖进来的文件: 指针下的窗口收 `dndenter` (`mime` 是 `["Files"]`) + `dnddrop`;
  `dnddrop` 的 `data` 是空的 (页面看不到绝对路径, #69), 另带 `files` (`Event.files`, 系统拖放的路径, 只有这里和 Linux 会话的
  `drop_performed` 填, 页面发起的拖动没有), 页面的 `File` 和句柄只从 `files` 来 (见「文件」的「拖放和打开请求的句柄」). dev 的 `drop` 请求经
  `Shell.drop(window, paths, x?, y?)` → `Cmd::Drop` 在那个窗口的页面坐标 (默认页面中心) 上走同一个入口 (`dropped`), 指针不动. 页面发起的拖动 (`startDrag`, acde-host `DragSource` 在页面里起的 HTML5 拖放带了数据时): 页面里的
  dragover / drop 由 `DragSource` 自己按指针做, hostwin (`App` 的 `data_drag`, `Cmd::StartDrag`) 只管别的窗口: 按住左键时才接 (否则回
  `dragend {button: 0}`), 指针移到别的 web 上发 `dndenter` (类型) / `dndmove`, 离开发 `dndleave`; 在别的窗口上松手发 `dnddrop` (数据) 再给源
  `dragend {button: 1}`, 不发 `pointerup`; 在源窗口里或没有窗口处松手照常发 `pointerup`. 数据来自页面, 没有 `files` (页面不能替用户担保
  文件). 没有拖动图标.
- **窗框在页面外**: 应用窗口 (清单 `frame` 不是 false) 的 rect 含窗框, 页面拿到 rect 减去窗框的高 (`State::content`). 出帧线程
  (`present.rs` `framed`) 把 render 的 `Decoration` 场景和下移了窗框高度的页面画进同一张纹理, 合成器只看到一层. 命中在窗框上
  (`Hit.bar`) 时页面收不到指针 (收 `pointerleave`); 三个按钮按下和松开在同一个上时发 `framebutton`; 标题栏 (按钮区外) 移动、四边 4 px /
  四角 10 px 改大小, 由 `Entry::grab_hints(&State.theme)` 和页面的 hint (下移窗框高度) 合成, 窗框的优先. `contentOffset` 是 `[0, H]`, 输入法候选框也加 `H`.
  **窗框上的菜单** (单应用会话, 没有桌面显示菜单时; Broker 的 `framesMenus` 是 `options.standalone`): 应用 `setMenus` 时 Broker 绑定菜单项的快捷键 (menu 级, 见「全局快捷键」), 并把整份菜单
  (JSON) 交给 `Shell::set_menus` (`shell/menu.rs` 解析; 没有 `onSelect` 的项当禁用), 存在 `Entry.menus`. `Bar.menus` 是各菜单名, 画在按钮后面
  (`Bar::menus_start`: Mac 样式在三个圆点后, Windows 样式在左边), 标题让到菜单右边 (居中的标题放不下时往右挪, 再不行截断). 出帧线程画标题栏时
  算出各菜单名的矩形写回 `Entry.menu_labels` (需要字体排版, 只有出帧线程有 `Decoration`); 标题栏的移动 hint 从最后一个菜单名右边开始, 按在菜单名上
  不拖动也不数双击. 打开的菜单 (`Entry.menu_open`: 第几个菜单、悬停的项) 由 `Decoration::menu_list` 画在页面上面 (紧贴标题栏下沿, 超出窗口右边时
  左移; 圆角、阴影、分隔线、禁用项变淡、勾、右边是快捷键的文字: Mac 样式 `⌃⌥⇧⌘`, Windows 样式 `Ctrl+Shift+…`), 各行的矩形写回 `Entry.menu_place`.
  开着时每帧整张重画 (页面的局部重画会盖掉列表), 关上后再整张画一次. 输入 (`app.rs`): 按在菜单名上打开; 开着时按在某一项上、松开时还在同一项上
  就选中 (`menuselect {window, key: 菜单 id, title: 项 id}` → Broker 调应用窗口的 `menu`, 和桌面的 `invokeMenu` 一样); 按在打开的菜单名上或别处关上
  (这一下不给页面); 指针移到另一个菜单名上换过去; 上下键在可选的项间移动 (跳过分隔线和禁用项, 首尾相接), 左右键换菜单, 回车 / 空格选中, Esc 关上;
  开着时键、滚轮、指针移动都不给页面; 宿主窗口失焦时关上. `Shell::menus(window)` 是给 inspect 的 JSON (菜单名和打开的列表, 窗口坐标).
  **双击标题栏**: 左键按在最上面的 hint 是「没有 edges」的地方 (运行时的标题栏, 或 `frame: false` 页面自己给的标题区) 时由 `State::press` 数次数
  (crates/model `Clicks`: 同一个窗口、平台双击时间内、平台双击矩形内; Windows 是 `GetDoubleClickTime` / `SM_CXDOUBLECLK`, headless 和 winit 是
  500 ms、4 × 4); 第二下按照桌面声明的动作 (`State.double_click`, model `DoubleClick`: `fill` 铺满 / 还原, `minimize`, `none`; 默认 `fill`)
  请求状态, 这一下不开始拖动, 计数归零. 只有 `free` 窗口照做, `fixed` 吃掉这一下不动, `pinned`、桌面、面板不算. 按住拖动照常移动.
- **注入** (`Shell.inject`): `Cmd::Inject` 到主线程, 和真输入走同一段代码 (命中、拖动、快捷键); 注入的修饰键和真的合起来匹配; 按键带 US 布局
  的字符 (`keys::us_text`). 中文等走 `acde:inspect` 的 `type`, 不经注入.
- **别的**: `capture(window)` (出帧线程读回这个窗口的页面纹理编 PNG; 还没画出第一帧时等到画出, 最多 10 秒), `screenshot(path)` (合成线程按窗口表把所有页面
  画进一张离屏的 `Rgba8Unorm` 纹理, 读回编 PNG 写到 path, 回 `{width, height}`, 和会话的 `Shell.screenshot` 同一个接口; 最多等 10 秒),
  `approve` / `dismissApproval` (批准对话框, 见「批准」), `notify` (`notify.rs`: macOS osascript, Linux `org.freedesktop.Notifications`; Windows 不绑定, 见「通知」), `openDefault` (`handoff.rs`, 只在 macOS / Windows,
  见「默认应用」), `devRespond`, `screen`, `shortcut`, `windows`,
  `launch`. `animate` 和会话一样走 model 的 `Transition` / `Look` (`State::animate` / `advance`): 合成线程每帧插值, 按 look 缩放、平移、
  调透明度画这个窗口 (最近点取样), 命中按 look 反算, 做完发 `windowanimated`; 窗口不存在时立刻发. `requestGrab` 一律授予. 宿主窗口的关闭按钮发 `windowcloserequest`:
  桌面的结束会话. `ACDE_HOST_DUMP=<目录>` 让合成器在画面停下 300 ms 后把整个合成结果读回写成 `screen.png` (和 `screenshot` 同一段).
- **独立应用的主窗口用宿主的控件** (`acdert app`, 平台层 `Host::controls()` 为真时, 现在只有 Win32): Broker 给 `acdert app <id>` 起的那个窗口的
  `grant` 带 `host: true`, 窗口表记 `Entry.host`. 它没有运行时的窗框 (`frame` 按 0), 宿主窗口自己的标题栏和按钮是唯一的一套; 标题交给宿主窗口.
  没有宿主控件的平台 (macOS / Linux winit) 也把第一个这样的窗口记成 `Entry.primary`, 它画运行时的窗框, 标题同样交给宿主窗口 (`Cmd::Title`),
  所以 Dock、⌘Tab、任务栏显示应用的标题, 不是 `acde`.
  它的状态落到宿主窗口上 (`request_state` 发 `Cmd::HostState`, `platform/win32/frame.rs`): 最小化是最小化宿主窗口, `filled` 是最大化 (平台工作区),
  全屏是去掉边框铺满所在显示器 (记下样式和位置, 回去时还原), `normal` 还原. 用户在平台上做的 (任务栏最小化、`Win+Down`、Snap、标题栏最大化)
  由 `WM_SIZE` 变成 `HostEvent::State`, 运行时照收并照常发 `state` / `windowstate`; Snap 后是 `normal` 加新尺寸. 页面的 grab hint 变成
  `WM_NCHITTEST` 的结果 (没有 edges 是 `HTCAPTION`: 系统的拖动、Snap、双击最大化; 有 edges 是对应的改大小边框). 宿主窗口所在显示器的尺寸、缩放和
  工作区经 `hostoutput` / `hostworkarea` 给 Broker (`broker/output.ts` `Outputs`), 只给这个窗口当 `acde:window.output`, 换显示器时变.
  页面经 `claimSurface` 的 `hostControls` 知道, `acde.window.hostControls` (加 `on('hostcontrols')`) 是每个窗口自己的值, 任何窗口都可能为真,
  本版本只有独立应用的主窗口为真. 别的窗口、完整桌面、headless 和 winit 的宿主照旧.
  独立应用里宿主窗口的关闭按钮 (`windowcloserequest` 窗口 0) 先问主窗口的 `beforeclose` (同样最多等 3 秒), 拒绝时宿主留着; 完整桌面里照旧结束会话.
  独立应用开的别的窗口 (`State.standalone` 之后 grant 的, `Entry.minimize` 为假) 保留运行时窗框, 照常挪、改尺寸、关, 但不能最小化 (没有 Dock 找回来):
  窗框的最小化按钮画成灰的、按了没反应, 运行时拒绝变成 `minimized`, `acde.window.minimize()` 和 `acde.windows.requestState(id, 'minimized')`
  以 `AcdeWindowError` (`code: 'unavailable'`, `status: 409`) 拒绝. `acde.window.minimizable` (加 `on('minimizable')`) 是每个窗口自己的值.
  **能不能最小化只有一个说法** (`Entry::minimizable`: 宿主替它做 (`host`), 或者 `minimize` 为真、不是桌面和面板、模式允许最小化): 窗框按钮的灰显、
  `Surface::minimizable`、`windows()` 行的 `minimize` 都用它. 所以宿主没有自己控件的平台 (macOS / Linux 的 winit 宿主、headless) 上, 独立应用的主窗口 (内部是
  `fullscreen` 模式, 没人替它最小化) 也是不能最小化的: `minimizable` 为假, 窗框的最小化按钮是灰的, `minimize()` 以同一个 409 拒绝, `acde:inspect` 的
  `act <窗口> minimize` 回 `ok: false` 和原因, 不再回「已最小化」而什么都没变. 原因的文字在 `WindowCalls.unminimizable(行)` 一处: 桌面、铺满宿主窗口的主窗口
  (`it fills the host window, which only the host window's own controls minimize here`)、钉住的窗口、独立应用的别的窗口 (`a standalone app has no Dock to bring it back`).
- **不显示 (`ACDE_HEADLESS=1`)**: 平台层在运行时二选一 (`platform.rs`: `Host` 是 trait, `Proxy` 是 enum; 原生的 win32 / winit 和
  `platform/headless.rs`). headless 不开窗口: 主线程只收 `Cmd` (`Exit` 时退出), 屏幕是 `ACDE_SIZE` (否则 1440 × 900) 乘 `ACDE_SCALE`
  (0.5–4, 默认 1), 起来就算宿主窗口有焦点. 合成器没有 surface: 不出画面、不数 `frames`, 但页面照常出帧 (出帧线程的节奏不靠宿主窗口),
  `capture` / `screenshot` / `ACDE_HOST_DUMP` 照常读回. 注入和真窗口走同一段 (`App::inject`). 只在 headless 下不同的: 剪贴板是进程里的一份
  (不碰系统剪贴板), 选文件夹、打开和保存文件没有事先的答复 (`choose`) 时回错 (Linux 的 headless 也不问 portal), 系统通知只写一行 info 日志 (不弹出), 标题和输入法区域不做. 仍然要 GPU (「GPU 与性能」: 网页只在
  GPU 上画, 不认 lavapipe): 能在有 Metal 的 macOS 机器 (含 GitHub 的 macOS runner, 没验) 或有 GPU 的 Linux / Windows 上无人值守地跑, 不能在
  没有 GPU 的 Linux CI 上跑. Linux 上设了它就算「在别人的桌面里」, 不要 `WAYLAND_DISPLAY` / `DISPLAY`.
- **系统能力**: fs、选文件夹、声音、剪贴板到处都有; 打开 / 保存文件在 Linux (portal)、macOS (`NSOpenPanel` / `NSSavePanel`) 和 Windows (Common Item Dialog, `platform/win32/dialog.rs`) 有; 应用后端的 unix socket 只在 unix; network、office、runtime 的 IME、语音、
  WebGPU 只在 Linux (WebGL 到处都有, 见「WebGL」). OpenSSL 在 macOS / Windows 上静态编进去 (`vendored`), 它不带根证书: runtime `http.rs` 的 `tls()` 在那两处从系统证书库
  (Keychain / Windows 证书存储, rustls-native-certs) 读进来; Linux 用系统的 OpenSSL 和它的证书目录. Windows 的证书库是按需下载的
  (第三方根证书要等系统自己的 TLS 第一次用到才进库), 所以 Windows 上 OpenSSL 校验失败时 (`system_trusts`) 再把对方的证书链交给
  `CertGetCertificateChain` + `CertVerifyCertificateChainPolicy` (SSL 策略, 带主机名) 验一次, 它会下载缺的根证书; 两边都不认才拒绝.
  页面联网的 TLS 握手超时是 30 秒 (`tls_config`, ntex 默认 5 秒, 走代理的慢站点握不完).
