# 宿主窗口 (`crates/hostwin`)

> 路径相对 `crates/hostwin/`。`src/host`、`src/model`、`src/render` 和不带出处的「章节」(「批准」「通知」「文件」「默认应用」
> 「全局快捷键」「GPU 与性能」「WebGL」) 指 libacde 的源码和它的 AGENTS.md。

`acde-hostwin` 是调试模式的「合成器」: **一个**宿主原生窗口, 里面按窗口表合成桌面、应用窗口和面板. 对 acde-host 的接口和会话一样
(Broker 的 `native.Shell.broker()` 换成 hostwin 的 `Shell`, 本仓 `src/hostnative.rs`; web 的 `claimSurface` 拿到 hostwin 的
`Surface`, src/host `surface.rs` 是两种的 enum).

- **结构**: `src/` 顶层是 `lib.rs`、`app.rs`、`shell.rs`、`dev.rs`、`keys.rs`、`platform.rs` (加 `platform/`); `output/` 是出帧到合成
  (`surface.rs`、`present.rs`、`compose.rs`、`gpu.rs`), `system/` 是交给宿主系统的事 (`chooser.rs`、`notify.rs`、`handoff.rs`). 下面只写文件名.
  平台层 (`platform.rs` 的 `Handler` / `HostEvent` / `Cmd`) 只有两个: `platform/win32.rs` (Win32: 窗口、IMM32、剪贴板、`WM_DROPFILES`、
  `SHBrowseForFolderW`、`IFileOpenDialog` / `IFileSaveDialog`、per-monitor DPI v2) 和 `platform/host_winit.rs` (macOS / Linux, winit + arboard; macOS 的选文件夹、打开和保存文件是 `chooser.rs`). `app.rs`:
  命中、拖动、焦点、快捷键、注入. `shell.rs`: 窗口表 (`State` / `Entry`, 层序 desktop < free / fixed < pinned, 再按 z; `Entry.parent` / `modal`
  来自 `grant`, `raise` 把子窗口带到父窗口上方, `modal_child` 找最上层的模态子窗口, `forget` 删窗口时放开它的子窗口); `shell/pointer.rs`: 命中 (`hit`, 模态子窗口挡住父窗口) 和按下 (`press`: 拖动的边、标题区双击). `present.rs`: 每个 web
  一条出帧线程 `acde-host-<id>`, vello 把页面和面板画进各自的纹理; `compose.rs`: `acde-compose` 线程按层贴到宿主 surface (AutoVsync).
  **出帧节奏** (`vsync.rs`): macOS 上页面的帧跟显示器的 vsync 走, 和浏览器的 rAF 一样. 一条
  `CVDisplayLink` (主显示器; `CVDisplayLinkCreateWithActiveCGDisplays`, API 已标过时但仍可用, 换 `NSWindow.displayLink` 要在主线程建 CADisplayLink)
  在它自己的线程上回调, 回调给「想要 vsync」的出帧线程发 `Msg::Vsync`; 出帧线程在页面要帧 (`requestFrame`) 或有动画时想要 vsync
  (`Follower::want(Pacer::wants())`), 收到就 `Pacer::vsync` 出一帧. 没人想要 1 秒后 `acde-vsync` 线程停掉 display link, 有人想要时再开.
  定时器 (`pace`: 显示器刷新率的 0.9 倍周期, 不知道时按 60 Hz) 只在三种情况下出帧: 停了一阵后的第一帧 (不等 vsync), vsync 停了 (4 个周期没来),
  没有 display link (别的平台、建不出来、`ACDE_NO_VSYNC=1`、设了 `ACDE_WEB_FPS`). 跟 vsync 走时 surface 的 `desired_maximum_frame_latency` 是 1
  (CAMetalLayer 两个 drawable), 否则 2. 原来的定时器每 15 ms 一帧比 60 Hz 的显示器快 (计时器还会晚 1–3 ms, 实际 55–66 帧/秒不定), 合成线程在
  `nextDrawable` 上等, 三个 drawable 的队列一直是满的, 每帧多等一个刷新周期 (上屏比交出晚 48.7 ms, 现在 32 ms); 另外每 5 秒有 14–27 帧画了没上屏.
  页面 / 面板都走 `Presenter::layered` (没有 layers 的 plane 当成一层, `in_layers`), 照 `acde_gpu::Raster::draw_pass` 用 `Composer` 做
  backdrop、投影、模糊和颜色矩阵 (Raster 要 dmabuf, 只在 Linux): 画进每个窗口自己的草稿纹理, 最后一次提交里拷进页面纹理 (分几次提交直接画,
  合成线程会读到只铺了底色的半成品). 草稿留着上一帧: 只重画 plane 的损坏区 (被 backdrop 读到的区域并进来; 超过一半面积就整张重画), 只画
  与它相交的层 (按滤镜外扩), 只拷这块; 没有损坏就不画, 也不叫合成器重画. 这一帧要画的层装箱进 `Composer` 的层画布 (`present.rs` `pack`), 一次 vello 画完
  (`Vello::render_clipped`, 每层裁在自己的格子里), `Composer` 的 `place` / `shadow` / `filtered` 用 `at` 从格子里读; 画布 (只增不减, 页面和面板共用, 闲时放掉) 装不下才分批.
  格子按 16 px 对齐并留出投影模糊的距离: 同一批里同样 sigma 的投影共用一次对整张画布的模糊 (`Composer::blur_layers`), 相邻的投影和贴层攒成
  一个 render pass (`Composer::draw`, `Op`), 遇到 backdrop、滤镜或换批时先画掉.
  这条路出的是预乘 alpha (`Page.straight` 为 false; 为 true 的非预乘页面合成器先在着色器里乘上 alpha).
  闲时放内存: 最后一次画出新内容 2 秒后 (`IDLE_TRIM`, `Presenter::trim`; `wait` 把这个时刻算进等待) 出帧线程放掉 `Composer` 的层画布和缓存的模糊纹理
  (`Composer::trim`) 和 vello 的中间缓冲 (`Vello::trim` 重建 renderer: vello 的每个 renderer 画过一次就一直留着约 165 MiB 的缓冲和图片图集,
  见 libacde 的 `docs/graphics/render-gpu.md`「vello 的中间缓冲」), 设备丢了时不做. 草稿和页面纹理留着 (下一帧只重画损坏区, 合成器要读).
  之后的第一帧重新分配这些缓冲. 帧率面板自己的 Vello (`compose.rs` `Meter`, 只在调试时开) 和合成线程的离屏画布不放.
  「2 秒」从最后一次 **vello 画** 算起 (`trim_at`, `velloed`), 不是从最后一次出帧: 只有 WebGPU canvas 在变、DOM 没变的帧不经 vello (下一条), 所以
  canvas 一直在动 (比如选区的蚂蚁线每 100 ms 一帧) 时 vello 的中间缓冲照样在 2 秒后放掉. 最后一次出帧 2 秒后 (`idle_at`) 再放掉下一条留的上层纹理.
- **只有 WebGPU canvas 变了的帧** (`Presenter::canvas_only`, libacde `vello::Hole` / `Kept`): 一个窗口的这一帧只有一层、没有 backdrop / 滤镜 / 投影,
  要重画的范围里恰好有一个不透明 (`alphaMode: 'opaque'`, `GpuImage::opaque`) 的 GPU 图片, 一像素对一像素、整像素位置地铺满一个矩形, 外面只套着
  矩形裁剪 (不透明度 1、普通混合), 而且这块范围里的场景除了这张图片是哪一张以外和上一帧完全一样 (`Kept::matches`: 逐条命令比, 别的 GPU 图片还比
  `generation`; 标题栏场景也比): 不画 vello, 把 canvas 的纹理直接拷进草稿的那个矩形 (`copy_texture_to_texture`), 再把盖在 canvas 上面的内容
  (`Hole::above`: 图片之后的命令, 套上同样的裁剪) 贴上去 (`Composer::place_from`, 预乘 over), 拷到页面纹理. 上层内容在场景第二次相同的那一帧用
  vello 画一次, 留在 `acde host above` 纹理里 (矩形大小), 之后的帧直接用; 场景一变、窗口改大小、标题栏或菜单变了 (`invalidate`) 都扔掉, 走原来的路.
  拷完 `GpuImage::mark_copied`, 页面那边才复用这张图片 (和 vello 拷进图集后一样). 条件不满足 (半透明 canvas、带圆角或变换、
  两个 WebGPU canvas、DOM 也在变) 时照旧整块用 vello 画. 和 vello 画的结果比, 只在上层内容半透明的像素 (抗锯齿边、阴影) 上差 1 (多量化一次).
- **窗口之间的毛玻璃**: 钉住的面板里 backdrop-filter 最大的那块 (同 window crate 的 `Panel::backdrops`) 和页面的 `acde.window.setBackdrop`
  (窗口本地物理像素, 加窗框高度) 记在 `Entry.backdrop`. 合成器先把各层画进一张离屏画布, 画到带 backdrop 的层之前调 `Composer::backdrop`
  模糊画布上已经画好的部分, 最后把画布贴到 surface; `screenshot` 读的也是这张画布.
  页面图层里的磨砂按元素的 CSS 角形画 (`present.rs` `part` 交 `Backdrop::exponent()`, 超椭圆指数 `n`, 见 libacde `docs/graphics/render-gpu.md`);
  窗口级的 `setBackdrop` 也带角形 (libacde issue 16: `SurfaceCommand::Backdrop` 的第 5 个数是指数, `Entry.backdrop` 照存, `compose.rs` 交给 `gpu::Backdrop`). 系统玻璃 (`Backdrop::glass()`) 也交给 `gpu::Backdrop`, 但 libacde 的进程内合成这一版仍按普通磨砂画. 桌面的 `setWindowLook` (窗口外圆角与阴影, 由 acdes 的合成器画) 宿主窗口不画, `SurfaceCommand::WindowLook` 直接忽略.
- **窗口背景材质** (2026-11-23, libacde `acde.window.setMaterial`): `SurfaceCommand::Material(WindowMaterial)` 记在 `Entry.material` (`none` 即清掉), 合成时
  `compose.rs` 的 `material` 按名字查 acde-scene 的材质表 (`Material::resolve(..).with_overrides(role, preference(), overrides)`, 查不到按 none 不画),
  得到的 `Glass` 乘缩放后作为这一层的第一块 `gpu::Backdrop` 画在窗口内容之下: 铺满整扇窗口 (页面纹理大小, 含窗框), `titlebar` 时只铺窗框高度. `glass` 和 `blur` 都走玻璃管线
  (blur 的参数没有透镜和高光). 跨窗口融合 (`group` / `spacing`) 宿主窗口这一版不做, 各窗口各画各的; 材质按直角铺满, 还不跟窗口外形走.
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
  逻辑坐标. 单应用模式 (`acdev runtime app`) 的主窗口清单设了 `size` 时, Broker 把它放进带 `host: true` 的那次 grant, `Shell::grant` 对第一次这样的
  grant 发 `Cmd::HostSize`: 宿主窗口还是 `normal` 时把内容区改成这个逻辑尺寸 (Win32 `frame.rs` `resize`: 按窗口 DPI 加上系统边框, 不超出
  所在显示器的工作区, 在工作区里居中, 改完由 `WM_SIZE` 报; winit `request_inner_size`: 它回 `Some` 时 (Wayland 总是, 之后不再发 `Resized`)
  `Host::set_size` 把这个尺寸交回, `App` 当场按它 `resized`, 不然合成器和屏幕留在默认尺寸), 之后照常 `output`. 设了 `ACDE_SIZE` 时以它为准不改; 宿主窗口先按默认尺寸
  显示, Broker 发出 grant 后才改. 没设 `size` 的照旧. headless 不改 (屏幕只看 `ACDE_SIZE`). 宿主窗口改尺寸 / 换缩放时桌面和全屏窗口跟着改 (`State::resize`), 工作区跟着重算: 变了就把 `workarea` 和 `output` 一起交给 Broker
  (`Inbox::push_all`, 同一批取走; 以前只发 `output`, 按 `size` 改过尺寸的单应用窗口 `output.workArea` 还是开窗时的 1361 × 835). Broker (`Outputs.take`) 把一批事件里对输出的改动
  合成一条 `screen` 再发给 web, 页面的 `on('output')` 只收到一次、尺寸和工作区对得上. web 的文档先按 Broker 给的 800 × 600 建, `claimSurface` 时
  (src/host `webnative.rs`, hostwin `Surface::size`) 立刻换成窗口表里这个窗口的内容尺寸, 在页面脚本运行之前; 不然加载期间
  (`Host.run` 开始 pump 之前) 页面一直是 800 × 600. 出帧线程起来后照常发一次 `resize`.
- **输入**: 平台事件变成 evdev 码 (`keys.rs`) 和逻辑坐标. 按下命中最上面的窗口 (`State::hit`; 面板按 input 区域, 落到 owner; 窗口有模态子窗口时 `Hit.blocked`, 只激活模态子窗口, 指针、滚轮、拖放都不给它), 给它焦点、提前,
  之后的移动和抬起都发给它 (隐式 grab); 按在 grab hint 上由 hostwin 自己拖动 / 改大小. 滚轮发 `wheel` 给指针下的窗口, 同时交给它的出帧线程
  (`Msg::Scroll` → `RenderHandle::scroll_at`) 做默认滚动, 和会话里 crates/window 一样; 指针的位置也交给它 (`Msg::Pointer` →
  `RenderHandle::pointer`, 离开是 -1, -1), CSS 的 `:hover` 和光标才跟着变. 每个 `CursorMoved` (和注入的 `move`) 都是一个 `pointermove`
  排进那个窗口的队列 (libacde model `Inbox` 不合并), 页面按帧派发一次、其余的作为 `getCoalescedEvents()` 的样本 (libacde `docs/web/web-apps.md`「指针事件」);
  winit 0.30 不给 NSEvent 的时间戳, 样本的 `timeStamp` 是主线程排队的时刻; AppKit 自己在主线程忙时合并鼠标事件 (`NSEvent.isMouseCoalescingEnabled`, winit 没关) 这一层没有动. 键先过快捷键表再发给焦点窗口; 宿主窗口失焦只发
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
- **指针锁定** (页面一侧见 libacde `docs/web/web-apps.md`「指针锁定」): 页面的 `SurfaceCommand::PointerLock(on)` 经 `Cmd::PointerLock` 到主线程
  (`App::lock` / `unlock`). 给锁的条件: 宿主窗口有焦点、这个窗口是焦点窗口且显示着、没有在拖动窗口或数据、没有打开的窗框菜单; 再由平台层
  `Host::lock_pointer(true)` 真的锁住 (winit: `CursorGrabMode::Locked`, 不支持时退到 `Confined`, 再藏起光标; headless 只记状态, 算成功;
  Win32 还没有, `Surface::pointer_lock` 为假, 页面直接拒绝). 回答 `pointerlock {code, title: 'request'}`. 锁着时: 平台的
  `CursorMoved` / 离开不用, 相对移动是 winit 的 `DeviceEvent::MouseMotion` (`HostEvent::Motion`, macOS 是 NSEvent 的 deltaX / deltaY, 带系统加速,
  逻辑像素; X11 / Wayland 是不带加速的原始量), 发给锁着的窗口 `pointermove {x, y: 锁定时的页面坐标, deltaX, deltaY}`; 按钮和滚轮都给它, 不命中、
  不拖窗口、不开菜单; 注入的 `move` 按和上一次注入位置的差、`motion` 按原值变成相对移动 (dev 的 `input` 和 driver 照样能测). 收回并发
  `pointerlock {code: 0, title: 'lost'}`: Esc (这次按下和松开都不发给页面)、宿主窗口失焦 (选择器、批准对话框、⌘Tab 也是这一条)、焦点给了别的窗口
  (`Server::activate` / `focus_top` 发 `Cmd::FocusMoved`). 页面 `exitPointerLock` 或窗口没了 (`Surface` drop) 时不回答, 直接放开. 放开时还按着的按钮照旧有抬起: 那个窗口成为隐式 grab 的目标
  (`capture`), 抬起发给它.
- **帧率面板** (调试用, 画法见 libacde `docs/graphics/render-gpu.md`「帧率面板」): `ACDE_HUD=1` 时起来就开着; 有 `ACDE_DEV` 时 Shift+F12
  开关 (`dev::DevtoolsKey`, 和 F12 一样按住的重复和松开都吞掉, 不给页面). 数在出帧线程记 (`output/hud.rs`): `Presenter::paint` 每画出页面的一帧新内容
  记一次时刻和这一帧的光栅化毫秒 (同 `perf::raster` 的 `surface ms`), 每个窗口留最近 120 个帧间隔; 关着时不记. FPS 是最近一秒里画出的帧数,
  平均是这些帧的间隔, 合成器重画不算帧, 所以静止的页面显示 idle. 合成线程 (`compose.rs` `meter`) 把它画成最上面一层: 焦点窗口 (没有时最上层的窗口)
  内容区右上角, 离边 8 px, 预算按 `State.refresh` (不知道时 60 Hz); 场景最多 100 ms 重画一次 (自己的 Vello, 纹理按缩放建, 换 GPU 设备时扔掉),
  页面不出帧时每 500 ms 合成一次, 让数字落到 idle
  (`Meter.idle_at`: 画过面板才排下一次; 合成提前返回 (headless 没有 surface、取不到 surface 纹理) 时不排, 不空转). `screen` 截图里也有它.
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
  (src/model `Clicks`: 同一个窗口、平台双击时间内、平台双击矩形内; Windows 是 `GetDoubleClickTime` / `SM_CXDOUBLECLK`, headless 和 winit 是
  500 ms、4 × 4); 第二下按照桌面声明的动作 (`State.double_click`, model `DoubleClick`: `fill` 铺满 / 还原, `minimize`, `none`; 默认 `fill`)
  请求状态, 这一下不开始拖动, 计数归零. 只有 `free` 窗口照做, `fixed` 吃掉这一下不动, `pinned`、桌面、面板不算. 按住拖动照常移动.
- **光标** (页面一侧见 libacde `docs/web/web-apps.md`「光标」): `Surface::claim` 给页面的 render 装 `RenderHandle::on_cursor`, 光标变了时
  (render 线程) 发 `Cmd::Cursor {window, cursor}` 到主线程, `App.cursors` 按窗口记下. 每个宿主事件处理完后 `App::show_cursor` 取指针下的窗口
  (`App.hover`) 的光标; 不在页面上 (窗框、标题栏、窗口外)、在拖窗口或开着窗框菜单时是 `default`; 变了才调 `Host::set_cursor`. winit
  (`host_winit.rs`): CSS 名字照 `CursorIcon::from_str` (cursor-icon 的名字就是 CSS 的, 认不出的用默认箭头), `none` 是 `set_cursor_visible(false)`;
  指针锁着时只记下, 放开时按记下的恢复 (`none` 仍然藏着). macOS 上 winit 把 `move` / `cell` 映射到 HIServices 里 WebKit 的光标,
  `help` / `zoom-in` / `zoom-out` / 斜向改大小映射到 AppKit 的私有光标, `wait` / `progress` 是 `busyButClickableCursor`. debug 日志
  `host window: cursor <名字>` (`RUST_LOG=acde_hostwin=debug`). headless 和 Win32 (`Host::set_cursor` 缺省什么都不做) 还没有, Win32 一直是箭头.
- **数位板** (2026-11-21 查): 还没有. winit 0.30.13 (`Cargo.lock`) 的 macOS 后端 (`platform_impl/macos/view.rs`) 把笔当鼠标, `CursorMoved` 只有位置,
  不读 NSEvent 的 `pressure` / `tilt` / `subtype` (`NSEventSubtypeTabletPoint`), 也不处理 `tabletPoint:` / `tabletProximity:`; 有压力的只有
  `WindowEvent::TouchpadPressure` (Force Touch 触控板的按压力度和档位, 不是指针的压力, 不拿来顶替) 和 `Touch.force` (Windows / iOS / Android / Web
  的触摸, macOS 不发). 要做得自己在 `NSView` 上接 tablet 事件, 或等 winit 的新指针事件接口.
- **注入** (`Shell.inject`): `Cmd::Inject` 到主线程, 和真输入走同一段代码 (命中、拖动、快捷键); 注入的修饰键和真的合起来匹配; 按键带 US 布局
  的字符 (`keys::us_text`). 中文等走 `acde:inspect` 的 `type`, 不经注入.
- **别的**: `capture(window)` (出帧线程读回这个窗口的页面纹理编 PNG; 还没画出第一帧时等到画出, 最多 10 秒), `screenshot(path)` (合成线程按窗口表把所有页面
  画进一张离屏的 `Rgba8Unorm` 纹理, 读回编 PNG 写到 path, 回 `{width, height}`, 和会话的 `Shell.screenshot` 同一个接口; 最多等 10 秒),
  `approve` / `dismissApproval` (批准对话框, 见「批准」), `notify` (`notify.rs`: macOS osascript, Linux `org.freedesktop.Notifications`; Windows 不绑定, 见「通知」), `openDefault` (`handoff.rs`, 只在 macOS / Windows,
  见「默认应用」), `devRespond`, `screen`, `shortcut`, `windows`,
  `launch`. `animate` 和会话一样走 model 的 `Transition` / `Look` (`State::animate` / `advance`): 合成线程每帧插值, 按 look 缩放、平移、
  调透明度画这个窗口 (最近点取样), 命中按 look 反算, 做完发 `windowanimated`; 窗口不存在时立刻发. `requestGrab` 一律授予. 宿主窗口的关闭按钮发 `windowcloserequest`:
  桌面的结束会话. `ACDE_HOST_DUMP=<目录>` 让合成器在画面停下 300 ms 后把整个合成结果读回写成 `screen.png` (和 `screenshot` 同一段).
- **独立应用的主窗口用宿主的控件** (`acdev runtime app`, 平台层 `Host::controls()` 为真时: Win32 和 winit (macOS / Linux), headless 没有): Broker 给 `acdev runtime app <id>` 起的那个窗口的
  `grant` 带 `host: true`, 窗口表记 `Entry.host`. 它没有运行时的窗框 (`frame` 按 0), 宿主窗口自己的标题栏和按钮是唯一的一套; 标题交给宿主窗口.
  没有宿主控件的平台 (headless) 也把第一个这样的窗口记成 `Entry.primary`, 它画运行时的窗框, 标题同样交给宿主窗口 (`Cmd::Title`),
  所以 Dock、⌘Tab、任务栏显示应用的标题, 不是 `acdev`. (2026-11-19 之前 macOS / Linux 也这样, 宿主窗口的系统标题栏下面还有一条运行时的窗框, 两层.)
  它的状态落到宿主窗口上 (`request_state` 发 `Cmd::HostState`, `platform/win32/frame.rs`): 最小化是最小化宿主窗口, `filled` 是最大化 (平台工作区),
  全屏是去掉边框铺满所在显示器 (记下样式和位置, 回去时还原), `normal` 还原. 用户在平台上做的 (任务栏最小化、`Win+Down`、Snap、标题栏最大化)
  由 `WM_SIZE` 变成 `HostEvent::State`, 运行时照收并照常发 `state` / `windowstate`; Snap 后是 `normal` 加新尺寸. 页面的 grab hint 变成
  `WM_NCHITTEST` 的结果 (没有 edges 是 `HTCAPTION`: 系统的拖动、Snap、双击最大化; 有 edges 是对应的改大小边框).
  winit (`platform/host_winit.rs`): 最小化 `set_minimized`, `filled` 是 `set_maximized` (macOS 是缩放), 全屏 `Fullscreen::Borderless` (macOS 是系统的全屏空间),
  `normal` 都撤掉; 用户在系统标题栏上做的 (红绿灯、双击标题栏、拖到屏幕边) 在 `Resized` / `Moved` / `Occluded` / `Focused` 之后按
  `is_minimized` / `fullscreen` / `is_maximized` 重新判断, 变了发 `HostEvent::State`. 页面的 grab hint 在按下左键时由 `App::host_hint` 处理:
  没有 edges 的交给 `Window::drag_window` (系统的移动), 有 edges 的交给 `drag_resize_window`, 这一下不给页面; 没有 edges 处的双击按
  `State.double_click` (默认铺满 / 还原). winit 拿不到显示器的工作区, 不发 `hostoutput` / `hostworkarea`. 宿主窗口所在显示器的尺寸、缩放和
  工作区经 `hostoutput` / `hostworkarea` 给 Broker (`broker/output.ts` `Outputs`), 只给这个窗口当 `acde:window.output`, 换显示器时变.
  页面经 `claimSurface` 的 `hostControls` 知道, `acde.window.hostControls` (加 `on('hostcontrols')`) 是每个窗口自己的值, 任何窗口都可能为真,
  本版本只有独立应用的主窗口为真. 别的窗口、完整桌面和 headless 照旧.
  独立应用里宿主窗口的关闭按钮 (`windowcloserequest` 窗口 0) 先问主窗口的 `beforeclose` (同样最多等 3 秒), 拒绝时宿主留着; 完整桌面里照旧结束会话.
  独立应用开的别的窗口 (`State.standalone` 之后 grant 的, `Entry.minimize` 为假) 保留运行时窗框, 照常挪、改尺寸、关, 但不能最小化 (没有 Dock 找回来):
  窗框的最小化按钮画成灰的、按了没反应, 运行时拒绝变成 `minimized`, `acde.window.minimize()` 和 `acde.windows.requestState(id, 'minimized')`
  以 `AcdeWindowError` (`code: 'unavailable'`, `status: 409`) 拒绝. `acde.window.minimizable` (加 `on('minimizable')`) 是每个窗口自己的值.
  **能不能最小化只有一个说法** (`Entry::minimizable`: 宿主替它做 (`host`), 或者 `minimize` 为真、不是桌面和面板、模式允许最小化): 窗框按钮的灰显、
  `Surface::minimizable`、`windows()` 行的 `minimize` 都用它. 所以宿主没有自己控件的平台 (headless) 上, 独立应用的主窗口 (内部是
  `fullscreen` 模式, 没人替它最小化) 也是不能最小化的: `minimizable` 为假, 窗框的最小化按钮是灰的, `minimize()` 以同一个 409 拒绝, `acde:inspect` 的
  `act <窗口> minimize` 回 `ok: false` 和原因, 不再回「已最小化」而什么都没变. 原因的文字在 `WindowCalls.unminimizable(行)` 一处: 桌面、铺满宿主窗口的主窗口
  (`it fills the host window, which only the host window's own controls minimize here`)、钉住的窗口、独立应用的别的窗口 (`a standalone app has no Dock to bring it back`).
- **不显示 (`ACDE_HEADLESS=1`)**: 平台层在运行时二选一 (`platform.rs`: `Host` 是 trait, `Proxy` 是 enum; 原生的 win32 / winit 和
  `platform/headless.rs`). headless 不开窗口: 主线程只收 `Cmd` (`Exit` 时退出), 屏幕是 `ACDE_SIZE` (否则 1440 × 900) 乘 `ACDE_SCALE`
  (0.5–4, 默认 1), 起来就算宿主窗口有焦点. 合成器没有 surface: 不出画面、不数 `frames`, 但页面照常出帧 (出帧线程的节奏不靠宿主窗口),
  `capture` / `screenshot` / `ACDE_HOST_DUMP` 照常读回. 注入和真窗口走同一段 (`App::inject`). 只在 headless 下不同的: 剪贴板是进程里的一份
  (不碰系统剪贴板), 选文件夹、打开和保存文件没有事先的答复 (`choose`) 时回错 (Linux 的 headless 也不问 portal), 系统通知只写一行 info 日志 (不弹出), 标题和输入法区域不做. 网页的画法和有窗口时一样 (libacde 的
  `docs/graphics/render-gpu.md`「GPU 与性能」: 优先 GPU, 没有时回退 CPU 类型的设备 lavapipe, 排最后, 慢): 能在有 Metal 的 macOS 机器 (含 GitHub 的
  macOS runner, 没验) 或有 GPU 的 Linux / Windows 上无人值守地跑; 没有 GPU 的 Linux CI 装了 lavapipe (Mesa 的 Vulkan 驱动包) 也能跑, 只是慢. Linux 上设了它就算「在别人的桌面里」, 不要 `WAYLAND_DISPLAY` / `DISPLAY`.
- **剪贴板** (libacde 单子 11, 接口见 libacde `docs/web/web-apps.md`「剪贴板」): 宿主按网页 MIME 类型收发 (`platform.rs` 的 `clipboard_set` /
  `clipboard_types` / `clipboard_read`, `output/surface.rs` 接 `SetClipboard` / `ClipboardTypes` / `ReadClipboard`).
  - Linux、macOS (`platform/host_winit.rs`, arboard 加 `image-data`): 认 `text/plain` 和 `image/png`; arboard 的图片是 RGBA, 和 PNG 之间由
    `clipimage.rs` (png crate) 换. **限制**: arboard 一次只能放一种类型, 写入时优先图片, 所以同时复制图片和文字时文字丢掉; `text/uri-list` 不写.
    读自己放进去的内容也经 arboard: 它在自己的线程上应答, 不会自己等自己.
  - Windows (`platform/win32.rs`): `text/plain` 是 `CF_UNICODETEXT`, `image/png` 是注册格式 `PNG`, 两种可以同时放; `text/uri-list` 不写. 〔未在
    Windows 上测〕
  - headless (`platform/headless.rs`): 进程里一张条目表, 读和列类型直接查它; 开发通道的 `clipboard` (`acde_hostwin::clipboard_text` /
    `set_clipboard_text`) 用的是同一张表 (只看 `text/plain`), 没有第二份.
- **系统能力**: fs、选文件夹、声音、剪贴板到处都有; 打开 / 保存文件在 Linux (portal)、macOS (`NSOpenPanel` / `NSSavePanel`) 和 Windows (Common Item Dialog, `platform/win32/dialog.rs`) 有; 应用后端的 unix socket 只在 unix; network、office、runtime 的 IME、语音、
  WebGPU 只在 Linux (WebGL 到处都有, 见「WebGL」). TLS 用 rustls (加密底层 ring, 三个平台一样; 2026-11-18 先定 aws-lc-rs (总仓 `.scratch/system/issues/14-openssl.md`), 同日为省掉 Windows 的 NASM 和 aws-lc 的 C 构建改成 ring, 用户定; ring 没有后量子混合密钥交换),
  证书校验交给 rustls-platform-verifier (runtime `http.rs` 的 `tls()`): Linux 读系统证书库 (发行版的 ca-certificates), macOS 用
  Security.framework, Windows 用系统的证书链校验 (`CertGetCertificateChain`, 会按需下载缺的根证书, 认组策略下发的证书). 不用内置的
  Mozilla 根证书列表. 二进制不再链接系统的 libssl.
  页面联网的 TLS 握手超时是 30 秒 (`tls_config`, ntex 默认 5 秒, 走代理的慢站点握不完).
