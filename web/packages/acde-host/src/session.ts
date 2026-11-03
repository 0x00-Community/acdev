import { spawnSync } from './sys/child_process'
import type { BrokerShell } from './broker'
import { WaylandSessions, type ForeignSession } from './foreign'
import { process } from './sys/process'
import { Level, Log } from './log'
import type { SessionLanguage } from './language'

type SessionEnd = 'logout' | 'reboot' | 'poweroff' | 'handoff'

export type RunEnd = 'close' | 'exit' | 'signal'

export class DesktopSession {
  own = false
  #shell: Pick<BrokerShell, 'launch' | 'quit'> | null = null
  #ending: SessionEnd | null = null
  readonly #children = new Set<number>()
  language: SessionLanguage | null = null


  attach(shell: Pick<BrokerShell, 'launch' | 'quit'>): void {
    this.#shell = shell
    const launch = shell.launch.bind(shell)
    shell.launch = (argv, options) => {
      const pid = launch(argv, options)
      if (pid > 0) this.#children.add(pid)
      return pid
    }
  }

  get ending(): SessionEnd | null {
    return this.#ending
  }

  exitCode(end: RunEnd): number {
    if (this.#ending === 'handoff') return WaylandSessions.HANDOFF_EXIT
    return end === 'exit' && !this.#ending ? 1 : 0
  }

  handOff(session: ForeignSession): void {
    const file = WaylandSessions.handOff(session)
    DesktopSession.#report(`handing the session over to ${session.id} (${session.argv.join(' ')}), ${file}`)
    this.end('handoff')
  }

  end(kind: SessionEnd): void {
    if (kind === 'reboot' || kind === 'poweroff') {
      if (!this.own) return void DesktopSession.#report(`${kind} asked for; nested, not done`)
      const result = spawnSync('systemctl', [kind, '--no-wall'], { encoding: 'utf8', timeout: 15000 })
      if (result.status !== 0) {
        const message = (result.error?.message ?? result.stderr ?? '').trim() || `systemctl ${kind}: exit ${result.status}`
        DesktopSession.#report(`${kind} refused: ${message}`, Level.Warn)
        throw new Error(message)
      }
    }
    DesktopSession.#report(`session ${kind}`)
    this.#ending = kind
    this.terminate()
    this.#shell?.quit()
  }

  terminate(): void {
    for (const pid of this.#children) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
      }
    }
    this.#children.clear()
    if (this.own) spawnSync('pkill', ['-TERM', '-x', '-u', String(process.getuid?.() ?? ''), 'fcitx5'], { timeout: 3000 })
  }

  static #report(line: string, level = Level.Info): void {
    Log.write(level, 'acde_host', line)
  }

  readonly api = {
    own: (): boolean => this.own,
    logout: (): void => this.end('logout'),
    reboot: (): void => this.end('reboot'),
    poweroff: (): void => this.end('poweroff'),
    setLanguage: (tag: string): void => {
      if (!this.language) throw Object.assign(new Error('acde.session.setLanguage: no session language here'), { status: 503 })
      this.language.set(String(tag))
    },
  }
}
