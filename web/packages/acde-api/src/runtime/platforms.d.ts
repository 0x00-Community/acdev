import type { Platform, PlatformSupport, RunningMode } from '../types/capabilities'

export declare const RUNNING_MODES: readonly RunningMode[]
export declare const PLATFORM_SUPPORT: Readonly<Record<Platform, Partial<Readonly<Record<RunningMode, PlatformSupport>>>>>
export declare function platformSupport(platform: string, mode: RunningMode): PlatformSupport | null
