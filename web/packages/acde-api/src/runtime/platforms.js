const HOST_WINDOW_ONLY = ['slots']
const WINDOWS_MISSING = ['network', 'system', 'bluetooth', 'audio', 'office', 'camera', 'microphone', ...HOST_WINDOW_ONLY]
const MACOS_MISSING = ['network', 'system', 'bluetooth', 'audio', 'office', ...HOST_WINDOW_ONLY]
const FULL = { backdrop: 'full' }

export const RUNNING_MODES = ['session', 'desktop', 'standalone']

export const PLATFORM_SUPPORT = {
  linux: {
    session: { unsupported: [], window: FULL },
    desktop: { unsupported: HOST_WINDOW_ONLY, window: FULL },
    standalone: { unsupported: HOST_WINDOW_ONLY, window: FULL },
  },
  win32: {
    desktop: { unsupported: WINDOWS_MISSING, window: FULL },
    standalone: { unsupported: [...WINDOWS_MISSING, 'notifications'], window: FULL },
  },
  darwin: {
    desktop: { unsupported: MACOS_MISSING, window: FULL },
    standalone: { unsupported: MACOS_MISSING, window: FULL },
  },
}

export function platformSupport(platform, mode) {
  return PLATFORM_SUPPORT[platform]?.[mode] ?? null
}
