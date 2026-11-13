import type { Acde } from './acde.ts'

export type ClockTime = number | string | Date

export type ClockDuration = number | string

export interface ClockState {
  readonly installed: boolean
  readonly paused: boolean
  readonly now: number
  readonly performanceNow: number
  readonly fixed: boolean
  readonly timers: number
}

export interface ClockTarget {
  readonly acde: Acde
  describe(): string
  web(): Promise<string>
}

export class Clock {
  readonly #target: ClockTarget

  constructor(target: ClockTarget) {
    this.#target = target
  }

  static time(time: ClockTime): number {
    const ms = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : Date.parse(time)
    if (!Number.isFinite(ms)) {
      throw new Error(`clock: ${JSON.stringify(time)} is not a time (milliseconds since 1970, a Date or a date string)`)
    }
    return ms
  }

  static duration(duration: ClockDuration): number {
    if (typeof duration === 'number') {
      if (!Number.isFinite(duration) || duration < 0) {
        throw new Error(`clock: ${duration} is not a duration in milliseconds`)
      }
      return duration
    }
    const parts = duration.split(':')
    if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
      throw new Error(`clock: ${JSON.stringify(duration)} is not a duration ("ss", "mm:ss" or "hh:mm:ss")`)
    }
    return parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000
  }

  install(options: { readonly time?: ClockTime } = {}): Promise<ClockState> {
    const { time } = options
    if (time === undefined) return this.#do('install', {}, '')
    return this.#do('install', { time: Clock.time(time) }, JSON.stringify(time))
  }

  fastForward(duration: ClockDuration): Promise<ClockState> {
    return this.#do('fastForward', { ms: Clock.duration(duration) }, JSON.stringify(duration))
  }

  runFor(duration: ClockDuration): Promise<ClockState> {
    return this.#do('runFor', { ms: Clock.duration(duration) }, JSON.stringify(duration))
  }

  pauseAt(time: ClockTime): Promise<ClockState> {
    return this.#do('pauseAt', { time: Clock.time(time) }, JSON.stringify(time))
  }

  resume(): Promise<ClockState> {
    return this.#do('resume', {}, '')
  }

  setFixedTime(time: ClockTime): Promise<ClockState> {
    return this.#do('setFixedTime', { time: Clock.time(time) }, JSON.stringify(time))
  }

  setSystemTime(time: ClockTime): Promise<ClockState> {
    return this.#do('setSystemTime', { time: Clock.time(time) }, JSON.stringify(time))
  }

  state(): Promise<ClockState> {
    return this.#do('state', {}, '')
  }

  #do(action: string, args: Record<string, number>, shown: string): Promise<ClockState> {
    const target = this.#target
    const step = `${target.describe()}.clock.${action}(${shown})`
    return target.acde.trace.step(step, async () => target.acde.clock(await target.web(), { action, ...args }))
  }
}
