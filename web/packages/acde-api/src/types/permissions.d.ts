export type ApprovalCapability = 'launch' | 'slots' | 'terminal' | 'network' | 'camera' | 'microphone'

export interface PermissionPrompt {
  readonly id: number
  readonly app: string
  readonly label: string
  readonly capability: ApprovalCapability
  readonly reason: 'launch' | 'request'
}

export interface PermissionPromptEvent extends PermissionPrompt {
  readonly type: 'permissionprompt'
}

export interface PermissionAnsweredEvent {
  readonly type: 'permissionanswered'
  readonly id: number
  readonly app: string
  readonly capability: ApprovalCapability
  readonly allowed: boolean
}

export interface PermissionEventMap {
  readonly prompt: PermissionPromptEvent
  readonly answered: PermissionAnsweredEvent
}

export interface PermissionDecision {
  readonly app: string
  readonly label: string | null
  readonly capability: ApprovalCapability
  readonly decision: 'granted' | 'denied'
}

export interface AcdePermissions {
  pending(): Promise<PermissionPrompt[]>
  answer(id: number, allow: boolean): Promise<void>
  list(app?: string): Promise<PermissionDecision[]>
  revoke(app: string, capability: ApprovalCapability): Promise<boolean>
  on<K extends keyof PermissionEventMap>(type: K, handler: (event: PermissionEventMap[K]) => void): () => boolean
}

export interface AcdePermissionError extends Error {
  readonly status: 403
  readonly code: 'denied'
  readonly capability: string
}
