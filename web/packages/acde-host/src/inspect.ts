import type { InspectAction, InspectArg, InspectMatch, InspectNode, InspectWindow, WindowState } from '@dopame/acde-api'
import type { BrokerShell } from './broker'
import type { ShellWindow } from './broker/types'
import { WindowCalls } from './broker/calls/windows'
import { Outline, type Line } from './inspect/outline'
import { chordCodes, keyCode } from './keys'
import type { PageNode, PagePoint, PageQuery, PageTree } from './pageinspect'
import type { Rpc } from './rpc'

export interface NativeAccessibility {
  tree(pid: number, title: string | null, limit: number): Promise<string | null>
  act(node: string, action: string, text?: string | null): Promise<boolean>
}

interface InspectHost {
  readonly shell: BrokerShell
  web(window: number): Rpc | null
  record(window: number): { readonly kind: 'native' | 'web'; readonly app: string | null; readonly title: string | null; readonly state?: WindowState } | null
  panel(window: number): boolean
  close(window: number): Promise<unknown>
  hide(window: number, hidden: boolean): void
  open(name: string): Promise<string>
  accessibility(): Promise<NativeAccessibility | null>
  records(): readonly number[]
}

interface SnapshotOptions {
  readonly window?: string
  readonly ref?: string
  readonly all?: boolean
  readonly diff?: boolean
  readonly limit?: number
  readonly find?: string
  readonly tree?: boolean
  readonly offscreen?: boolean
}

interface QueryOptions {
  readonly selector: string
  readonly window?: string
  readonly ref?: string
  readonly limit?: number
  readonly attributes?: readonly string[]
}

interface Query {
  readonly window: string
  readonly count: number
  readonly nodes: readonly InspectMatch[]
}

interface Snapshot {
  readonly text: string
  readonly windows: readonly InspectWindow[]
  readonly trees: Readonly<Record<string, readonly InspectNode[]>>
}

interface InspectStep {
  readonly ref: string
  readonly action: InspectAction
  readonly text?: InspectArg
}

interface ActResult {
  readonly ok: boolean
  readonly text: string
}

interface NativeNode {
  readonly id: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly states?: readonly string[]
  readonly rect?: readonly [number, number, number, number] | null
  readonly actions?: readonly string[]
  readonly more?: number
  readonly children?: readonly NativeNode[]
}

interface Aliases {
  readonly byKey: Map<string, number>
  readonly byNumber: Map<number, { key: string; rect: readonly [number, number, number, number] | null }>
  next: number
}

interface Tree {
  readonly nodes: InspectNode[]
  readonly notes: string[]
}

type Box = readonly [number, number, number, number]

interface MenuGeometry {
  readonly menus: readonly { readonly id: string; readonly label: string; readonly rect: Box }[]
  readonly open: {
    readonly index: number
    readonly hover: number | null
    readonly items: readonly {
      readonly label: string
      readonly shortcut: string | null
      readonly checked: boolean
      readonly disabled: boolean
      readonly separator: boolean
      readonly rect: Box
    }[]
  } | null
}

const LEFT = 0x110
const RIGHT = 0x111
const MIDDLE = 0x112
const MODIFIERS = new Set(['shift', 'ctrl', 'control', 'alt', 'option', 'meta', 'super', 'cmd', 'command'])

export type InspectInput =
  | { readonly type: 'move'; readonly x: number; readonly y: number }
  | { readonly type: 'down' | 'up'; readonly x: number; readonly y: number; readonly button?: 'left' | 'right' | 'middle' }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly dx?: number; readonly dy?: number }
  | { readonly type: 'keydown' | 'keyup'; readonly key: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'wait'; readonly ms: number }

type Point = { readonly x: number; readonly y: number } | { readonly error: string }

export class Inspect {
  static readonly LIMIT = 600
  static readonly SETTLE_MS = 400
  static readonly QUIET_MS = 200
  static readonly BUSY_MS = 3000
  static readonly OPEN_MS = 5000
  static readonly FIND_LIMIT = 3000
  static readonly DRAG_STEPS = 10
  static readonly DRAG_STEP_MS = 16
  static readonly INPUT_WAIT_MS = 10_000
  static readonly GENERIC = new Set([
    ...['generic', 'filler', 'panel', 'section', 'unknown', 'redundant-object', 'split-pane', 'layered-pane'],
    ...['scroll-pane', 'viewport', 'internal-frame', 'root-pane', 'glass-pane', 'option-pane', 'window'],
  ])

  readonly #host: InspectHost
  readonly #refs = new Map<number, string>()
  readonly #native = new Map<number, Aliases>()
  readonly #seen = new Map<string, Line[]>()
  #headers = ''
  #next = 1

  constructor(host: InspectHost) {
    this.#host = host
  }

  readonly api = {
    snapshot: (options?: SnapshotOptions): Promise<Snapshot> => this.snapshot(options ?? {}),
    act: (ref: string, action: InspectAction, arg?: InspectArg): Promise<ActResult> => this.act(String(ref), action, arg ?? null),
    run: (steps: readonly InspectStep[]): Promise<ActResult> =>
      this.run(Array.isArray(steps) ? steps.map((s) => ({ ref: String(s?.ref ?? ''), action: s?.action, text: s?.text ?? null })) : []),
    open: (name: string): Promise<ActResult> => this.open(String(name)),
    query: (options: QueryOptions): Promise<Query> => this.query(options),
    input: (window: number, events: readonly InspectInput[]): Promise<ActResult> => this.input(window, events),
  }

  windows(): InspectWindow[] {
    const rows = this.#host.shell.windows()
    const out: InspectWindow[] = []
    for (const row of rows) {
      const id = row.window ?? row.id
      if (id !== 0 && this.#host.panel(id)) continue
      const record = id === 0 ? null : this.#host.record(id)
      if (id !== 0 && !record) continue
      const state = this.#state(row)
      out.push({
        ref: this.#ref(id),
        id,
        kind: id === 0 ? 'desktop' : record!.kind,
        app: record?.app ?? null,
        title: record?.title ?? null,
        mode: row.mode,
        state,
        rect: [row.x, row.y, row.width, row.height],
        z: row.z,
        focus: row.focus,
        hidden: Inspect.#offScreen(row, state),
        pid: row.pid ?? null,
        parent: row.parent ?? null,
        modal: !!row.modal,
      })
    }
    return out.sort((a, b) => b.z - a.z)
  }

  #state(row: ShellWindow): WindowState {
    const id = row.window ?? row.id
    return row.state ?? (id === 0 ? undefined : this.#host.record(id)?.state) ?? 'normal'
  }

  static #offScreen(row: ShellWindow, state: WindowState): boolean {
    return !!row.hidden || state === 'minimized'
  }

  static #minimized(window: InspectWindow): string {
    return `${window.ref} is minimized; act restore on it first`
  }

  async snapshot(options: SnapshotOptions): Promise<Snapshot> {
    const windows = this.windows()
    const find = options.find?.trim().toLowerCase() || null
    const limit = find ? Inspect.FIND_LIMIT : Math.max(20, Math.min(Number(options.limit) || Inspect.LIMIT, 3000))
    const parsed = options.ref ? Inspect.#parse(options.ref) : null
    const wanted = parsed ? `w${parsed.window}` : options.window
    const targets =
      options.tree === false
        ? []
        : wanted
          ? windows.filter((w) => w.ref === wanted)
          : options.all || find
            ? windows.filter((w) => !w.hidden)
            : [windows.find((w) => w.focus && !w.hidden) ?? windows.find((w) => w.kind === 'desktop')].filter((w): w is InspectWindow => !!w)
    if (wanted && !targets.length) throw Object.assign(new Error(`no window ${wanted}`), { status: 404 })
    const headers = windows.map((w) => Inspect.#header(w))
    const same = options.diff && this.#headers === headers.join('\n')
    this.#headers = headers.join('\n')
    const trees: Record<string, readonly InspectNode[]> = {}
    const bodies = new Map<string, string[]>()
    for (const window of targets) {
      const { nodes, notes } = await this.#tree(window, parsed?.node ?? null, limit, options.offscreen === true, options.all === true)
      if (find) {
        const found = Outline.find(nodes, find)
        if (!found.length) continue
        trees[window.ref] = found
        const body: Line[] = []
        Outline.lines(found, 0, body)
        bodies.set(window.ref, body.map(([, line]) => line))
        continue
      }
      trees[window.ref] = nodes
      const body: Line[] = []
      Outline.lines(nodes, 0, body)
      const key = parsed?.node === undefined || parsed?.node === null ? window.ref : `${window.ref}.${parsed.node}`
      const before = this.#seen.get(key)
      this.#seen.set(key, body)
      const shown = options.diff && before ? Outline.diff(before, body) : body.length ? body.map(([, line]) => line) : ['(empty)']
      bodies.set(window.ref, [...shown, ...notes])
    }
    const lines: string[] = same ? ['(windows unchanged)'] : []
    for (const [i, window] of windows.entries()) {
      const body = bodies.get(window.ref)
      if (same && !body) continue
      lines.push(headers[i]!, ...(body ?? []).map((line) => `  ${line}`))
    }
    const hint = options.offscreen ? '' : '; elements outside the visible area are left out: scroll, add offscreen, or try another window'
    if (find && !Object.keys(trees).length) lines.push(`(no element contains ${JSON.stringify(options.find!.trim())}${hint})`)
    return { text: lines.join('\n'), windows, trees }
  }

  act(ref: string, action: InspectAction, arg: InspectArg): Promise<ActResult> {
    return this.run([{ ref, action, text: arg }])
  }

  async run(steps: readonly InspectStep[]): Promise<ActResult> {
    if (!steps.length) return { ok: false, text: 'no steps to do' }
    const before = Inspect.#shape(this.windows())
    const opening = this.#opening()
    const said: string[] = []
    let last: InspectWindow | null = null
    let failed = false
    for (const [i, step] of steps.entries()) {
      const done = await this.#step(step)
      said.push(steps.length > 1 ? `${i + 1}. ${done.text}` : done.text)
      if (!done.ok || !done.window) {
        failed = true
        break
      }
      last = done.window
      if (step.action === 'close') await Inspect.#sleep(Inspect.SETTLE_MS)
      else await this.#settle(done.window)
    }
    if (!last) return { ok: false, text: said.join('\n') }
    if (failed && steps.length > 1) said.push('(the remaining steps were not done)')
    await Inspect.#until(() => [...this.#opening()].every((id) => opening.has(id)))
    const windows = this.windows()
    const moved = Inspect.#shape(windows) !== before
    if (moved) {
      const focused = windows.find((w) => w.focus && !w.hidden)
      if (focused && focused.id !== last.id) await this.#settle(focused)
    }
    const after = moved ? await this.snapshot({ diff: true }) : await this.snapshot({ window: last.ref, diff: true })
    return { ok: !failed, text: `${said.join('\n')}${moved ? ' (the windows changed)' : ''}\n\n${after.text}` }
  }

  async open(name: string): Promise<ActResult> {
    try {
      const before = Inspect.#shape(this.windows())
      const opened = await this.#host.open(name)
      await Inspect.#until(() => Inspect.#shape(this.windows()) !== before)
      const focused = this.windows().find((w) => w.focus && !w.hidden)
      if (focused) await this.#settle(focused)
      const after = await this.snapshot({})
      return { ok: true, text: `${opened}\n\n${after.text}` }
    } catch (error) {
      return { ok: false, text: (error as Error).message ?? String(error) }
    }
  }

  async #step(step: InspectStep): Promise<ActResult & { window?: InspectWindow }> {
    const parsed = Inspect.#parse(step.ref)
    if (!parsed) return { ok: false, text: `cannot read ref ${step.ref} (expected like w3, w3.12 or a menu, w3.m1 or w3.m1.2)` }
    const window = this.windows().find((w) => w.ref === `w${parsed.window}`)
    if (!window) return { ok: false, text: `no window w${parsed.window}` }
    const arg = step.text ?? null
    try {
      const done =
        parsed.menu !== null
          ? await this.#menuAct(window, parsed.menu, parsed.item, step.action)
          : parsed.node === null
          ? await this.#windowAct(window, step.action, arg)
          : window.kind === 'native'
            ? await this.#nativeAct(window, parsed.node, step.action, arg)
            : await this.#webAct(window, parsed.node, step.action, arg)
      return { ...done, window }
    } catch (error) {
      return { ok: false, text: (error as Error).message ?? String(error) }
    }
  }

  async #settle(window: InspectWindow): Promise<void> {
    const rpc = window.kind === 'native' ? null : this.#host.web(window.id)
    if (!rpc) return Inspect.#sleep(Inspect.SETTLE_MS)
    await rpc.call('inspect', 'settle', [Inspect.QUIET_MS, Inspect.BUSY_MS]).catch(() => Inspect.#sleep(Inspect.SETTLE_MS))
  }

  #opening(): Set<number> {
    const shown = new Set(this.#host.shell.windows().map((r) => r.window ?? r.id))
    return new Set(this.#host.records().filter((id) => !shown.has(id)))
  }

  static async #until(done: () => boolean): Promise<void> {
    const started = Date.now()
    while (!done() && Date.now() - started < Inspect.OPEN_MS) await Inspect.#sleep(100)
  }

  async #windowAct(window: InspectWindow, action: InspectAction, arg: InspectArg): Promise<ActResult> {
    switch (action) {
      case 'focus':
      case 'restore':
        if (window.hidden) this.#host.hide(window.id, false)
        if (action === 'restore' && (window.state === 'filled' || window.state === 'fullscreen')) this.#host.shell.setState?.(window.id, 'normal')
        this.#focus(window)
        return { ok: true, text: `${window.ref} is in front` }
      case 'fill':
      case 'fullscreen': {
        const state = action === 'fill' ? 'filled' : 'fullscreen'
        if (window.kind === 'desktop') return { ok: false, text: `the desktop cannot be made ${state}` }
        if (window.mode === 'fullscreen') return { ok: false, text: `${window.ref} already fills the host window` }
        if (!this.#host.shell.setState) return { ok: false, text: `this session cannot make ${window.ref} ${state}` }
        if (window.hidden) this.#host.hide(window.id, false)
        this.#host.shell.setState(window.id, state)
        this.#focus(window)
        return { ok: true, text: `${window.ref} is ${state}` }
      }
      case 'minimize': {
        if (window.kind === 'desktop') return { ok: false, text: 'the desktop cannot be minimized' }
        const reason = WindowCalls.unminimizable(this.#host.shell.windows().find((row) => (row.window ?? row.id) === window.id))
        if (reason) return { ok: false, text: `${window.ref} cannot be minimized: ${reason}` }
        if (this.#host.shell.setState) this.#host.shell.setState(window.id, 'minimized')
        else this.#host.hide(window.id, true)
        return { ok: true, text: `${window.ref} is minimized` }
      }
      case 'close':
        if (window.kind === 'desktop') return { ok: false, text: 'the desktop cannot be closed' }
        await this.#host.close(window.id)
        return { ok: true, text: `closed ${window.ref}` }
      case 'key':
        this.#focus(window)
        this.#keys(String(arg ?? ''))
        return { ok: true, text: `pressed ${arg} in ${window.ref}` }
      case 'click':
      case 'double':
      case 'right':
      case 'hover':
      case 'scroll': {
        const [x, y, width, height] = window.rect
        return this.#pointer(window, x + width / 2, y + height / 2, action, arg)
      }
      default:
        return { ok: false, text: `a window cannot ${action}; give an element ref` }
    }
  }

  async #webAct(window: InspectWindow, node: number, action: InspectAction, arg: InspectArg): Promise<ActResult> {
    const rpc = this.#host.web(window.id)
    if (!rpc) return { ok: false, text: `the page of ${window.ref} is not running` }
    switch (action) {
      case 'type':
      case 'settext': {
        this.#focus(window)
        const { value } = (await rpc.call('inspect', 'type', [node, String(arg ?? ''), action === 'settext'])) as { value: string | null }
        return { ok: true, text: `typed, the value is now ${JSON.stringify(value ?? '')}` }
      }
      case 'focus':
        this.#focus(window)
        await rpc.call('inspect', 'focus', [node])
        return { ok: true, text: `focused ${window.ref}.${node}` }
      case 'key':
        this.#focus(window)
        await rpc.call('inspect', 'focus', [node])
        this.#keys(String(arg ?? ''))
        return { ok: true, text: `pressed ${arg}` }
      case 'select': {
        const values = Inspect.#values(arg)
        if (!values) return { ok: false, text: 'select needs the value or text of an option (a string, or a list of strings for a multiple select)' }
        const { selected } = (await rpc.call('inspect', 'select', [node, values])) as { selected: string[] }
        return { ok: true, text: `selected ${JSON.stringify(selected)}` }
      }
      case 'drag': {
        const point = await this.#measure(window, rpc, node)
        if ('error' in point) return { ok: false, text: point.error }
        return this.#drag(window, window.rect[0] + point.x, window.rect[1] + point.y, arg)
      }
      default: {
        const point = await this.#measure(window, rpc, node)
        if ('error' in point) return { ok: false, text: point.error }
        const [x, y] = window.rect
        return this.#pointer(window, x + point.x, y + point.y, action, arg)
      }
    }
  }

  async #nativeAct(window: InspectWindow, node: number, action: InspectAction, arg: InspectArg): Promise<ActResult> {
    const entry = this.#native.get(window.id)?.byNumber.get(node)
    if (!entry) return { ok: false, text: `unknown ref ${window.ref}.${node}; snapshot ${window.ref} first` }
    const access = await this.#host.accessibility()
    const at = (): [number, number] | null => {
      if (!entry.rect) return null
      const [x, y, w, h] = entry.rect
      return [window.rect[0] + x + w / 2, window.rect[1] + y + h / 2]
    }
    switch (action) {
      case 'click':
        if (access && (await access.act(entry.key, 'click').catch(() => false))) return { ok: true, text: `clicked ${window.ref}.${node}` }
        break
      case 'type':
      case 'settext':
        if (access && (await access.act(entry.key, action, String(arg ?? '')).catch(() => false))) {
          return { ok: true, text: `typed ${JSON.stringify(String(arg ?? ''))}` }
        }
        return { ok: false, text: 'cannot type into this element directly; click it, then use key or type on the window' }
      case 'focus':
        if (access && (await access.act(entry.key, 'focus').catch(() => false))) return { ok: true, text: `focused ${window.ref}.${node}` }
        break
      case 'key':
        this.#focus(window)
        if (access) await access.act(entry.key, 'focus').catch(() => false)
        this.#keys(String(arg ?? ''))
        return { ok: true, text: `pressed ${arg}` }
      default:
        break
    }
    const point = at()
    if (!point) return { ok: false, text: `${window.ref}.${node} has no position, cannot ${action}` }
    if (action === 'drag') return this.#drag(window, point[0], point[1], arg)
    return this.#pointer(window, point[0], point[1], action === 'focus' ? 'click' : action, arg)
  }

  #pointer(window: InspectWindow, x: number, y: number, action: InspectAction, arg: InspectArg): ActResult {
    if (window.hidden) return { ok: false, text: Inspect.#minimized(window) }
    const cover = this.#cover(window, x, y)
    if (cover) {
      if (window.kind === 'desktop') return { ok: false, text: `covered there by ${Inspect.#label(cover)}; minimize or close it first` }
      this.#focus(window)
    }
    const shell = this.#host.shell
    const held = action === 'scroll' ? [] : Inspect.#modifiers(arg)
    if (held === null) return { ok: false, text: `${action} takes the modifier keys to hold (shift, ctrl, alt, meta, joined with +), not ${JSON.stringify(arg)}` }
    shell.inject({ type: 'move', x, y })
    for (const code of held) shell.inject({ type: 'keydown', code })
    try {
      return this.#press(action, x, y, arg, held.length ? ` (holding ${String(arg)})` : '')
    } finally {
      for (const code of [...held].reverse()) shell.inject({ type: 'keyup', code })
    }
  }

  static #modifiers(arg: InspectArg): number[] | null {
    if (arg === null || arg === undefined || arg === '') return []
    if (typeof arg !== 'string') return null
    const names = arg.toLowerCase().split('+').map((n) => n.trim()).filter(Boolean)
    if (!names.every((n) => MODIFIERS.has(n))) return null
    const codes = names.map((n) => keyCode(n))
    return codes.every((c): c is number => c !== null) ? codes : null
  }

  #press(action: InspectAction, x: number, y: number, arg: InspectArg, held: string): ActResult {
    const shell = this.#host.shell
    const press = (button: number) => {
      shell.inject({ type: 'down', x, y, button })
      shell.inject({ type: 'up', x, y, button })
    }
    switch (action) {
      case 'hover':
        return { ok: true, text: `moved the pointer to ${Math.round(x)},${Math.round(y)}${held}` }
      case 'right':
        press(RIGHT)
        return { ok: true, text: `right-clicked ${Math.round(x)},${Math.round(y)}${held}` }
      case 'double':
        press(LEFT)
        press(LEFT)
        return { ok: true, text: `double-clicked ${Math.round(x)},${Math.round(y)}${held}` }
      case 'scroll': {
        const dy = Number(arg) || 400
        shell.inject({ type: 'wheel', x, y, dx: 0, dy, source: 'wheel' })
        return { ok: true, text: `scrolled ${dy} at ${Math.round(x)},${Math.round(y)}` }
      }
      case 'click':
        press(LEFT)
        return { ok: true, text: `clicked ${Math.round(x)},${Math.round(y)}${held}` }
      default:
        return { ok: false, text: `unsupported action ${action}` }
    }
  }

  async #drag(window: InspectWindow, x: number, y: number, to: InspectArg): Promise<ActResult> {
    const parsed = typeof to === 'string' ? Inspect.#parse(to) : null
    if (typeof to !== 'string' || !parsed) return { ok: false, text: 'drag needs where to drop: the target ref (like w3.12, or a window w3)' }
    if (window.hidden) return { ok: false, text: Inspect.#minimized(window) }
    const onto = this.windows().find((w) => w.ref === `w${parsed.window}`)
    if (onto?.hidden) return { ok: false, text: `cannot drop: ${Inspect.#minimized(onto)}` }
    const cover = this.#cover(window, x, y)
    if (cover) {
      if (window.kind === 'desktop') return { ok: false, text: `covered there by ${Inspect.#label(cover)}; minimize or close it first` }
      this.#focus(window)
    }
    const shell = this.#host.shell
    const step = () => Inspect.#sleep(Inspect.DRAG_STEP_MS)
    shell.inject({ type: 'move', x, y })
    await step()
    shell.inject({ type: 'down', x, y, button: LEFT })
    await step()
    const target = await this.#point(to)
    if ('error' in target) {
      shell.inject({ type: 'up', x, y, button: LEFT })
      return { ok: false, text: `cannot drop: ${target.error}` }
    }
    for (let i = 1; i <= Inspect.DRAG_STEPS; i++) {
      const t = i / Inspect.DRAG_STEPS
      shell.inject({ type: 'move', x: x + (target.x - x) * t, y: y + (target.y - y) * t })
      await step()
    }
    await step()
    shell.inject({ type: 'up', x: target.x, y: target.y, button: LEFT })
    return { ok: true, text: `dragged from ${Math.round(x)},${Math.round(y)} to ${to} (${Math.round(target.x)},${Math.round(target.y)})` }
  }

  async #point(ref: string): Promise<Point> {
    const parsed = Inspect.#parse(ref)
    const window = parsed && this.windows().find((w) => w.ref === `w${parsed.window}`)
    if (!parsed || !window) return { error: `no ${ref}` }
    const [wx, wy, ww, wh] = window.rect
    if (parsed.node === null) return this.#uncovered(window, wx + ww / 2, wy + wh / 2)
    if (window.kind === 'native') {
      const rect = this.#native.get(window.id)?.byNumber.get(parsed.node)?.rect
      if (!rect) return { error: `${ref} has no position` }
      return this.#uncovered(window, wx + rect[0] + rect[2] / 2, wy + rect[1] + rect[3] / 2)
    }
    const rpc = this.#host.web(window.id)
    if (!rpc) return { error: `the page of ${window.ref} is not running` }
    const point = await this.#measure(window, rpc, parsed.node)
    return 'error' in point ? point : this.#uncovered(window, wx + point.x, wy + point.y)
  }

  async #measure(window: InspectWindow, rpc: Rpc, node: number): Promise<PagePoint> {
    if (window.hidden) return { error: Inspect.#minimized(window) }
    return (await rpc.call('inspect', 'point', [node])) as PagePoint
  }

  #uncovered(window: InspectWindow, x: number, y: number): Point {
    if (window.hidden) return { error: Inspect.#minimized(window) }
    const cover = this.#cover(window, x, y)
    return cover ? { error: `${window.ref} is covered there by ${Inspect.#label(cover)}` } : { x, y }
  }

  static #label(w: InspectWindow): string {
    return `${w.ref} (${w.title ?? w.app ?? w.kind})`
  }

  static #values(arg: InspectArg): string[] | null {
    if (typeof arg === 'string') return [arg]
    if (Array.isArray(arg) && arg.every((v) => typeof v === 'string')) return [...arg]
    return null
  }

  #cover(window: InspectWindow, x: number, y: number): InspectWindow | null {
    const rows = this.#host.shell.windows()
    const own = rows.find((r) => (r.window ?? r.id) === window.id)
    const at = (row: (typeof rows)[number]) => x >= row.x && y >= row.y && x < row.x + row.width && y < row.y + row.height
    const away = (row: ShellWindow) => Inspect.#offScreen(row, this.#state(row))
    const panel = window.kind === 'desktop' ? rows.find((row) => !away(row) && this.#host.panel(row.window ?? row.id) && at(row)) : undefined
    for (const row of rows) {
      const id = row.window ?? row.id
      if (id === window.id || away(row) || (own && row.z <= own.z)) continue
      if (window.kind === 'desktop' && this.#host.panel(id)) continue
      if (panel && !(row.mode === 'pinned' && row.z > panel.z)) continue
      if (!at(row)) continue
      if (this.#host.panel(id)) {
        const rect: [number, number, number, number] = [row.x, row.y, row.width, row.height]
        const title = 'desktop panel'
        return { ref: 'w0', id: 0, kind: 'desktop', app: null, title, mode: row.mode, rect, z: row.z, focus: row.focus, hidden: false, pid: null }
      }
      return this.windows().find((w) => w.id === id) ?? null
    }
    return null
  }

  #focus(window: InspectWindow): void {
    if (window.kind === 'desktop') return
    this.#host.shell.focus(window.id)
  }

  #keys(spec: string): void {
    const shell = this.#host.shell
    const chords = spec.trim().split(/\s+/).filter(Boolean).map((chord) => ({ chord, codes: chordCodes(chord) }))
    const unknown = chords.filter((c) => !c.codes).map((c) => c.chord)
    if (unknown.length) throw new Error(`unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')} (nothing was pressed)`)
    for (const { codes } of chords) {
      for (const code of codes!) shell.inject({ type: 'keydown', code })
      for (const code of [...codes!].reverse()) shell.inject({ type: 'keyup', code })
    }
  }

  async input(id: number, events: readonly InspectInput[]): Promise<ActResult> {
    const window = this.windows().find((w) => w.id === id)
    if (!window) return { ok: false, text: `window ${id} is gone` }
    const rpc = this.#host.web(window.id)
    if (!rpc) return { ok: false, text: `the page of ${window.ref} is not running` }
    if (!Array.isArray(events) || !events.length) return { ok: false, text: 'input needs a list of events' }
    const [ox, oy] = (await rpc.call('inspect', 'offset', [])) as [number, number]
    const at = (e: { x: number; y: number }) => {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) throw new Error('input: x and y are page coordinates (numbers)')
      return { x: window.rect[0] + ox + e.x, y: window.rect[1] + oy + e.y }
    }
    const buttons = { left: LEFT, right: RIGHT, middle: MIDDLE } as const
    const shell = this.#host.shell
    this.#focus(window)
    let moved = false
    let pointer: { x: number; y: number } | null = null
    const to = (event: { x: number; y: number }) => {
      const point = at(event)
      if (pointer?.x !== point.x || pointer.y !== point.y) shell.inject({ type: 'move', ...point })
      pointer = point
      return point
    }
    for (const event of events) {
      if (event?.type === 'move' && moved) await Inspect.#sleep(Inspect.DRAG_STEP_MS)
      moved = event?.type === 'move'
      switch (event?.type) {
        case 'move':
          pointer = at(event)
          shell.inject({ type: 'move', ...pointer })
          break
        case 'down':
        case 'up': {
          const button = buttons[(event.button ?? 'left') as keyof typeof buttons] as number | undefined
          if (button === undefined) throw new Error(`input: button is left, right or middle, not ${String(event.button)}`)
          shell.inject({ type: event.type, ...to(event), button })
          break
        }
        case 'wheel':
          shell.inject({ type: 'wheel', ...to(event), dx: Number(event.dx) || 0, dy: Number(event.dy) || 0, source: 'wheel' })
          break
        case 'keydown':
        case 'keyup': {
          const code = keyCode(String(event.key ?? ''))
          if (code === null) throw new Error(`input: unknown key ${JSON.stringify(event.key)}`)
          shell.inject({ type: event.type, code })
          break
        }
        case 'text':
          await rpc.call('inspect', 'text', [String(event.text ?? '')])
          break
        case 'wait': {
          const ms = Number(event.ms)
          if (!(ms >= 0 && ms <= Inspect.INPUT_WAIT_MS)) throw new Error(`input: wait takes ms from 0 to ${Inspect.INPUT_WAIT_MS}, not ${JSON.stringify(event.ms)}`)
          await Inspect.#sleep(ms)
          break
        }
        default:
          throw new Error(`input: an event's type is move, down, up, wheel, keydown, keyup, text or wait, not ${JSON.stringify((event as { type?: unknown })?.type)}`)
      }
    }
    await this.#settle(window)
    return { ok: true, text: `sent ${events.length} input events to ${window.ref}` }
  }

  async query(options: QueryOptions): Promise<Query> {
    const selector = String(options?.selector ?? '').trim()
    if (!selector) throw Object.assign(new Error('query needs a CSS selector'), { status: 400 })
    const parsed = options.ref ? Inspect.#parse(options.ref) : null
    if (options.ref && !parsed) throw Object.assign(new Error(`cannot read ref ${options.ref} (expected like w3 or w3.12)`), { status: 400 })
    const windows = this.windows()
    const wanted = parsed ? `w${parsed.window}` : options.window
    const window = wanted ? windows.find((w) => w.ref === wanted) : (windows.find((w) => w.focus && !w.hidden) ?? windows.find((w) => w.kind === 'desktop'))
    if (!window) throw Object.assign(new Error(wanted ? `no window ${wanted}` : 'no window'), { status: 404 })
    if (window.kind === 'native') throw Object.assign(new Error(`${window.ref} is a native window; CSS selectors work only in pages`), { status: 400 })
    const rpc = this.#host.web(window.id)
    if (!rpc) throw Object.assign(new Error(`the page of ${window.ref} is not running`), { status: 409 })
    const limit = Math.max(1, Math.min(Number(options.limit) || Inspect.LIMIT, Inspect.FIND_LIMIT))
    const attributes = Array.isArray(options.attributes) ? options.attributes.filter((a): a is string => typeof a === 'string' && !!a).slice(0, 20) : []
    const found = (await rpc.call('inspect', 'query', [selector, parsed?.node ?? -1, limit, attributes])) as PageQuery
    const nodes = found.nodes.map((n): InspectMatch => {
      const node = Inspect.#node(window, n.id, n, n.states, n.rect, [])
      return { ...node, tag: n.tag, visible: n.visible && !window.hidden, ...(n.attributes && { attributes: n.attributes }) }
    })
    return { window: window.ref, count: found.count, nodes }
  }

  async #tree(window: InspectWindow, node: number | null, limit: number, offscreen = false, invisible = false): Promise<Tree> {
    if (window.hidden) return { nodes: [], notes: ['(minimized; act restore on it to see its elements)'] }
    if (window.kind === 'native') return this.#nativeTree(window, limit)
    const rpc = this.#host.web(window.id)
    if (!rpc) return { nodes: [], notes: ['(the page is not running)'] }
    const tree = (await rpc.call('inspect', 'tree', [node ?? -1, limit, offscreen, invisible])) as PageTree
    const convert = (n: PageNode): InspectNode => Inspect.#node(window, n.id, n, n.states, n.rect, (n.children ?? []).map(convert))
    const notes: string[] = []
    if (tree.hidden) notes.push(`(${tree.hidden} more outside the visible area; scroll, or add offscreen)`)
    if (tree.truncated) notes.push(`(too many elements, listed ${limit}; snapshot a ref to see what is under it)`)
    const menus = node === null ? this.#menus(window) : null
    return { nodes: [...(menus ? [Inspect.#menubar(window, menus)] : []), ...tree.nodes.map(convert)], notes }
  }

  #menus(window: InspectWindow): MenuGeometry | null {
    const text = this.#host.shell.menus?.(window.id)
    if (!text) return null
    const geometry = JSON.parse(text) as MenuGeometry
    return geometry.menus.length ? geometry : null
  }

  static #menubar(window: InspectWindow, geometry: MenuGeometry): InspectNode {
    const [ox, oy] = window.rect
    const at = ([x, y, w, h]: Box): Box => [x + ox, y + oy, w, h]
    const menus = geometry.menus.map((menu, i): InspectNode => {
      const open = geometry.open?.index === i ? geometry.open : null
      const items = (open?.items ?? []).flatMap((item, k): InspectNode[] => {
        if (item.separator) return []
        const states = [...(item.disabled ? ['disabled'] : []), ...(item.checked ? ['checked'] : []), ...(open?.hover === k ? ['focused'] : [])]
        return [{
          ref: `${window.ref}.m${i + 1}.${k + 1}`,
          role: 'menuitem',
          name: item.label,
          ...(item.shortcut ? { value: item.shortcut } : {}),
          ...(states.length ? { states } : {}),
          rect: at(item.rect),
        }]
      })
      return {
        ref: `${window.ref}.m${i + 1}`,
        role: 'menuitem',
        name: menu.label,
        states: [open ? 'expanded' : 'collapsed'],
        rect: at(menu.rect),
        ...(items.length ? { children: items } : {}),
      }
    })
    return { ref: `${window.ref}.m`, role: 'menubar', children: menus }
  }

  async #menuAct(window: InspectWindow, menu: number, item: number | null, action: InspectAction): Promise<ActResult> {
    const ref = `${window.ref}.m${menu}${item === null ? '' : `.${item}`}`
    if (action !== 'click' && action !== 'hover') return { ok: false, text: `a menu can be clicked or hovered, not ${action}` }
    const geometry = this.#menus(window)
    if (!geometry) return { ok: false, text: `${window.ref} shows no menus (menus show on the window frame only when no desktop does)` }
    const label = geometry.menus[menu - 1]
    if (!label) return { ok: false, text: `no menu ${ref}; ${window.ref} has ${geometry.menus.length}` }
    const centre = ([x, y, w, h]: Box): [number, number] => [window.rect[0] + x + w / 2, window.rect[1] + y + h / 2]
    if (item === null) return this.#pointer(window, ...centre(label.rect), action, null)
    let open = geometry.open?.index === menu - 1 ? geometry.open : null
    if (!open) {
      const opened = this.#pointer(window, ...centre(label.rect), geometry.open ? 'hover' : 'click', null)
      if (!opened.ok) return opened
      const started = Date.now()
      while (!open && Date.now() - started < Inspect.OPEN_MS) {
        await Inspect.#sleep(20)
        const now = this.#menus(window)?.open
        open = now?.index === menu - 1 && now.items.length ? now : null
      }
      if (!open) return { ok: false, text: `${window.ref}.m${menu} did not open` }
    }
    const row = open.items[item - 1]
    if (!row || row.separator) return { ok: false, text: `no item ${ref}` }
    if (row.disabled && action === 'click') return { ok: false, text: `${ref} (${row.label}) is disabled` }
    const done = this.#pointer(window, ...centre(row.rect), action, null)
    return done.ok ? { ok: true, text: `${action === 'click' ? 'chose' : 'hovered'} ${label.label} › ${row.label}` } : done
  }

  async #nativeTree(window: InspectWindow, limit: number): Promise<Tree> {
    const access = await this.#host.accessibility()
    if (!access) return { nodes: [], notes: ['(this session has no AT-SPI, so native windows show no elements)'] }
    if (!window.pid) return { nodes: [], notes: ['(the process of this window is unknown)'] }
    const json = await access.tree(window.pid, window.title, limit)
    if (!json) return { nodes: [], notes: ['(this program reports no accessibility information)'] }
    const root = JSON.parse(json) as NativeNode
    let aliases = this.#native.get(window.id)
    if (!aliases) this.#native.set(window.id, (aliases = { byKey: new Map(), byNumber: new Map(), next: 1 }))
    const table = aliases
    const convert = (n: NativeNode): InspectNode[] => {
      let number = table.byKey.get(n.id)
      if (number === undefined) {
        number = table.next++
        table.byKey.set(n.id, number)
      }
      table.byNumber.set(number, { key: n.id, rect: n.rect ?? null })
      const children = (n.children ?? []).flatMap(convert)
      if (Inspect.GENERIC.has(n.role) && !n.name && !n.more) return children
      const plain = !['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab'].includes(n.role)
      const states = [...(n.states ?? []), ...(n.actions?.length && plain ? ['clickable'] : [])]
      return [Inspect.#node(window, number, n, states, n.rect, children)]
    }
    return { nodes: (root.children ?? []).flatMap(convert), notes: [] }
  }

  static #node(
    window: InspectWindow,
    id: number,
    n: { role: string; name?: string; value?: string; level?: number; more?: number },
    states: readonly string[] | undefined,
    rect: readonly [number, number, number, number] | null | undefined,
    children: InspectNode[],
  ): InspectNode {
    const [ox, oy] = window.rect
    return {
      ref: `${window.ref}.${id}`,
      role: n.role,
      ...(n.name ? { name: n.name } : {}),
      ...(n.value !== undefined ? { value: n.value } : {}),
      ...(states?.length ? { states } : {}),
      ...(n.level ? { level: n.level } : {}),
      ...(rect ? { rect: [rect[0] + ox, rect[1] + oy, rect[2], rect[3]] as const } : {}),
      ...(n.more ? { more: n.more } : {}),
      ...(children.length ? { children } : {}),
    }
  }

  #ref(id: number): string {
    if (id === 0) return 'w0'
    let ref = this.#refs.get(id)
    if (!ref) this.#refs.set(id, (ref = `w${this.#next++}`))
    return ref
  }

  static #parse(ref: string): { window: number; node: number | null; menu: number | null; item: number | null } | null {
    const m = /^w(\d+)(?:\.(\d+)|\.m([1-9]\d*)(?:\.([1-9]\d*))?)?$/.exec(ref.trim())
    if (!m) return null
    const number = (v: string | undefined) => (v === undefined ? null : Number(v))
    return { window: Number(m[1]), node: number(m[2]), menu: number(m[3]), item: number(m[4]) }
  }

  static #shape(windows: readonly InspectWindow[]): string {
    return windows.map((w) => `${w.ref}${w.focus ? '*' : ''}${w.hidden ? '-' : ''}`).join(' ')
  }

  static #header(w: InspectWindow): string {
    const flags = [w.app ? `app=${w.app}` : '', w.kind === 'native' ? 'native' : '', w.focus ? 'focused' : '', w.hidden ? 'minimized' : '']
    if (w.mode !== 'free') flags.push(w.mode)
    if ((w.state === 'filled' || w.state === 'fullscreen') && !flags.includes(w.state)) flags.push(w.state)
    const title = w.title ? ` ${JSON.stringify(w.title)}` : ''
    return `- ${w.kind === 'desktop' ? 'desktop' : 'window'}${title}${flags.map((f) => (f ? ` [${f}]` : '')).join('')} [${w.ref}]`
  }

  static #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
