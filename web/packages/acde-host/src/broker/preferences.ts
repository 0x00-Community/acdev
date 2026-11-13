import { Level, Log } from '../log'

export interface Emulation {
  readonly colorScheme?: 'light' | 'dark' | null
}

export interface Emulated {
  colorScheme: 'light' | 'dark'
  emulated: boolean
}

export class Preferences {
  #dark: boolean
  #systemDark: boolean
  #emulatedDark: boolean | null = null
  readonly #post: (message: Record<string, unknown>) => void

  constructor(dark: boolean, post: (message: Record<string, unknown>) => void) {
    this.#dark = dark
    this.#systemDark = dark
    this.#post = post
  }

  get dark(): boolean {
    return this.#dark
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
    return { colorScheme: this.#dark ? 'dark' : 'light', emulated: this.#emulatedDark !== null }
  }

  #applyDark(): void {
    const dark = this.#emulatedDark ?? this.#systemDark
    if (this.#dark === dark) return
    this.#dark = dark
    Log.write(Level.Info, 'acde_host', `color scheme: ${dark ? 'dark' : 'light'}${this.#emulatedDark === null ? '' : ' (emulated)'}`)
    this.#post({ type: 'colorscheme', dark })
  }
}
