import type { InspectAction, InspectArg, InspectMatch, InspectNode, InspectWindow } from '@dopame/acde-api'
import type { BrokerShell } from './broker'
import { chordCodes } from './keys'
import type { PageNode, PagePoint, PageQuery, PageTree } from './pageinspect'
import type { Rpc } from './rpc'

export interface NativeAccessibility {
  tree(pid: number, title: string | null, limit: number): Promise<string | null>
  act(node: string, action: string, text?: string | null): Promise<boolean>
}

interface InspectHost {
  readonly shell: BrokerShell
  web(window: number): Rpc | null
  record(window: number): { readonly kind: 'native' | 'web'; readonly app: string | null; readonly title: string | null } | null
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

type Line = readonly [string, string]

interface Tree {
  readonly nodes: InspectNode[]
  readonly notes: string[]
}

const LEFT = 0x110
const RIGHT = 0x111

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
  }

  windows(): InspectWindow[] {
    const rows = this.#host.shell.windows()
    const out: InspectWindow[] = []
    for (const row of rows) {
      const id = row.window ?? row.id
      if (id !== 0 && this.#host.panel(id)) continue
      const record = id === 0 ? null : this.#host.record(id)
      if (id !== 0 && !record) continue
      out.push({
        ref: this.#ref(id),
        id,
        kind: id === 0 ? 'desktop' : record!.kind,
        app: record?.app ?? null,
        title: record?.title ?? null,
        mode: row.mode,
        state: row.state ?? 'normal',
        rect: [row.x, row.y, row.width, row.height],
        z: row.z,
        focus: row.focus,
        hidden: !!row.hidden || row.state === 'minimized',
        pid: row.pid ?? null,
        parent: row.parent ?? null,
        modal: !!row.modal,
      })
    }
    return out.sort((a, b) => b.z - a.z)
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
        const found = Inspect.#find(nodes, find)
        if (!found.length) continue
        trees[window.ref] = found
        const body: Line[] = []
        Inspect.#lines(found, 0, body)
        bodies.set(window.ref, body.map(([, line]) => line))
        continue
      }
      trees[window.ref] = nodes
      const body: Line[] = []
      Inspect.#lines(nodes, 0, body)
      const key = parsed?.node === undefined || parsed?.node === null ? window.ref : `${window.ref}.${parsed.node}`
      const before = this.#seen.get(key)
      this.#seen.set(key, body)
      const shown = options.diff && before ? Inspect.#diff(before, body) : body.length ? body.map(([, line]) => line) : ['(empty)']
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
    if (!parsed) return { ok: false, text: `cannot read ref ${step.ref} (expected like w3 or w3.12)` }
    const window = this.windows().find((w) => w.ref === `w${parsed.window}`)
    if (!window) return { ok: false, text: `no window w${parsed.window}` }
    const arg = step.text ?? null
    try {
      const done =
        parsed.node === null
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
        if (window.state === 'minimized' && this.#host.shell.setState) this.#host.shell.setState(window.id, 'normal')
        else if (window.hidden) this.#host.hide(window.id, false)
        this.#focus(window)
        return { ok: true, text: `${window.ref} is in front` }
      case 'minimize':
        if (window.kind === 'desktop') return { ok: false, text: 'the desktop cannot be minimized' }
        if (this.#host.shell.setState) this.#host.shell.setState(window.id, 'minimized')
        else this.#host.hide(window.id, true)
        return { ok: true, text: `${window.ref} is minimized` }
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
        const point = (await rpc.call('inspect', 'point', [node])) as PagePoint
        if ('error' in point) return { ok: false, text: point.error }
        return this.#drag(window, window.rect[0] + point.x, window.rect[1] + point.y, arg)
      }
      default: {
        const point = (await rpc.call('inspect', 'point', [node])) as PagePoint
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
    const cover = this.#cover(window, x, y)
    if (cover) {
      if (window.kind === 'desktop') return { ok: false, text: `covered there by ${Inspect.#label(cover)}; minimize or close it first` }
      this.#focus(window)
    }
    const shell = this.#host.shell
    shell.inject({ type: 'move', x, y })
    const press = (button: number) => {
      shell.inject({ type: 'down', x, y, button })
      shell.inject({ type: 'up', x, y, button })
    }
    switch (action) {
      case 'hover':
        return { ok: true, text: `moved the pointer to ${Math.round(x)},${Math.round(y)}` }
      case 'right':
        press(RIGHT)
        return { ok: true, text: `right-clicked ${Math.round(x)},${Math.round(y)}` }
      case 'double':
        press(LEFT)
        press(LEFT)
        return { ok: true, text: `double-clicked ${Math.round(x)},${Math.round(y)}` }
      case 'scroll': {
        const dy = Number(arg) || 400
        shell.inject({ type: 'wheel', x, y, dx: 0, dy, source: 'wheel' })
        return { ok: true, text: `scrolled ${dy} at ${Math.round(x)},${Math.round(y)}` }
      }
      case 'click':
        press(LEFT)
        return { ok: true, text: `clicked ${Math.round(x)},${Math.round(y)}` }
      default:
        return { ok: false, text: `unsupported action ${action}` }
    }
  }

  async #drag(window: InspectWindow, x: number, y: number, to: InspectArg): Promise<ActResult> {
    if (typeof to !== 'string' || !Inspect.#parse(to)) return { ok: false, text: 'drag needs where to drop: the target ref (like w3.12, or a window w3)' }
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
    const point = (await rpc.call('inspect', 'point', [parsed.node])) as PagePoint
    return 'error' in point ? point : this.#uncovered(window, wx + point.x, wy + point.y)
  }

  #uncovered(window: InspectWindow, x: number, y: number): Point {
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
    const panel = window.kind === 'desktop' ? rows.find((row) => !row.hidden && this.#host.panel(row.window ?? row.id) && at(row)) : undefined
    for (const row of rows) {
      const id = row.window ?? row.id
      if (id === window.id || row.hidden || (own && row.z <= own.z)) continue
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
      return { ...node, tag: n.tag, visible: n.visible, ...(n.attributes && { attributes: n.attributes }) }
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
    return { nodes: tree.nodes.map(convert), notes }
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

  static #parse(ref: string): { window: number; node: number | null } | null {
    const m = /^w(\d+)(?:\.(\d+))?$/.exec(ref.trim())
    return m ? { window: Number(m[1]), node: m[2] === undefined ? null : Number(m[2]) } : null
  }

  static #shape(windows: readonly InspectWindow[]): string {
    return windows.map((w) => `${w.ref}${w.focus ? '*' : ''}${w.hidden ? '-' : ''}`).join(' ')
  }

  static #header(w: InspectWindow): string {
    const flags = [w.app ? `app=${w.app}` : '', w.kind === 'native' ? 'native' : '', w.focus ? 'focused' : '', w.hidden ? 'minimized' : '']
    if (w.mode !== 'free') flags.push(w.mode)
    const title = w.title ? ` ${JSON.stringify(w.title)}` : ''
    return `- ${w.kind === 'desktop' ? 'desktop' : 'window'}${title}${flags.map((f) => (f ? ` [${f}]` : '')).join('')} [${w.ref}]`
  }

  static #lines(nodes: readonly InspectNode[], depth: number, out: Line[]): void {
    const pad = '  '.repeat(depth)
    for (const n of nodes) {
      const parts = [`${pad}- ${n.role}`]
      if (n.name) parts.push(JSON.stringify(n.name))
      let line = parts.join(' ')
      if (n.value !== undefined) line += `: ${JSON.stringify(n.value)}`
      if (n.level) line += ` [level=${n.level}]`
      for (const s of n.states ?? []) line += ` [${s}]`
      line += ` [${n.ref}]`
      out.push([`${n.ref}|${n.role}`, line])
      if (n.children) Inspect.#lines(n.children, depth + 1, out)
      if (n.more) out.push([`${n.ref}|more`, `${pad}  - … ${n.more} more not listed`])
    }
  }

  static #find(nodes: readonly InspectNode[], needle: string): InspectNode[] {
    const hit = (n: InspectNode) => [n.name, n.value].some((s) => s?.toLowerCase().includes(needle))
    const walk = (n: InspectNode): InspectNode | null => {
      if (hit(n)) return n
      const children = (n.children ?? []).map(walk).filter((c): c is InspectNode => !!c)
      if (!children.length) return null
      const { more: _more, ...rest } = n
      return { ...rest, children }
    }
    return nodes.map(walk).filter((n): n is InspectNode => !!n)
  }

  static #diff(before: readonly Line[], after: readonly Line[]): string[] {
    const keyed = (lines: readonly Line[]) => {
      const seen = new Map<string, number>()
      return lines.map(([key, line]) => {
        const n = seen.get(key) ?? 0
        seen.set(key, n + 1)
        return [`${key}#${n}`, line] as const
      })
    }
    const old = new Map(keyed(before))
    const now = keyed(after)
    const kept = new Set<string>()
    const out: string[] = []
    for (const [key, line] of now) {
      const was = old.get(key)
      kept.add(key)
      if (was === undefined) out.push(`+ ${line.trimStart()}`)
      else if (was !== line) out.push(`~ ${line.trimStart()}`)
    }
    for (const [key, line] of old) if (!kept.has(key)) out.push(`- ${line.trimStart()}`)
    if (!out.length) return ['(no changes)']
    if (out.length > after.length * 0.6 && after.length > 10) return ['(many changes, listing everything)', ...after.map(([, line]) => line)]
    return out
  }

  static #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
