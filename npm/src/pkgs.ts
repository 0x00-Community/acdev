export class Pkgs {
  static readonly BASE = 'https://pkgs.dopame.ai'
  static readonly ACDEV = `${Pkgs.BASE}/acdev`

  static scriptProblems(sh: string, ps1: string): string[] {
    const wanted: [string, string, string][] = [
      ['install.sh', sh, `ACDEV_DIST=\${ACDEV_DIST:-${Pkgs.ACDEV}}`],
      ['install.ps1', ps1, `} else { '${Pkgs.ACDEV}' }`],
    ]
    return wanted.filter(([, text, line]) => !text.includes(line))
      .map(([file, , line]) => `${file}: the default download address is not ${line}`)
  }
}
