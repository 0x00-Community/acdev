import { Level, Log } from '../log'
import type { BrokerShell, MenuKey, WindowRecord, WireMenu } from './types'

export class MenuKeys {
  static of(menus: readonly WireMenu[]): Map<string, MenuKey> {
    const keys = new Map<string, MenuKey>()
    for (const menu of menus) {
      for (const item of menu.items) {
        if ('type' in item || !item.shortcut || !item.action || item.disabled || keys.has(item.shortcut)) continue
        keys.set(item.shortcut, { menu: menu.id, item: item.id })
      }
    }
    return keys
  }

  static bind(shell: Pick<BrokerShell, 'shortcut' | 'unshortcut'>, record: WindowRecord, menus: readonly WireMenu[]): void {
    const before = record.menuKeys ?? new Map<string, MenuKey>()
    const next = MenuKeys.of(menus)
    for (const combo of before.keys()) if (!next.has(combo)) shell.unshortcut(combo, 'menu', record.id)
    for (const combo of next.keys()) {
      if (before.has(combo)) continue
      try {
        shell.shortcut(combo, 'menu', record.id)
      } catch (error) {
        next.delete(combo)
        Log.write(Level.Warn, 'acde_host', `window ${record.id}: menu shortcut ${combo}: ${(error as Error).message}`)
      }
    }
    record.menuKeys = next
  }
}
