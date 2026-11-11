import type { Acde, PermissionDecision, PermissionPrompt, Permissions } from './driver/acde.ts'
import { Format } from './driver/format.ts'

export interface Wanted {
  readonly prompt?: number
  readonly app?: string
  readonly capability?: string
  readonly all?: boolean
}

export class Approvals {
  static pick(permissions: Permissions, wanted: Wanted, naming: string): PermissionPrompt[] {
    const { pending, decisions } = permissions
    if (wanted.prompt !== undefined) {
      const named = pending.find((prompt) => prompt.id === wanted.prompt)
      if (named) return [named]
      throw new Error(`no approval prompt ${wanted.prompt} is waiting${Approvals.#others(pending)}`)
    }
    if (wanted.app !== undefined || wanted.capability !== undefined) {
      if (wanted.app === undefined || wanted.capability === undefined)
        throw new Error('an approval prompt is named by its id, or by its app and its capability together')
      const { app, capability } = wanted
      const named = pending.find((prompt) => prompt.app === app && prompt.capability === capability)
      if (named) return [named]
      const decided = decisions.find((decision) => decision.app === app && decision.capability === capability)
      const why = decided ? `: it is already ${decided.decision} (revoke takes that back)` : Approvals.#others(pending)
      throw new Error(`no approval prompt of ${app} for ${capability} is waiting${why}`)
    }
    if (pending.length === 0) throw new Error('no approval prompt is waiting')
    if (wanted.all || pending.length === 1) return [...pending]
    const listed = pending.map((prompt) => `  ${Format.prompt(prompt)}`).join('\n')
    throw new Error(`${pending.length} approval prompts wait; ${naming}:\n${listed}`)
  }

  static async answer(acde: Acde, wanted: Wanted, allow: boolean, naming: string): Promise<string> {
    const lines: string[] = []
    for (const prompt of Approvals.pick(await acde.permissions(), wanted, naming)) {
      await acde.answer(prompt, allow)
      lines.push(Format.answered(prompt, allow))
    }
    return lines.join('\n')
  }

  static async revoke(acde: Acde, app: string, capability: string): Promise<string> {
    if (await acde.revoke(app, capability as PermissionDecision['capability'])) return `revoked ${app} ${capability}`
    throw new Error(`no decision about ${app} ${capability} to revoke (permissions lists the decisions)`)
  }

  static async waiting(acde: Acde, how: string): Promise<string[]> {
    return (await acde.permissions()).pending.map((prompt) => Format.waiting(prompt, how))
  }

  static #others(pending: readonly PermissionPrompt[]): string {
    return pending.length ? ` (waiting: ${pending.map((prompt) => prompt.id).join(', ')})` : ''
  }
}
