export class Failure {
  static line(error: unknown, debug: boolean): string {
    const stack = error instanceof Error ? error.stack : undefined
    if (debug && stack) return `acde: ${stack}\n`
    const message = error instanceof Error ? error.message : String(error)
    return `acde: ${message}\n`
  }
}
