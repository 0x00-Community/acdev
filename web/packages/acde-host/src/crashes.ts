export class Crashes {
  readonly #times = new Map<string, number[]>()

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
  ) {}

  note(key = ''): { count: number; tooMany: boolean } {
    const now = Date.now()
    const times = [...(this.#times.get(key) ?? []).filter((t) => now - t < this.windowMs), now]
    this.#times.set(key, times)
    return { count: times.length, tooMany: times.length > this.limit }
  }

  forget(key = ''): void {
    this.#times.delete(key)
  }
}
