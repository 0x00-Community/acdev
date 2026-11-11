import type { CapabilityStatus } from '@dopame/acde-api/manifest'
import type { AppRegistry } from '../../apps'
import { CapabilityCheck } from '../access/capabilities'
import { Permissions } from '../access/approval/permissions'
import { Web } from '../web'

export interface PermissionCallsHost {
  readonly permissions: Permissions
  apps(): AppRegistry
  capabilities(): CapabilityCheck
}

export class PermissionCalls {
  readonly #host: PermissionCallsHost

  constructor(host: PermissionCallsHost) {
    this.#host = host
  }

  permissions(web: Web, method: string, args: unknown[]): unknown {
    if (!web.shell('permissions')) throw Web.refused(web, 'acde:permissions')
    const permissions = this.#host.permissions
    switch (method) {
      case 'pending':
        return permissions.pending()
      case 'answer':
        return permissions.answer(Number(args[0]), args[1] === true)
      case 'list':
        return permissions.list(args[0] === undefined || args[0] === null ? undefined : String(args[0]))
      case 'revoke':
        return permissions.revoke(String(args[0]), String(args[1]))
    }
    throw new Error(`acde.permissions has no ${method}`)
  }

  async capabilities(web: Web, method: string, args: unknown[]): Promise<CapabilityStatus> {
    if (method !== 'request') throw new Error(`acde.capabilities has no ${method}`)
    const name = String(args[0])
    const app = web.app
    const check = this.#host.capabilities()
    if (!app) return check.status(name, null, { level: 1, system: true })
    const origin = this.#host.apps().origin(app.id)
    const status = check.status(name, app, origin)
    if (CapabilityCheck.asks(status.state) && Permissions.approval(name)) await this.#host.permissions.ask(app, origin, name, 'request')
    return check.status(name, app, origin)
  }
}
