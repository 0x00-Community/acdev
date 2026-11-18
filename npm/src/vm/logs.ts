export const DEVD_LOGS = '/var/log/acdevd'

export interface LogOptions {
  readonly follow: boolean
  readonly lines: number
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

function logFile(source: string | undefined): string | null {
  if (source === undefined) return null
  if (/^\d+$/.test(source)) return `${DEVD_LOGS}/${source}.log`
  return source.startsWith('/') ? source : null
}

export function logCommand(source: string | undefined, options: LogOptions): string {
  const file = logFile(source)
  if (file) return `exec tail -n ${options.lines}${options.follow ? ' -F' : ''} ${quote(file)}`
  const unit = source === undefined ? '' : ` -u ${quote(source)}`
  return `exec journalctl --no-pager -o short-precise -n ${options.lines}${options.follow ? ' -f' : ''}${unit}`
}

export class LineFilter {
  #rest = ''
  readonly #pattern: RegExp | null

  readonly write: (text: string) => void

  constructor(pattern: string | undefined, write: (text: string) => void) {
    this.write = write
    this.#pattern = pattern === undefined ? null : new RegExp(pattern, 'i')
  }

  push(chunk: Buffer): void {
    if (!this.#pattern) {
      this.write(chunk.toString())
      return
    }
    const lines = (this.#rest + chunk.toString()).split('\n')
    this.#rest = lines.pop()!
    for (const line of lines) if (this.#pattern.test(line)) this.write(`${line}\n`)
  }

  end(): void {
    if (this.#rest && (!this.#pattern || this.#pattern.test(this.#rest))) this.write(`${this.#rest}\n`)
    this.#rest = ''
  }
}
