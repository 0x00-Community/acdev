import { spawnSync } from './sys/child_process'
import type { BrokerShell } from './broker'
import { WaylandSessions, type ForeignSession } from './foreign'
import { process } from './sys/process'
import { Level, Log } from './log'

type SessionEnd = 'logout' | 'reboot' | 'poweroff' | 'handoff'

export type RunEnd = 'close' | 'exit' | 'signal'

export class DesktopSession {
  own = false
  #shell: Pick<BrokerShell, 'launch' | 'quit'> | null = null
  #ending: SessionEnd | null = null
  #children: () => number[] = () => []

  /** `children`: the pids of every program the session started (the desk keeps them), ended with it. */
  attach(shell: Pick<BrokerShell, 'launch' | 'quit'>, children: () => number[]): void {
    this.#shell = shell
    this.#children = children
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

  /** Ends the session (the desk has already done what `acde:session` asked: systemd for reboot / power-off). */
  finish(kind: SessionEnd): void {
    DesktopSession.#report(`session ${kind}`)
    this.#ending = kind
    this.terminate()
    this.#shell?.quit()
  }

  /** The greeter's logout after a login, and hand-offs: nothing to ask systemd. */
  end(kind: 'logout' | 'handoff'): void {
    this.finish(kind)
  }

  terminate(): void {
    for (const pid of this.#children()) {
      if (!(pid > 0)) continue
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
      }
    }
    if (this.own) spawnSync('pkill', ['-TERM', '-x', '-u', String(process.getuid()), 'fcitx5'], 3000)
  }

  static #report(line: string, level = Level.Info): void {
    Log.write(level, 'acde_host', line)
  }
}
