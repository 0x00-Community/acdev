// What drive.sh runs inside a session's Broker (ACDE_DEBUG_DIR, web/packages/acde-host src/debug.ts): input through
// shell's own routing (Shell.inject, the same path as real input), code in a web, and measurements. `run(api, argv)`
// answers one command line; its value is drive.sh's output (JSON).
//   keys ctrl+space n i h a o space   evdev key names, `+` joins a chord, a capital letter is shifted
//   type 'nihao'                      a-z A-Z 0-9 space and a few symbols as key presses
//   move X Y | click [X Y] [right] | drag X1 Y1 X2 Y2 | wheel X Y DY   logical pixels
//   eval WEB CODE                     CODE evaluated in WEB ("desktop", `<app>#<window>`), awaited
//   windows                           the Broker's window table
//   launch APP | close WINDOW         through the desktop's acde:apps (open) / acde:windows
//   stats [reset]                     shell's frame timings and render's per web, as they are
//   screenshot PATH                   the main output drawn once off screen, saved as a PNG at PATH
//   perf SCENARIO [SECONDS] [ARG]     a measurement (below); prints what changed over it

const KEYS = {
  esc: 1, minus: 12, equal: 13, backspace: 14, tab: 15, enter: 28, ctrl: 29, semicolon: 39, apostrophe: 40, shift: 42,
  comma: 51, dot: 52, slash: 53, alt: 56, space: 57, f1: 59, up: 103, pageup: 104, left: 105, right: 106, down: 108,
  pagedown: 109, super: 125,
}
for (const [row, first] of [['qwertyuiop', 16], ['asdfghjkl', 30], ['zxcvbnm', 44], ['1234567890', 2]]) [...row].forEach((c, i) => (KEYS[c] = first + i))
const SYMBOLS = { ' ': 'space', '-': 'minus', '=': 'equal', '.': 'dot', '/': 'slash', ',': 'comma', ';': 'semicolon', "'": 'apostrophe' }
const BUTTONS = { left: 0x110, right: 0x111 }
/** the input rate of the scenarios (a 60 Hz mouse) */
const TICK_MS = 16
/** /proc's clock ticks per second */
const HZ = 100

/** Input through shell.inject. */
class Input {
  constructor(api) {
    this.api = api
  }

  static code(name) {
    const code = KEYS[name.toLowerCase()]
    if (code === undefined) throw new Error(`unknown key ${name}`)
    return code
  }

  async chord(spec) {
    const codes = spec.split('+').map(Input.code)
    if (/^[A-Z]$/.test(spec)) codes.unshift(KEYS.shift)
    for (const code of codes) this.api.shell.inject({ type: 'keydown', code })
    for (const code of [...codes].reverse()) this.api.shell.inject({ type: 'keyup', code })
    await this.api.sleep(40)
  }

  move(x, y) {
    this.api.shell.inject({ type: 'move', x: Number(x), y: Number(y) })
  }

  button(name, down) {
    this.api.shell.inject({ type: down ? 'down' : 'up', button: BUTTONS[name ?? 'left'] })
  }

  async click(x, y, which) {
    if (x !== null) {
      this.move(x, y)
      await this.api.sleep(60)
    }
    this.button(which, true)
    await this.api.sleep(60)
    this.button(which, false)
  }

  async drag(x1, y1, x2, y2) {
    this.move(x1, y1)
    await this.api.sleep(60)
    this.button('left', true)
    await this.api.sleep(150)
    for (let i = 1; i <= 20; i++) {
      this.move(x1 + ((x2 - x1) * i) / 20, y1 + ((y2 - y1) * i) / 20)
      await this.api.sleep(25)
    }
    await this.api.sleep(150)
    this.button('left', false)
  }
}

/** The desktop's windows, through its web. */
class Windows {
  constructor(api) {
    this.api = api
  }

  async screen() {
    const [width, height] = await this.api.web('desktop', '[innerWidth, innerHeight]')
    return { width, height }
  }

  async launch(app) {
    return this.api.web('desktop', `import("acde:apps").then(({ apps }) => apps.open(${JSON.stringify(app)})).then((r) => r.window)`)
  }

  async close(id) {
    return this.api.web('desktop', `import("acde:windows").then(({ windows }) => windows.close(${Number(id)}))`)
  }

  /** where window `id` is on the screen (logical px, from the compositor's window table), null while it is not placed */
  async rect(id) {
    const w = this.api.shell.windows().find((w) => w.window === Number(id))
    return w && w.width > 1 ? { x: w.x, y: w.y, width: w.width, height: w.height } : null
  }

  /** a window of `app` (an open one, else a new one) once it is placed, and whether it was opened here;
   * `fresh`: the app's open windows are closed first (launching a single-window app only returns its window, wherever
   * it is in the stacking order) */
  async ensure(app, fresh = false) {
    if (fresh) {
      for (const w of this.api.broker.windows.filter((w) => w.app === app && w.running)) await this.close(w.id).catch(() => {})
      await this.api.sleep(500)
    }
    const open = fresh ? undefined : this.api.broker.windows.find((w) => w.app === app && w.running)
    const id = open?.id ?? (await this.launch(app))
    for (let i = 0; i < 50; i++) {
      const rect = await this.rect(id)
      if (rect) {
        if (!open) await this.api.sleep(1500) // its opening animation
        return { id, rect: (await this.rect(id)) ?? rect, opened: !open }
      }
      await this.api.sleep(200)
    }
    throw new Error(`window ${id} (${app}) is not placed`)
  }
}

/** What changes over a scenario: CPU per thread, shell's frames, render's per web. */
class Measure {
  constructor(api) {
    this.api = api
  }

  /** a file under /proc (`readText`) or a directory (`readDir`); null when its process or thread has ended */
  read(path, how = 'readText') {
    try {
      return this.api[how](path)
    } catch {
      return null
    }
  }

  /** this process and every process under it (the web processes, apps' backends, native programs) */
  pids() {
    const self = this.api.readText('/proc/self/stat').split(' ')[0]
    const children = new Map()
    for (const pid of this.api.readDir('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      const stat = this.read(`/proc/${pid}/stat`)
      if (stat === null) continue
      const ppid = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]
      children.set(ppid, [...(children.get(ppid) ?? []), pid])
    }
    const pids = [self]
    for (let i = 0; i < pids.length; i++) pids.push(...(children.get(pids[i]) ?? []))
    return pids
  }

  static ticks(stat) {
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  }

  /** clock ticks per thread name (`acde-web`, `acde-render`, ...), summed over threads of the same name in all the processes */
  threads(pids) {
    const ticks = {}
    for (const pid of pids) {
      for (const tid of this.read(`/proc/${pid}/task`, 'readDir') ?? []) {
        const stat = this.read(`/proc/${pid}/task/${tid}/stat`)
        if (stat === null) continue
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
        ticks[name] = (ticks[name] ?? 0) + Measure.ticks(stat)
      }
    }
    return ticks
  }

  /** clock ticks per process (threads that already ended included) */
  processes(pids) {
    const ticks = {}
    for (const pid of pids) {
      const stat = this.read(`/proc/${pid}/stat`)
      if (stat !== null) ticks[pid] = Measure.ticks(stat)
    }
    return ticks
  }

  rssMb(pids) {
    let kb = 0
    for (const pid of pids) {
      const line = this.read(`/proc/${pid}/status`)?.split('\n').find((l) => l.startsWith('VmRSS:'))
      kb += Number(line?.split(/\s+/)[1] ?? 0)
    }
    return Math.round(kb / 1024)
  }

  async start() {
    this.api.shell.stats(true)
    await this.api.stats(true)
    this.shell = this.api.shell.stats()
    const pids = this.pids()
    this.ticks = this.threads(pids)
    this.total = this.processes(pids)
    this.started = Date.now()
  }

  async finish() {
    const seconds = (Date.now() - this.started) / 1000
    const shell = this.api.shell.stats()
    const webs = await this.api.stats()
    const pids = this.pids()
    const ticks = this.threads(pids)
    const total = Object.entries(this.processes(pids)).reduce((sum, [pid, t]) => sum + t - (this.total[pid] ?? 0), 0)
    const r = (v, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits
    const percent = (t) => r((100 * t) / HZ / seconds, 0)
    const threads = Object.entries(ticks)
      .map(([name, t]) => [name, t - (this.ticks[name] ?? 0)])
      .filter(([, t]) => t > 0)
      .sort((a, b) => b[1] - a[1])
    const timing = (t) => (t?.count ? { perSecond: r(t.count / seconds), meanMs: r(t.totalMs / t.count, 2), maxMs: r(t.maxMs) } : null)
    return {
      seconds: r(seconds),
      // acde and the processes under it, alive at the end (one that ended in between is not counted)
      cpuPercent: percent(total),
      // threads alive at the end (a short-lived one, as `acde-web-cpu`, only counts in cpuPercent)
      threads: Object.fromEntries(threads.slice(0, 10).map(([name, t]) => [name, percent(t)])),
      rssMb: this.rssMb(pids),
      // the web processes rasterize their own frames: their timing is in the `perf::raster` log lines
      shell: {
        composedPerSecond: r((shell.frames - this.shell.frames) / seconds),
        compose: { p50: r(shell.composeP50, 2), p95: r(shell.composeP95, 2), max: r(shell.composeMax) },
      },
      webs: Object.fromEntries(
        Object.entries(webs).map(([name, s]) => [
          name,
          s.error ? s : { frame: timing(s.frame), frameLocked: timing(s.frameLocked), resolve: timing(s.resolve), nodes: s.nodes, animating: s.animating },
        ]),
      ),
    }
  }
}

/** The measurements: each runs for `seconds` while it does its thing. */
class Scenarios {
  constructor(api) {
    this.api = api
    this.input = new Input(api)
    this.windows = new Windows(api)
  }

  /** `every` each TICK_MS (with the tick's number and the elapsed fraction) until `seconds` are over */
  async loop(seconds, every) {
    const end = Date.now() + seconds * 1000
    for (let i = 0; Date.now() < end; i++) {
      every(i, 1 - (end - Date.now()) / (seconds * 1000))
      await this.api.sleep(TICK_MS)
    }
  }

  async measured(seconds, during) {
    const measure = new Measure(this.api)
    await measure.start()
    await during()
    return measure.finish()
  }

  /** nothing: what the session costs at rest */
  async idle(seconds) {
    return this.measured(seconds, () => this.api.sleep(seconds * 1000))
  }

  /** the pointer circling over the middle of the desktop (hover effects, the Dock) */
  async pointer(seconds) {
    const { width, height } = await this.windows.screen()
    return this.measured(seconds, () =>
      this.loop(seconds, (i) => {
        const a = (i * TICK_MS) / 600
        this.input.move(width / 2 + (width / 3) * Math.cos(a), height / 2 + (height / 3) * Math.sin(a))
      }),
    )
  }

  /** an app's window dragged in circles by its title bar */
  async drag(seconds, app = 'files', fresh = false) {
    const { id, rect } = await this.windows.ensure(app, fresh)
    const [x, y] = [rect.x + rect.width / 2, rect.y - 14]
    this.input.move(x, y)
    await this.api.sleep(100)
    this.input.button('left', true)
    await this.api.sleep(100)
    // where the window is half way (at the end it may be back where it was: kept on the screen at an edge)
    const halfway = this.api.sleep((seconds * 1000) / 2).then(() => this.windows.rect(id))
    const result = await this.measured(seconds, () =>
      this.loop(seconds, (i) => {
        const a = (i * TICK_MS) / 300
        this.input.move(x + 150 * Math.sin(a), y + 80 - 80 * Math.cos(a))
      }),
    )
    this.input.button('left', false)
    const moved = await halfway
    const at = (r) => `${Math.round(r.x)},${Math.round(r.y)}`
    return { ...result, window: id, dragged: !!moved && at(moved) !== at(rect) }
  }

  /** an app's window scrolled up and down with the wheel */
  async scroll(seconds, app = 'files') {
    const { rect } = await this.windows.ensure(app)
    this.input.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await this.api.sleep(100)
    return this.measured(seconds, () =>
      this.loop(seconds, (i) => {
        const down = Math.floor((i * TICK_MS) / 1000) % 2 === 0
        this.api.shell.inject({ type: 'wheel', dx: 0, dy: down ? 40 : -40, source: 'wheel' })
      }),
    )
  }

  /** `count` windows of the stress app (tests/fixtures/stress-app on ACDE_PATH) repainting every frame: surfaces
   * sharing the rasterizing thread */
  async stress(seconds, count = 3) {
    const ids = []
    for (let n = 0; n < Number(count); n++) ids.push(await this.windows.launch('stress'))
    await this.api.sleep(2000)
    try {
      return { ...(await this.measured(seconds, () => this.api.sleep(seconds * 1000))), windows: ids }
    } finally {
      for (const id of ids) await this.windows.close(id).catch(() => {})
    }
  }

  /** `count` stress windows repainting while a new files window (on top of them) is dragged: surfaces competing for
   * the rasterizing thread (each web's frames per second show who got a turn) */
  async contend(seconds, count = 3) {
    const ids = []
    for (let n = 0; n < Number(count); n++) ids.push(await this.windows.launch('stress'))
    await this.api.sleep(2000)
    let dragged = null
    try {
      const result = await this.drag(seconds, 'files', true)
      dragged = result.window
      return { ...result, windows: ids }
    } finally {
      for (const id of [...ids, dragged]) if (id !== null) await this.windows.close(id).catch(() => {})
    }
  }

  /** an app's window opened and closed again and again (the desktop's open / close animations) */
  async open(seconds, app = 'files') {
    return this.measured(seconds, async () => {
      const end = Date.now() + seconds * 1000
      while (Date.now() < end) {
        const id = await this.windows.launch(app)
        await this.api.sleep(1200)
        await this.windows.close(id)
        await this.api.sleep(800)
      }
    })
  }
}

export async function run(api, [command, ...args]) {
  const input = new Input(api)
  const windows = new Windows(api)
  switch (command) {
    case 'keys':
      for (const chord of args) await input.chord(chord)
      return true
    case 'type':
      for (const c of args.join(' ')) await input.chord(/[a-zA-Z0-9]/.test(c) ? c : SYMBOLS[c])
      return true
    case 'move':
      input.move(args[0], args[1])
      return true
    case 'click': {
      const [x, y, which] = args.length >= 2 ? args : [null, null, args[0]]
      await input.click(x, y, which)
      return true
    }
    case 'drag':
      await input.drag(...args.map(Number))
      return true
    case 'wheel':
      input.move(args[0], args[1])
      api.shell.inject({ type: 'wheel', dx: 0, dy: Number(args[2]), source: 'wheel' })
      return true
    case 'eval':
      return api.web(args[0], args.slice(1).join(' '))
    case 'windows':
      return api.broker.windows
    case 'launch':
      return windows.launch(args[0])
    case 'close':
      return windows.close(args[0])
    case 'screenshot':
      return api.shell.screenshot(args[0])
    case 'stats':
      return { shell: api.shell.stats(args[0] === 'reset'), webs: await api.stats(args[0] === 'reset') }
    case 'perf': {
      const [scenario, seconds = '10', arg] = args
      const scenarios = new Scenarios(api)
      if (!['idle', 'pointer', 'drag', 'scroll', 'stress', 'contend', 'open'].includes(scenario)) throw new Error(`unknown scenario ${scenario}`)
      return { scenario, ...(await scenarios[scenario](Number(seconds), arg)) }
    }
    default:
      throw new Error(`unknown command ${command}`)
  }
}
