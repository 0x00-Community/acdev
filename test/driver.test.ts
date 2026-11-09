import { afterAll, describe, expect as check, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InspectMatch, InspectNode } from '@dopame/acde-api'
import { Acde, ActError, AssertionError, expect, Locator, type Query, type Source } from '../src/driver/index.ts'
import { Sessions } from '../src/sessions.ts'
import { cleanup, standIn } from './helpers.ts'

afterAll(cleanup)

describe('Locator.match', () => {
  const node = (ref: string, role: string, name?: string, children?: InspectNode[], states?: string[]): InspectNode => ({ ref, role, ...(name !== undefined && { name }), ...(children && { children }), ...(states && { states }) })
  const tree = [
    node('w1.1', 'list', 'Tasks', [node('w1.2', 'listitem', 'Buy milk', [node('w1.3', 'text', 'Buy milk'), node('w1.4', 'checkbox', 'Done', undefined, ['checked'])]), node('w1.5', 'listitem', 'Walk the dog', [node('w1.6', 'text', 'Walk the dog'), node('w1.7', 'checkbox', 'Done')])]),
    node('w1.8', 'button', 'Save'),
    node('w1.9', 'button', 'Save as…'),
  ]
  const card: InspectMatch = { ref: 'w1.20', role: 'generic', name: 'Card', tag: 'div', visible: true }
  const queried: string[] = []
  const source: Source = {
    nodes: tree,
    children: async (n) => ('tag' in n ? [node('w1.21', 'button', 'Inside the card')] : (n.children ?? [])),
    query: async (selector, within) => {
      queried.push(`${selector}${within ? ` in ${within.ref}` : ''}`)
      if (selector === '.card') return [card]
      if (selector === 'input' && within) return within.ref === 'w1.2' ? [{ ...node('w1.4', 'checkbox', 'Done', undefined, ['checked']), tag: 'input', visible: true }] : []
      return []
    },
  }
  const refs = async (queries: readonly Query[]) => (await Locator.match(source, queries)).map((n) => n.ref)

  test('role and name: a substring ignoring case, exact, a RegExp; states and nesting', async () => {
    check(await refs([{ kind: 'role', role: 'button', options: { name: 'save' } }])).toEqual(['w1.8', 'w1.9'])
    check(await refs([{ kind: 'role', role: 'button', options: { name: 'Save', exact: true } }])).toEqual(['w1.8'])
    check(await refs([{ kind: 'role', role: 'button', options: { name: /as/ } }])).toEqual(['w1.9'])
    check(await refs([{ kind: 'role', role: 'checkbox', options: { checked: true } }])).toEqual(['w1.4'])
    check(await refs([{ kind: 'role', role: 'checkbox', options: { checked: false } }])).toEqual(['w1.7'])
  })

  test('text matches the innermost element; chaining looks under the matches; filter and nth pick among them', async () => {
    check(await refs([{ kind: 'text', text: 'Buy milk', options: {} }])).toEqual(['w1.3'])
    check(await refs([{ kind: 'role', role: 'listitem', options: {} }, { kind: 'role', role: 'checkbox', options: {} }])).toEqual(['w1.4', 'w1.7'])
    check(await refs([{ kind: 'role', role: 'listitem', options: {} }, { kind: 'filter', options: { hasText: 'dog' } }, { kind: 'role', role: 'checkbox', options: {} }])).toEqual(['w1.7'])
    check(await refs([{ kind: 'role', role: 'listitem', options: {} }, { kind: 'filter', options: { hasNotText: 'dog' } }])).toEqual(['w1.2'])
    check(await refs([{ kind: 'role', role: 'listitem', options: {} }, { kind: 'nth', index: -1 }])).toEqual(['w1.5'])
    check(await refs([{ kind: 'role', role: 'listitem', options: {} }, { kind: 'nth', index: 5 }])).toEqual([])
    check(await refs([{ kind: 'role', role: 'list', options: {} }, { kind: 'role', role: 'listitem', options: {} }])).toEqual(['w1.2', 'w1.5'])
  })

  test('text: the name, or for a nameless container the names under it', async () => {
    const status = node('w1.30', 'status', undefined, [node('w1.31', 'text', 'Saved'), node('w1.32', 'generic', undefined, [node('w1.33', 'text', 'just now')])])
    check(await Locator.text(source, status)).toBe('Saved just now')
    check(await Locator.text(source, tree[0]!)).toBe('Tasks')
    check(await Locator.text(source, card)).toBe('Card')
    check(await Locator.text(source, { ref: 'w1.40', role: 'generic', tag: 'div', visible: true } as InspectMatch)).toBe('Inside the card')
  })

  test('CSS: asked of acdert in the window or under each match; what it finds is searched by role through its own subtree', async () => {
    queried.length = 0
    check(await refs([{ kind: 'css', selector: '.card' }])).toEqual(['w1.20'])
    check(await refs([{ kind: 'css', selector: '.card' }, { kind: 'role', role: 'button', options: {} }])).toEqual(['w1.21'])
    check(await refs([{ kind: 'css', selector: '.card' }, { kind: 'filter', options: { hasText: 'inside' } }])).toEqual(['w1.20'])
    check(await refs([{ kind: 'role', role: 'listitem', options: {} }, { kind: 'css', selector: 'input' }])).toEqual(['w1.4'])
    check(queried).toEqual(['.card', '.card', '.card', 'input in w1.2', 'input in w1.5'])
    check(Locator.testId('a"b\\c')).toBe('[data-testid="a\\"b\\\\c"]')
  })
})

describe('the driver against acde dev with a stand-in acdert', () => {
  test('launch, find by role and text, act, wait for what comes later, assert, open, logs, close', async () => {
    const s = standIn()
    const acde = await Acde.launch({ cwd: s.project, env: s.env, timeout: 2_000 })
    try {
      check(acde.session.apps).toEqual(['alpha'])
      check((await acde.webs()).map((w) => w.name)).toEqual(['desktop', 'alpha#7'])

      const attached = await Acde.attach({ cwd: s.project, env: s.env })
      check((await attached.webs()).length).toBe(2)
      await attached.close()

      const alpha = acde.window('alpha')
      await expect(alpha).toHaveTitle('Alpha')
      check(await alpha.web()).toBe('alpha#7')
      const add = alpha.getByRole('button', { name: 'Add' })
      await expect(add).toBeDisabled()
      const field = alpha.getByRole('textbox', { name: 'New task' })
      await field.fill('Buy')
      await field.type(' milk')
      await expect(field).toHaveValue('Buy milk')
      await expect(add).toBeEnabled()
      const done = await add.click()
      check(done.ok).toBe(true)
      check(done.text).toBe('click w1.3 null')

      await expect(alpha.getByText('Buy milk')).toBeVisible()
      await expect(alpha.getByRole('listitem')).toHaveCount(1)
      await expect(alpha.getByText(/tasks$/)).toHaveText('1 tasks')
      await field.fill('Walk the dog')
      await add.click()
      await expect(alpha.getByRole('listitem')).toHaveCount(2)

      const strict = await alpha.getByRole('checkbox').click({ timeout: 300 }).catch((e: Error) => e)
      check(strict).toBeInstanceOf(Error)
      check((strict as Error).message).toContain('2 elements match')
      check((strict as Error).message).toContain('checkbox "Done: Buy milk" [w1.12]')

      const dog = alpha.getByRole('listitem').filter({ hasText: 'dog' }).getByRole('checkbox')
      await dog.click()
      await expect(dog).toBeChecked()
      await expect(alpha.getByRole('listitem').first().getByRole('checkbox')).not.toBeChecked()
      check(await alpha.getByRole('listitem').nth(1).name()).toBe('Walk the dog')
      check((await alpha.getByRole('listitem').all()).length).toBe(2)

      const missing = await expect(alpha.getByText('Nothing here')).toBeVisible({ timeout: 200 }).catch((e: Error) => e)
      check(missing).toBeInstanceOf(AssertionError)
      check((missing as Error).message).toBe('expected window(app "alpha").getByText("Nothing here") to be visible within 200 ms; saw no element')
      await expect(alpha.getByText('Nothing here')).toBeHidden()
      const ghost = await acde.window('ghost').getByRole('button').click({ timeout: 200 }).catch((e: Error) => e.message)
      check(ghost).toBe('window(app "ghost").getByRole("button"): window(app "ghost") is not open (waited 200 ms)')

      const beta = await acde.open('beta')
      await expect(beta).toHaveTitle('Beta')
      check((await beta.info()).id).toBe(8)
      check(await beta.snapshot()).toBe('snapshot {"window":"w2","find":null,"all":false}')
      check(await acde.open('nope').catch((e: Error) => e)).toBeInstanceOf(ActError)
      check(await beta.evaluate('document.title')).toEqual({ web: 'beta#8', code: 'document.title' })
      const shot = await beta.screenshot({ path: join(s.root, 'beta.png') })
      check(shot.png.subarray(1, 4).toString()).toBe('PNG')
      check(readFileSync(join(s.root, 'beta.png')).equals(shot.png)).toBe(true)
      await beta.close()
      await expect(beta).not.toBeOpen()

      const added = await alpha.getByTestId('add').count()
      check(added).toBe(1)
      await expect(alpha.locator('li')).toHaveCount(2)
      await expect(alpha.locator('li').filter({ hasText: 'dog' }).locator('input[type=checkbox]')).toBeChecked()
      await expect(alpha.locator('.ghost')).toBeHidden()

      const logged = await alpha.console()
      check(logged.entries.map((e) => e.text)).toEqual(['alpha ready', 'added Buy milk', 'added Walk the dog'])
      check((await acde.console({ level: 'info', since: 3 })).entries.map((e) => e.text)).toEqual(['added Walk the dog'])
      check((await alpha.network()).entries.map((e) => `${e.method} ${e.status} ${e.url}`)).toEqual(['POST 201 http://acde.local/api/tasks', 'POST 201 http://acde.local/api/tasks'])
      check((await acde.network({ failed: true })).entries).toEqual([])
      const screen = await acde.screen()
      check([screen.png.subarray(1, 4).toString(), screen.width, screen.path]).toEqual(['PNG', 1, null])
      check((await acde.screen({ path: join(s.root, 'screen.png') })).path).toBe(join(s.root, 'screen.png'))
      await acde.chooseFolder(s.root)
      await acde.chooseFolder(null)
      check(await acde.chooseFolder('relative').then(() => 'resolved')).toBe('resolved')
      await acde.chooseFiles([join(s.root, 'a.txt'), 'relative.txt'])
      await acde.chooseFiles('one.txt')
      await acde.chooseFiles(null)
      check(await acde.chooseFiles([]).then(() => 'resolved', (e: Error) => e.message)).toContain('choose: open')
      await acde.chooseSaveFile('out.txt')
      await acde.chooseSaveFile(null)
      check(await acde.emulate({ colorScheme: 'dark', reducedMotion: true })).toEqual({ colorScheme: 'dark', emulated: true, reducedMotion: true })

      check(acde.logs!.tail(100).text).toContain('[alpha#7] js: fake acdert is up')
      check(acde.logs!.tail(100, { grep: /^acde: dev app alpha/ }).lines.length).toBe(1)
      const next = acde.logs!.next
      check(acde.logs!.since(next).lines).toEqual([])
    } finally {
      await acde.close()
    }
    const sessions = join(s.root, 'acde-dev')
    check(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([])
    const replacement = Sessions.write({ ...acde.session, started: acde.session.started + 1 }, sessions)
    await acde.close()
    check(existsSync(replacement)).toBe(true)
    check(Sessions.list(sessions)).toEqual([])
  }, 60_000)

  test('headless: acde dev --headless runs acdert with ACDE_HEADLESS=1 and says so in its session', async () => {
    const s = standIn()
    const acde = await Acde.launch({ cwd: s.project, env: s.env, headless: true })
    try {
      check(acde.session.headless).toBe(true)
      check(Sessions.describe(acde.session)).toContain('app alpha (headless)')
      const started = readFileSync(s.env['FAKE_ACDERT_LOG']!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { headless?: string | null })[0]!
      check(started.headless).toBe('1')
    } finally {
      await acde.close()
    }
  }, 30_000)

  test('a launch that fails says why, with the output of acde dev', async () => {
    const s = standIn()
    writeFileSync(join(s.project, 'acde.config.jsonc'), '{ "type": "app" ')
    const error = await Acde.launch({ cwd: s.project, env: s.env }).catch((e: Error) => e)
    check(error).toBeInstanceOf(Error)
    check((error as Error).message).toMatch(/^acde dev exited \(1\) before it was ready:\n/)
  }, 30_000)
})
