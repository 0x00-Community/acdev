import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { Color } from '../src/color.ts'
import { Doctor, type Check, type Repair } from '../src/doctor.ts'
import { DevSession } from '../src/dev.ts'
import { Sessions } from '../src/sessions.ts'
import { Runtime } from '../src/runtime.ts'
import { Versions } from '../src/versions.ts'
import { cleanup, collect, env, standIn, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const NO_ACDERT = `${dirname(process.execPath)}${WINDOWS ? ';' : ':'}${WINDOWS ? 'C:\\nonexistent' : '/nonexistent'}`

afterAll(cleanup)

function doctor(args: string[], cwd: string, vars: Record<string, string>) {
  return collect([process.execPath, CLI, 'doctor', ...args], { cwd, env: env(vars) })
}

function isolated(): Record<string, string> {
  const home = tmp()
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', APPDATA: '',
  }
}

function line(out: string, title: string): string {
  return out.split('\n').find((text) => text.slice(7).startsWith(`${title}: `)) ?? `(no ${title} line in)\n${out}`
}

function fixAfter(out: string, title: string): string {
  const lines = out.split('\n')
  const at = lines.findIndex((text) => text.slice(7).startsWith(`${title}: `))
  return at >= 0 && lines[at + 1]?.startsWith('       fix: ') ? lines[at + 1]!.slice('       fix: '.length) : ''
}

describe('acde doctor', () => {
  test('no acdert: an error that says where it looked and how to get one; the checks that need it are skipped', async () => {
    const s = standIn()
    const ran = await doctor([], s.project, { ...s.env, ACDERT: '', PATH: NO_ACDERT })
    expect(ran.code).toBe(1)
    expect(line(ran.stdout, 'acdert')).toBe(
      'error  acdert: acde dev needs the Dopame runtime (acdert) and found none: ' +
      'set ACDERT to an acdert binary, or put acdert on PATH',
    )
    expect(fixAfter(ran.stdout, 'acdert')).toContain('set ACDERT to its target/release/acdert')
    expect(line(ran.stdout, 'contract level')).toBe('skip   contract level: needs an acdert that runs')
    expect(line(ran.stdout, 'runtime check')).toBe('skip   runtime check: needs an acdert that runs')
    expect(ran.stdout.trim().split('\n').at(-1)).toMatch(/^acde doctor: 1 error, \d+ warnings?$/)
  }, 60_000)

  test('ACDERT that is not there, or that does not run, is an error with the reason', async () => {
    const s = standIn()
    const gone = join(tmp(), 'gone')
    const missing = await doctor([], s.project, { ...s.env, ACDERT: gone })
    expect(missing.code).toBe(1)
    expect(line(missing.stdout, 'acdert')).toBe(`error  acdert: ACDERT=${gone}: no such file; point ACDERT at an acdert binary, or unset it`)
    if (WINDOWS) return
    const broken = join(tmp(), 'acdert')
    writeFileSync(broken, '#!/bin/sh\necho "acdert: error while loading shared libraries: libgbm.so.1" >&2\nexit 127\n', { mode: 0o755 })
    const ran = await doctor([], s.project, { ...s.env, ACDERT: broken })
    expect(ran.code).toBe(1)
    expect(line(ran.stdout, 'acdert')).toBe(
      `error  acdert: ${broken} (from ACDERT) does not run: it exited with code 127: ` +
      'acdert: error while loading shared libraries: libgbm.so.1',
    )
    expect(fixAfter(ran.stdout, 'acdert')).toBe('install the system library named above, which acdert links against')
  }, 60_000)

  test('a working acdert: found, its contract level, and the checks it runs on itself', async () => {
    const s = standIn()
    const ran = await doctor([], s.project, { ...s.env, FAKE_ACDERT_DOCTOR: 'ok' })
    expect(line(ran.stdout, 'acdert')).toBe(`ok     acdert: acdert 0.0.0 (contract level ${API_LEVEL}) at ${s.env['ACDERT']} (from ACDERT)`)
    expect(line(ran.stdout, 'contract level')).toBe(
      `warn   contract level: level ${API_LEVEL} on both sides, but acde ${Versions.acde()} is built with SDK ${Versions.sdk()}, ` +
      `which pairs with acdert ${Versions.sdk()} and this one is 0.0.0`,
    )
    expect(line(ran.stdout, 'host files')).toBe('ok     host files: /fake/app/dist')
    expect(line(ran.stdout, 'gpu')).toBe('ok     gpu: Fake GPU (Metal, integrated GPU): drew a test frame in 1 ms')
    expect(line(ran.stdout, 'project')).toBe('ok     project: alpha, app (acde.config.jsonc): acde check finds nothing wrong')
    expect(line(ran.stdout, 'acde dev sessions')).toBe('ok     acde dev sessions: none running')
    expect(ran.code).toBe(0)
  }, 60_000)

  test('what acdert doctor finds wrong is an error of acde doctor; an acdert without it is a warning', async () => {
    const s = standIn()
    const gpu = await doctor([], s.project, { ...s.env, FAKE_ACDERT_DOCTOR: 'gpu' })
    expect(gpu.code).toBe(1)
    expect(line(gpu.stdout, 'gpu')).toBe('error  gpu: no usable Metal driver was found')
    expect(fixAfter(gpu.stdout, 'gpu')).toBe('update the GPU driver')
    const old = await doctor([], s.project, s.env)
    expect(old.code).toBe(0)
    expect(line(old.stdout, 'runtime check')).toBe(
      'warn   runtime check: acdert 0.0.0 cannot check itself (it has no acdert doctor), so its GPU and host files were not checked',
    )
    const garbage = await doctor([], s.project, { ...s.env, FAKE_ACDERT_DOCTOR: 'garbage' })
    expect(garbage.code).toBe(1)
    expect(line(garbage.stdout, 'runtime check')).toBe('error  runtime check: acdert doctor gave no report: acdert doctor: it broke')
  }, 60_000)

  test('a runtime of another contract level is an error: acde dev would refuse it', async () => {
    const s = standIn()
    const other = API_LEVEL + 1
    const ran = await doctor([], s.project, { ...s.env, FAKE_ACDERT_LEVEL: String(other) })
    expect(ran.code).toBe(1)
    expect(line(ran.stdout, 'contract level')).toBe(
      `error  contract level: acde builds level ${API_LEVEL} apps, but acdert 0.0.0 runs level ${other}: acde dev refuses to start it`,
    )
  }, 60_000)

  test('--json: the same checks as one object', async () => {
    const s = standIn()
    const ran = await doctor(['--json'], s.project, { ...s.env, FAKE_ACDERT_DOCTOR: 'gpu' })
    expect(ran.code).toBe(1)
    const report = JSON.parse(ran.stdout) as { ok: boolean; checks: Check[] }
    expect(report.ok).toBe(false)
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining(['acde', 'acdert', 'contract', 'runtime.host', 'runtime.gpu', 'project']))
    expect(report.checks.find((check) => check.id === 'runtime.gpu')).toEqual({
      id: 'runtime.gpu', title: 'gpu', status: 'error', summary: 'no usable Metal driver was found', fix: 'update the GPU driver',
    })
  }, 60_000)

  test('the project: acde check findings, a directory that is not a project, dependencies that are not installed', async () => {
    const s = standIn()
    const named = await doctor([tmp()], s.project, s.env)
    expect(named.code).toBe(1)
    expect(line(named.stdout, 'project')).toMatch(/^error  project: no acde project in .* \(no acde\.config\.jsonc, no acde field in package\.json\)$/)
    const here = await doctor([], tmp(), s.env)
    expect(line(here.stdout, 'project')).toMatch(/^skip   project: no acde project in .*: run acde doctor in a project, or pass its directory, to check it too$/)
    const bad = join(tmp(), 'bad')
    mkdirSync(bad)
    writeFileSync(join(bad, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'Not An Id' }))
    writeFileSync(join(bad, 'index.html'), '<!doctype html><title>Bad</title>')
    const wrong = await doctor([bad], s.project, s.env)
    expect(wrong.code).toBe(1)
    expect(line(wrong.stdout, 'project')).toMatch(/^error  project: /)
    expect(fixAfter(wrong.stdout, 'project')).toBe('acde check lists them')
    writeFileSync(join(s.project, 'package.json'), JSON.stringify({ name: 'alpha', packageManager: 'bun@1.4.4', dependencies: { 'left-pad': '1.3.0' } }))
    const deps = await doctor([], s.project, s.env)
    expect(line(deps.stdout, 'dependencies')).toBe('warn   dependencies: not installed: left-pad')
    expect(fixAfter(deps.stdout, 'dependencies')).toBe('bun install')
    mkdirSync(join(dirname(s.project), 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(dirname(s.project), 'node_modules', 'left-pad', 'package.json'), '{"name":"left-pad","version":"1.3.0"}')
    const hoisted = await doctor([], s.project, s.env)
    expect(line(hoisted.stdout, 'dependencies')).toMatch(/^ok     dependencies: installed with bun \(runs on Bun /)
  }, 60_000)

  test('an app that waits for approval in a running acde dev: a warning that names it', async () => {
    const s = standIn()
    const dev = Bun.spawn([process.execPath, CLI, 'dev'], {
      cwd: s.project, env: env({ ...s.env, FAKE_ACDERT_WAITS: '1' }), stdout: 'ignore', stderr: 'ignore',
    })
    try {
      const dir = Sessions.dir(env(s.env))
      for (let i = 0; i < 200 && Sessions.list(dir).length === 0; i++) await sleep(50)
      const ran = await doctor([], s.project, s.env)
      expect(line(ran.stdout, 'acde dev sessions')).toMatch(/^ok     acde dev sessions: 1 running: /)
      expect(line(ran.stdout, 'approval')).toBe(
        `warn   approval: alpha waits for approval of camera in acde dev ${dev.pid}, so its getUserMedia waits until the prompt is answered`,
      )
      expect(fixAfter(ran.stdout, 'approval')).toBe('acde allow (or acde deny): approving is the user\'s decision')
    } finally {
      dev.kill()
      await dev.exited
    }
  }, 60_000)

  test('acde dev: an acdert that exits before it is ready points at acde doctor', async () => {
    const s = standIn()
    const ran = await collect([process.execPath, CLI, 'dev'], { cwd: s.project, env: env({ ...s.env, FAKE_ACDERT_FAILS: '1' }) })
    expect(ran.code).toBe(1)
    expect(ran.stderr).toContain('web layer unavailable: fake acdert has no GPU')
    expect(ran.stderr).toContain('acde: acdert exited (1) before it was ready; acde doctor checks the runtime, the GPU and this setup')
    expect(ran.stderr).toContain(`acde: ${DevSession.WINDOW_HINT}`)
  }, 60_000)

  test('acde dev and acde test --headed without a display (Linux) stop at once and point at headless', async () => {
    const s = standIn()
    const bare = env(s.env)
    delete bare['WAYLAND_DISPLAY']
    delete bare['DISPLAY']
    expect(Runtime.noDisplay(bare, 'linux')).toBe('no display here (no WAYLAND_DISPLAY or DISPLAY)')
    expect(Runtime.noDisplay({ DISPLAY: ':0' }, 'linux')).toBeNull()
    expect(Runtime.noDisplay({}, 'darwin')).toBeNull()
    expect(Runtime.noDisplay({}, 'win32')).toBeNull()
    if (process.platform !== 'linux') return
    const dev = await collect([process.execPath, CLI, 'dev'], { cwd: s.project, env: bare })
    expect([dev.code, dev.stderr.trim()])
      .toEqual([1, 'acde: no display here (no WAYLAND_DISPLAY or DISPLAY): run acde dev --headless'])
    const headed = await collect([process.execPath, CLI, 'test', '--headed'], { cwd: s.project, env: bare })
    expect([headed.code, headed.stderr.trim()])
      .toEqual([1, 'acde: no display here (no WAYLAND_DISPLAY or DISPLAY): run acde test without --headed'])
  }, 60_000)

  test('format: one line per check, a fix under it, a last line that counts', () => {
    const checks: Check[] = [
      Doctor.ok('acde', 'acde', '0.0.9'),
      Doctor.warn('skill', 'agent skill', 'not installed', 'acde skills install'),
      Doctor.error('acdert', 'acdert', 'not found', 'run the installer again'),
      Doctor.skip('contract', 'contract level', 'needs an acdert that runs'),
    ]
    expect(Doctor.format(checks, Color.palette(false))).toBe([
      'ok     acde: 0.0.9',
      'warn   agent skill: not installed',
      '       fix: acde skills install',
      'error  acdert: not found',
      '       fix: run the installer again',
      'skip   contract level: needs an acdert that runs',
      'acde doctor: 1 error, 1 warning',
    ].join('\n'))
    const coloured = Doctor.format(checks, Color.palette(true)).split('\n')
    expect(coloured[0]).toBe('\x1b[32mok    \x1b[39m acde: 0.0.9')
    expect(coloured[1]).toBe('\x1b[33mwarn  \x1b[39m agent skill: not installed')
    expect(coloured[3]).toStartWith('\x1b[1;31merror \x1b[22;39m acdert')
    expect(coloured[5]).toStartWith('\x1b[2mskip  \x1b[22m contract')
    expect(Doctor.format([checks[0]!], Color.palette(false)))
      .toBe('ok     acde: 0.0.9\nacde doctor: everything acde needs is here')
    expect(Doctor.format(checks.slice(0, 2)).split('\n').at(-1)).toBe('acde doctor: no errors, 1 warning')
    expect(Doctor.failed(checks)).toBe(true)
    expect(Doctor.failed(checks.slice(0, 2))).toBe(false)
    const long = Doctor.warn('display', 'display', 'no display: the host window cannot open, so run acde dev with '
      + '--headless or start a desktop session first', 'set DISPLAY or WAYLAND_DISPLAY to a running display server')
    expect(Doctor.format([long], Color.palette(false), 40).split('\n')).toEqual([
      'warn   display: no display: the host',
      '       window cannot open, so run acde',
      '       dev with --headless or start a',
      '       desktop session first',
      '       fix: set DISPLAY or',
      '            WAYLAND_DISPLAY to a running',
      '            display server',
      'acde doctor: no errors, 1 warning',
    ])
    expect(Doctor.format([long], Color.palette(false), null).split('\n')).toHaveLength(3)
  })

  test('helpers: versions compare by number; inside is about whole path segments', () => {
    expect(Versions.newer('0.0.10', '0.0.9')).toBe(true)
    expect(Versions.newer('0.0.9', '0.0.10')).toBe(false)
    expect(Versions.newer('0.0.9', '0.0.9')).toBe(false)
    expect(Versions.newer('0.1.0', '0.0.99')).toBe(true)
    const root = join(tmp(), 'acde')
    expect(Doctor.inside(join(root, 'bin', 'acde'), root)).toBe(true)
    expect(Doctor.inside(root, root)).toBe(true)
    expect(Doctor.inside(`${root}-other`, root)).toBe(false)
    expect(Doctor.inside(join(root, '..', 'x'), root)).toBe(false)
  })
})

describe('acde doctor --fix', () => {
  const SKILL = 'install the acde skill for the coding agents found here (acde skills install)'

  test('fixes the skill and .acde/ in .gitignore without asking, then checks again', async () => {
    const s = standIn()
    const vars: Record<string, string> = { ...s.env, ...isolated(), FAKE_ACDERT_DOCTOR: 'ok' }
    const git = spawnSync('git', ['init', '-q'], { cwd: s.project })
    const before = await doctor([], s.project, vars)
    expect(line(before.stdout, 'agent skill')).toBe('warn   agent skill: the acde skill is not installed for any coding agent')
    const ran = await doctor(['--fix'], s.project, vars)
    expect(ran.stdout).toContain(`fixing: ${SKILL}\n`)
    expect(ran.stdout).toContain(`fixed: ${SKILL}\n`)
    expect(existsSync(join(vars['HOME']!, '.agents', 'skills', 'acde', 'SKILL.md'))).toBe(true)
    const after = ran.stdout.slice(ran.stdout.indexOf('acde doctor: after fixing:\n'))
    expect(after).toMatch(/\nok     agent skill: current in /)
    if (git.status === 0) {
      expect(ran.stdout).toContain(`added .acde/ to ${join(s.project, '.gitignore')}\n`)
      expect(readFileSync(join(s.project, '.gitignore'), 'utf8')).toBe('.acde/\n')
      expect(line(after, 'git')).toBe('ok     git: .acde/ (the build output) is ignored')
    }
    expect(ran.code).toBe(0)
    const again = await doctor(['--fix'], s.project, vars)
    expect(again.stdout).toContain('acde doctor: nothing here it can fix; the fix lines say what to do')
    expect(again.stdout).not.toContain('after fixing')
  }, 120_000)

  test('what installs or stops something waits for --yes: without a terminal it is skipped and says so', async () => {
    const s = standIn()
    const vars: Record<string, string> = { ...s.env, ...isolated(), FAKE_ACDERT_DOCTOR: 'ok' }
    mkdirSync(join(s.project, 'local-dep'))
    writeFileSync(join(s.project, 'local-dep', 'package.json'), '{"name":"local-dep","version":"1.0.0"}')
    writeFileSync(join(s.project, 'package.json'),
      JSON.stringify({ name: 'alpha', packageManager: 'bun@1.4.4', dependencies: { 'local-dep': 'file:./local-dep' } }))
    const does = `install the project's dependencies (bun install in ${s.project})`
    const asked = await doctor(['--fix'], s.project, vars)
    expect(asked.stdout).toContain(`skipped: ${does} (it asks first: pass --yes to allow it)\n`)
    expect(existsSync(join(s.project, 'node_modules'))).toBe(false)
    const yes = await doctor(['--fix', '--yes'], s.project, vars)
    expect(yes.stdout).toContain(`fixed: ${does}\n`)
    expect(existsSync(join(s.project, 'node_modules', 'local-dep', 'package.json'))).toBe(true)
    expect(line(yes.stdout.slice(yes.stdout.indexOf('after fixing')), 'dependencies')).toMatch(/^ok     dependencies: installed with bun/)
    const refused = await doctor(['--yes'], s.project, vars)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toBe('acde: doctor: --yes is for --fix (acde doctor --help)\n')
  }, 120_000)

  test('a sessions directory that is not a directory is made again', async () => {
    const s = standIn()
    const vars: Record<string, string> = { ...s.env, ...isolated(), FAKE_ACDERT_DOCTOR: 'ok' }
    const dir = Sessions.dir(env(vars))
    writeFileSync(dir, 'not a directory')
    const broken = await doctor([], s.project, vars)
    expect(broken.code).toBe(1)
    expect(line(broken.stdout, 'acde dev sessions')).toBe(`error  acde dev sessions: ${dir} is not a plain directory; remove it and run again`)
    const ran = await doctor(['--fix'], s.project, vars)
    expect(ran.stdout).toContain(`made ${dir} again\n`)
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(line(ran.stdout.slice(ran.stdout.indexOf('after fixing')), 'acde dev sessions')).toBe('ok     acde dev sessions: none running')
    expect(ran.code).toBe(0)
  }, 120_000)

  test('--fix --json: one object on stdout with what was fixed; the progress goes to stderr', async () => {
    const s = standIn()
    const vars: Record<string, string> = { ...s.env, ...isolated(), FAKE_ACDERT_DOCTOR: 'ok' }
    const ran = await doctor(['--fix', '--json'], s.project, vars)
    const report = JSON.parse(ran.stdout) as { ok: boolean; fixed: { repair: Repair; result: string }[]; checks: Check[] }
    expect(report.fixed).toContainEqual(expect.objectContaining({ repair: expect.objectContaining({ action: 'skill' }), result: 'fixed' }))
    expect(report.checks.find((check) => check.id === 'skill')?.status).toBe('ok')
    expect(ran.stderr).toContain(`fixed: ${SKILL}`)
  }, 120_000)

  test('the checks say what they would fix; only problems are fixed, each once; the user may say no', async () => {
    const dir = tmp()
    const gitignore: Repair = { action: 'gitignore', target: dir, ask: false, does: 'add .acde/' }
    const asking: Repair = { action: 'gitignore', target: join(dir, 'x'), ask: true, does: 'something that asks' }
    const checks: Check[] = [
      Doctor.mend(Doctor.warn('gitignore', 'git', 'not ignored'), gitignore),
      Doctor.mend(Doctor.error('again', 'again', 'same repair'), gitignore),
      Doctor.mend(Doctor.ok('fine', 'fine', 'nothing wrong'), asking),
      Doctor.mend(Doctor.warn('ask', 'ask', 'needs asking'), asking),
      Doctor.error('gpu', 'gpu', 'no driver', 'install the driver'),
    ]
    expect(Doctor.repairs(checks)).toEqual([gitignore, asking])
    expect(JSON.parse(Doctor.json(checks)).checks[0].repair).toEqual(gitignore)
    const said: string[] = []
    const asked: string[] = []
    const fixed = await Doctor.fix(checks, {
      yes: false, output: 'capture', say: (text) => said.push(text), allowing: 'never shown',
      confirm: async (repair) => {
        asked.push(repair.does)
        return false
      },
    })
    expect(asked).toEqual(['something that asks'])
    expect(fixed.map((done) => done.result)).toEqual(['fixed', 'skipped'])
    expect(said).toEqual(['fixing: add .acde/', `added .acde/ to ${join(dir, '.gitignore')}`, 'fixed: add .acde/', 'skipped: something that asks'])
    const none: string[] = []
    expect(await Doctor.fix([checks[4]!], { yes: true, output: 'capture', say: (text) => none.push(text), confirm: null, allowing: '' }))
      .toEqual([])
    expect(none).toEqual(['acde doctor: nothing here it can fix; the fix lines say what to do'])
  })
})
