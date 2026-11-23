import { isAbsolute, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { InspectAction, InspectNode, InspectWindow } from '@acde/api'
import { Approvals, type Wanted } from './approvals.ts'
import * as Call from './driver/call/index.ts'
import { ACTIONS, Acde, type ConsoleLevel, type DevPage } from './driver/acde.ts'
import { Format } from './driver/format.ts'
import type { Appearance, AppearanceChange, GlassLevel, OpenTarget } from './driver/types.ts'
import { Png, type Image } from './driver/png.ts'
import { Screenshots, type Box } from './driver/screenshot.ts'
import type { InputEvent } from './driver/input.ts'
import { DevClient } from './ipc.ts'
import { Exit, Output } from './output.ts'
import { slug } from './paths.ts'
import { Runtime } from './runtime.ts'
import { Sessions, type Pin } from './sessions.ts'

export type Region = { readonly ref: string } | { readonly rect: Box }

export class Tools {
  static readonly COMMANDS = new Set([
    'webs', 'eval', 'shot', 'inspect', 'query', 'act', 'input', 'console', 'network', 'screen', 'pointer', 'choose', 'drop', 'permissions',
    'allow', 'deny', 'revoke', 'stop', 'open', 'appearance', 'call',
  ])
  static readonly ANSWER = 'acdev allow (or acdev deny)'
  static readonly NAMING = 'name one (its id, or <app> <capability>) or pass --all'
  static readonly QUERY_LIMIT = 3000
  static readonly FOLLOW_MS = 500
  static readonly STOP_MS = 10_000
  static readonly LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'errors'])
  static readonly NOTHING = Exit.NOTHING
  static readonly NEEDS: Readonly<Record<string, string>> = {
    type: 'the text to type', settext: 'the text to set', key: 'the keys to press', select: 'the option to select',
    drag: 'the ref to drop on', move: 'where to, in screen x,y', resize: 'the size, WxH',
  }
  static readonly EXAMPLE: Readonly<Record<string, string>> = {
    type: '"hello"', settext: '"hello"', key: '"ctrl+a backspace"', select: '"high"', drag: 'w1.12', move: '100,80',
    resize: '800x600',
  }
  static readonly NO_WINDOW = /^no window w\d+$/
  static readonly REF = /^w\d+(\.\S+)?$/

  static async #windowed<T>(acde: Acde, ask: () => Promise<T>): Promise<T> {
    try {
      return await ask()
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error)
      if (!Tools.NO_WINDOW.test(said)) throw error
      throw new Error(`${said}${await Tools.#windows(acde)}`)
    }
  }

  static async #windows(acde: Acde): Promise<string> {
    const windows = await acde.windows().catch(() => [])
    if (!windows.length) return '; there are no windows'
    const name = (w: (typeof windows)[number]) =>
      w.kind === 'desktop' ? 'desktop' : JSON.stringify(w.title ?? w.app ?? '')
    const named = windows.map((w) => `${w.ref} ${name(w)}`)
    return `; the windows: ${named.join(', ')} (acdev inspect lists them)`
  }

  static #events(text: string): InputEvent[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`input: the events are a JSON array (${(error as Error).message}) (acdev input --help)`)
    }
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((e) => e && typeof e === 'object' && typeof e.type === 'string'))
      throw new Error('input: the events are a non-empty JSON array of objects with a type (acdev input --help)')
    return parsed as InputEvent[]
  }

  static choice(args: readonly string[], cancel: boolean): { kind: 'folder' | 'open' | 'save'; paths: string[] | null } {
    const [kind, ...paths] = args
    if (kind !== 'folder' && kind !== 'open' && kind !== 'save') {
      throw new Error(`choose: ${kind} is not a picker; give folder, open or save (acdev choose --help)`)
    }
    if (cancel) {
      if (paths.length) throw new Error('choose: --cancel takes no paths (acdev choose --help)')
      return { kind, paths: null }
    }
    if (!paths.length) throw new Error(`choose ${kind}: give the ${kind === 'open' ? 'files' : kind === 'folder' ? 'folder' : 'file'} to answer, ` +
      'or --cancel (acdev choose --help)')
    if (kind !== 'open' && paths.length > 1) throw new Error(`choose ${kind}: one path, not ${paths.length} (acdev choose --help)`)
    return { kind, paths }
  }

  static at(text: string | undefined): [number, number] | undefined {
    if (text === undefined) return undefined
    const point = text.split(',').map((v) => Number(v.trim()))
    if (point.length !== 2 || !point.every(Number.isFinite)) throw Output.option('drop', 'at', text, 'X,Y in the page\'s CSS pixels')
    return point as [number, number]
  }

  static region(command: string, flags: ReadonlyMap<string, string>): Region | null {
    const ref = flags.get('ref')
    const rect = flags.get('rect')
    if (ref !== undefined && rect !== undefined) throw new Error(`${command}: give --ref or --rect, not both (acdev ${command} --help)`)
    if (ref !== undefined) {
      if (!Tools.REF.test(ref)) throw Output.option(command, 'ref', ref, 'an element or window ref, like w3.12 or w3 (acdev inspect lists them)')
      return { ref }
    }
    if (rect === undefined) return null
    const box = Screenshots.rect(rect)
    if (!box) throw Output.option(command, 'rect', rect, 'X,Y,W,H in logical pixels, W and H above 0')
    return { rect: box }
  }

  static async crop(acde: Acde, web: string | null, region: Region): Promise<Image> {
    const windows = await acde.windows()
    const within = web === null ? null : Tools.#windowOf(windows, (await acde.webs()).find((w) => w.name === web)?.window, web)
    const shot = within ? await acde.screenshot(web!) : await acde.screen()
    const image = Png.decode(shot.png)
    const frame = within?.rect ?? windows.find((w) => w.kind === 'desktop')?.rect ?? ([0, 0, image.width, image.height] as const)
    const [fx, fy] = within ? frame : [0, 0]
    const target = 'rect' in region
      ? ([region.rect[0] + fx, region.rect[1] + fy, region.rect[2], region.rect[3]] as const)
      : await Tools.#rectOf(acde, windows, region.ref, within)
    const what = 'rect' in region ? `--rect ${region.rect.join(',')}` : region.ref
    return Screenshots.within(image, frame, target, what)
  }

  static #saved(image: Image, path: string): string {
    Screenshots.save(image, path)
    return path
  }

  static #windowOf(windows: readonly InspectWindow[], id: number | undefined, web: string): InspectWindow {
    const window = windows.find((w) => w.id === id)
    if (!window) throw new Error(`${web}: no window with a page by this name (acdev webs lists them)`)
    return window
  }

  static async #rectOf(acde: Acde, windows: readonly InspectWindow[], ref: string, within: InspectWindow | null): Promise<Box> {
    const windowRef = ref.split('.')[0]!
    const window = windows.find((w) => w.ref === windowRef)
    if (!window) throw new Error(`no window ${windowRef}${await Tools.#windows(acde)}`)
    if (within && window.id !== within.id)
      throw new Error(`${ref} is in ${window.ref}, not in this web's window ${within.ref}; acdev screen --ref ${ref} takes it`)
    if (ref === windowRef) return window.rect
    const snapshot = await acde.snapshot({ ref, limit: 20 })
    const node = Tools.#find(snapshot.trees[windowRef] ?? [], ref)
    if (!node) {
      const why = 'scrolled out of view, in a hidden part, or gone (acdev inspect --find TEXT gives the current refs)'
      throw new Error(`${ref} is not on the screen: ${why}`)
    }
    if (!node.rect) throw new Error(`${ref} has no position on the screen`)
    return node.rect
  }

  static #find(nodes: readonly InspectNode[], ref: string): InspectNode | null {
    for (const node of nodes) {
      if (node.ref === ref) return node
      const found = Tools.#find(node.children ?? [], ref)
      if (found) return found
    }
    return null
  }

  static opening(args: readonly string[]): OpenTarget {
    const link = (text: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    const pathy = (text: string) => /[\\/]/.test(text) || text === '.' || text === '..'
    const [first, second] = args
    if (second === undefined) {
      if (link(first!)) return { url: first! }
      return pathy(first!) ? { path: first! } : { name: first! }
    }
    if (pathy(first!) || link(first!)) throw new Error(`open: ${first} is not an app; give the app first, then the path or link (acdev open --help)`)
    return link(second) ? { name: first!, url: second } : { name: first!, path: second }
  }

  static located(given: OpenTarget, guest: boolean, base = process.cwd()): OpenTarget {
    if (given.url !== undefined && !/^https?:\/\//i.test(given.url)) throw new Error(`open: ${given.url}: only http and https links (acdev open --help)`)
    if (given.path === undefined || isAbsolute(given.path)) return given
    if (guest) throw new Error(`open: ${given.path}: a path in the guest is absolute, like /home/tester/Documents (acdev open --help)`)
    return { ...given, path: resolve(base, given.path) }
  }

  static readonly GLASS: readonly GlassLevel[] = ['clear', 'medium', 'tinted']

  static appearing(flags: ReadonlyMap<string, string>): AppearanceChange {
    if (flags.has('dark') && flags.has('light')) throw new Error('appearance: give --dark or --light, not both (acdev appearance --help)')
    const scheme = flags.has('dark') ? 'dark' : flags.has('light') ? 'light' : undefined
    const transparency = flags.get('reduced-transparency')
    if (transparency !== undefined && transparency !== 'on' && transparency !== 'off')
      throw Output.option('appearance', 'reduced-transparency', transparency, 'on or off')
    const level = flags.get('glass-level')
    const glass = level === undefined ? undefined : Tools.GLASS[/^[0-2]$/.test(level) ? Number(level) : -1]
    if (level !== undefined && !glass) throw Output.option('appearance', 'glass-level', level, '0 (clear), 1 (medium) or 2 (tinted)')
    return {
      ...(scheme && { scheme }),
      ...(glass && { glass }),
      ...(transparency !== undefined && { reducedTransparency: transparency === 'on' }),
    }
  }

  static appearanceLine(now: Appearance): string {
    const level = Tools.GLASS.indexOf(now.glass)
    const emulated = now.emulated ? ' (this session only; the system setting is unchanged)' : ''
    const scheme = now.scheme ?? 'no preference'
    return `${scheme}, glass level ${level} (${now.glass}), reduced transparency ${now.reducedTransparency ? 'on' : 'off'}${emulated}`
  }

  static async #calling(args: readonly string[]): Promise<{ to: Call.CallTarget; method: string; params: unknown }> {
    const to = Call.target(args[0]!)
    const text = args[2] === '-' ? await Runtime.readStdin() : args[2]
    return { to, method: args[1]!, params: Call.params(text) }
  }

  static missing(text: string): string | null {
    const gone = /^(element|window) \S+ is gone$/.exec(text)
    return gone ? `there is no such ${gone[1]} (any more); acdev inspect --find TEXT gives the current refs` : null
  }

  static async run(command: string, args: readonly string[], flags: ReadonlyMap<string, string>): Promise<number> {
    const session = Tools.pid(flags.get('session'), command)
    if (command === 'act' && !ACTIONS.includes(args[1] as InspectAction))
      throw new Error(`act: ${args[1]} is not an action (${ACTIONS.join(', ')}) (acdev act --help)`)
    const needs = command === 'act' && args[2] === undefined ? Tools.NEEDS[args[1]!] : undefined
    if (needs) {
      throw new Error(`act: ${args[1]} needs ${needs}: acdev act ${args[0]} ${args[1]} ${Tools.EXAMPLE[args[1]!]}`)
    }
    const events = command === 'input' ? Tools.#events(args[1] === '-' ? await Runtime.readStdin() : args[1]!) : []
    const level = flags.get('level')
    if (command === 'console' && level !== undefined && !Tools.LEVELS.has(level))
      throw Output.option('console', 'level', level, `one of ${[...Tools.LEVELS].join(', ')}`)
    const start = flags.get('since')
    if (start !== undefined && start !== 'reload' && !/^[1-9]\d*$/.test(start))
      throw Output.option(command, 'since', start, 'reload, or the number of an entry')
    const limit = command === 'query' ? Tools.#limit(flags.get('limit')) : undefined
    const wanted = command === 'allow' || command === 'deny' ? Tools.wanted(command, args, flags) : {}
    const choice = command === 'choose' ? Tools.choice(args, flags.has('cancel')) : null
    const at = command === 'drop' ? Tools.at(flags.get('at')) : undefined
    const region = command === 'shot' || command === 'screen' ? Tools.region(command, flags) : null
    const opening = command === 'open' ? Tools.opening(args) : null
    const appearance = command === 'appearance' ? Tools.appearing(flags) : null
    const calling = command === 'call' ? await Tools.#calling(args) : null
    if (command === 'stop') return await Tools.#stop(session)
    const say = (line: string) => console.error(line)
    const acde = await Acde.attach(session === undefined ? { say } : { session, say })
    try {
      switch (command) {
        case 'webs': {
          const { webs, locked } = await acde.webList()
          console.log(Format.webs(webs, locked))
          for (const line of await Approvals.waiting(acde, Tools.ANSWER)) console.log(line)
          return 0
        }
        case 'permissions':
          console.log(Format.permissions(await acde.permissions()))
          return 0
        case 'allow':
        case 'deny':
          console.log(await Approvals.answer(acde, wanted, command === 'allow', Tools.NAMING))
          return 0
        case 'revoke':
          console.log(await Approvals.revoke(acde, args[0]!, args[1]!))
          return 0
        case 'eval': {
          const code = args[1] === '-' ? await Runtime.readStdin() : args[1]!
          console.log(JSON.stringify((await acde.evaluate(args[0]!, code)) ?? null, null, 2))
          return 0
        }
        case 'shot': {
          const path = resolve(flags.get('output') ?? `${slug(args[0]!)}.png`)
          if (region) console.log(Tools.#saved(await Tools.crop(acde, args[0]!, region), path))
          else console.log((await acde.screenshot(args[0]!, { path })).path)
          return 0
        }
        case 'inspect': {
          const find = flags.get('find')
          const snapshot = await Tools.#windowed(acde, () => acde.snapshot({
            ...(flags.has('window') && { window: flags.get('window')! }),
            ...(find !== undefined && { find }),
            ...(flags.has('all') && { all: true }),
            ...(flags.has('offscreen') && { offscreen: true }),
          }))
          if (find === undefined) {
            console.log(snapshot.text)
            return 0
          }
          const found = Format.found(snapshot, find)
          if (found.length) {
            console.log(found.join('\n'))
            return 0
          }
          const hint = flags.has('offscreen') ? '' : '; elements scrolled out of view need --offscreen'
          console.error(`acdev: no element's name or value contains ${JSON.stringify(find.trim())}${hint}`)
          return Tools.NOTHING
        }
        case 'query': {
          const found = await Tools.#windowed(acde, () => acde.query({
            selector: args[0]!,
            ...(flags.has('window') && { window: flags.get('window')! }),
            ...(flags.has('ref') && { ref: flags.get('ref')! }),
            ...(limit !== undefined && { limit }),
          }))
          if (!found.count) {
            console.error(`acdev: ${Format.matches(found, args[0]!)}`)
            return Tools.NOTHING
          }
          console.log(Format.matches(found, args[0]!))
          return 0
        }
        case 'input': {
          const result = await acde.input(args[0]!, events)
          if (result.ok) console.log(result.text)
          else console.error(`acdev: input ${args[0]}: ${result.text}`)
          return result.ok ? 0 : 1
        }
        case 'act': {
          const result = await acde.act(args[0]!, args[1] as InspectAction, args[2])
          if (result.ok) console.log(result.text)
          else {
            const told = Tools.missing(result.text) ?? result.text
            const listed = Tools.NO_WINDOW.test(told) ? await Tools.#windows(acde) : ''
            console.error(`acdev: act ${args[0]}: ${told}${listed}`)
          }
          return result.ok ? 0 : 1
        }
        case 'console': {
          const options = {
            ...(flags.has('web') && { web: flags.get('web')! }),
            ...(level !== undefined && { level: level as ConsoleLevel | 'errors' }),
          }
          const read = (since: number) => acde.console({ ...options, ...(since && { since }) })
          const from = Tools.#since(start, acde.session.reloaded?.console)
          return await Tools.#follow(flags.has('follow'), from, read, Format.console, 'console entries')
        }
        case 'network': {
          const options = {
            ...(flags.has('web') && { web: flags.get('web')! }),
            ...(flags.has('failed') && { failed: true }),
          }
          const read = (since: number) => acde.network({ ...options, ...(since && { since }) })
          const from = Tools.#since(start, acde.session.reloaded?.network)
          return await Tools.#follow(flags.has('follow'), from, read, Format.request, 'requests')
        }
        case 'appearance':
          console.log(Tools.appearanceLine(await acde.appearance(appearance!)))
          return 0
        case 'open': {
          const result = await acde.openWith(Tools.located(opening!, acde.guest))
          console.log(result.text)
          return result.ok ? 0 : 1
        }
        case 'screen': {
          const path = resolve(flags.get('output') ?? 'screen.png')
          if (region) console.log(Tools.#saved(await Tools.crop(acde, null, region), path))
          else console.log((await acde.screen({ path })).path)
          return 0
        }
        case 'choose': {
          const { kind, paths } = choice!
          if (kind === 'folder') await acde.chooseFolder(paths?.[0] ?? null)
          else if (kind === 'open') await acde.chooseFiles(paths)
          else await acde.chooseSaveFile(paths?.[0] ?? null)
          const what = paths === null ? 'cancels it' : `answers ${paths.map((p) => resolve(p)).join(', ')}`
          console.log(`the next ${kind === 'open' ? 'file' : kind} picker ${what}`)
          return 0
        }
        case 'drop': {
          const dropped = await acde.drop(args.slice(1), { web: args[0]!, ...(at && { x: at[0], y: at[1] }) })
          console.log(`dropped ${dropped.files.length} file${dropped.files.length === 1 ? '' : 's'} onto ${dropped.web}`)
          return 0
        }
        case 'call': {
          const { to, method, params } = calling!
          console.log(JSON.stringify((await acde.call(to, method, params)) ?? null, null, 2))
          return 0
        }
        case 'pointer': {
          const [x, y] = args.map(Number) as [number, number]
          if (!Number.isFinite(x) || !Number.isFinite(y))
            throw new Error(`pointer: ${args.join(' ')}: x and y are numbers (acdev pointer --help)`)
          const at = await acde.pointer(x, y)
          console.log(`the pointer is at ${at.x}, ${at.y}`)
          return 0
        }
        default:
          throw new Error(`no tool ${command}`)
      }
    } finally {
      await acde.close()
    }
  }

  static async #stop(pid: Pin | undefined): Promise<number> {
    if (pid === Sessions.VM) throw new Error('stop: the session in the guest ends when its user logs out; acdev vm stop stops the guest')
    const session = await Sessions.find(process.cwd(), pid, (line) => console.error(line))
    const link = await DevClient.connect(session.endpoint).catch(() => null)
    if (!link) {
      Sessions.remove(session.pid)
      throw new Error(`acdev dev ${session.pid} is gone (nothing answers on ${session.endpoint})`)
    }
    link.send({ type: 'quit' })
    const timer = new AbortController()
    try {
      await Promise.race([link.closed, sleep(Tools.STOP_MS, null, { signal: timer.signal }).catch(() => null)])
    } finally {
      timer.abort()
    }
    link.close()
    const until = Date.now() + Tools.STOP_MS
    while (Sessions.alive(session.pid) && Date.now() < until) await sleep(50)
    if (Sessions.alive(session.pid)) {
      try {
        process.kill(session.pid, 'SIGTERM')
      } catch {}
      console.error(`acdev: acdev dev ${session.pid} did not end within ${Tools.STOP_MS / 1000} s of quit; ended it`)
    }
    Sessions.remove(session.pid)
    console.log(`acdev: stopped acdev dev ${session.pid}`)
    return 0
  }

  static async #follow<T>(
    follow: boolean,
    from: number,
    read: (since: number) => Promise<DevPage<T>>,
    line: (entry: T) => string,
    what: string,
  ): Promise<number> {
    let since = from
    for (let first = true; ; first = false) {
      const page = await read(since)
      if (page.dropped) console.log(`… ${page.dropped} older entries were dropped`)
      for (const entry of page.entries) console.log(line(entry))
      if (first && !page.dropped && !page.entries.length) {
        console.error(`acdev: no ${what}${from ? ' in that range' : ''}${follow ? ' yet; waiting for new ones' : ''}`)
      }
      since = page.next
      if (!follow) return 0
      await sleep(Tools.FOLLOW_MS)
    }
  }

  static #since(value: string | undefined, reloaded: number | undefined): number {
    if (value === undefined) return 0
    if (value === 'reload') return reloaded ?? 0
    return Number(value)
  }

  static wanted(command: string, args: readonly string[], flags: ReadonlyMap<string, string>): Wanted {
    const [first, second] = args
    const hint = `(acdev ${command} --help)`
    if (flags.has('all')) {
      if (first === undefined) return { all: true }
      throw new Error(`${command}: --all answers every waiting prompt; leave the prompt out ${hint}`)
    }
    if (first === undefined) return {}
    if (second !== undefined) return { app: first, capability: second }
    if (/^\d+$/.test(first)) return { prompt: Number(first) }
    const listed = 'acdev permissions lists them'
    throw new Error(`${command}: ${first} is not a prompt id (${listed}); or give <app> <capability> ${hint}`)
  }

  static #limit(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const most = Tools.QUERY_LIMIT
    const limit = /^\d+$/.test(value) ? Number(value) : NaN
    if (limit >= 1 && limit <= most) return limit
    throw Output.option('query', 'limit', value, `how many elements to list at most, 1 to ${most}`)
  }

  static pid(value: string, command: string): Pin
  static pid(value: string | undefined, command: string): Pin | undefined
  static pid(value: string | undefined, command: string): Pin | undefined {
    if (value === undefined) return undefined
    if (value === Sessions.VM) return Sessions.VM
    const pid = Number(value)
    if (Number.isInteger(pid) && pid > 0) return pid
    throw Output.option(command, 'session', value, 'the process id of an acdev dev, or vm for the session in the guest of acdev vm')
  }
}
