# 目录

> 运行时库的文档, 文中代码路径 (`src/`、`tests/`、`scripts/`、`vendor/`、`protocol/`、`include/`) 相对 `acdert/`.

| 路径 | 职责 |
| --- | --- |
| `src/host` | `acdert` lib: 内嵌 V8 (rusty_v8), 每个 isolate 的事件循环 (`rt.rs`), 模块加载 (`modules.rs`), web 线程 (`web.rs`), DOM 绑定 (`dom.rs`), 注入的能力, 声音, inspector, 主进程 (`supervise.rs`, Linux), 自检 (`doctor.rs`) |
| `crates/shell` / `crates/window` / `crates/paint` | 会话 (Wayland 合成器、会话里 web 的 Wayland 客户端和光栅化) 已搬到 [acdebin-system](http://gitea.dopamine/AC/acdebin-system), 说明在它的 AGENTS.md |
| `src/render` | Blitz 包成的渲染引擎 (`Document` / `Dom` / `RenderHandle`), 窗框 `Decoration`. `Dom` 在 `dom.rs` (结构、加锁读写的辅助、小工具) 和 `dom/`: `types.rs` (`NodeType` / `Ns` / `Viewport` / `Quad`)、`values.rs` (控件种类、数值字符串、`RangeValue`)、`dom_tree.rs` / `dom_view.rs` (`Dom` 的公开方法: 树、属性、文本、选择器 / 表单、几何、样式、图片、样式表、画布)、`engine_tree.rs` / `engine_state.rs` (`Engine` 上对应的实现: 节点与树操作、解析、属性 / 控件值、焦点选区、滚动、图片状态、innerText)、`select.rs`、`semantics.rs` |
| `src/gpu` | 设备层: 共享设备 `Gpu` (包着 detour 的 `Shared`; WebGPU / WebGL / video / canvas 图都在它上面), 接口 `Compositor` (前端在发布 `Gpu` 时用 `Gpu::set_compositor` 装上) 交出 `Offscreen` (render 画 canvas、滤镜、阴影、截图用); 平铺导出 detour 的 2D 场景 (`Scene` / `PaintScene` / 滤镜)、`Part` / `Pass` / `Content`、`Px` / `Backdrop` / `Shadow` / `Effect`、`GpuImage` |
| `src/vello` | `acde-vello`: 合成器的 vello / wgpu 实现 (`VelloCompositor`, `Offscreen`, `Composer`, 会话的 `Raster`); acdev runtime 和会话用它. detour 实现以后也放本仓库 |
| `src/webgl` | `acde-webgl`: wgpu 上的 WebGL 1 / 2 (见 `docs/graphics/webgl.md`「WebGL」). 检查: `cargo test --release -p acdert webgl` |
| `src/runtime` | 系统接口 (napi 导出 + 注入用的 Rust 对象). 异步执行器 `rt.rs`: `acde-rt` 线程上的 ntex System (不用 tokio, TLS 用 OpenSSL). 检查: `cargo test -p acdert runtime` (含真 pty / Windows 伪控制台上的终端、unix socket 上的 HTTP / WebSocket)、`ime-check.sh`、`portal-check.sh`、`atspi-check.sh` (经 `tests/run.sh`) |
| `src/model` | canvas / 窗口表、计划、快捷键、shell 事件 (`Event` / `Inbox`)、`acde_window` / `acde_shell` 协议 |
| `src/log` | `acde-log`: 日志和计时 |
| `src/media` | `acde-media`: 解码音视频, 读摄像头和麦克风 (Linux GStreamer, macOS AVFoundation; 见 `docs/web/web-apps.md`「视频」「摄像头和麦克风」). 检查: `cargo test --release -p acdert media` (`tests/fixtures` 是 ffmpeg 命令行生成的 1 秒小片段; `tests/capture.rs` 用假设备; `tests/devices.rs` 里 `--ignored` 的列出 / 读真设备、在 macOS 上问权限) |
| `src/storage` | `acde-storage`: 网页存储的分区和 SQLite (见 `docs/web/storage.md`「网页存储」). 检查: `cargo test --release -p acdert storage` |
| `src/napi` | rusty_v8 实现的 Node-API (napi8), 让 `#[napi]` 导出在 Broker 里可用. 改自 Deno `ext/napi` 0.191.0 (MIT, LICENSE-MIT), 去掉了用不到的入口 |
| `web/packages/acde-host` | acdert 的 JS: Broker 和每个 web 的宿主, 包发现, 桌面服务, 登录页 |
| `web/packages/acde-dom` | web 里的浏览器全局对象和 DOM |
| `web/packages/acde-api` | `@dopame/acde-api`: SDK (唯一对外发布的 JS 包) |

## web/packages

> `web/` 已于 acdert 91e7dd1e 删除 (CTO 决定), 取代方案未定; 本节和上表的 `web/packages` 三行是删除前的说明, 留作讨论依据.

Bun workspace (`bun install`, `bun run build`, `bun run typecheck`, `bun run test`; 测试是 `bun test`, 没有 Node).

- **acde-api**: 入口在 `src/` 顶层 (`index`、`app.d.ts` / `shell.d.ts`、`vite`、`validate.ts`), `src/types/` 是接口声明, `src/modules/` 是 `acde:*` 模块声明, `src/runtime/` 是运行时的 JS. `API_LEVEL` (`src/runtime/level.js`, 契约级别, 包根和 `./manifest` 都导出)、`load(name)` (`src/runtime/load.js`: `import('acde:<name>')` 的默认导出, 拿不到时是 null; 说明符带 `@vite-ignore` 等)、
  `@dopame/acde-api/vite` (build 时 `acde:*` 留作外部模块, dev 时换成会 reject 的替身); 声明 `types/` 的 `manifest.d.ts` / `service.d.ts` / `page.d.ts` (加 `events.d.ts`、`office.d.ts`) /
  `config.d.ts` (+ `config.schema.json`) 和 `modules/`; `src/validate.ts` (导出 `./manifest`) 是清单校验和 `ICON_NAMES`, 测试
  `test/validate.test.ts`. acdev 仓库用 `file:../acdert/web/packages/acde-api`, acde-dopame 拷一份 (`scripts/sync-acde-api.sh`).
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
- **acde-host**: 测试 `bun test` (只测不碰原生接口的模块, 如 `mimedb.ts`). esbuild 打成 `dist/broker.js` (`src/main.ts`, Broker) 和 `dist/web.js` (`src/worker.ts`, 每个 web). release 构建是 `build:release` (出 `dist-release/`). 基准 `bash scripts/release-perf/bench.sh` (Windows, 无头, 每边 5 轮中位数): 加载到 `shell running` 开发 1106 ms、release 941 ms; DOM 和布局负载 95 ms 对 107 ms; 纯 JS 负载 29.3 ms 对 29.4 ms. 多一层字符串数组混淆时加载慢约 470 ms, 所以预设不用它. 打包开着 `keepNames`: 有静态块的类会被 esbuild 改名 (`class _Blob`), 不留名字的话 `Blob.name`、`Object.prototype.toString` 都是错的. 文件按本仓文档的章节命名
  (`broker.ts`、`worker.ts` / `host.ts`、`remote.ts` / `rpc.ts`、`inspect.ts`、`devhot.ts` …); `sys/` 是原生接口的 node 风格包装.
  `broker/` 是从 Broker 拆出的部分, 每块经一个小的宿主接口 (`…Host`) 拿 Broker 的私有状态: `types.ts` (Broker 的接口和窗口记录)、`web.ts`
  (`Web`: 一个 web 的线程和 rpc, 它的授权、环境变量和 403)、`dev.ts` (`DevRequests`: acdev dev 的请求、假回应规则、找 web)、`preferences.ts`
  (配色和减少动态, 含模拟)、`records.ts` (`WindowRecords`: 窗口表、原生窗口的事件、应用的窗口位置)、`approvals.ts` (`Approvals`: 批准的接线, `acde:permissions` / `acde:capabilities` 的调用、给 web 的 `permit`; 决定文件和日志由 Broker 经 `ApprovalsHost` 给)、`listing.ts`
  (`AppListing`: 桌面知道的应用列表, 变了发 `appschanged`); `calls/` 是 web 经 rpc 来的调用: `apps.ts` (`acde.apps` / `acde.packages`)、`windows.ts` (`acde.windows` /
  `acde.launch` / `acde.window`)、`page.ts` (页面调用和钉住的面板)、`services.ts` (交给 web 的服务形状、内置和桌面包服务的调用)、`desktops.ts`
  (`acde.desktops`); `access/` 是谁能用什么: `tier.ts` (按调用者层级的模块)、`family.ts` (打开窗口时的父窗口)、`launchable.ts` (应用能不能
  在这里起: 找不到 404 / 级别不对 409、缺系统服务 503、宿主窗口里要 slots 404、第三方声明外壳模块 403; 列表只给能起的)、`modules.ts`
  (桌面服务 `ctx.import` 拿到的外壳模块和它们的事件)、`capabilities.ts` (必需与可选能力), `access/approval/` 是批准: `permissions.ts` (决定)、`permits.ts` (web 侧的守卫)、
  `dialog.ts` (单应用模式的原生对话框). `broker.ts` 留着会话循环和 web 的起停. `greet/` 是登录页,
  `brand/` 的 `mark.mjs` / `art.mjs` 是 agentos 仓库 `branding/` 的原样拷贝 (只在那边改).
