import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, tmp } from '../helpers.ts'
import { systemTar } from '../../scripts/shipped.ts'

const ROOT = join(import.meta.dir, '..', '..')
const VERSION = '0.0.5'
const TRIPLES = ['generic']

type Plant = { where: 'archive' | 'release'; triple?: string; path: string; text?: string }

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const TARGETS = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']

function pack(root: string, file: string, member: string, text: string, flag: string): void {
  const stage = join(root, `.${member.replaceAll('/', '_')}`)
  mkdirSync(join(stage, member, '..'), { recursive: true })
  writeFileSync(join(stage, member), text)
  const made = systemTar([flag, file, '-C', stage, member.split('/')[0]!])
  if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`)
  rmSync(stage, { recursive: true, force: true })
}

function release(plant: Plant[] = [], tamper = false, runtimeMember = ''): string {
  const root = tmp()
  const out = join(root, 'out')
  const version = join(out, VERSION)
  mkdirSync(version, { recursive: true })
  const lines: string[] = []
  for (const target of TARGETS) {
    const windows = target.endsWith('-windows-msvc')
    const file = `acdebin-dbg-${target}${windows ? '.tar.gz' : '.tar.xz'}`
    pack(root, join(version, file), runtimeMember || (windows ? 'acdebin-dbg.exe' : 'acdebin-dbg'), 'binary', windows ? '-czf' : '-cJf')
    lines.push(`${sha(join(version, file))}  ${file}`)
  }
  pack(root, join(version, `acde-host-${VERSION}.tar.gz`), 'app/dist/broker.js', 'export {}\n', '-czf')
  pack(root, join(version, `acde-api-${VERSION}.tar.gz`), 'package/package.json', '{}', '-czf')
  for (const file of [`acde-host-${VERSION}.tar.gz`, `acde-api-${VERSION}.tar.gz`]) lines.push(`${sha(join(version, file))}  ${file}`)
  for (const triple of TRIPLES) {
    const stage = join(root, 'stage', triple)
    const top = `acde-${VERSION}`
    const write = (path: string, text: string) => {
      mkdirSync(join(stage, top, path, '..'), { recursive: true })
      writeFileSync(join(stage, top, path), text)
    }
    write('bin/acde', 'shim')
    write('lib/acde/package.json', '{"name":"acde"}')
    write('lib/acde/dist/cli.js', 'console.log(1)\n')
    write('lib/acde/templates/app/index.html', '<!doctype html>')
    write('LICENSE', 'license')
    for (const item of plant.filter((p) => p.where === 'archive' && (p.triple ?? triple) === triple)) {
      write(item.path, item.text ?? '')
    }
    const name = `${top}.tar.gz`
    const file = join(version, name)
    const made = systemTar(['-czf', file, '-C', join(root, 'stage', triple), top])
    if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`)
    lines.push(`${sha(file)}  ${name}`)
  }
  writeFileSync(join(version, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  writeFileSync(join(out, 'latest'), `${VERSION}\n`)
  writeFileSync(join(out, 'install.sh'), 'sh')
  writeFileSync(join(out, 'install.ps1'), 'ps1')
  writeFileSync(join(out, 'install.md'), 'md')
  writeFileSync(join(out, 'latest.json'), JSON.stringify({ version: VERSION, files: readdirSync(version).sort() }))
  if (tamper) writeFileSync(join(version, `acde-${VERSION}.tar.gz`), 'changed after the checksum')
  for (const item of plant.filter((p) => p.where === 'release')) {
    mkdirSync(join(out, item.path, '..'), { recursive: true })
    writeFileSync(join(out, item.path), item.text ?? '')
  }
  return out
}

function guard(out: string): { code: number | null; out: string } {
  const child = Bun.spawnSync([
    process.execPath, '../scripts/release-guard.ts', '--dir', out, '--version', VERSION, '--targets', TARGETS.join(','),
  ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  return { code: child.exitCode, out: child.stdout.toString() + child.stderr.toString() }
}

afterAll(cleanup)

describe('release guard', () => {
  test('passes a release that holds exactly the allow-list', () => {
    const made = guard(release())
    expect(made.code, made.out).toBe(0)
    expect(made.out).toContain('are listed')
  }, 180_000)

  test('fails on a file in the release that is not on the allow-list', () => {
    const made = guard(release([{ where: 'release', path: `${VERSION}/notes.txt`, text: 'internal' }]))
    expect(made.code).toBe(1)
    expect(made.out).toContain(`${VERSION}/notes.txt: not on the allow-list`)
  }, 180_000)

  test('fails when an allowed file is missing', () => {
    const out = release()
    rmSync(join(out, 'install.sh'))
    const made = guard(out)
    expect(made.code).toBe(1)
    expect(made.out).toContain('install.sh: missing from the release')
  }, 180_000)

  test('fails when a build holds anything but acdebin-dbg, or a target is missing', () => {
    const wrong = guard(release([], false, 'acdert'))
    expect(wrong.code).toBe(1)
    expect(wrong.out).toContain('acdebin-dbg-x86_64-unknown-linux-gnu.tar.xz: not exactly the one file acdebin-dbg')
    const out = release()
    rmSync(join(out, VERSION, 'acdebin-dbg-x86_64-pc-windows-msvc.tar.gz'))
    expect(guard(out).out).toContain(`${VERSION}/acdebin-dbg-x86_64-pc-windows-msvc.tar.gz: missing from the release`)
  }, 180_000)

  test('fails on an archive whose checksum no longer matches', () => {
    const made = guard(release([], true))
    expect(made.code).toBe(1)
    expect(made.out).toContain('not the checksum SHA256SUMS lists')
  }, 180_000)

  const forbidden: [string, string, string, string][] = [
    ['a source map', 'lib/acde/dist/cli.js.map', '{}', 'source map, symbol or log file'],
    ['a sourcesContent field', 'lib/acde/dist/extra.js', 'x;var s="sourcesContent";', 'sourcesContent'],
    [
      'a sourceMappingURL comment', 'lib/acde/dist/extra.js', 'x\n//# sourceMappingURL=cli.js.map\n',
      'source map reference',
    ],
    [
      'a sourceURL naming a file', 'lib/acde/dist/extra.js', 'x\n//# sourceURL=../src/app.ts\n',
      'sourceURL naming a file',
    ],
    ['a TypeScript source outside the templates', 'lib/acde/dist/app.ts', 'export {}', 'TypeScript source'],
    ['a symbol file', 'lib/acde/dist/cli.pdb', 'pdb', 'source map, symbol or log file'],
    ['a dotenv file', '.env', 'TOKEN=1', 'dotfile or symbol bundle'],
    ['a dot directory', '.acde/state.json', '{}', 'dotfile or symbol bundle'],
    ['a test fixture', 'lib/acde/fixtures/page.html', '<p>', 'test, fixture or log directory'],
    ['a log file', 'lib/acde/dist/run.log', 'ran', 'source map, symbol or log file'],
    ['a GitHub token', 'lib/acde/dist/config.js', 'x="ghp_abcdefghijklmnopqrstuvwxyz0123"', 'GitHub token'],
    ['a local build path', 'lib/acde/dist/config.js', 'x="D:\\Projects\\AgentComputer\\acde"', 'local build path'],
  ]
  for (const [label, path, text, reason] of forbidden) {
    test(`fails on ${label} inside an archive`, () => {
      const made = guard(release([{ where: 'archive', triple: TRIPLES[0], path, text }]))
      expect(made.code, made.out).toBe(1)
      expect(made.out).toContain(reason)
    }, 180_000)
  }

  test('still passes the interpolated sourceURL the driver writes at run time', () => {
    const text = 'x=`/*# sourceURL=${name} */`'
    const made = guard(release([{ where: 'archive', triple: TRIPLES[0], path: 'lib/acde/dist/driver/index.js', text }]))
    expect(made.code, made.out).toBe(0)
  }, 180_000)

  test('a stray file beside the allowed ones is refused', () => {
    const made = guard(release([{ where: 'release', path: 'latest.bak', text: '0.0.4' }]))
    expect(made.code).toBe(1)
    expect(made.out).toContain('latest.bak: not on the allow-list')
  }, 180_000)

  test.skipIf(process.platform === 'win32')('fails on a symbolic link inside an archive', () => {
    const root = tmp()
    const top = `acde-${VERSION}`
    const stage = join(root, 'stage')
    mkdirSync(join(stage, top, 'lib'), { recursive: true })
    writeFileSync(join(stage, top, 'LICENSE'), 'license')
    symlinkSync('/etc/hosts', join(stage, top, 'lib', 'hosts'))
    const out = release()
    const file = join(out, VERSION, `${top}.tar.gz`)
    systemTar(['-czf', file, '-C', stage, top])
    const lines = TRIPLES.map((triple) => {
      const name = `acde-${VERSION}.tar.gz`
      return `${sha(join(out, VERSION, name))}  ${name}`
    })
    writeFileSync(join(out, VERSION, 'SHA256SUMS'), `${lines.join('\n')}\n`)
    const made = guard(out)
    expect(made.code).toBe(1)
    expect(made.out).toContain('symbolic link')
  }, 180_000)
})
