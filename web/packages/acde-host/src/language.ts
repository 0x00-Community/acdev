import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from './sys/fs'
import { sys } from './sys/natives'
import { xdgHome } from './sys/os'
import { dirname, join } from './sys/path'
import { process, type Env } from './sys/process'
import { Level, Log } from './log'

export interface Languages {
  readonly language?: string
  readonly languages?: string[]
}

export class SessionLanguage {
  static readonly TAG = /^([a-z]{2,3})-([A-Z]{2})$/

  static of(env: Env, system: readonly string[] = []): Languages {
    const tag = (locale: string) => {
      const base = locale.split(/[.@]/)[0]!.trim()
      if (!base) return null
      if (base === 'C' || base === 'POSIX') return 'en-US'
      return base.replace(/_/g, '-')
    }
    const locale = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || ''
    const set = [...(env['LANGUAGE'] ? env['LANGUAGE'].split(':') : []), locale].map(tag).filter((t): t is string => !!t)
    const list = set.length ? set : system.map((t) => t.trim()).filter(Boolean)
    const languages = [...new Set(list.flatMap((t) => (t.includes('-') ? [t, t.split('-')[0]!] : [t])))]
    return languages.length ? { language: languages[0]!, languages } : {}
  }

  static #locale(tag: string): string {
    const match = SessionLanguage.TAG.exec(tag)
    if (!match) throw Object.assign(new Error(`acde.session.setLanguage: ${JSON.stringify(tag)} is not a language-REGION tag such as zh-CN`), { status: 400 })
    return `${match[1]}_${match[2]}.UTF-8`
  }

  static #persist(locale: string, file: string): void {
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*(LANG|LANGUAGE)=/.test(l)) : []
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, [`LANG=${locale}`, ...lines, ''].join('\n'))
    renameSync(`${file}.tmp`, file)
  }

  #current: Languages
  readonly #onChange: (languages: Languages) => void

  constructor(onChange: (languages: Languages) => void) {
    this.#current = SessionLanguage.of(process.env, sys().languages())
    this.#onChange = onChange
  }

  get current(): Languages {
    return this.#current
  }

  set(tag: string): void {
    const locale = SessionLanguage.#locale(tag)
    const next = SessionLanguage.of({ LANG: locale })
    const file = join(xdgHome('config'), 'locale.conf')
    try {
      SessionLanguage.#persist(locale, file)
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `${file} not written: ${(error as Error).message}`)
    }
    process.env['LANG'] = locale
    delete process.env['LANGUAGE']
    delete process.env['LC_ALL']
    delete process.env['LC_MESSAGES']
    if (this.#current.language === next.language) return
    Log.write(Level.Info, 'acde_host', `session language: ${next.language}`)
    this.#current = next
    this.#onChange(next)
  }
}
