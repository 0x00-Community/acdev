# Platforms

The host window used for development (`acde dev`) runs on macOS, Windows, and Linux; Dopame OS itself is Linux.

| | macOS | Windows | Linux (development) | Dopame OS |
| --- | --- | --- | --- | --- |
| Page rendering (requires a GPU) | Metal | DX12 | Vulkan | Vulkan |
| `acde:fs`, file choosers | ✓ | ✓ | ✓ | ✓ |
| Sound, clipboard | ✓ | ✓ | ✓ | ✓ |
| System notifications | ✓ | | ✓ | Shown by the desktop |
| App backends | ✓ | Not yet | ✓ | ✓ |
| `acde:terminal` | ✓ | | ✓ | ✓ |
| `acde:network`, `acde:office` | | | ✓ | ✓ |
| WebGPU, voice input | | | ✓ | ✓ |
| Native programs (`.desktop`) | | | ✓ | ✓ |
| Headless (`--headless`, `acde test`) | ✓ | ✓ | ✓ (requires a GPU) | |

- The runtime draws pages only on the GPU, so Linux CI without a GPU cannot run headless. macOS CI runners can.
- Capabilities a platform lacks are not faked: the corresponding module fails to import, or the method throws.
