import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Agents, type Agent } from './agents.ts'

interface Place {
  readonly dir: string
  readonly names: readonly string[]
  readonly found: boolean
}

type State = 'missing' | 'foreign' | 'current' | 'outdated' | 'broken'

interface Seen {
  readonly state: State
  readonly kind: 'link' | 'copy' | null
}

export class Skills {
  static readonly NAME = 'acde'
  static readonly ACTIONS = ['status', 'install', 'remove', 'path'] as const
  static readonly SOURCE = join(import.meta.dirname, '..', 'skills', Skills.NAME)

  static run(args: readonly string[], flags: ReadonlyMap<string, string>): number {
    const action = args[0] ?? 'status'
    if (!Skills.ACTIONS.some((known) => known === action)) {
      throw new Error(`skills ${action}: one of ${Skills.ACTIONS.join(', ')}`)
    }
    if (flags.has('copy') && action !== 'install') throw new Error(`skills ${action}: --copy is for skills install`)
    if (flags.has('agent') && flags.has('dir')) throw new Error('skills: --agent or --dir, not both')
    if (!existsSync(join(Skills.SOURCE, 'SKILL.md'))) {
      throw new Error(`the acde skill is not in this install (${Skills.SOURCE}): install acde again`)
    }
    const source = Skills.stable()
    if (action === 'path') {
      console.log(source)
      return 0
    }
    const all = Skills.places(Agents.all())
    const chosen = Skills.chosen(all, flags)
    if (action === 'install') return Skills.install(source, chosen ?? all.filter((place) => place.found), flags.has('copy'))
    if (action === 'remove') return Skills.remove(chosen ?? all)
    return Skills.status(source, chosen ?? all)
  }

  static stable(): string {
    const real = realpathSync(Skills.SOURCE)
    const inside = join('lib', 'acde', 'skills', Skills.NAME)
    const version = real.endsWith(sep + inside) ? real.slice(0, -inside.length - 1) : ''
    if (version && basename(dirname(version)) === 'versions') {
      const current = join(dirname(dirname(version)), 'current', inside)
      if (existsSync(current) && realpathSync(current) === real) return current
    }
    return real
  }

  static places(agents: readonly Agent[]): Place[] {
    const places = new Map<string, { names: string[]; found: boolean }>()
    for (const agent of agents) {
      const place = places.get(agent.skills) ?? { names: [], found: false }
      place.names.push(agent.name)
      place.found ||= Agents.found(agent)
      places.set(agent.skills, place)
    }
    const last = Agents.all().find((agent) => agent.id === Agents.SHARED)!.name
    return [...places].map(([dir, { names, found }]) => {
      return { dir, found, names: [...names.filter((name) => name !== last), ...names.filter((name) => name === last)] }
    })
  }

  static chosen(all: readonly Place[], flags: ReadonlyMap<string, string>): Place[] | null {
    if (flags.has('dir')) {
      const dir = flags.get('dir')!
      if (!dir) throw new Error('--dir needs a skills directory')
      return [{ dir: resolve(dir), names: [], found: true }]
    }
    if (!flags.has('agent')) return null
    const ids = flags.get('agent')!.split(',').map((id) => id.trim()).filter(Boolean)
    if (ids.length === 0) throw new Error('--agent needs an agent id, or several separated by commas')
    const dirs = new Set(Agents.named(ids, Agents.all()).map((agent) => agent.skills))
    return all.filter((place) => dirs.has(place.dir)).map((place) => ({ ...place, found: true }))
  }

  static install(source: string, places: readonly Place[], copy: boolean): number {
    const blocked = places.filter((place) => Skills.look(source, place).state === 'foreign')
    if (blocked.length > 0) {
      throw new Error(`${blocked.map((place) => Skills.at(place)).join(', ')}: not the acde skill; ` +
        'move it away, or install somewhere else with --dir')
    }
    for (const place of places) {
      const dest = Skills.at(place)
      mkdirSync(place.dir, { recursive: true })
      const staged = `${dest}.new-${process.pid}`
      rmSync(staged, { recursive: true, force: true })
      if (copy) cpSync(realpathSync(source), staged, { recursive: true })
      else symlinkSync(source, staged, process.platform === 'win32' ? 'junction' : 'dir')
      rmSync(dest, { recursive: true, force: true })
      renameSync(staged, dest)
      console.log(`acde: skill ${copy ? 'copied' : 'linked'} to ${dest}${Skills.who(place)}`)
    }
    if (places.length === 0) console.log('acde: no agent found; name one with --agent, or a skills directory with --dir')
    return places.length === 0 ? 1 : 0
  }

  static remove(places: readonly Place[]): number {
    let removed = 0
    for (const place of places) {
      const { state } = Skills.look('', place)
      if (state === 'missing' || state === 'foreign') continue
      rmSync(Skills.at(place), { recursive: true, force: true })
      console.log(`acde: skill removed from ${Skills.at(place)}`)
      removed++
    }
    if (removed === 0) console.log('acde: the skill is not installed anywhere acde knows; name a directory with --dir')
    return 0
  }

  static status(source: string, places: readonly Place[]): number {
    console.log(`skill   ${source}`)
    let installed = 0
    for (const place of places) {
      const { state, kind } = Skills.look(source, place)
      if (state === 'missing' && !place.found) continue
      if (state !== 'missing' && state !== 'foreign') installed++
      const what = state === 'missing' ? 'not installed' : state === 'foreign' ? 'another skill' : `${kind}, ${state}`
      console.log(`${what.padEnd(15)} ${Skills.at(place)}${Skills.who(place)}`)
    }
    if (installed === 0) console.log('acde: the skill is not installed for any agent: acde skills install')
    return 0
  }

  static look(source: string, place: Place): Seen {
    const dest = Skills.at(place)
    const stat = lstatSync(dest, { throwIfNoEntry: false })
    if (!stat) return { state: 'missing', kind: null }
    if (stat.isSymbolicLink()) {
      if (!existsSync(dest)) return { state: 'broken', kind: 'link' }
      if (!Skills.ours(dest)) return { state: 'foreign', kind: null }
      return { state: source && realpathSync(dest) === realpathSync(source) ? 'current' : 'outdated', kind: 'link' }
    }
    if (!stat.isDirectory() || !Skills.ours(dest)) return { state: 'foreign', kind: null }
    return { state: source && Skills.same(realpathSync(source), dest) ? 'current' : 'outdated', kind: 'copy' }
  }

  static ours(dir: string): boolean {
    const file = join(dir, 'SKILL.md')
    return existsSync(file) && /^---\n(?:.*\n)*?name: acde\n/.test(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  }

  static same(a: string, b: string): boolean {
    const names = readdirSync(a).sort()
    if (names.join('\n') !== readdirSync(b).sort().join('\n')) return false
    return names.every((name) => {
      const [left, right] = [join(a, name), join(b, name)]
      const [one, two] = [lstatSync(left), lstatSync(right)]
      if (one.isDirectory() || two.isDirectory()) return one.isDirectory() && two.isDirectory() && Skills.same(left, right)
      return readFileSync(left).equals(readFileSync(right))
    })
  }

  static at(place: Place): string {
    return join(place.dir, Skills.NAME)
  }

  static who(place: Place): string {
    return place.names.length > 0 ? ` (${place.names.join(', ')})` : ''
  }
}
