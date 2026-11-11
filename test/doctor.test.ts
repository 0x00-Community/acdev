import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { Doctor, type Check } from '../src/doctor.ts'
import { Sessions } from '../src/sessions.ts'
import { Versions } from '../src/versions.ts'
import { cleanup, collect, env, standIn, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const NO_ACDERT = `${dirname(process.execPath)}${WINDOWS ? ';' : ':'}${WINDOWS ? 'C:\\nonexistent' : '/nonexistent'}`

afterAll(cleanup)

function doctor(args: string[], cwd: string, vars: Record<string, string>) {
  return collect([process.execPath, CLI, 'doctor', ...args], { cwd, env: env(vars) })
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
        `warn   approval: alpha waits for approval of launch in acde dev ${dev.pid}, so it opens no window until the prompt is answered`,
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
  }, 60_000)

  test('format: one line per check, a fix under it, a last line that counts', () => {
    const checks: Check[] = [
      Doctor.ok('acde', 'acde', '0.0.9'),
      Doctor.warn('skill', 'agent skill', 'not installed', 'acde skills install'),
      Doctor.error('acdert', 'acdert', 'not found', 'run the installer again'),
      Doctor.skip('contract', 'contract level', 'needs an acdert that runs'),
    ]
    expect(Doctor.format(checks)).toBe([
      'ok     acde: 0.0.9',
      'warn   agent skill: not installed',
      '       fix: acde skills install',
      'error  acdert: not found',
      '       fix: run the installer again',
      'skip   contract level: needs an acdert that runs',
      'acde doctor: 1 error, 1 warning',
    ].join('\n'))
    expect(Doctor.format([checks[0]!])).toBe('ok     acde: 0.0.9\nacde doctor: everything acde needs is here')
    expect(Doctor.format(checks.slice(0, 2)).split('\n').at(-1)).toBe('acde doctor: no errors, 1 warning')
    expect(Doctor.failed(checks)).toBe(true)
    expect(Doctor.failed(checks.slice(0, 2))).toBe(false)
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
