# acdev 自己的窗口: QEMU 的 D-Bus 显示 (`crates/tool`)

> 路径相对仓库根。

三平台模拟器里程碑工作项 11 (总仓 `.scratch/acdev-m2/issues/11-dbus-display.md`): 客户机画面显示在 acdev 自己的窗口里, 键鼠转发进去,
不再用 QEMU 自带的 GTK 窗口. 依据总仓 `.scratch/roadmap/research/05-emulator.md` 第四节 (推荐 D-Bus 显示, VNC 作退路). 先做 Linux;
Windows (`Listener.Win32.Map`、`get-win32-socket`) 和 macOS (按键码表) 随工作项 02、03.

`crates/tool` 是独立的 Cargo 工作区 (根工作区 `exclude` 掉, 同 `crates/devd`), 出一个程序 `acdevtool`, 窗口是它的子命令 `view` (`src/view/`; 另一个子命令 `relay` 见 `vm.md`). `view` 只在 unix 上编进去. 不依赖运行时库:
窗口用 winit, 画面用 softbuffer (CPU 拷贝到窗口, 不要 GPU), D-Bus 用 zbus, 传描述符用 rustix. 没有用 `qemu-display` crate: 它连带
usbredir (C 库)、qapi 等我们用不到的东西, 而我们只要五六个方法; 接口语义照它和 QEMU 的 `ui/dbus-display1.xml`.

## 怎么连上

1. `acdev vm start --viewer` 给 QEMU `-display dbus,p2p=yes` (不注册到任何总线, 只接受经 QMP 交来的连接). 本机 Ubuntu 的 QEMU 8.2.2
   带这个后端 (`qemu-system-x86_64 -display help` 里有 `dbus`, 模块 `ui-dbus.so`).
2. QEMU 起来后 acdev 在后台 (`setsid`) 起 `acdevtool view --qmp <run/qmp.sock> --title …`, 输出写 `logs/viewer.log`. 关掉窗口只结束
   viewer, 客户机照跑; `acdev vm view` 再开一个.
3. viewer 连 QMP: 读问候、`qmp_capabilities`; 建一对 Unix 套接字, 一端经 `getfd` 交给 QEMU (描述符走 `SCM_RIGHTS`, QMP 文字里只有名字
   `acdevtool`), 再 `add_client` (`protocol` 是 `@dbus-display`). 之后关掉 QMP 连接 (QMP 套接字一次只接一个客户端, 不能占着).
4. 在自己那一端上建点对点 D-Bus 连接 (客户端一方), 对 `/org/qemu/Display1/Console_0` 调 `Console.RegisterListener`, 交另一对套接字的
   一端; 调用返回后在自己那一端上提供 `/org/qemu/Display1/Listener`. 顺序照 qemu-display (先注册, 再建连接).

## 只打开输出, 不开窗口

`acdevtool view --qmp … --outputs N`: 同样连上 D-Bus 显示, 对 `Console_1`…`Console_{N-1}` 调 `Console.SetUIInfo` (1280×800, 横向依次
排开) 让 virtio-gpu 把这些输出标成已连接, 然后退出. `acdev vm start --headless --outputs N` 用它 (见 `docs/vm.md`「多个显示输出」).

## 画面

- 只实现 `org.qemu.Display1.Listener` 的基础方法: `Scanout` (整帧, 换分辨率)、`Update` (矩形)、`Disable`、`MouseSet`、`CursorDefine`;
  `Interfaces` 属性为空, 所以 QEMU 不会用共享内存 (`Listener.Unix.Map`, 8.2 还没有) 或 DMABUF (只在 `gl=on` 时). 像素经 D-Bus 拷贝,
  1280×800 一帧约 4 MB, 本机的 Unix 套接字上够用 (〔推论〕, 帧率待测); 以后换 `Unix.Map` 省掉拷贝.
- 只认 `PIXMAN_x8r8g8b8` 和 `a8r8g8b8` (小端内存是 B、G、R、X), 存成 softbuffer 要的 `0x00RRGGBB`; 别的格式记一条警告, 不画.
- 窗口按客户机分辨率要求大小; 大小不一样时按最近点缩放.
- 指针: virtio-gpu 的指针在单独的平面上, 不在帧里: `CursorDefine` (ARGB) 转成 winit 的自定义指针, `MouseSet` 的 `on` 决定显示与否;
  宿主指针本身就是客户机指针 (virtio 平板是绝对坐标).
- 画帧只在 `RedrawRequested` 里做: 收到新帧时请求重画, 由 winit 按合成器的帧回调节流, 不在事件里直接提交缓冲.

## 键鼠

- 键: winit 的物理键取平台扫描码 (`to_scancode`): Linux 上是 evdev 码, 1–83 与 QEMU 键号 (XT set 1, 扩展键高位置 1) 相同, 其余查表
  (`src/keys.rs`, 值照 QEMU 的 keycodemapdb, 打印键和 Pause 〔未核实〕); Windows 上是 set 1 码, `0xE0xx` 换成 `0x80 | xx`; macOS 还没有.
  经 `Keyboard.Press` / `Release` 发.
- 指针: `Mouse.SetAbsPosition` (按窗口到客户机的比例换算)、`Press` / `Release` (左 0、中 1、右 2、后退 5、前进 6), 滚轮是按下再松开
  3 (上) 或 4 (下).
- 输入在一个单独的线程里发 (阻塞调用不卡窗口).
- 客户机刚起来时鼠标还不是绝对坐标 (virtio 平板的驱动没载入), `SetAbsPosition` 回 `org.qemu.Display1.Error.Invalid: Mouse is not
  absolute`; 驱动载入后就好. 指针移动的失败只记调试级, 其余输入的失败记警告.

## 日志

诊断用 `log` 的宏, `main.rs` 里的小记录器写到标准错误 (`acdevtool view: [目标] …`): 自己的记录写信息级 (`ACDEV_VIEWER_DEBUG=1` 时也写
调试级, 比如没有键号的键), 依赖库 (winit、softbuffer、zbus) 的写警告及以上, 窗口一侧出错时能看到原因.

## 已知问题

- WSLg 的 Wayland 合成器会崩 (2026-11-18): acdev-test 复测时 `acdev vm view` 重开失败 (`Io error: Connection reset by peer`、winit 的
  `Exit Failure: 1`), 走 X11 (`env -u WAYLAND_DISPLAY`) 两次都正常. 原因不在 QEMU, 也不在窗框配色: WSLg 的 `/mnt/wslg/stderr.log` 里,
  每次都是 weston 本身段错误 (`pid … terminated with signal 11, /usr/bin/weston --backend=rdp-backend.so … --shell=rdprail-shell.so`),
  时间紧跟在当时 acdev-viewer 的窗口出现之后 (`/mnt/wslg/weston.log` 的 `ClientGetAppidReq: … appId:acdev-viewer` 后 8～70 秒: 01:54:51 →
  01:56:05, 02:28:22 → 02:28:53, 02:29:17 → 02:29:25); 合成器一崩, 所有 Wayland 客户端的连接都被重置, 连 Xwayland 也断 (`failed to read
  Wayland events: Broken pipe`). 第一次开窗也会崩, 只是晚一些 (关窗时). `XDG Settings Portal did not return response in time` 只是 sctk-adwaita
  取配色时 `dbus-send` 等 100 ms 没等到, 不相干. weston 9 (WSLg 的 rdprail 外壳) 为什么崩, 我们查不到它的崩溃现场; 这个窗口在
  Wayland 下和 QEMU 的 GTK 窗口不同的地方是 sctk-adwaita 画的客户端窗框 (日志里每个窗口带 5 个"不是顶层窗口"的子表面) 和自定义指针,
  嫌疑在这两处〔推论〕.
- 所以在 WSLg 上 (`/mnt/wslg` 是目录、有 `DISPLAY`) viewer 默认走 X11 (winit `EventLoopBuilderExtX11::with_x11`), 日志里写一句;
  设 `ACDEV_VIEWER_WAYLAND=1` 才用 Wayland. 别的 Linux 照 winit 的默认 (有 `WAYLAND_DISPLAY` 就用 Wayland).

## 测试

`cargo test` (在 `crates/tool`, 含 relay 的套接字往返): 键号换算、`Scanout` / `Update` 落到像素、缩放. 命令行一侧 `test/vm/qemu.test.ts`: `--viewer` 的 QEMU 参数、
`ACDEVTOOL`、`view` 和参数冲突的报错. 窗口本身要在有图形环境的机器上起一台客户机看 (见总仓工作项 11 的验收).

## 构建依赖的代价

新增 winit、softbuffer、zbus (带 `p2p`、`serde_bytes`)、rustix、serde_bytes、log. winit 和 zbus 在根工作区已有 (hostwin), 但这是独立工作区,
要另编一份. 发布版二进制 5.4 MB (2026-11-18 acdev-test 实测); 冷编时间未单独量. 不进 `acdev` 主程序的依赖图.
