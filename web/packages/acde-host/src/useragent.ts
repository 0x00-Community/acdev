import pkg from '../package.json' with { type: 'json' }
import { process } from './sys/process'

export class UserAgent {
  static #current: ReturnType<typeof UserAgent.of> | null = null

  static get current(): ReturnType<typeof UserAgent.of> {
    return (UserAgent.#current ??= UserAgent.of(process.platform))
  }

  static of(os: string): { readonly userAgent: string; readonly platform: string } {
    const [system, platform] = os === 'darwin' ? ['Macintosh; Intel Mac OS X 10_15_7', 'MacIntel'] : os === 'win32' ? ['Windows NT 10.0; Win64; x64', 'Win32'] : ['X11; Linux x86_64', 'Linux x86_64']
    return { userAgent: `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) acdert/${pkg.version}`, platform }
  }
}
