# Platform support

The host window used for development (`acde dev`) runs on macOS, Windows, and Linux; Dopame OS itself is Linux. The runtime is built for macOS on Apple silicon and Intel, Linux on x86_64, and Windows on x64; see [Install](../start/install.md#supported-platforms).

| | macOS | Windows | Linux (development) | Dopame OS |
| --- | --- | --- | --- | --- |
| Page rendering (requires a GPU) | Metal | DX12 | Vulkan (a hardware driver) | Vulkan |
| `acde:fs`, file pickers | ✓ | ✓ | ✓ | ✓ |
| Sound, clipboard | ✓ | ✓ | ✓ | ✓ |
| System notifications | ✓ | Only in a desktop, which shows them | ✓ | Shown by the desktop |
| App backends | ✓ | ✓ (see [Backend](../guide/backend.md#on-windows)) | ✓ | ✓ |
| `acde:terminal` (`terminal`) | ✓ | ✓ | ✓ | ✓ |
| Camera and microphone (`camera`, `microphone`) | ✓ | | ✓ | ✓ |
| `acde:network`, `acde:office` (`network`, `office`) | | | ✓ | ✓ |
| Native programs embedded in a window (`slots`) | | | | ✓ |
| WebGPU, voice input | | | ✓ | ✓ |
| Native programs (`.desktop`) | | | ✓ | ✓ |
| Headless (`--headless`, `acde test`) | ✓ | ✓ | ✓ (requires a GPU) | |

- Capabilities a platform lacks are not faked. An app that **requires** one does not start there (`Notes needs "network" (unsupported on this platform)`) and is left out of the app list; one that lists it in `optional` starts, `load()` gives `null` for the module, and `acde:capabilities` reports `state: 'unsupported'`. See [Capabilities](../guide/capabilities.md#optional-capabilities).
- `acde check --platform windows` (or `macos`, `linux`) tells you before you run there: `error: macos (standalone): app "notes" requires network, which this mode lacks`, or a `note:` when the capability is optional. The data is `PLATFORM_SUPPORT` in `@dopame/acde-api`, per platform and way of running: `session` (Dopame OS), `desktop` (a desktop in the host window), `standalone` (a single app in the host window). A page reads its own from `acde:capabilities` (`platform`, `mode`).
- The runtime draws pages on the GPU. On Linux without one it falls back to the software Vulkan driver (lavapipe, in `mesa-vulkan-drivers` on Debian, Ubuntu and Fedora, `vulkan-swrast` on Arch), which draws on the CPU and animates slowly, so Linux CI without a GPU can run headless once that driver is installed. macOS CI runners use their GPU.
- On Linux the runtime wants the **hardware Vulkan driver** of the machine's GPU; the software one (lavapipe / llvmpipe) is used only when no other is there, and `acde doctor` warns about it. With no Vulkan driver at all, `acde dev` fails at startup with a log line that says so and names the GPU the system has: `web layer unavailable: the system has a GPU (card0, kernel driver i915) but no usable Vulkan driver was found: install the GPU's Vulkan driver (for example vulkan-intel, vulkan-radeon, nvidia-utils) or point VK_DRIVER_FILES at its ICD (…)`. The fix is to install the driver, then check that `vulkaninfo --summary` lists the GPU: for Mesa, `vulkan-intel` or `vulkan-radeon` on Arch, `mesa-vulkan-drivers` on Debian, Ubuntu and Fedora; for NVIDIA, the vendor's driver.
