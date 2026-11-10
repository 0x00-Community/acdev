import pkg from '../package.json' with { type: 'json' }

export class UserAgent {
  static readonly current: { readonly userAgent: string; readonly platform: string } = {
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) acdert/${pkg.version}`,
    platform: 'Linux x86_64',
  }
}
