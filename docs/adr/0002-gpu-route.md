# GPU 路线: 用 acgpu、只经标准图形接口、没有 GPU 时回退 CPU 设备

用户定 2026-11-14: acgpu 接管原来的 acde-gpu (那个 crate 已删, 设备登记留在 `src/gpu`), 2D 场景和渲染器都用 acgpu 的, blitz fork 直接画进 acgpu 的场景.
依赖 acgpu 时不开 `compiler` (没有 MLIR、没有专用驱动), 只开 `fallback-vulkan`, 每个 OS 只编一个 wgpu 后端 (Windows DX12、Linux Vulkan、macOS Metal);
Xe3 驱动只在 acdebin-system 里用.

用户定 2026-11-13: 网页优先在 GPU 上画, 不带 vello_cpu. 真 GPU 排前, lavapipe 这类 CPU 类型的设备排最后, 只有它时才用 (虚拟机 / VNC, 慢);
什么设备都没有时网页图层不可用, 页面不出帧. 整条链路仍不许 CPU 拷像素、不许 GPU 回读 (RDP、截屏、要同步给像素的标准接口除外).

见 `docs/graphics/render-gpu.md`「GPU 与性能 (硬约束)」.
