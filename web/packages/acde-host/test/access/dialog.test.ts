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

test('a camera use is asked in a native dialog and its answer is stored like a desktop answer', async () => {
  const { permissions, shown, files } = open()
  const tool = app('tool', { camera: true })
  const asked = permissions.ask(tool, third, 'camera', 'request')
  await settle()
  assert.equal(shown.length, 1)
  assert.match(shown[0]!.title, /Tool/)
  assert.match(shown[0]!.message, /asks to use "camera"/)
  shown[0]!.answer(true)
  assert.equal(await asked, true)
  assert.deepEqual(files.get('p'), { 'tool:camera': 'granted' })
  assert.deepEqual(permissions.list('tool').map((row) => row.decision), ['granted'])
})

test('no in the dialog is stored as a denial', async () => {
  const { permissions, shown, files } = open()
  const tool = app('tool', { camera: true })
  const asked = permissions.ask(tool, third, 'camera', 'request')
  await settle()
  shown[0]!.answer(false)
  assert.equal(await asked, false)
  assert.deepEqual(files.get('p'), { 'tool:camera': 'denied' })
  assert.equal(permissions.permit(tool, third, 'camera'), 'denied')
})

test('one dialog at a time; the next prompt shows after the first is answered', async () => {
  const { permissions, shown } = open()
  const one = permissions.ask(app('tool', { camera: true }), third, 'camera', 'request')
  const two = permissions.ask(app('other', { microphone: true }), third, 'microphone', 'request')
  await settle()
  assert.equal(shown.length, 1)
  shown[0]!.answer(false)
  await settle()
  assert.equal(shown.length, 2)
  assert.match(shown[1]!.message, /"microphone"/)
  shown[1]!.answer(true)
  assert.deepEqual(await Promise.all([one, two]), [false, true])
})

test('an answer from elsewhere closes the open dialog and drops queued ones', async () => {
  const { permissions, shown, dismissed } = open()
  const one = permissions.ask(app('tool', { camera: true }), third, 'camera', 'request')
  const two = permissions.ask(app('other', { microphone: true }), third, 'microphone', 'request')
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
    const asked = permissions.ask(app('tool', { camera: true }), third, 'camera', 'request')
    await settle()
    assert.equal(shown.length, 0)
    assert.equal(permissions.pending().length, 1)
    permissions.answer(permissions.pending()[0]!.id, true)
    assert.equal(await asked, true)
  }
})
