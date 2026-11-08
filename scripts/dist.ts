import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dirname, '..')
const SELF = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; description: string; license: string; repository: object; exports: object; engines: object }
const TRIPLES = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-musl', 'x86_64-unknown-linux-musl', 'x86_64-pc-windows-msvc']
const CARRIED = ['listen.ts', 'sockets.ts', 'ipc.ts', 'sessions.ts', 'configs.ts', 'paths.ts', 'runtime.ts']

const { values } = parseArgs({
  options: {
    acdert: { type: 'string' },
    host: { type: 'string' },
    api: { type: 'string', default: join(ROOT, '../acdert/web/packages/acde-api') },
    desktop: { type: 'string', default: join(ROOT, '../acde-dopame/packages/dopame') },
    triple: { type: 'string' },
    version: { type: 'string', default: SELF.version },
    out: { type: 'string', default: join(ROOT, '.dist') },
  },
})

function need(name: string, value: string | undefined, what: string): string {
  if (!value) throw new Error(`--${name} <${what}>`)
  return value
}

const acdert = resolve(need('acdert', values.acdert, 'the acdert binary'))
const host = resolve(need('host', values.host, 'the acde-host dist directory (broker.js, web.js)'))
const api = resolve(values.api!)
const desktop = resolve(values.desktop!)
const triple = need('triple', values.triple, `rust target triple: ${TRIPLES.join(', ')}`)
const version = values.version!
if (!TRIPLES.includes(triple)) throw new Error(`--triple ${triple}: one of ${TRIPLES.join(', ')}`)
const windows = triple.endsWith('-windows-msvc')
const crlf = (from: string, to: string) => writeFileSync(to, readFileSync(from, 'utf8').replace(/\r?\n/g, '\r\n'))
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--version ${version}: x.y.z`)
if (!statSync(acdert).isFile()) throw new Error(`--acdert ${acdert}: not a file`)
if (!existsSync(join(host, 'broker.js'))) throw new Error(`--host ${host}: no broker.js in it`)
if (!existsSync(join(api, 'package.json'))) throw new Error(`--api ${api}: no package.json in it`)
if (!existsSync(join(desktop, 'package.json')) || !existsSync(join(desktop, 'dist'))) throw new Error(`--desktop ${desktop}: a built desktop package (package.json and dist/), e.g. acde-dopame's packages/dopame after bun run build`)

const name = `acde-${version}-${triple}`
const dir = join(resolve(values.out!), version)
const stage = join(dir, `.stage-${triple}`)
const top = join(stage, name)
rmSync(stage, { recursive: true, force: true })

mkdirSync(join(top, 'bin', 'app', 'dist'), { recursive: true })
if (windows) {
  crlf(join(ROOT, 'scripts', 'acde.cmd'), join(top, 'bin', 'acde.cmd'))
  copyFileSync(acdert, join(top, 'bin', 'acdert.exe'))
} else {
  copyFileSync(join(ROOT, 'scripts', 'acde.sh'), join(top, 'bin', 'acde'))
  copyFileSync(acdert, join(top, 'bin', 'acdert'))
  for (const file of ['acde', 'acdert']) chmodSync(join(top, 'bin', file), 0o755)
}
for (const file of readdirSync(host)) if (file.endsWith('.js')) copyFileSync(join(host, file), join(top, 'bin', 'app', 'dist', file))
const shipped = join(top, 'bin', 'app', 'packages', basename(desktop))
mkdirSync(shipped, { recursive: true })
copyFileSync(join(desktop, 'package.json'), join(shipped, 'package.json'))
cpSync(join(desktop, 'dist'), join(shipped, 'dist'), { recursive: true, filter: (from) => !from.endsWith('.map') })

const lib = join(top, 'lib', 'acde')
mkdirSync(join(lib, 'src'), { recursive: true })
for (const path of ['templates', 'launcher.mjs', 'launcher.d.mts', 'LICENSE']) cpSync(join(ROOT, path), join(lib, path), { recursive: true })
for (const file of CARRIED) copyFileSync(join(ROOT, 'src', file), join(lib, 'src', file))
for (const sub of ['driver', 'e2e']) cpSync(join(ROOT, 'src', sub), join(lib, 'src', sub), { recursive: true })
const bundled = await Bun.build({
  entrypoints: [join(ROOT, 'src/cli.ts')],
  outdir: join(lib, 'src'),
  target: 'node',
  format: 'esm',
  naming: { entry: 'cli.js' },
  minify: { syntax: true, whitespace: false, identifiers: false },
  external: ['acde/launcher'],
})
if (!bundled.success) throw new AggregateError(bundled.logs, 'bundling src/cli.ts failed')
const cli = join(lib, 'src', 'cli.js')
writeFileSync(cli, readFileSync(cli, 'utf8').replace(/^#!.*\n(\/\/ @bun.*\n)?/, ''))
writeFileSync(
  join(lib, 'package.json'),
  `${JSON.stringify({ name: 'acde', version, description: SELF.description, license: SELF.license, repository: SELF.repository, type: 'module', engines: SELF.engines, exports: SELF.exports }, null, 2)}\n`,
)
cpSync(api, join(top, 'lib', 'acde-api'), { recursive: true, filter: (from) => !/[\\/](node_modules|test)$/.test(from) })

const tarball = join(dir, `${name}.tar.gz`)
const tar = spawnSync('tar', ['-czf', tarball, ...(process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []), '-C', stage, name], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
if (tar.status !== 0) throw new Error(`tar for ${tarball} failed`)
rmSync(stage, { recursive: true, force: true })

const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const sums = join(dir, 'SHA256SUMS')
const lines = existsSync(sums) ? readFileSync(sums, 'utf8').split('\n').filter((line) => line && !line.endsWith(`  ${name}.tar.gz`)) : []
writeFileSync(sums, `${[...lines, `${sum}  ${name}.tar.gz`].sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n')}\n`)
writeFileSync(join(resolve(values.out!), 'latest'), `${version}\n`)
copyFileSync(join(ROOT, 'install.sh'), join(resolve(values.out!), 'install.sh'))
copyFileSync(join(ROOT, 'install.ps1'), join(resolve(values.out!), 'install.ps1'))
console.log(`${tarball}\n${sum}`)
