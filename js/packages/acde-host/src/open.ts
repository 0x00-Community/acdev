// The desktop entries acde writes for other programs (`acde applications`): `acde-<app>.desktop` per app with
// `mimeTypes`, and the package's `acde-mimeapps.list`. Choosing and opening is the desk's (crates/acde `desk/open.rs`).
import type { AppManifest } from './apps'
import { DesktopEntry } from './desktopentry'

const MIME = /^[\w.+-]+\/[\w.+-]+$/
const MimeTypes = { valid: (mime: string): boolean => MIME.test(mime) }

export class DesktopEntries {
  static readonly #ACDE = /^acde-([\w-]+)\.desktop$/

  static appOf(id: string): string | null {
    return DesktopEntries.#ACDE.exec(id)?.[1] ?? null
  }

  static idOf(app: string): string {
    return `acde-${app}.desktop`
  }

  static entries(apps: readonly AppManifest[], exec = 'acde'): { name: string; text: string }[] {
    return apps.flatMap((app) => {
      const types = app.mimeTypes.filter((m) => MimeTypes.valid(m))
      if (!types.length) return []
      return [{
        name: DesktopEntries.idOf(app.id),
        text: [
          '[Desktop Entry]',
          'Type=Application',
          `Name=${DesktopEntry.line(app.label)}`,
          `Exec=${exec} open --app ${app.id} %U`,
          `TryExec=${exec}`,
          `MimeType=${types.join(';')};`,
          'NoDisplay=true',
          'OnlyShowIn=acde;',
          'Terminal=false',
          '',
        ].join('\n'),
      }]
    })
  }

  static mimeapps(apps: readonly AppManifest[]): string {
    const first = new Map<string, string>()
    for (const app of apps) for (const m of app.mimeTypes) if (MimeTypes.valid(m) && !first.has(m)) first.set(m, DesktopEntries.idOf(app.id))
    return ['[Default Applications]', ...[...first].map(([m, id]) => `${m}=${id};`), ''].join('\n')
  }
}

