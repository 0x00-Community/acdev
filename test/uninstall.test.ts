import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Uninstall } from '../src/uninstall.ts'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

function machine() {
  const home = tmp()
  const env = { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }
  const packages = join(home, 'data', 'acde', 'packages')
  const pkg = join(packages, 'notes')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'notes', acde: { apps: [{ id: 'notes' }] } }))
  const data = [
    join(home, 'data', 'acde', 'storage', 'app-notes'),
    join(home, 'data', 'acde', 'apps', 'notes'),
  ]
  for (const dir of data) mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, 'config', 'acde', 'storage'), { recursive: true })
  const legacy = join(home, 'config', 'acde', 'storage', 'app-notes.json')
  writeFileSync(legacy, '{}')
  mkdirSync(join(home, 'data', 'acde', 'storage', 'app-other'), { recursive: true })
  return { env, packages, pkg, data: [...data, legacy], other: join(home, 'data', 'acde', 'storage', 'app-other') }
}

describe('acde uninstall and the apps\' data', () => {
  test('--data removes the package and its apps\' storage, backend data and legacy storage, nothing else', async () => {
    const m = machine()
    const said: string[] = []
    const code = await Uninstall.run('notes', {
      yes: true, confirm: null, say: (line) => said.push(line), dir: m.packages, sessions: [], data: true, env: m.env,
    })
    expect(code).toBe(0)
    expect(existsSync(m.pkg)).toBe(false)
    for (const path of m.data) expect(existsSync(path), path).toBe(false)
    expect(existsSync(m.other)).toBe(true)
    for (const path of m.data) expect(said).toContain(`acde: removed its data ${path}`)
  })

  test('without --data, --yes keeps the data and says where it is; asked, the answer decides', async () => {
    const kept = machine()
    const said: string[] = []
    await Uninstall.run('notes', {
      yes: true, confirm: null, say: (line) => said.push(line), dir: kept.packages, sessions: [], env: kept.env,
    })
    expect(existsSync(kept.pkg)).toBe(false)
    for (const path of kept.data) expect(existsSync(path), path).toBe(true)
    expect(said.at(-1)).toBe(`acde: kept its data (delete it by hand; --data removes it while uninstalling): ${
      kept.data.join(', ')}`)

    const asked = machine()
    const questions: string[] = []
    const confirm = async (question: string) => (questions.push(question), true)
    await Uninstall.run('notes', {
      yes: false, confirm, say: () => undefined, dir: asked.packages, sessions: [], env: asked.env,
    })
    expect(questions).toEqual(['Remove notes?', `Also remove the data of notes (${asked.data.join(', ')})?`])
    for (const path of asked.data) expect(existsSync(path), path).toBe(false)

    const keep = machine()
    await Uninstall.run('notes', {
      yes: false, confirm, say: () => undefined, dir: keep.packages, sessions: [], data: false, env: keep.env,
    })
    for (const path of keep.data) expect(existsSync(path), path).toBe(true)
  })

  test('ACDE_STORAGE moves the storage; empty, there is none and no legacy file', () => {
    const m = machine()
    const entry = Uninstall.find('notes', m.packages)!
    const moved = join(m.env.HOME, 'elsewhere')
    mkdirSync(join(moved, 'app-notes'), { recursive: true })
    expect(Uninstall.data(entry, { ...m.env, ACDE_STORAGE: moved }))
      .toEqual([join(moved, 'app-notes'), join(m.env.XDG_DATA_HOME, 'acde', 'apps', 'notes')])
    expect(Uninstall.data(entry, { ...m.env, ACDE_STORAGE: '' }))
      .toEqual([join(m.env.XDG_DATA_HOME, 'acde', 'apps', 'notes')])
  })
})
