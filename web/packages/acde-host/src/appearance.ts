import { Level, Log } from './log'
import type { Native } from './native'
import { process, type Env } from './sys/process'

interface NativeAppearance {
  dark(): Promise<boolean>
  watch(callback: (dark: boolean) => void): void
}

export class Appearance {
  static readonly WAIT_MS = 1000

  static fixed(env: Env = process.env): boolean | null {
    const set = env['ACDE_COLOR_SCHEME']
    if (set === 'dark') return true
    if (set === 'light') return false
    if (set) Log.write(Level.Warn, 'acde_host', `ACDE_COLOR_SCHEME=${set}: neither light nor dark, following the portal`)
    return null
  }

  static async follow(native: Native, apply: (dark: boolean) => void): Promise<void> {
    const Portal = (native as unknown as { Appearance?: { open(): Promise<NativeAppearance> } }).Appearance
    if (!Portal) return
    try {
      const portal = await Portal.open()
      portal.watch((dark) => apply(dark === true))
      apply(await portal.dark())
    } catch (error) {
      let message = String((error as Error)?.message ?? error)
      try {
        message = (JSON.parse(message) as { message?: string }).message || message
      } catch {}
      Log.write(Level.Info, 'acde_host', `color scheme: light, the portal has no setting (${message})`)
    }
  }
}
