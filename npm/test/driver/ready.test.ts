import { describe, expect, test } from 'bun:test'
import type { InspectWindow } from '@acde/api'
import { ready } from '../../src/driver/ready/index.ts'
import type { Web } from '../../src/driver/types.ts'

const web = (name: string, kind: string, window: number, app: string | null = null, extra: Partial<Web> = {}): Web =>
  ({ name, app, kind, window, title: name, ...extra })
const shown = (...ids: number[]) => ids.map((id) => ({ id, ref: `w${id}` }) as InspectWindow)

describe('ready', () => {
  test('a wallpaper page the backend opened on the background layer has no window to wait for', () => {
    const webs = [web('desktop', 'desktop', 0), web('backend:wallpaper-acompositor-1#1', 'app', 1, 'backend:wallpaper-acompositor-1')]
    expect(ready(webs, shown(0))).toBe(true)
  })

  test('the lock screen and the confirm page are not windows of the session either', () => {
    const webs = [web('desktop', 'desktop', 0), web('lock', 'desktop', 900, null, { lock: true }), web('confirm', 'desktop', 901, null, { lock: true })]
    expect(ready(webs, shown(0))).toBe(true)
  })

  test('an app page whose window is not shown yet keeps it not ready', () => {
    const webs = [web('desktop', 'desktop', 0), web('notes#1', 'app', 3, 'notes'), web('backend:wallpaper-x#1', 'app', 1, 'backend:wallpaper-x')]
    expect(ready(webs, shown(0))).toBe(false)
    expect(ready(webs, shown(0, 3))).toBe(true)
    expect(ready([web('desktop', 'desktop', 0)], [])).toBe(false)
  })
})
