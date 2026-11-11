import type { ApprovalCapability, PermissionAnsweredEvent, PermissionPrompt, PermissionPromptEvent } from '@dopame/acde-api'

export interface NativeApproval {
  show(title: string, message: string): Promise<boolean | null>
  dismiss(): void
}

export interface PromptAnswers {
  pending(): PermissionPrompt[]
  answer(id: number, allow: boolean): void
}

export class ApprovalDialogs {
  static readonly #WHAT: Partial<Record<ApprovalCapability, string>> = {
    camera: 'It can use the camera.',
    microphone: 'It can use the microphone.',
  }
  readonly #answers: PromptAnswers
  readonly #native: () => NativeApproval | null
  readonly #queue: PermissionPrompt[] = []
  #showing: number | null = null

  constructor(answers: PromptAnswers, native: () => NativeApproval | null) {
    this.#answers = answers
    this.#native = native
  }

  static text(prompt: PermissionPrompt): { title: string; message: string } {
    const { label, capability } = prompt
    const what = ApprovalDialogs.#WHAT[capability] ?? ''
    return { title: `${label}: allow "${capability}"?`, message: `${label} asks to use "${capability}". ${what}\n\nAllow it?` }
  }

  event(event: PermissionPromptEvent | PermissionAnsweredEvent): void {
    if (event.type === 'permissionprompt') {
      const { type: _, ...prompt } = event
      this.#queue.push(prompt)
      return this.#next()
    }
    const queued = this.#queue.findIndex((prompt) => prompt.id === event.id)
    if (queued >= 0) this.#queue.splice(queued, 1)
    if (this.#showing === event.id) this.#native()?.dismiss()
  }

  #next(): void {
    if (this.#showing !== null) return
    const prompt = this.#queue.shift()
    if (!prompt) return
    const native = this.#native()
    if (!native) return void (this.#queue.length = 0)
    this.#showing = prompt.id
    const { title, message } = ApprovalDialogs.text(prompt)
    const done = (allowed: boolean | null) => {
      this.#showing = null
      if (allowed !== null && this.#answers.pending().some((waiting) => waiting.id === prompt.id)) this.#answers.answer(prompt.id, allowed)
      this.#next()
    }
    native.show(title, message).then(done, () => done(null))
  }
}
