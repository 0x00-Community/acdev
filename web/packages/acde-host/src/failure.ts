export class Failure {
  static debug(env: Readonly<Record<string, string | undefined>>): boolean {
    const value = env['ACDE_DEBUG']
    return value !== undefined && value !== '' && value !== '0'
  }

  static line(error: unknown, debug: boolean): string {
    const stack = error instanceof Error ? error.stack : undefined
    if (debug && stack) return `acde: ${stack}\n`
    const message = error instanceof Error ? error.message : String(error)
    return `acde: ${message}\n`
  }
}
