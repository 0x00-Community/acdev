import { process, type Env } from './sys/process'

export interface Languages {
  readonly language?: string
  readonly languages?: string[]
}

export class SessionLanguage {
  static of(env: Env): Languages {
    const tag = (locale: string) => {
      const base = locale.split(/[.@]/)[0]!.trim()
      if (!base) return null
      if (base === 'C' || base === 'POSIX') return 'en-US'
      return base.replace(/_/g, '-')
    }
    const locale = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || ''
    const list = [...(env['LANGUAGE'] ? env['LANGUAGE'].split(':') : []), locale].map(tag).filter((t): t is string => !!t)
    const languages = [...new Set(list.flatMap((t) => (t.includes('-') ? [t, t.split('-')[0]!] : [t])))]
    return languages.length ? { language: languages[0]!, languages } : {}
  }

  #current: Languages = SessionLanguage.of(process.env)

  get current(): Languages {
    return this.#current
  }

  /** The desk changed the session language (`acde:session.setLanguage`, crates/acde `desk/session.rs`): what programs started from now on inherit. */
  adopt(locale: string): void {
    process.env['LANG'] = locale
    delete process.env['LANGUAGE']
    delete process.env['LC_ALL']
    delete process.env['LC_MESSAGES']
    this.#current = SessionLanguage.of({ LANG: locale })
  }
}
