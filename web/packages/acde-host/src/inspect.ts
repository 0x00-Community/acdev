import type { BrokerShell } from './broker'
import { keyCode } from './keys'
import type { PageNode, PagePoint, PageTree } from './pageinspect'
import type { Rpc } from './rpc'

export interface NativeAccessibility {
  tree(pid: number, title: string | null, limit: number): Promise<string | null>
  act(node: string, action: string, text?: string | null): Promise<boolean>
}

export interface InspectHost {
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

export interface InspectNode {
  readonly ref: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly states?: readonly string[]
  readonly level?: number
  readonly rect?: readonly [number, number, number, number]
  readonly more?: number
  readonly children?: readonly InspectNode[]
}

export interface InspectWindow {
  readonly ref: string
  readonly id: number
  readonly kind: 'desktop' | 'web' | 'native'
  readonly app: string | null
  readonly title: string | null
  readonly mode: string
  readonly rect: readonly [number, number, number, number]
  readonly z: number
  readonly focus: boolean
  readonly hidden: boolean
  readonly pid: number | null
}

export interface SnapshotOptions {
  readonly window?: string
  readonly ref?: string
  readonly all?: boolean
  readonly diff?: boolean
  readonly limit?: number
  readonly find?: string
  readonly tree?: boolean
}

export interface Snapshot {
  readonly text: string
  readonly windows: readonly InspectWindow[]
  readonly trees: Readonly<Record<string, readonly InspectNode[]>>
}

export type InspectAction = 'click' | 'double' | 'right' | 'hover' | 'type' | 'settext' | 'key' | 'scroll' | 'focus' | 'close' | 'minimize' | 'restore'

export interface InspectStep {
  readonly ref: string
  readonly action: InspectAction
  readonly text?: string | number | null
}

export interface ActResult {
  readonly ok: boolean
  readonly text: string
}

interface ShellRow {
  readonly id: number
  readonly window?: number
  readonly mode: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly z: number
  readonly focus: boolean
  readonly hidden?: boolean
  readonly pid?: number | null
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

const LEFT = 0x110
const RIGHT = 0x111

export class Inspect {
  static readonly LIMIT = 600
  static readonly SETTLE_MS = 400
  static readonly QUIET_MS = 200
  static readonly BUSY_MS = 3000
  static readonly OPEN_MS = 5000
  static readonly FIND_LIMIT = 3000
  static readonly GENERIC = new Set(['generic', 'filler', 'panel', 'section', 'unknown', 'redundant-object', 'split-pane', 'layered-pane', 'scroll-pane', 'viewport', 'internal-frame', 'root-pane', 'glass-pane', 'option-pane', 'window'])

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
    act: (ref: string, action: InspectAction, arg?: string | number | null): Promise<ActResult> => this.act(String(ref), action, arg ?? null),
    run: (steps: readonly InspectStep[]): Promise<ActResult> =>
      this.run(Array.isArray(steps) ? steps.map((s) => ({ ref: String(s?.ref ?? ''), action: s?.action, text: s?.text ?? null })) : []),
    open: (name: string): Promise<ActResult> => this.open(String(name)),
  }

  windows(): InspectWindow[] {
    const rows = this.#host.shell.windows() as readonly ShellRow[]
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
        rect: [row.x, row.y, row.width, row.height],
        z: row.z,
        focus: row.focus,
        hidden: !!row.hidden,
        pid: row.pid ?? null,
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
    if (wanted && !targets.length) throw Object.assign(new Error(`没有窗口 ${wanted}`), { status: 404 })
    const headers = windows.map((w) => Inspect.#header(w))
    const same = options.diff && this.#headers === headers.join('\n')
    this.#headers = headers.join('\n')
    const lines: string[] = same ? ['窗口没变.'] : ['窗口 (上面的在前):', ...headers]
    const trees: Record<string, readonly InspectNode[]> = {}
    for (const window of targets) {
      const { nodes, notes } = await this.#tree(window, parsed?.node ?? null, limit)
      const under = parsed?.node != null ? ` (${options.ref} 以下)` : ''
      if (find) {
        const found = Inspect.#find(nodes, find)
        if (!found.length) continue
        trees[window.ref] = found
        const body: Line[] = []
        Inspect.#lines(found, 0, body)
        lines.push('', `${window.ref} 里含 ${JSON.stringify(options.find!.trim())} 的${under}:`, ...body.map(([, line]) => line))
        continue
      }
      trees[window.ref] = nodes
      const body: Line[] = []
      Inspect.#lines(nodes, 0, body)
      const key = parsed?.node === undefined || parsed?.node === null ? window.ref : `${window.ref}.${parsed.node}`
      const before = this.#seen.get(key)
      this.#seen.set(key, body)
      lines.push('', `${window.ref} 的内容${under}:`)
      if (options.diff && before) lines.push(...Inspect.#diff(before, body))
      else lines.push(...(body.length ? body.map(([, line]) => line) : ['(空)']))
      lines.push(...notes)
    }
    if (find && !Object.keys(trees).length) lines.push('', `没找到含 ${JSON.stringify(options.find!.trim())} 的元素 (可见范围外的找不到; scroll 或换个窗口再找)`)
    return { text: lines.join('\n'), windows, trees }
  }

  act(ref: string, action: InspectAction, arg: string | number | null): Promise<ActResult> {
    return this.run([{ ref, action, text: arg }])
  }

  async run(steps: readonly InspectStep[]): Promise<ActResult> {
    if (!steps.length) return { ok: false, text: '没有要做的步骤' }
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
    if (failed && steps.length > 1) said.push('(后面的步骤没做)')
    await this.#arrive(opening)
    const windows = this.windows()
    const moved = Inspect.#shape(windows) !== before
    if (moved) {
      const focused = windows.find((w) => w.focus && !w.hidden)
      if (focused && focused.id !== last.id) await this.#settle(focused)
    }
    const after = moved ? await this.snapshot({ diff: true }) : await this.snapshot({ window: last.ref, diff: true })
    return { ok: !failed, text: `${said.join('\n')}${moved ? ' (窗口变了)' : ''}\n\n${after.text}` }
  }

  async open(name: string): Promise<ActResult> {
    try {
      const before = Inspect.#shape(this.windows())
      const opened = await this.#host.open(name)
      const started = Date.now()
      while (Inspect.#shape(this.windows()) === before && Date.now() - started < Inspect.OPEN_MS) await Inspect.#sleep(100)
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
    if (!parsed) return { ok: false, text: `看不懂 ref ${step.ref} (应该像 w3 或 w3.12)` }
    const window = this.windows().find((w) => w.ref === `w${parsed.window}`)
    if (!window) return { ok: false, text: `没有窗口 w${parsed.window}` }
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
    const shown = new Set((this.#host.shell.windows() as readonly ShellRow[]).map((r) => r.window ?? r.id))
    return new Set(this.#host.records().filter((id) => !shown.has(id)))
  }

  async #arrive(before: ReadonlySet<number>): Promise<void> {
    const started = Date.now()
    for (;;) {
      const waiting = [...this.#opening()].filter((id) => !before.has(id))
      if (!waiting.length || Date.now() - started >= Inspect.OPEN_MS) return
      await Inspect.#sleep(100)
    }
  }

  async #windowAct(window: InspectWindow, action: InspectAction, arg: string | number | null): Promise<ActResult> {
    switch (action) {
      case 'focus':
      case 'restore':
        if (window.hidden) this.#host.hide(window.id, false)
        this.#focus(window)
        return { ok: true, text: `${window.ref} 到了最前面` }
      case 'minimize':
        if (window.kind === 'desktop') return { ok: false, text: '桌面不能最小化' }
        this.#host.hide(window.id, true)
        return { ok: true, text: `${window.ref} 最小化了` }
      case 'close':
        if (window.kind === 'desktop') return { ok: false, text: '桌面不能关' }
        await this.#host.close(window.id)
        return { ok: true, text: `关了 ${window.ref}` }
      case 'key':
        this.#focus(window)
        this.#keys(String(arg ?? ''))
        return { ok: true, text: `在 ${window.ref} 按了 ${arg}` }
      case 'click':
      case 'double':
      case 'right':
      case 'hover':
      case 'scroll': {
        const [x, y, width, height] = window.rect
        return this.#pointer(window, x + width / 2, y + height / 2, action, arg)
      }
      default:
        return { ok: false, text: `窗口不能 ${action}; 给一个元素的 ref` }
    }
  }

  async #webAct(window: InspectWindow, node: number, action: InspectAction, arg: string | number | null): Promise<ActResult> {
    const rpc = this.#host.web(window.id)
    if (!rpc) return { ok: false, text: `${window.ref} 的页面没在运行` }
    switch (action) {
      case 'type':
      case 'settext': {
        this.#focus(window)
        const { value } = (await rpc.call('inspect', 'type', [node, String(arg ?? ''), action === 'settext'])) as { value: string | null }
        return { ok: true, text: `输入了, 现在的值: ${JSON.stringify(value ?? '')}` }
      }
      case 'focus':
        this.#focus(window)
        await rpc.call('inspect', 'focus', [node])
        return { ok: true, text: `焦点给了 ${window.ref}.${node}` }
      case 'key':
        this.#focus(window)
        await rpc.call('inspect', 'focus', [node])
        this.#keys(String(arg ?? ''))
        return { ok: true, text: `按了 ${arg}` }
      default: {
        const point = (await rpc.call('inspect', 'point', [node])) as PagePoint
        if ('error' in point) return { ok: false, text: point.error }
        const [x, y] = window.rect
        return this.#pointer(window, x + point.x, y + point.y, action, arg)
      }
    }
  }

  async #nativeAct(window: InspectWindow, node: number, action: InspectAction, arg: string | number | null): Promise<ActResult> {
    const entry = this.#native.get(window.id)?.byNumber.get(node)
    if (!entry) return { ok: false, text: `${window.ref}.${node} 不认识, 先 look ${window.ref}` }
    const access = await this.#host.accessibility()
    const at = (): [number, number] | null => {
      if (!entry.rect) return null
      const [x, y, w, h] = entry.rect
      return [window.rect[0] + x + w / 2, window.rect[1] + y + h / 2]
    }
    switch (action) {
      case 'click':
        if (access && (await access.act(entry.key, 'click').catch(() => false))) return { ok: true, text: `点了 ${window.ref}.${node}` }
        break
      case 'type':
      case 'settext':
        if (access && (await access.act(entry.key, action, String(arg ?? '')).catch(() => false))) return { ok: true, text: `输入了 ${JSON.stringify(String(arg ?? ''))}` }
        return { ok: false, text: '这个元素不能直接输入; 先 click 它, 再用 key 或对窗口 type' }
      case 'focus':
        if (access && (await access.act(entry.key, 'focus').catch(() => false))) return { ok: true, text: `焦点给了 ${window.ref}.${node}` }
        break
      case 'key':
        this.#focus(window)
        if (access) await access.act(entry.key, 'focus').catch(() => false)
        this.#keys(String(arg ?? ''))
        return { ok: true, text: `按了 ${arg}` }
      default:
        break
    }
    const point = at()
    if (!point) return { ok: false, text: `${window.ref}.${node} 没有位置, 做不了 ${action}` }
    return this.#pointer(window, point[0], point[1], action === 'focus' ? 'click' : action, arg)
  }

  #pointer(window: InspectWindow, x: number, y: number, action: InspectAction, arg: string | number | null): ActResult {
    const cover = this.#cover(window, x, y)
    if (cover) {
      if (window.kind === 'desktop') return { ok: false, text: `那里被 ${cover.ref} (${cover.title ?? cover.app ?? cover.kind}) 挡住了; 先把它最小化或关掉` }
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
        return { ok: true, text: `指针移到了 ${Math.round(x)},${Math.round(y)}` }
      case 'right':
        press(RIGHT)
        return { ok: true, text: `右键点了 ${Math.round(x)},${Math.round(y)}` }
      case 'double':
        press(LEFT)
        press(LEFT)
        return { ok: true, text: `双击了 ${Math.round(x)},${Math.round(y)}` }
      case 'scroll': {
        const dy = Number(arg) || 400
        shell.inject({ type: 'wheel', x, y, dx: 0, dy, source: 'wheel' })
        return { ok: true, text: `在 ${Math.round(x)},${Math.round(y)} 滚动了 ${dy}` }
      }
      case 'click':
        press(LEFT)
        return { ok: true, text: `点了 ${Math.round(x)},${Math.round(y)}` }
      default:
        return { ok: false, text: `不支持 ${action}` }
    }
  }

  #cover(window: InspectWindow, x: number, y: number): InspectWindow | null {
    const rows = this.#host.shell.windows() as readonly ShellRow[]
    const own = rows.find((r) => (r.window ?? r.id) === window.id)
    for (const row of rows) {
      const id = row.window ?? row.id
      if (id === window.id || row.hidden || (own && row.z <= own.z)) continue
      if (window.kind === 'desktop' && this.#host.panel(id)) continue
      if (x < row.x || y < row.y || x >= row.x + row.width || y >= row.y + row.height) continue
      if (this.#host.panel(id)) return { ref: 'w0', id: 0, kind: 'desktop', app: null, title: '桌面的面板', mode: row.mode, rect: [row.x, row.y, row.width, row.height], z: row.z, focus: row.focus, hidden: false, pid: null }
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
    for (const chord of spec.trim().split(/\s+/).filter(Boolean)) {
      const parts = chord.split('+')
      const codes = parts.map((p) => keyCode(p))
      if (codes.some((c) => c === null)) throw new Error(`不认识的键: ${chord}`)
      if (parts.length === 1 && /^[A-Z]$/.test(parts[0]!)) codes.unshift(keyCode('shift'))
      for (const code of codes) shell.inject({ type: 'keydown', code: code! })
      for (const code of [...codes].reverse()) shell.inject({ type: 'keyup', code: code! })
    }
  }

  async #tree(window: InspectWindow, node: number | null, limit: number): Promise<{ nodes: InspectNode[]; notes: string[] }> {
    if (window.hidden) return { nodes: [], notes: ['(最小化了; act 它 restore 再看)'] }
    if (window.kind === 'native') return this.#nativeTree(window, limit)
    const rpc = this.#host.web(window.id)
    if (!rpc) return { nodes: [], notes: ['(页面没在运行)'] }
    const tree = (await rpc.call('inspect', 'tree', [node ?? -1, limit])) as PageTree
    const [ox, oy] = window.rect
    const convert = (n: PageNode): InspectNode => ({
      ref: `${window.ref}.${n.id}`,
      role: n.role,
      ...(n.name ? { name: n.name } : {}),
      ...(n.value !== undefined ? { value: n.value } : {}),
      ...(n.states?.length ? { states: n.states } : {}),
      ...(n.level ? { level: n.level } : {}),
      rect: [n.rect[0] + ox, n.rect[1] + oy, n.rect[2], n.rect[3]],
      ...(n.more ? { more: n.more } : {}),
      ...(n.children?.length ? { children: n.children.map(convert) } : {}),
    })
    const notes: string[] = []
    if (tree.hidden) notes.push(`(可见范围外还有 ${tree.hidden} 个元素没列出; scroll 再看)`)
    if (tree.truncated) notes.push(`(元素太多, 只列了 ${limit} 个; look 某个 ref 看它下面)`)
    return { nodes: tree.nodes.map(convert), notes }
  }

  async #nativeTree(window: InspectWindow, limit: number): Promise<{ nodes: InspectNode[]; notes: string[] }> {
    const access = await this.#host.accessibility()
    if (!access) return { nodes: [], notes: ['(这个会话没有 AT-SPI, 看不到原生窗口的内容)'] }
    if (!window.pid) return { nodes: [], notes: ['(不知道这个窗口的进程)'] }
    const json = await access.tree(window.pid, window.title, limit)
    if (!json) return { nodes: [], notes: ['(这个程序没有上报无障碍信息)'] }
    const root = JSON.parse(json) as NativeNode
    let aliases = this.#native.get(window.id)
    if (!aliases) this.#native.set(window.id, (aliases = { byKey: new Map(), byNumber: new Map(), next: 1 }))
    const table = aliases
    const [ox, oy] = window.rect
    const convert = (n: NativeNode): InspectNode[] => {
      let number = table.byKey.get(n.id)
      if (number === undefined) {
        number = table.next++
        table.byKey.set(n.id, number)
      }
      table.byNumber.set(number, { key: n.id, rect: n.rect ?? null })
      const children = (n.children ?? []).flatMap(convert)
      if (Inspect.GENERIC.has(n.role) && !n.name && !n.more) return children
      const states = [...(n.states ?? []), ...(n.actions?.length && !['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab'].includes(n.role) ? ['clickable'] : [])]
      return [{
        ref: `${window.ref}.${number}`,
        role: n.role,
        ...(n.name ? { name: n.name } : {}),
        ...(n.value !== undefined ? { value: n.value } : {}),
        ...(states.length ? { states } : {}),
        ...(n.rect ? { rect: [n.rect[0] + ox, n.rect[1] + oy, n.rect[2], n.rect[3]] as const } : {}),
        ...(n.more ? { more: n.more } : {}),
        ...(children.length ? { children } : {}),
      }]
    }
    return { nodes: (root.children ?? []).flatMap(convert), notes: [] }
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
    const kind = w.kind === 'desktop' ? '桌面' : w.kind === 'web' ? `应用 ${w.app ?? ''}`.trim() : `原生 ${w.app ?? ''}`.trim()
    const flags = [w.focus ? '焦点' : '', w.hidden ? '最小化' : '', w.mode !== 'free' ? w.mode : ''].filter(Boolean)
    return `${w.ref} ${kind}${w.title ? ` ${JSON.stringify(w.title)}` : ''}${flags.length ? ` ${flags.join(' ')}` : ''}`
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
      if (n.more) out.push([`${n.ref}|more`, `${pad}  - …还有 ${n.more} 项没列出`])
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
    if (!out.length) return ['(没有变化)']
    if (out.length > after.length * 0.6 && after.length > 10) return ['(变化很大, 全部重列)', ...after.map(([, line]) => line)]
    return out
  }

  static #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
