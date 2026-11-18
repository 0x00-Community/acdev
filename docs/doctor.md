# 运行时自检 `acdev runtime doctor` (`src/doctor.rs`)

> 路径相对仓库根。CLI 一侧怎么调它、怎么并进 `acdev doctor` 见 `docs/acde-doctor.md`。从 acdert (今 libacde) 的 `docs/dev/build-run.md` 迁来。

`acdev runtime doctor [--json]` 由 `src/main.rs` 直接分派, 不起 V8 也不起 Broker: 查这台机器上 `acdev runtime app` / `acdev runtime desktop` 起得来要的
东西, 给 `acdev doctor` 用 (acdev 看 `--help` 里有没有 `acdev runtime doctor` (或旧的 `acdert doctor`) 判断支不支持, 不按版本号). 每项 `ok` /
`warn` / `error`, 可带一条 `fix`:

- `gpu`: 和宿主窗口同一条路打开设备 (`acdert::gpu::Gpu::open`: 真 GPU 排在前面, 只有 CPU 适配器 (lavapipe) 时也用它; 一个都没有时的原因和提示就是 `no_adapter` 那句), 再用
  `acdert::vello::Offscreen` 画一张 16x16 的纯色图、回读中心像素和画的颜色比 (每通道差 ≤ 2). 所以着色器编译 (Metal / DXC / Vulkan)、提交、
  回读都走过一遍. 在 `acde-doctor` 线程上做, 30 s 没结果算错误 (驱动挂住时不卡死), 回读是 doctor 自己要的像素, 不在 GPU 硬约束的禁止之列.
  打开的是 CPU 适配器时是警告 (页面在 CPU 上画, 整屏动画只有几帧); WSL 上 (`/proc/sys/kernel/osrelease` 含 `microsoft`) fix 指向
  `WGPU_ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER=1`: wgpu 默认藏起不是一致性实现的 Vulkan 驱动, WSL 的 Dozen 就是, 于是只剩 lavapipe.
- `display` (只在 Linux): 和起会话同一个判断 (`main.rs` 的 `outer()`: `WAYLAND_DISPLAY` / `DISPLAY` / `ACDE_HEADLESS`); 都没有时是警告:
  这时 `acdev runtime app` / `desktop` 不开宿主窗口, 而是去试着起 DRM 会话 (按代码的分支读出来的, 没在共用的机器上实测抢屏), fix 是
  `acdev dev --headless` 或在图形会话里跑.

不查的: 视频解码器 (只影响 `<video>`, 不影响起得来)、存储目录 (位置由 JS 的 `places.ts` 定, Rust 这边重算一份会分叉)、缺动态库 (那时
acdev runtime 自己就起不来, 由 acdev 从 stderr 读出原因).

输出: 第一行 `acdev runtime <版本> (contract level N): <exe>`, 每项一行 `<状态> <标题>: <内容>`, 有 fix 时下一行 `fix: …`; `--json` 是一个
对象 `{"acdev runtime": <版本>, level, platform, exe, checks: [{id, title, status, summary, fix}]}` (`fix` 可为 null), stdout 上只有它.
有 `error` 退出 1, 否则 0; 不认的参数一行原因加用法, 退出 2.
