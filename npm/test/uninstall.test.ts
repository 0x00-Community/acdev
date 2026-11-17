import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Uninstall } from '../src/uninstall.ts'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

function machine() {
  const home = tmp()
  const env = { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') }
  const packages = join(home, 'data', 'acde', 'packages')
  const pkg = join(packages, 'notes')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'notes', acde: { apps: [{ id: 'notes' }] } }))
  const dirs = [
    join(home, 'data', 'acde', 'storage', 'app-notes'),
    join(home, 'data', 'acde', 'apps', 'notes'),
    join(home, 'data', 'acde', 'files', 'notes'),
  ]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, 'state', 'acde', 'grants'), { recursive: true })
  const grants = join(home, 'state', 'acde', 'grants', 'notes.json')
  writeFileSync(grants, '{}')
  const data = [...dirs, grants]
  const permissions = join(home, 'config', 'acde', 'permissions.json')
  const windows = join(home, 'state', 'acde', 'windows.json')
  mkdirSync(join(home, 'config', 'acde', 'storage'), { recursive: true })
  const legacy = join(home, 'config', 'acde', 'storage', 'app-notes.json')
  writeFileSync(legacy, '{}')
  writeFileSync(permissions, JSON.stringify({ 'notes:terminal': 'granted', 'notes:network': 'denied', 'other:terminal': 'granted' }))
  writeFileSync(windows, JSON.stringify({ notes: '[0,0,800,600]', other: '[10,10,400,300]' }))
  mkdirSync(join(home, 'data', 'acde', 'storage', 'app-other'), { recursive: true })
  const entries = [`${permissions} (notes:terminal, notes:network)`, `${windows} (notes)`]
  return {
    env, packages, pkg, data: [...data, legacy], entries, permissions, windows,
    other: join(home, 'data', 'acde', 'storage', 'app-other'),
  }
}

describe('acdev uninstall and the apps\' data', () => {
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
    for (const path of m.data) expect(said).toContain(`acdev: removed its data ${path}`)
    expect(JSON.parse(readFileSync(m.permissions, 'utf8'))).toEqual({ 'other:terminal': 'granted' })
    expect(JSON.parse(readFileSync(m.windows, 'utf8'))).toEqual({ other: '[10,10,400,300]' })
    expect(said).toContain(`acdev: removed its entries from ${m.entries[0]}`)
  })

  test('an entries file that is not JSON is left alone and said so', async () => {
    const m = machine()
    writeFileSync(m.permissions, '{"notes:terminal": "granted"')
    const said: string[] = []
    await Uninstall.run('notes', {
      yes: true, confirm: null, say: (line) => said.push(line), dir: m.packages, sessions: [], data: true, env: m.env,
    })
    expect(readFileSync(m.permissions, 'utf8')).toBe('{"notes:terminal": "granted"')
    expect(JSON.parse(readFileSync(m.windows, 'utf8'))).toEqual({ other: '[10,10,400,300]' })
  })

  test('without --data, --yes keeps the data and says where it is; asked, the answer decides', async () => {
    const kept = machine()
    const said: string[] = []
    await Uninstall.run('notes', {
      yes: true, confirm: null, say: (line) => said.push(line), dir: kept.packages, sessions: [], env: kept.env,
    })
    expect(existsSync(kept.pkg)).toBe(false)
    for (const path of kept.data) expect(existsSync(path), path).toBe(true)
    expect(said.at(-1)).toBe(`acdev: kept its data (delete it by hand; --data removes it while uninstalling): ${
      [...kept.data, ...kept.entries].join(', ')}`)
    expect(JSON.parse(readFileSync(kept.permissions, 'utf8'))['notes:terminal']).toBe('granted')

    const asked = machine()
    const questions: string[] = []
    const confirm = async (question: string) => (questions.push(question), true)
    await Uninstall.run('notes', {
      yes: false, confirm, say: () => undefined, dir: asked.packages, sessions: [], env: asked.env,
    })
    expect(questions).toEqual(['Remove notes?', `Also remove the data of notes (${[...asked.data, ...asked.entries].join(', ')})?`])
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
    const rest = [
      join(m.env.XDG_DATA_HOME, 'acde', 'apps', 'notes'), join(m.env.XDG_DATA_HOME, 'acde', 'files', 'notes'),
      join(m.env.XDG_STATE_HOME, 'acde', 'grants', 'notes.json'),
    ]
    expect(Uninstall.data(entry, { ...m.env, ACDE_STORAGE: moved })).toEqual([join(moved, 'app-notes'), ...rest])
    expect(Uninstall.data(entry, { ...m.env, ACDE_STORAGE: '' })).toEqual(rest)
  })

  test('an app id that is not a valid id never reaches the file system, and only <id>:<capability> keys go', async () => {
    const m = machine()
    const evil = join(m.packages, 'evil')
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, 'package.json'), JSON.stringify({ name: 'evil', acde: { apps: [{ id: '../..' }, { id: 'x/../../..' }] } }))
    const entry = Uninstall.find('evil', m.packages)!
    expect(entry.apps).toEqual([])
    expect(Uninstall.data(entry, m.env)).toEqual([])
    expect(Uninstall.data({ ...entry, apps: ['..', 'notes/..'] }, m.env)).toEqual([])
    await Uninstall.run('evil', {
      yes: true, confirm: null, say: () => undefined, dir: m.packages, sessions: [], data: true, env: m.env,
    })
    for (const path of m.data) expect(existsSync(path), path).toBe(true)
    writeFileSync(m.permissions, JSON.stringify({ 'notes:terminal': 'granted', 'notes:': 'x', 'notes:../a': 'y', 'other:terminal': 'granted' }))
    const notes = Uninstall.find('notes', m.packages)!
    expect(Uninstall.entries(notes, m.env)[0]!.keys).toEqual(['notes:terminal'])
  })

})
