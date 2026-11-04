import { host, report } from './host'

interface Timer {
  handle: number
  readonly callback: unknown
  readonly args: unknown[]
  readonly ms: number
  readonly repeat: boolean
  refed: boolean
}

const timers = new Map<number, Timer>()
let nextId = 1

function run(id: number): void {
  const timer = timers.get(id)
  if (!timer) return
  if (timer.repeat) timer.handle = host.setTimer(timer.ms, () => run(id), timer.refed)
  else timers.delete(id)
  try {
    const callback = timer.callback
    if (typeof callback === 'function') callback(...timer.args)
    else host.runScript(String(callback), 'timer')
  } catch (error) {
    report(error)
  }
}

function start(callback: unknown, ms: unknown, args: unknown[], repeat: boolean): number {
  const id = nextId++
  const delay = Math.max(0, Number(ms) || 0)
  const timer: Timer = { handle: 0, callback, args, ms: delay, repeat, refed: true }
  timers.set(id, timer)
  timer.handle = host.setTimer(delay, () => run(id), true)
  return id
}

function stop(id: unknown): void {
  const key = Number(id)
  const timer = timers.get(key)
  if (!timer) return
  timers.delete(key)
  host.clearTimer(timer.handle)
}

class Timeout {
  constructor(readonly id: number) {}
  ref(): this {
    setRef(this.id, true)
    return this
  }
  unref(): this {
    setRef(this.id, false)
    return this
  }
  hasRef(): boolean {
    return timers.get(this.id)?.refed ?? false
  }
  refresh(): this {
    const timer = timers.get(this.id)
    if (timer) {
      host.clearTimer(timer.handle)
      timer.handle = host.setTimer(timer.ms, () => run(this.id), timer.refed)
    }
    return this
  }
  [Symbol.toPrimitive](): number {
    return this.id
  }
}

function setRef(id: number, refed: boolean): void {
  const timer = timers.get(id)
  if (!timer || timer.refed === refed) return
  timer.refed = refed
  host.refTimer(timer.handle, refed)
}

export function timerGlobals(node: boolean) {
  const wrap = node ? (id: number) => new Timeout(id) : (id: number) => id
  return {
    setTimeout: (callback: unknown, ms?: unknown, ...args: unknown[]) => wrap(start(callback, ms, args, false)),
    setInterval: (callback: unknown, ms?: unknown, ...args: unknown[]) => wrap(start(callback, ms, args, true)),
    clearTimeout: stop,
    clearInterval: stop,
    queueMicrotask,
    requestIdleCallback,
    cancelIdleCallback: stop,
  }
}

export function queueMicrotask(callback: () => void): void {
  if (typeof callback !== 'function') throw new TypeError("Failed to execute 'queueMicrotask': parameter 1 is not of type 'Function'.")
  host.queueMicrotask(() => {
    try {
      callback()
    } catch (error) {
      report(error)
    }
  })
}

function requestIdleCallback(callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void, options?: { timeout?: number }): number {
  void options
  return start(() => {
    const end = host.now() + 50
    callback({ didTimeout: false, timeRemaining: () => Math.max(0, end - host.now()) })
  }, 1, [], false)
}
