import { Manifest, SHELL_MODULES, type ShellModule } from '@dopame/acde-api/manifest'
import type { AppManifest, AppOrigin } from '../../apps'
import type { CapabilitySnapshot } from './capabilities'

export interface WebTier {
  readonly level: number
  readonly shell: readonly ShellModule[]
  readonly refused: Readonly<Record<string, string>>
  readonly capabilities?: CapabilitySnapshot
}

export class Tiers {
  static readonly LEGACY: WebTier = { level: 0, shell: [], refused: {} }
  static readonly DESKTOP: WebTier = { level: 1, shell: [...SHELL_MODULES], refused: {} }
  static readonly #CAPABILITY_MODULES = ['fs', 'terminal', 'network', 'office'] as const
  static readonly #EVENTS: ReadonlyMap<string, ShellModule> = new Map([
    ['appschanged', 'packages'],
    ['download', 'desktop'],
    ['notification', 'desktop'],
  ])

  static app(app: AppManifest, origin: AppOrigin): WebTier {
    if (origin.level < 1) return Tiers.LEGACY
    const caps = app.capabilities
    const declared = `the capabilities of ${app.label}`
    const shell = origin.system ? Manifest.shellModules(caps) : []
    const refused: Record<string, string> = {}
    for (const name of SHELL_MODULES) {
      if (shell.includes(name)) continue
      refused[`acde:${name}`] = origin.system
        ? `acde:${name} is a shell module: declare "${name}" in ${declared}`
        : `acde:${name} is a shell module: only the desktop, its services and system apps may import it, and ${app.label} is not a system app`
    }
    if (!caps.launch && !caps.slots) refused['acde:launch'] = `acde:launch needs "launch" or "slots" in ${declared}`
    if (!caps.openFiles) for (const name of ['openPath', 'handlers']) refused[`acde:${name}`] = `acde:${name} needs "openFiles" in ${declared}`
    for (const name of Tiers.#CAPABILITY_MODULES) if (!caps[name]) refused[`acde:${name}`] = `acde:${name} needs "${name}" in ${declared}`
    return { level: origin.level, shell, refused }
  }

  static refusal(app: AppManifest, origin: AppOrigin): string | null {
    if (origin.level < 1 || origin.system) return null
    const declared = Manifest.shellModules(app.capabilities)
    if (!declared.length) return null
    const names = declared.map((name) => `acde:${name}`).join(', ')
    const are = declared.length > 1 ? 'are shell modules' : 'is a shell module'
    return `${app.label}: ${names} ${are}; only system apps (apps of a desktop package) may declare them`
  }

  static listens(tier: WebTier, type: string): boolean {
    const module = type.startsWith('window') ? 'windows' : Tiers.#EVENTS.get(type)
    return !!module && tier.shell.includes(module)
  }
}
