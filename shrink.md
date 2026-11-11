# acdert 精简审计: 可删减的代码约 4500-5000 行

我分 7 路读完了整个仓库 (vendors 除外), 共约 8.2 万行. 去掉各路之间重复的条目后, 能删的约占 6%, 其中低风险的约 3000 行. 每一路的主要结论我都在代码里抽查过. 这一轮没有改任何代码.

## 一、死代码 (直接删, 约 900 行)

- **合成器接口 `raise` / `setMode` / `canvases`**: acde-host 和 acde-dopame 的源码里都没人调. 一起删掉的有:
  - 协议 xml 里对应的请求和事件
  - `link.rs`、`napi_shell.rs` 里的对应方法
  - compositor 的 `Command::Raise` / `SetMode`
  - [hostnative.rs](crates/acdert/src/hostnative.rs) 的三个 native
  - hostwin `Shell::screen` / `set_mode`
  - 约 180 行.
- **napi 的 `Finder` / `Terminals` / `Network`**: Broker 的 `#LOCAL` 把 fs / terminal / network 的调用都拒掉了.
  - `Network` 完全没人用, 约 80 行.
  - `Finder` 只用到 `locate`, 约 75 行.
  - `Terminals` 只用到 `closeAll` 和一个存在性检查, 约 45 行.
- **[office/blank.rs](crates/runtime/src/office/blank.rs)**: 258 行手写 ZIP 和 XML. 输出每次都一样, 可以生成一次后改成 `include_bytes!`. 约省 225 行, 还能去掉 `crc32fast` 这个依赖.
- **crates/ipc**: 只有 hostwin `dev.rs` 在用, `Listener` / `endpoint` 只有它自己的测试用. 改成在 `dev.rs` 里写约 20 行, 整个 crate 删掉, 约 120 行.
- **`setReducedMotion`**: 从 JS 接口到 render 的整条链都没人调. 另外 `defaultLang` 的解析读的是一个 JS 从不传的选项. 约 25 行.
- **`fake-ds.ts`**: 105 行, 没有任何地方引用.
- **零散的小项**: `impl Images for ()`、paint 的 `Pixels` trait、`Effect::IDENTITY` / `ColorMatrix::IDENTITY` 重复、audio 的 `live` 集合只写不读、`MockDom.commits` 只写不读、acde-napi 里 9 个没用的状态常量等.

## 二、无用包装层 (约 700 行)

- **合成器控制路径有三层转发**:
  - napi `Shell` 原样转给 `link::Link`, 合并能省约 65 行.
  - compositor 的 `Command` 枚举在同一线程里绕一圈, 有的还建 mpsc 再立刻 `try_recv`. 只留 `Connect` / `Quit`, 约省 60 行.
- **Surface 有两个后端, 方法逐个手写转发**:
  - [window/client.rs](crates/window/src/client.rs) 有 15 个 `send(Command::X)`, [acdert/src/surface.rs](crates/acdert/src/surface.rs) 再用枚举把每个方法分发到两个后端.
  - `DragImage` 定义了 3 份.
  - 改成一个共享的 `SurfaceCommand` 枚举, 约省 130 行.
- **一块 GPU 设备有两套全局登记**: render 的 `gpu.rs` 和 paint 的 `gpu.rs` 各管一份. 同一个类型还换了三个名字 (`GpuImage` → `CanvasImage` → `CanvasImage`). 约 35 行.
- **render 测试的 `Doc` 只是转发**: `tests/common` 的 `Doc` 只转发或包一层 `Ok`, 测试 helper 在各个文件里复制了很多份. 约 100 行.
- **TS 里的 Rpc 端口适配层**: `sys/worker.ts`、`worker.ts` 的 `brokerPort`、`Web.post`. 约 40 行.
- **runtime 里的转发**: `UnixClient` 只转发给 `Connections`, `OfficeFiles` 只转发给 `fs::Shared`, 还有 `rt::Task` 这个 newtype. 约 35 行.

## 三、重复, 改成表驱动或宏 (约 2200 行)

- **acde-dom 的 getter / 类注册样板, 约 450 行**:
  - 约 78 个返回常量的 getter (`Navigator` / `Screen` / `document` …), 约 170 行.
  - 事件类约 42 个 init 转发 getter, 约 100 行.
  - `registerHtml` 逐行注册, 约 55 行.
  - geometry 的访问器, 约 75 行.
  - `metricsOf` 转发, 约 32 行.
  - 三个结构相同的列表类, 约 35 行.
  - 静态常量和原型常量各写一遍 (dom 和 core 都有), 约 45 行.
- **acde-napi, 约 380 行**:
  - 68 处 `*result = X` 加 18 处判空后再写, 用 `put!` / `put_opt!` 宏, 约 150 行.
  - 结构相同的 creator / getter, 约 80 行.
  - latin1 和 utf8 两个函数几乎一样, 约 42 行.
  - 15 处 `object!` 样板, 约 30 行.
- **[render/src/dom.rs](crates/render/src/dom.rs)**: 约 42 个方法都是 `read(|e| { let node = e.n(id)?; … })` 这种结构, 加两个 helper 即可. 约 130 行.
- **crates/acdert 的绑定层**:
  - [fs.rs](crates/acdert/src/fs.rs) 的 19 个方法写了三遍 (枚举、`name()`、`call()`), 改一张常量表, 约 70 行.
  - `IntoJs` 改成共享的, 再加 `js_object!` 宏, 替掉各处逐字段建对象的代码, 约 80 行.
  - terminal / network / office 的 settle、回调表、参数读取各写了一份, 约 50 行.
  - 自增 id 加 HashMap 的写法出现 8 次, 约 18 行.
- **WebGPU, 约 300 行**:
  - Rust 侧约 20 个 native 开头都是同一段 `enter` + `with_state`, 约 45 行.
  - 默认值在 TS、serde、wgpu 三处都写了.
  - `Extent` / `Origin` 和 wgpu 自带的类型重复.
  - `load_op` 一类字符串匹配可以交给 serde.
- **audio, 约 270 行**:
  - 7 个节点命令重复同一段查找.
  - PipeWire / null / cpal 各有一份输出控制循环.
  - `off_thread` 重新实现了一遍 `offload::run`.
  - TS 侧的节点类可以用表生成.
- **wire 枚举的双向转换**: Mode / Scope / Easing / Grab 在 `acde_shell.rs`、`link.rs`、`acde_window.rs` 各手写一遍. 改成 `#[repr(u32)]` 加 `TryFrom`, 约 150 行. hostwin 还自己定义了一份 `Mode` 和 `Injected`, 约 70 行.
- **vello 渲染循环写了 3 遍**: `offscreen.rs`、`raster.rs`、hostwin `present.rs`. 再加上选 adapter 写了 3 遍、纹理描述写了 6 遍, 合计约 90 行.
- **window 和 hostwin 之间的重复**: 窗框的拖拽热区、按边改尺寸的计算、帧节奏控制、`BTN_LEFT`、修饰键打包. 约 150 行.
- **acde-api 的 `modules.d.ts`**: 14 个 7 行的 module 块可以各缩成一行. 约 95 行.
- **其他**:
  - TS 里 `readTextOr`: 读文件失败就吞掉错误的写法有 10 处, 约 40 行.
  - net.ts 的路由判断有 5 种写法, 约 25 行.
  - 测试的 `createWeb` + `loadPage` + `close` 样板, 约 120 行.

## 四、绕远路的写法 (约 150 行)

- [semantics.rs](crates/render/src/dom/semantics.rs) 手写 JSON, 可以改用 serde derive. 约 55 行.
- hostwin 的 compose 用动态 offset 的 uniform 缓冲, 还带槽位计数和扩容. 改成每页一块固定的 uniform, 约 42 行.
- shell 的窗口 id 有两套 (native 的 u32 和 model 的 WindowId), 中间用两张 map 和 5 个转换函数对上. 统一成一套约省 30 行, 风险中等.
- [rt.rs](crates/acdert/src/rt.rs) 的 `run_until`: `recv` / `recv_timeout` 分两支可以合成一支.
- `modules.rs`: import map 为空时的快速路径和通用路径结果相同, 可以删.

## 五、需要你定的

1. **`webkitAudioContext`**: 挂在全局的非标准名字, 违反第一原则. 删不删?
2. **paint verify 路径** (`ACDE_PAINT_VERIFY`): 删掉约 150 行, 但会失去一项验收对照.
3. **acde-napi 按 rustfmt 重排**: 约省 150-230 行, 但以后和 Deno 上游对比会难一些. 现在全仓有 168 个文件没按 rustfmt 排过, 如果做, 建议单独出一个只改格式的提交.
4. **改用 ntex 自带的 HTTP 客户端**: 替掉手写的 HTTP/1.1 解析和 WebSocket 客户端 (`http.rs` / `unixhttp.rs`), 约 250 行. 风险高, 1xx 处理、分片上限、关闭时序都可能变, 要靠现有 11 个测试兜住.
5. **`dopamine` → `dopame` 改名迁移**: 约 20 行. acdert 的用户还会有旧状态吗?

## 顺带发现的问题

- **bug, 已核实**: [canvas.ts:840-843](web/packages/acde-dom/src/dom/canvas.ts#L840-L843) 的 `Path2D.roundRect` 把 radii 数组展开进了命令. 重放时 `ctx.roundRect` 只取第 5 个参数, 所以传多个圆角时只有第一个生效.
- **功能缺口**: hostwin 的 `present.rs` 不处理 layer 的 backdrop 和 filter 效果, 调试窗口里会缺毛玻璃和滤镜.
- **类型不一致**: acde-api 的 `AcdeModules` 里没有 `inspect`, 但 `modules.d.ts` 声明了 `acde:inspect`.

## 已验证 / 未验证

- **已验证**: 每一路的结论我都抽查过几条, 包括:
  - `Images` 只有空实现; `Dom` 方法有统一样板.
  - `blank.rs` 的 ZIP 日期写死, 输出确定.
  - Broker `#LOCAL` 拒掉了 fs / terminal / network.
  - `raise` / `setMode` / `canvases` 没有调用方.
  - ipc 只有 hostwin 在用; `fake-ds.ts` 无人引用.
  - `setReducedMotion` 没人调; `roundRect` 的 bug.
- **未验证**: 其余条目没有逐条复核, 行数是估算; 所有改法都没编译过.

建议先做低风险的那批: 第一节的死代码, 加上第三节的 napi 宏、`Dom` helper、fs 方法表、wire 枚举、DOM 常量表. 合计约 1500 行. 每改一个 crate 跑一次 clippy 和测试, `roundRect` 的 bug 一起修. 要开始吗?