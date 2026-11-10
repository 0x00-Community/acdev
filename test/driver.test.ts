import { afterAll, describe, expect as check, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InspectMatch, InspectNode } from '@dopame/acde-api'
import { Acde, ActError, AssertionError, expect, LaunchError, Locator, Png, Screenshots, type Query, type Source } from '../src/driver/index.ts'
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
    query: async (selector, within, attributes) => {
      queried.push(`${selector}${within ? ` in ${within.ref}` : ''}`)
      if (selector === '.card') return [card]
      if (selector === '[placeholder]' && attributes?.[0] === 'placeholder') return [{ ...node('w1.50', 'textbox', 'Search'), tag: 'input', visible: true, attributes: { placeholder: 'Find a task' } }, { ...node('w1.51', 'textbox', 'Note'), tag: 'textarea', visible: true, attributes: { placeholder: 'Write a note' } }]
      if (selector.startsWith('img[alt]') && attributes?.[0] === 'alt') return [{ ...node('w1.52', 'img', 'Logo'), tag: 'img', visible: true, attributes: { alt: 'Company logo' } }]
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

  test('text content: the text under an element, not its accessible name (as Playwright\'s toHaveText)', async () => {
    const display = node('w1.6', 'generic', 'Display', [node('w1.7', 'text', '18')])
    check(await Locator.content(source, display)).toBe('18')
    check(await Locator.text(source, display)).toBe('Display')
    check(await Locator.content(source, node('w1.8', 'button', 'Save'))).toBe('Save')
    check(await Locator.content(source, tree[0]!)).toBe('Buy milk Done Walk the dog Done')
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

  test('label: form fields by their accessible name only; placeholder, title and alt by the attribute acdert reads back', async () => {
    const fields = { ...source, nodes: [...tree, node('w1.60', 'textbox', 'Email'), node('w1.61', 'heading', 'Email'), node('w1.62', 'checkbox', 'Remember me')] }
    const pick = async (queries: readonly Query[]) => (await Locator.match(fields, queries)).map((n) => n.ref)
    check(await pick([{ kind: 'label', text: 'email', options: {} }])).toEqual(['w1.60'])
    check(await pick([{ kind: 'label', text: /remember/i, options: {} }])).toEqual(['w1.62'])
    check(await pick([{ kind: 'label', text: 'Done', options: { exact: true } }])).toEqual(['w1.4', 'w1.7'])
    check(await pick([{ kind: 'attr', name: 'placeholder', text: 'task', options: {} }])).toEqual(['w1.50'])
    check(await pick([{ kind: 'attr', name: 'placeholder', text: /^write/i, options: {} }])).toEqual(['w1.51'])
    check(await pick([{ kind: 'attr', name: 'placeholder', text: 'Find', options: { exact: true } }])).toEqual([])
    check(await pick([{ kind: 'attr', name: 'alt', text: 'logo', options: {} }])).toEqual(['w1.52'])
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

      check(acde.trace.text()).toContain('window(app "alpha").getByRole("textbox", { name: "New task" }).fill("Buy")')
      check(acde.trace.steps.find((step) => step.title.startsWith('expect window(app "alpha").getByText("Nothing here") to be visible'))?.ok).toBe(false)
      check(acde.trace.steps.find((step) => step.title === 'open("beta")')?.ok).toBe(true)
      check(acde.trace.steps.filter((step) => step.title.startsWith('act(')).length).toBe(0)

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

  test('closing the only window of a single-app session ends it, and close says so; ' +
    'any other loss of the connection is an error', async () => {
    const s = standIn()
    const launch = (extra: Record<string, string> = {}, desktop?: string) =>
      Acde.launch({ cwd: s.project, env: { ...s.env, ...extra }, timeout: 2_000, ...(desktop && { desktop }) })
    const said = (acde: Acde) => `closed w1; acdert exited with it, so acde dev ${acde.session.pid} ended`
    const message = (error: Error) => error.message

    const single = await launch()
    try {
      check(await single.window('alpha').close()).toEqual({ ok: true, text: said(single), ended: true })
      check(single.closed).toBe(true)
      const gone = `acde dev ${single.session.pid} is no longer connected`
      check(await single.webs().catch(message)).toBe(gone)
      check(await single.act('w1', 'close').catch(message)).toBe(gone)
      check(single.trace.text()).toContain(said(single))
    } finally {
      await single.close()
    }

    const answering = await launch({ FAKE_ACDERT_CLOSE: 'answers' })
    try {
      check(await answering.window('alpha').close()).toEqual({ ok: true, text: said(answering), ended: true })
    } finally {
      await answering.close()
    }

    const crashing = await launch({ FAKE_ACDERT_DIES_ON: 'focus' })
    try {
      check(await crashing.window('alpha').focus().catch(message)).toBe('acdert closed the connection')
      check(crashing.closed).toBe(true)
    } finally {
      await crashing.close()
    }

    const desktop = await launch({ FAKE_ACDERT_DIES_ON: 'close' }, 'dopame')
    try {
      check(desktop.session.desktop).toBe('dopame')
      check(await desktop.window('alpha').close().catch(message)).toBe('acdert closed the connection')
    } finally {
      await desktop.close()
    }

    const kept = await launch({}, 'dopame')
    try {
      const closed = await kept.window('alpha').close()
      check([closed.ok, closed.text, closed.ended]).toEqual([true, 'close w1 null', undefined])
      check(kept.closed).toBe(false)
      check(await kept.window('alpha').isOpen()).toBe(false)
    } finally {
      await kept.close()
    }
  }, 60_000)

  test('approval prompts: wait, allow, deny, list; revoke; simulated drops', async () => {
    const s = standIn()
    const acde = await Acde.launch({ cwd: s.project, env: s.env, timeout: 2_000 })
    try {
      check((await acde.permissions()).pending.map((p) => p.id)).toEqual([1, 2])
      check((await acde.waitForPrompt({ capability: 'fs.documents' })).app).toBe('beta')
      const missing = await acde.waitForPrompt({ app: 'gamma', timeout: 300 }).catch((e: Error) => e.message)
      check(missing).toBe('waitForPrompt: no approval prompt for app gamma within 300 ms')
      check(await acde.allow({ app: 'alpha' })).toMatchObject({ id: 1, capability: 'launch' })
      await acde.answer(2, false)
      const after = await acde.permissions()
      check(after.pending).toEqual([])
      check(after.decisions.map((d) => `${d.app} ${d.capability} ${d.decision}`))
        .toEqual(['alpha launch granted', 'beta fs.documents denied'])
      const none = await acde.deny({ timeout: 200 }).catch((e: Error) => e.message)
      check(none).toContain('no approval prompt within 200 ms')
      check(await acde.revoke('alpha', 'launch')).toBe(true)
      check(await acde.revoke('alpha', 'launch')).toBe(false)
      check((await acde.permissions()).decisions.map((d) => d.app)).toEqual(['beta'])

      check(await acde.drop([join(s.root, 'a.txt'), 'b.txt'])).toEqual({
        web: 'desktop', window: 0, files: [join(s.root, 'a.txt'), join(process.cwd(), 'b.txt')],
      })
      check(await acde.window('alpha').drop('c.png', { x: 3, y: 4 })).toMatchObject({ web: 'alpha#7', window: 7 })
      check(await acde.drop([]).catch((e: Error) => e.message)).toBe('drop: give at least one file')
      check(await acde.drop('d.txt', { x: 1 }).catch((e: Error) => e.message)).toBe('drop: give x and y together')
      check(acde.trace.text()).toContain('allow(for app alpha)')
      check(acde.trace.text()).toContain('drop(')
    } finally {
      await acde.close()
    }
    const sent = readFileSync(join(s.root, 'fake.log'), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { got?: Record<string, unknown> }).flatMap((e) => (e.got ? [e.got] : []))
    check(sent.find((m) => m['op'] === 'answer' && m['prompt'] === 1)).toMatchObject({ allow: true })
    check(sent.find((m) => m['op'] === 'revoke')).toMatchObject({ app: 'alpha', capability: 'launch' })
    check(sent.some((m) => m['op'] === 'eval')).toBe(false)
    check(sent.find((m) => m['op'] === 'drop' && m['web'] === 'alpha#7'))
      .toMatchObject({ x: 3, y: 4, files: [join(process.cwd(), 'c.png')] })
  }, 60_000)

  test('select, check, drag, label / placeholder / title locators, attributes, routes and waits, clipboard, element pictures and screenshot baselines', async () => {
    const s = standIn()
    const acde = await Acde.launch({ cwd: s.project, env: s.env, timeout: 2_000 })
    try {
      const alpha = acde.window('alpha')
      const priority = alpha.getByLabel('Priority')
      await expect(priority).toHaveValue('low')
      check((await priority.selectOption('high')).text).toBe('selected ["high"]')
      await expect(priority).toHaveValue('high')
      const wrong = await priority.selectOption(['low', 'high'], { timeout: 300 }).catch((e: Error) => e)
      check(wrong).toBeInstanceOf(ActError)
      check((wrong as Error).message).toContain('no option ["low","high"]')

      const field = alpha.getByPlaceholder('needs doing')
      await expect(field).toHaveAttribute('placeholder', 'What needs doing?')
      await expect(field).toHaveAttribute('placeholder')
      await expect(alpha.getByTitle('Add a task')).toHaveText('Add')
      await expect(alpha.getByLabel('New task')).toHaveAttribute('placeholder', /doing/)
      const noTitle = await expect(field).toHaveAttribute('title', undefined, { timeout: 200 }).catch((e: Error) => e.message)
      check(noTitle).toBe('expected window(app "alpha").getByPlaceholder("needs doing") to have attribute title within 200 ms; saw no title')

      const id = await acde.route('/api/tasks', { status: 202, json: { ok: true } }, { times: 1 })
      check(id).toBe(1)
      const posted = acde.waitForRequest('/api/tasks', { method: 'post' })
      const logged = acde.waitForConsole(/^added Buy/)
      await field.fill('Buy milk')
      await alpha.getByRole('button', { name: 'Add' }).click()
      const request = await posted
      check([request.status, request.mocked]).toEqual([202, true])
      check((await logged).text).toBe('added Buy milk')
      check(await acde.waitForRequest('**/nowhere', { timeout: 200 }).catch((e: Error) => e.message)).toBe('waitForRequest: no request to "**/nowhere" within 200 ms')
      await field.fill('Walk the dog')
      await alpha.getByRole('button', { name: 'Add' }).click()
      await expect(alpha.getByRole('listitem')).toHaveCount(2)
      check((await alpha.network()).entries.map((e) => `${e.status}${e.mocked ? ' mocked' : ''}`)).toEqual(['202 mocked', '201'])
      check(await acde.unroute()).toEqual({ removed: 1, left: 0 })
      check(Acde.urlMatcher('/api/*')('http://acde.local/api/tasks?x=1')).toBe(true)
      check(Acde.urlMatcher('/api/*')('http://acde.local/api/tasks/7')).toBe(false)
      check(Acde.urlMatcher('/api/tasks')('http://acde.local/api/tasks?x=1')).toBe(false)
      check(Acde.urlMatcher('https://example.com/**')('https://example.com/a/b')).toBe(true)
      check(Acde.urlMatcher(/tasks$/g)('http://acde.local/api/tasks')).toBe(true)

      const box = alpha.getByRole('checkbox', { name: 'Done: Walk the dog' })
      await box.check()
      await expect(box).toBeChecked()
      await box.check()
      await expect(box).toBeChecked()
      await box.setChecked(false)
      await expect(box).not.toBeChecked()
      await box.uncheck()
      await expect(box).not.toBeChecked()

      const items = alpha.getByRole('listitem')
      check((await items.last().dragTo(items.first())).ok).toBe(true)
      check(await items.first().name()).toBe('Walk the dog')
      const badDrag = await items.first().dragTo(alpha.getByRole('button', { name: 'Add' }), { timeout: 300 }).catch((e: Error) => e.message)
      check(badDrag).toContain('cannot drag w1.10 onto w1.3')

      await acde.setClipboard('copied text')
      check(await acde.clipboard()).toBe('copied text')

      const whole = Png.decode((await alpha.screenshot()).png)
      check([whole.width, whole.height]).toEqual([8, 6])
      check(Array.from(whole.data.subarray(0, 8))).toEqual([255, 0, 0, 255, 255, 0, 0, 255])
      const part = await alpha.getByRole('textbox', { name: 'New task' }).screenshot({ path: join(s.root, 'field.png') })
      check([part.width, part.height]).toEqual([4, 1])
      check(Png.decode(readFileSync(join(s.root, 'field.png'))).width).toBe(4)
      const masked = Png.decode((await alpha.screenshot({ mask: [alpha.getByRole('button', { name: 'Add' })] })).png)
      check(Array.from(masked.data.subarray((1 * 8 + 4) * 4, (1 * 8 + 4) * 4 + 4))).toEqual([...Screenshots.MASK])

      const baseline = join(s.root, 'shots', 'alpha.png')
      await expect(alpha).toHaveScreenshot(baseline)
      check(Png.decode(readFileSync(baseline)).width).toBe(8)
      await expect(alpha).toHaveScreenshot(baseline)
      await field.fill('Third')
      await alpha.getByRole('button', { name: 'Add' }).click()
      await expect(items).toHaveCount(3)
      const changed = await expect(alpha).toHaveScreenshot(baseline, { timeout: 500 }).catch((e: Error) => e)
      check(changed).toBeInstanceOf(AssertionError)
      check((changed as Error).message).toContain(`expected window(app "alpha") to match screenshot ${baseline}: 1 pixel differs`)
      check(readdirSync(join(s.root, 'shots')).sort()).toEqual(['alpha-actual.png', 'alpha-diff.png', 'alpha-expected.png', 'alpha.png'])
      await expect(alpha).toHaveScreenshot(baseline, { maxDiffPixels: 1 })
      await expect(alpha).toHaveScreenshot(baseline, { maxDiffPixelRatio: 0.03 })
      check(await Promise.resolve().then(() => expect(alpha).not.toHaveScreenshot(baseline)).catch((e: Error) => e.message)).toBe('toHaveScreenshot cannot be negated')
      mkdirSync(join(s.root, 'ci'))
      const missing = await expect(alpha.getByRole('button', { name: 'Add' })).toHaveScreenshot(join(s.root, 'ci', 'add'), { timeout: 300 }).catch((e: Error) => e.message)
      check(process.env['CI'] ? missing : 'skipped').toBe(process.env['CI'] ? `expected window(app "alpha").getByRole("button", { name: "Add" }) to match screenshot ${join(s.root, 'ci', 'add.png')}, but there is no such file (CI is set, so acde does not write it; run acde test --update-screenshots and commit it)` : 'skipped')
    } finally {
      await acde.close()
    }
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
    check(error).toBeInstanceOf(LaunchError)
    const exited = error as LaunchError
    check(exited.message).toMatch(/^acde dev exited \(1\) before it was ready:\n/)
    check([exited.name, exited.phase, exited.code]).toEqual(['Error', 'exited', 1])
    check(exited.message.split('\n').slice(1).join('\n')).toBe(exited.logs.tail(40).text)
    check(Object.keys(exited)).toEqual([])
  }, 30_000)

  test('a launch that stalls says in which phase, and keeps the whole output of acde dev', async () => {
    const s = standIn()
    const stalled = async (env: Record<string, string>) => {
      const error = await Acde.launch({ cwd: s.project, env: { ...s.env, ...env }, startTimeout: 5_000 })
        .catch((e: Error) => e)
      check(error).toBeInstanceOf(LaunchError)
      return error as LaunchError
    }
    const unheard = await stalled({ FAKE_ACDERT_LISTEN_MS: '600000' })
    check(unheard.phase).toBe('session')
    const lines = unheard.message.split('\n')
    check(lines[0]).toMatch(/^acde dev \(pid \d+\) did not register a session within 5 s in .+acde-dev$/)
    check(lines[1]).toBe('no session yet: its build did not finish, or acdert did not start listening; last output:')
    check(lines[2]).toStartWith('acde: dev app alpha: ')
    check(unheard.logs.tail(5000).text).toContain('[alpha#7] js: fake acdert is up')

    const windowless = await stalled({ FAKE_ACDERT_WINDOWLESS: '1' })
    check(windowless.phase).toBe('window')
    check(windowless.message.split('\n').slice(0, 3)).toEqual([
      'acde dev did not start within 5 s:',
      'acdert runs and answers, but no window appeared (pages: 0, windows: 0) and no approval prompt waits; ' +
        'last output:',
      windowless.logs.tail(5000).lines[0]!.text,
    ])
    check(readdirSync(join(s.root, 'acde-dev')).filter((name) => name.endsWith('.json'))).toEqual([])
  }, 30_000)

  test('close() leaves nothing that keeps a script alive', async () => {
    const s = standIn()
    const script = join(s.root, 'script.ts')
    const driver = join(import.meta.dir, '../src/driver/index.ts')
    writeFileSync(script, `import { Acde } from ${JSON.stringify(driver)}
const acde = await Acde.launch({ cwd: ${JSON.stringify(s.project)} })
await acde.close()
console.log('closed')
`)
    const started = Date.now()
    const child = Bun.spawn([process.execPath, script], { env: s.env, stdout: 'pipe', stderr: 'pipe' })
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()])
    check([code, out]).toEqual([0, 'closed\n'])
    check(Date.now() - started).toBeLessThan(8_000)
  }, 30_000)
})
