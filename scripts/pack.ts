import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { acdertPackage, bunPackage, TARGETS } from '../launcher.mjs'

const ROOT = resolve(import.meta.dir, '..')
const SELF = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const BUN_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl', 'win32-arm64', 'win32-x64']

const { values } = parseArgs({
  options: {
    acdert: { type: 'string', multiple: true, default: [] },
    host: { type: 'string' },
    api: { type: 'string', default: join(ROOT, '../acdert/web/packages/acde-api') },
    version: { type: 'string', default: SELF.version },
    'bun-version': { type: 'string', default: Bun.version },
    out: { type: 'string', default: join(ROOT, '.npm') },
    publish: { type: 'string' },
    tag: { type: 'string', default: 'latest' },
  },
})

const version = values.version!
const out = resolve(values.out!)
const stage = join(out, 'stage')
rmSync(out, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

const COMMON = { license: 'Apache-2.0', repository: { type: 'git', url: 'https://github.com/dopame-org/acde' } }

function write(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(json, null, 2)}\n`)
}

async function pack(dir: string): Promise<string> {
  const child = Bun.spawn([process.execPath, 'pm', 'pack', '--destination', out, '--quiet', '--ignore-scripts'], { cwd: dir, stdout: 'pipe', stderr: 'inherit' })
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code !== 0) throw new Error(`bun pm pack in ${dir} failed`)
  return join(out, basename(text.trim().split('\n').pop()!))
}

const tarballs: string[] = []

const binaries = new Map<string, string>()
for (const spec of values.acdert!) {
  const [target, file] = spec.split('=', 2) as [string, string | undefined]
  if (!TARGETS.includes(target) || !file) throw new Error(`--acdert <target>=<binary>, target one of ${TARGETS.join(', ')}`)
  binaries.set(target, resolve(file))
}
if (binaries.size > 0 && !values.host) throw new Error('--host <acde-host dist> (broker.js, web.js)')

for (const [target, binary] of binaries) {
  const [os, cpu, libc] = target.split('-') as [string, string, string | undefined]
  const dir = join(stage, `acdert-${target}`)
  const exe = os === 'win32' ? 'acdert.exe' : 'acdert'
  mkdirSync(join(dir, 'bin', 'app', 'dist'), { recursive: true })
  copyFileSync(binary, join(dir, 'bin', exe))
  chmodSync(join(dir, 'bin', exe), 0o755)
  for (const name of readdirSync(values.host!)) if (name.endsWith('.js')) copyFileSync(join(values.host!, name), join(dir, 'bin', 'app', 'dist', name))
  write(dir, {
    name: acdertPackage(target),
    version,
    description: `acdert, the acde runtime, for ${target}: used by the acde CLI`,
    ...COMMON,
    os: [os],
    cpu: [cpu],
    ...(os === 'linux' && { libc: [libc ?? 'glibc'] }),
    files: ['bin'],
    preferUnplugged: true,
  })
  tarballs.push(await pack(dir))
}

const api = JSON.parse(readFileSync(join(values.api!, 'package.json'), 'utf8')) as { version: string }
tarballs.push(await pack(values.api!))

const acde = join(stage, 'acde')
mkdirSync(join(acde, 'src'), { recursive: true })
for (const path of ['bin', 'templates', 'launcher.mjs', 'LICENSE']) cpSync(join(ROOT, path), join(acde, path), { recursive: true })
for (const name of ['listen.ts', 'sockets.ts']) copyFileSync(join(ROOT, 'src', name), join(acde, 'src', name))
const launcher: Bun.BunPlugin = {
  name: 'launcher',
  setup: (build) => {
    build.onResolve({ filter: /^\.\.\/launcher\.mjs$/ }, (args) => ({ path: args.path, external: true }))
  },
}
const bundled = await Bun.build({ entrypoints: [join(ROOT, 'src/cli.ts')], outdir: join(acde, 'src'), target: 'bun', format: 'esm', naming: { entry: 'cli.js' }, minify: { syntax: true, whitespace: false, identifiers: false }, plugins: [launcher] })
if (!bundled.success) throw new AggregateError(bundled.logs, 'bundling src/cli.ts failed')
write(acde, {
  name: 'acde',
  version,
  description: SELF.description,
  ...COMMON,
  type: 'module',
  engines: SELF.engines,
  bin: SELF.bin,
  exports: SELF.exports,
  preferUnplugged: true,
  files: ['bin', 'launcher.mjs', 'src', 'templates'],
  dependencies: { '@dopame/acde-api': api.version },
  optionalDependencies: {
    ...Object.fromEntries([...binaries.keys()].map((t) => [acdertPackage(t), version])),
    ...Object.fromEntries(BUN_TARGETS.map((t) => [bunPackage(t), values['bun-version']!])),
  },
})
tarballs.push(await pack(acde))

const create = join(stage, 'create-acde')
const createSelf = JSON.parse(readFileSync(join(ROOT, 'packages/create-acde/package.json'), 'utf8'))
mkdirSync(create, { recursive: true })
copyFileSync(join(ROOT, 'packages/create-acde/index.mjs'), join(create, 'index.mjs'))
write(create, { ...createSelf, version, preferUnplugged: true, dependencies: { acde: version } })
tarballs.push(await pack(create))

for (const file of tarballs) console.log(file)

if (values.publish) {
  const npm = Bun.which('npm')
  if (!npm) throw new Error('--publish needs npm on PATH')
  for (const file of tarballs) {
    const { name, version: v } = JSON.parse(Bun.spawnSync(['tar', '-xOzf', file, 'package/package.json']).stdout.toString()) as { name: string; version: string }
    const seen = Bun.spawnSync([npm, 'view', `${name}@${v}`, 'version', '--registry', values.publish]).stdout.toString().trim()
    if (seen === v) {
      console.log(`${name}@${v} is already on ${values.publish}`)
      continue
    }
    const child = Bun.spawn([npm, 'publish', file, '--registry', values.publish, '--tag', values.tag!, '--access', 'public'], { stdio: ['ignore', 'inherit', 'inherit'] })
    if ((await child.exited) !== 0) throw new Error(`npm publish ${file} failed`)
  }
}
