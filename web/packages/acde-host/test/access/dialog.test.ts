import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PermissionAnsweredEvent, PermissionPromptEvent } from '@dopame/acde-api'
import type { AppManifest } from '../../src/apps.ts'
import { ApprovalDialogs } from '../../src/broker/access/approval/dialog.ts'
import { Permissions } from '../../src/broker/access/approval/permissions.ts'

const third = { level: 1, system: false }
const app = (id: string, capabilities: Record<string, unknown>, optional: string[] = []) => {
  const label = id === 'tool' ? 'Tool' : 'Other'
  return { id, label, icon: 'app', entry: '/t/index.html', capabilities, optional, services: [], requests: [] } as unknown as AppManifest
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const open = (native: boolean | 'none' = true) => {
  const shown: { title: string; message: string; answer: (allowed: boolean | null) => void }[] = []
  let dismissed = 0
  let dialogs: ApprovalDialogs | null = null
  const files = new Map<string, Record<string, string>>()
  const permissions: Permissions = new Permissions({
    store: { read: () => files.get('p') ?? null, changed: (e) => void files.set('p', e), flush: () => {} },
    label: () => null,
    supported: () => true,
    tell: (event: PermissionPromptEvent | PermissionAnsweredEvent) => dialogs?.event(event),
    changed: () => {},
    log: () => {},
  })
  dialogs = new ApprovalDialogs(permissions, () =>
    native === false
      ? null
      : {
          show: (title, message) =>
            native === 'none' ? Promise.resolve(null) : new Promise<boolean | null>((answer) => void shown.push({ title, message, answer })),
          dismiss: () => {
            dismissed++
            shown.at(-1)?.answer(null)
          },
        },
  )
  return { permissions, shown, dismissed: () => dismissed, files }
}

test('a required capability is asked in a native dialog and its answer is stored like a desktop answer', async () => {
  const { permissions, shown, files } = open()
  const tool = app('tool', { launch: true })
  const admitted = permissions.admit(tool, third)
  await settle()
  assert.equal(shown.length, 1)
  assert.match(shown[0]!.title, /Tool/)
  assert.match(shown[0]!.message, /"launch"/)
  assert.match(shown[0]!.message, /does not start/)
  shown[0]!.answer(true)
  await admitted
  assert.deepEqual(files.get('p'), { 'tool:launch': 'granted' })
  assert.deepEqual(permissions.list('tool').map((row) => row.decision), ['granted'])
})

test('no in the dialog keeps the app from starting', async () => {
  const { permissions, shown } = open()
  const admitted = permissions.admit(app('tool', { launch: true }), third)
  await settle()
  shown[0]!.answer(false)
  await assert.rejects(admitted, (e: Error & { code?: string }) => e.code === 'denied')
})

test('an optional request is asked in the dialog with its own wording', async () => {
  const { permissions, shown } = open()
  const asked = permissions.ask(app('tool', { launch: true }, ['launch']), third, 'launch', 'request')
  await settle()
  assert.match(shown[0]!.message, /asks to use "launch"/)
  assert.doesNotMatch(shown[0]!.message, /does not start/)
  shown[0]!.answer(true)
  assert.equal(await asked, true)
})

test('one dialog at a time; the next prompt shows after the first is answered', async () => {
  const { permissions, shown } = open()
  const one = permissions.ask(app('tool', { launch: true }), third, 'launch', 'request')
  const two = permissions.ask(app('other', { slots: true }), third, 'slots', 'request')
  await settle()
  assert.equal(shown.length, 1)
  shown[0]!.answer(false)
  await settle()
  assert.equal(shown.length, 2)
  assert.match(shown[1]!.message, /"slots"/)
  shown[1]!.answer(true)
  assert.deepEqual(await Promise.all([one, two]), [false, true])
})

test('an answer from elsewhere closes the open dialog and drops queued ones', async () => {
  const { permissions, shown, dismissed } = open()
  const one = permissions.ask(app('tool', { launch: true }), third, 'launch', 'request')
  const two = permissions.ask(app('other', { slots: true }), third, 'slots', 'request')
  await settle()
  permissions.answer(2, true)
  await settle()
  assert.equal(dismissed(), 0, 'the queued prompt was not on screen')
  permissions.answer(1, false)
  await settle()
  assert.equal(dismissed(), 1)
  assert.equal(shown.length, 1)
  assert.deepEqual(await Promise.all([one, two]), [false, true])
})

test('without a native dialog the prompt keeps waiting for another answer', async () => {
  for (const native of [false, 'none'] as const) {
    const { permissions, shown } = open(native)
    const asked = permissions.ask(app('tool', { launch: true }), third, 'launch', 'request')
    await settle()
    assert.equal(shown.length, 0)
    assert.equal(permissions.pending().length, 1)
    permissions.answer(permissions.pending()[0]!.id, true)
    assert.equal(await asked, true)
  }
})
