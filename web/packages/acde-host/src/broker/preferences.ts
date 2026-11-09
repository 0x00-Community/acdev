import { Level, Log } from '../log'

export interface Emulation {
  readonly colorScheme?: 'light' | 'dark' | null
  readonly reducedMotion?: boolean | null
}

export interface Emulated {
  colorScheme: 'light' | 'dark'
  emulated: boolean
  reducedMotion: boolean
}

export class Preferences {
  #dark: boolean
  #systemDark: boolean
  #emulatedDark: boolean | null = null
  #reducedMotion: boolean | null
  readonly #systemMotion: boolean | null
  readonly #post: (message: Record<string, unknown>) => void

  constructor(dark: boolean, reducedMotion: boolean | null, post: (message: Record<string, unknown>) => void) {
    this.#dark = dark
    this.#systemDark = dark
    this.#reducedMotion = reducedMotion
    this.#systemMotion = reducedMotion
    this.#post = post
  }

  get dark(): boolean {
    return this.#dark
  }

  get reducedMotion(): boolean | null {
    return this.#reducedMotion
  }

  setDark(dark: boolean): void {
    this.#systemDark = dark
    this.#applyDark()
  }

  emulate(options: Emulation): Emulated {
    if (options.colorScheme !== undefined) {
      if (options.colorScheme !== null && options.colorScheme !== 'light' && options.colorScheme !== 'dark') {
        throw Object.assign(new Error(`emulate: colorScheme is light, dark or null, not ${JSON.stringify(options.colorScheme)}`), { status: 400 })
      }
      this.#emulatedDark = options.colorScheme === null ? null : options.colorScheme === 'dark'
      this.#applyDark()
    }
    if (options.reducedMotion !== undefined) {
      const reduced = options.reducedMotion === null ? this.#systemMotion : options.reducedMotion === true
      if (reduced !== this.#reducedMotion) {
        this.#reducedMotion = reduced
        Log.write(Level.Info, 'acde_host', `reduced motion: ${reduced === true}`)
        this.#post({ type: 'motion', reduced: reduced === true })
      }
    }
    return { colorScheme: this.#dark ? 'dark' : 'light', emulated: this.#emulatedDark !== null, reducedMotion: this.#reducedMotion === true }
  }

  #applyDark(): void {
    const dark = this.#emulatedDark ?? this.#systemDark
    if (this.#dark === dark) return
    this.#dark = dark
    Log.write(Level.Info, 'acde_host', `color scheme: ${dark ? 'dark' : 'light'}${this.#emulatedDark === null ? '' : ' (emulated)'}`)
    this.#post({ type: 'colorscheme', dark })
  }
}
