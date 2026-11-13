export class Pkgs {
  static readonly BASE = 'https://pkgs.dopame.ai'
  static readonly ACDE = `${Pkgs.BASE}/acde`

  static scriptProblems(sh: string, ps1: string): string[] {
    const wanted: [string, string, string][] = [
      ['install.sh', sh, `ACDE_DIST=\${ACDE_DIST:-${Pkgs.ACDE}}`],
      ['install.ps1', ps1, `} else { '${Pkgs.ACDE}' }`],
    ]
    return wanted.filter(([, text, line]) => !text.includes(line))
      .map(([file, , line]) => `${file}: the default download address is not ${line}`)
  }
}
