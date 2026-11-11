import { ActError, type Acde, type ActResult } from './acde.ts'

export type Modifier = 'Shift' | 'Control' | 'Alt' | 'Meta' | 'ControlOrMeta'

export type MouseButton = 'left' | 'right' | 'middle'

export type InputEvent =
  | { readonly type: 'move'; readonly x: number; readonly y: number }
  | { readonly type: 'down' | 'up'; readonly x: number; readonly y: number; readonly button?: MouseButton }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly dx?: number; readonly dy?: number }
  | { readonly type: 'keydown' | 'keyup'; readonly key: string }
  | { readonly type: 'text'; readonly text: string }

export interface InputTarget {
  readonly acde: Acde
  describe(): string
  web(): Promise<string>
}

const MODIFIER_KEYS: Record<Exclude<Modifier, 'ControlOrMeta'>, string> = {
  Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'meta',
}

export const Modifiers = {
  chord(modifiers: readonly Modifier[] | undefined): string | null {
    if (!modifiers?.length) return null
    const names = modifiers.map((m) => {
      const name = m === 'ControlOrMeta' ? 'Control' : m
      const key = MODIFIER_KEYS[name as keyof typeof MODIFIER_KEYS]
      if (!key) throw new Error(`unknown modifier ${JSON.stringify(m)} (Shift, Control, Alt, Meta, ControlOrMeta)`)
      return key
    })
    return [...new Set(names)].join('+')
  },
}

async function send(target: InputTarget, what: string, events: readonly InputEvent[]): Promise<ActResult> {
  return target.acde.trace.step(`${target.describe()}.${what}`, async () => {
    const result = await target.acde.input(await target.web(), events)
    if (!result.ok) throw new ActError(`${target.describe()}: ${what}`, result)
    return result
  })
}

interface ClickOptions {
  readonly button?: MouseButton
  readonly clickCount?: number
  readonly modifiers?: readonly Modifier[]
}

export class Mouse {
  readonly #target: InputTarget
  #x = 0
  #y = 0

  constructor(target: InputTarget) {
    this.#target = target
  }

  get position(): { readonly x: number; readonly y: number } {
    return { x: this.#x, y: this.#y }
  }

  move(x: number, y: number, options: { readonly steps?: number } = {}): Promise<ActResult> {
    const steps = Math.max(1, Math.floor(options.steps ?? 1))
    const from = { x: this.#x, y: this.#y }
    const events: InputEvent[] = Array.from({ length: steps }, (_, i) => {
      const t = (i + 1) / steps
      return { type: 'move', x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t }
    })
    this.#x = x
    this.#y = y
    return send(this.#target, `mouse.move(${x}, ${y}${steps > 1 ? `, { steps: ${steps} }` : ''})`, events)
  }

  down(options: { readonly button?: MouseButton } = {}): Promise<ActResult> {
    const event: InputEvent = { type: 'down', x: this.#x, y: this.#y, button: options.button ?? 'left' }
    return send(this.#target, `mouse.down(${Mouse.#button(options.button)})`, [event])
  }

  up(options: { readonly button?: MouseButton } = {}): Promise<ActResult> {
    const event: InputEvent = { type: 'up', x: this.#x, y: this.#y, button: options.button ?? 'left' }
    return send(this.#target, `mouse.up(${Mouse.#button(options.button)})`, [event])
  }

  click(x: number, y: number, options: ClickOptions = {}): Promise<ActResult> {
    const button = options.button ?? 'left'
    const held = Keyboard.keys(options.modifiers)
    const count = Math.max(1, Math.floor(options.clickCount ?? 1))
    const press: InputEvent[] = [{ type: 'down', x, y, button }, { type: 'up', x, y, button }]
    const presses: InputEvent[] = Array.from({ length: count }, () => press).flat()
    this.#x = x
    this.#y = y
    return send(this.#target, `mouse.click(${x}, ${y}${Mouse.#options(options)})`, [
      { type: 'move', x, y },
      ...held.map((key): InputEvent => ({ type: 'keydown', key })),
      ...presses,
      ...[...held].reverse().map((key): InputEvent => ({ type: 'keyup', key })),
    ])
  }

  dblclick(
    x: number, y: number, options: { readonly button?: MouseButton; readonly modifiers?: readonly Modifier[] } = {},
  ): Promise<ActResult> {
    return this.click(x, y, { ...options, clickCount: 2 })
  }

  wheel(deltaX: number, deltaY: number): Promise<ActResult> {
    const event: InputEvent = { type: 'wheel', x: this.#x, y: this.#y, dx: deltaX, dy: deltaY }
    return send(this.#target, `mouse.wheel(${deltaX}, ${deltaY})`, [event])
  }

  static #button(button: MouseButton | undefined): string {
    return button && button !== 'left' ? `{ button: '${button}' }` : ''
  }

  static #options(options: object): string {
    const given = Object.entries(options).filter(([, v]) => v !== undefined)
    const parts = given.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    return parts.length ? `, { ${parts.join(', ')} }` : ''
  }
}

export class Keyboard {
  readonly #target: InputTarget

  constructor(target: InputTarget) {
    this.#target = target
  }

  static keys(modifiers: readonly Modifier[] | undefined): string[] {
    return Modifiers.chord(modifiers)?.split('+') ?? []
  }

  down(key: string): Promise<ActResult> {
    return send(this.#target, `keyboard.down(${JSON.stringify(key)})`, [{ type: 'keydown', key: Keyboard.#key(key) }])
  }

  up(key: string): Promise<ActResult> {
    return send(this.#target, `keyboard.up(${JSON.stringify(key)})`, [{ type: 'keyup', key: Keyboard.#key(key) }])
  }

  press(keys: string): Promise<ActResult> {
    const chord = keys.split('+').map((k) => Keyboard.#key(k.trim()))
    if (chord.some((k) => !k)) {
      throw new Error(`keyboard.press: ${JSON.stringify(keys)} is not a key or a chord like "Control+a"`)
    }
    const down = chord.map((key): InputEvent => ({ type: 'keydown', key }))
    const up = [...chord].reverse().map((key): InputEvent => ({ type: 'keyup', key }))
    const events: InputEvent[] = [...down, ...up]
    return send(this.#target, `keyboard.press(${JSON.stringify(keys)})`, events)
  }

  type(text: string): Promise<ActResult> {
    const events: InputEvent[] = []
    for (const char of text) {
      const key = Keyboard.#typed(char)
      if (key === null) events.push({ type: 'text', text: char })
      else {
        const tap: InputEvent[] = [{ type: 'keydown', key: key.key }, { type: 'keyup', key: key.key }]
        if (key.shift) events.push({ type: 'keydown', key: 'shift' }, ...tap, { type: 'keyup', key: 'shift' })
        else events.push(...tap)
      }
    }
    return send(this.#target, `keyboard.type(${JSON.stringify(text)})`, events)
  }

  insertText(text: string): Promise<ActResult> {
    return send(this.#target, `keyboard.insertText(${JSON.stringify(text)})`, [{ type: 'text', text }])
  }

  static #key(key: string): string {
    if (key.length === 1 && /[A-Za-z0-9]/.test(key)) return key.toLowerCase()
    return { ' ': 'space', Space: 'space', Control: 'ctrl', ControlOrMeta: 'ctrl' }[key] ?? key
  }

  static #typed(char: string): { key: string; shift: boolean } | null {
    if (/^[a-z0-9]$/.test(char)) return { key: char, shift: false }
    if (/^[A-Z]$/.test(char)) return { key: char.toLowerCase(), shift: true }
    const named: Record<string, string> = { ' ': 'space', '\n': 'enter', '\t': 'tab' }
    const plain = named[char] ?? ("-=[];'`\\,./".includes(char) ? char : undefined)
    if (plain) return { key: plain, shift: false }
    return null
  }
}
