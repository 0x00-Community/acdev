export interface WindowFamily {
  readonly parent: number
  readonly modal: boolean
}

export interface FamilyWindow {
  readonly kind: 'native' | 'web'
  readonly appId: string | null
}

export interface FamilyCaller {
  readonly desktop: boolean
  readonly appId: string | null
  readonly label: string
}

export class Family {
  static of(options: unknown, caller: FamilyCaller, find: (id: number) => FamilyWindow | undefined): WindowFamily | null {
    if (options === undefined || options === null) return null
    if (typeof options !== 'object') throw Family.#bad('options is an object')
    const { parent, modal } = options as { parent?: unknown; modal?: unknown }
    if (parent === undefined || parent === null) return null
    if (typeof parent !== 'number' || !Number.isInteger(parent) || parent < 0) throw Family.#bad('parent is a window id')
    const window = find(parent)
    if (!window) throw Object.assign(new Error(`open: no window ${parent}`), { status: 404 })
    if (!caller.desktop && (window.kind !== 'web' || window.appId !== caller.appId)) {
      throw Object.assign(new Error(`open: window ${parent} is not a window of ${caller.label}`), { status: 403, code: 'forbidden' })
    }
    return { parent, modal: modal === true }
  }

  static #bad(what: string): Error {
    return Object.assign(new TypeError(`open: ${what}`), { status: 400 })
  }
}
