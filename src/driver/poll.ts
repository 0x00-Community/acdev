export class Poll {
  static readonly INTERVAL_MS = 100

  static async until<T>(timeout: number, attempt: () => T | null | undefined | Promise<T | null | undefined>, fail: () => Error | string | Promise<Error | string>): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await attempt()
      if (value !== null && value !== undefined) return value
      if (Date.now() >= deadline) {
        const error = await fail()
        throw typeof error === 'string' ? new Error(error) : error
      }
      await Bun.sleep(Math.min(Poll.INTERVAL_MS, Math.max(0, deadline - Date.now())))
    }
  }
}
