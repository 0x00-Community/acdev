import type { AppRegistry } from '../apps'
import type { RawShellEvent } from '../native'
import type { CapabilityCheck } from './access/capabilities'
import { ApprovalDialogs, type NativeApproval } from './access/approval/dialog'
import { Permissions, type Approval, type DecisionStore } from './access/approval/permissions'
import { PermissionCalls } from './calls/permissions'
import type { WindowRecord } from './types'
import type { Web } from './web'

export interface ApprovalsHost {
  apps(): AppRegistry
  capabilities(): CapabilityCheck
  records(): Iterable<WindowRecord>
  toDesktop(event: Record<string, unknown> | RawShellEvent): void
  dialog(): NativeApproval | null
  standalone(): boolean
  finder(): FolderGrants | null
  store(): DecisionStore | null
  log(line: string): void
  listed(): void
}

export interface FolderGrants {
  folders(owner: string): { id: string; label: string; exists: boolean }[]
  revokeFolder(owner: string, id: string): boolean
}

export class Approvals {
  readonly permissions: Permissions
  readonly calls: PermissionCalls
  readonly #host: ApprovalsHost

  constructor(host: ApprovalsHost) {
    this.#host = host
    const answers = { pending: () => this.permissions.pending(), answer: (id: number, allow: boolean) => this.permissions.answer(id, allow) }
    const dialogs = new ApprovalDialogs(answers, () => host.dialog())
    this.permissions = new Permissions({
      store: host.store(),
      label: (id) => host.apps().get(id)?.label ?? null,
      supported: (capability) => host.capabilities().supported(capability),
      tell: (event) => {
        host.toDesktop(event)
        dialogs.event(event)
      },
      changed: (appId, capability, approval) => this.#changed(appId, capability, approval),
      log: (line) => host.log(line),
      asksAgain: () => host.standalone(),
      folders: (appId) => {
        const finder = host.finder()
        const ids = appId === undefined ? host.apps().list().map((app) => app.id) : [appId]
        return finder ? ids.flatMap((app) => finder.folders(app).map((folder) => ({ app, ...folder }))) : []
      },
      revokeFolder: (appId, id) => host.finder()?.revokeFolder(appId, id) ?? false,
    })
    this.calls = new PermissionCalls({ permissions: this.permissions, apps: () => host.apps(), capabilities: () => host.capabilities() })
  }

  allow(web: Web, capability: string): void {
    if (!web.app) return
    const approval = this.permissions.approval(web.app, this.#host.apps().origin(web.app.id), capability)
    if (approval !== 'granted') throw Permissions.error(web.app.label, capability, approval)
  }

  #changed(appId: string, capability: string, approval: Approval): void {
    for (const record of this.#host.records()) {
      const app = record.app
      if (!app || app.id !== appId || !record.web) continue
      const status = Permissions.folder(capability) ? null : this.#host.capabilities().status(capability, app, this.#host.apps().origin(appId))
      record.web.thread.post({ type: 'permit', capability, approval, status })
    }
    this.#host.listed()
  }
}
