import { CAPABILITY_MODULES, Manifest, SHELL_MODULES, type ShellModule } from '@dopame/acde-api/manifest'
import type { AppManifest, AppOrigin } from '../../apps'
import type { CapabilitySnapshot } from './capabilities'
import type { Permit } from './approval/permissions'

export interface WebTier {
  readonly level: number
  readonly system?: boolean
  readonly shell: readonly ShellModule[]
  readonly refused: Readonly<Record<string, string>>
  readonly capabilities?: CapabilitySnapshot
  readonly permits?: Readonly<Record<string, Permit>>
}

export class Tiers {
  static readonly DESKTOP: WebTier = { level: 1, shell: [...SHELL_MODULES], refused: {} }
  static readonly #GATED = [...SHELL_MODULES, 'launch', 'openPath', 'handlers', ...CAPABILITY_MODULES]
  static readonly #EVENTS: ReadonlyMap<string, ShellModule> = new Map([
    ['appschanged', 'packages'],
    ['download', 'desktop'],
    ['notification', 'desktop'],
    ['permissionprompt', 'permissions'],
    ['permissionanswered', 'permissions'],
  ])

  static app(app: AppManifest, origin: AppOrigin): WebTier {
    const shell = origin.system ? Manifest.shellModules(app.capabilities) : []
    const refused: Record<string, string> = {}
    for (const name of Tiers.#GATED) {
      const rule = Manifest.importRule(name, app, origin)
      if (!rule.allowed) refused[`acde:${name}`] = rule.reason!
    }
    return { level: origin.level, system: origin.system, shell, refused }
  }

  static refusal(app: AppManifest, origin: AppOrigin): string | null {
    if (origin.system) return null
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
