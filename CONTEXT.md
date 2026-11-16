# acdert

acdert 是 acde (Agent Computer Desktop Environment, Dopame 的桌面基座) 的通用运行时库. 这里定义本仓库特有的术语; 机制细节在 `docs/`.

## 仓库与运行方式

**前端**:
建在 acdert 之上、实现 `Platform` 并调用 `acdert::start` / `acdert::common` 的可执行程序: acdebin-dbg (调试运行时) 和 acdebin-system (Dopame OS 会话运行时).
_Avoid_: 壳、宿主程序

**会话**:
Dopame OS 上由 acdert 自己 (经 acdebin-system) 当 Wayland 合成器的跑法, 输出到屏幕 (DRM/KMS) 或 RDP.
_Avoid_: 系统模式

**宿主窗口**:
在别人的桌面里开的一个原生窗口, 桌面和所有逻辑窗口都由运行时合成进去; 分**调试桌面** (`desktop`, 完整桌面) 和**调试窗口** (`app`, 单应用铺满, 也叫独立应用 / standalone).
_Avoid_: 嵌入模式

## 运行时内部

**Broker**:
运行时主线程上的那个 isolate (`web/packages/acde-host`), 管会话、包、桌面服务、窗口记录和权限.
_Avoid_: 主进程、守护进程

**web**:
一个页面实例: 一条 JS 线程加一个自己的 V8 isolate、DOM、render 文档和 surface; 名字形如 `files#1048576`, 桌面的叫 `desktop`.
_Avoid_: 渲染进程、tab

**isolate**:
V8 的隔离堆; 整个运行时一个 V8, 每个窗口一个 isolate, 各管各的内存、生死和 CPU. 不是安全边界.

**canvas**:
框架的工作区抽象 (Rust 表项), 屏幕只有一块, canvas 可以有多个, 同时只显示一个. 和 HTML `<canvas>` 无关.

**窗口**:
框架的逻辑窗口 (Rust 表项), 内容只是客户端交的缓冲; 桌面、面板、菜单都是窗口. 和操作系统窗口不一一对应.
_Avoid_: surface (那是客户端交缓冲的通道)

**窗口模式**:
窗口能不能挪、改尺寸: `free` / `fixed` / `pinned` (内部还有铺满 canvas 的 `fullscreen`).

**窗口状态**:
`normal` / `minimized` / `filled` (铺满工作区) / `fullscreen` (铺满输出), 由运行时裁决; 和窗口模式是两回事.

**面板**:
桌面页面经 `pin` 钉出来的 `pinned` 窗口 (Dock、菜单栏、弹出层), 可以在输出的一条边上占住工作区.

**窗框**:
运行时给应用窗口画的标题栏和按钮, 不在页面的文档里; 清单 `frame: false` 的应用自己画.

**原生窗口**:
普通 Wayland 客户端 (Firefox 等) 的窗口, 和 web 窗口在同一个窗口 id 空间里.

## 包、应用与能力

**桌面包**:
一个目录, `package.json` 的 `acde` 字段声明桌面、应用、资源和服务; 具体的桌面 (如 Dopame) 由它提供, acdert 不认识它.
_Avoid_: 主题、皮肤

**桌面**:
桌面包里的一个 desktop: 满屏在所有窗口后面的那张网页, 拿全部 `acde:` 模块.

**应用**:
桌面包 `apps` 里的一项, 按清单的 `capabilities` 拿模块. **系统应用**是和某个已安装桌面同包的应用, 其余是**第三方应用**.

**桌面服务**:
在 Broker isolate 里跑的 ES 模块, 随桌面起停; 应用要在清单 `services` 里写服务名才能调.
_Avoid_: 后端 (后端是应用自己的 bun / node 进程)

**后端**:
应用的 `backend/server.js`, 由运行时用 bun 或 node 起成子进程, 页面经 unix socket (或 Windows 通道) 和它通信, 不开 TCP 监听.

**`acde:` 模块**:
系统能力的唯一入口, 照 `node:fs` 的写法导入, 进程内直接注入 isolate, 不是 RPC; 没授权的导入直接失败.
_Avoid_: acde 全局、私有 web 接口

**外壳模块**:
只给桌面页面、声明了它的桌面服务和系统应用的 `acde:` 模块 (`SHELL_MODULES`: `windows`、`packages`、`session` …); 相对的是给所有应用的**应用模块** (`APP_MODULES`).

**层级**:
按调用者是桌面、系统应用还是第三方应用决定注入哪些模块的规则 (`broker/tier.ts`).
_Avoid_: 权限等级

**能力**:
清单 `capabilities` 里声明的系统能力 (`fs`、`terminal`、`network` …), 默认必需, 列进 `optional` 的可以缺; 状态由 `acde:capabilities` 报.

**批准**:
要用户同意才可用的能力; 现在只有 `camera`、`microphone`.

**契约级别**:
包清单的整数 `apiLevel`, 必须等于运行时的 `API_LEVEL` (SDK `src/runtime/level.js`) 才加载; 现在是第 1 级.
_Avoid_: 版本号

**SDK**:
`@dopame/acde-api` (`web/packages/acde-api`): 清单、`acde:` 模块和事件的类型, 加上唯一一份清单校验 `validate.ts`.

## 文件

**根**:
`acde:fs` 调用的第一个参数, 是不透明的标识而不是路径: `private` (应用私有数据)、公共位置名, 或用户选的文件夹的令牌 `folder-<哈希>`.

**公共位置**:
SDK `SHARED_PLACES` 里的六个用户目录 (`desktop`、`documents`、`downloads`、`music`、`pictures`、`videos`), 要在清单 `fs.roots` 里点名.
