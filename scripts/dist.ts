import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const SELF = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  description: string
  license: string
  repository: object
  engines: object
}
const TRIPLES = [
  'aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-musl', 'x86_64-unknown-linux-musl', 'x86_64-pc-windows-msvc',
]
const BUNDLES: { entry: string; file: string; target: 'node' | 'bun' }[] = [
  { entry: 'src/cli.ts', file: 'cli.js', target: 'node' },
  { entry: 'src/driver/index.ts', file: 'driver.js', target: 'node' },
  { entry: 'src/e2e/index.ts', file: 'test.js', target: 'bun' },
]

const { values } = parseArgs({
  options: {
    acdert: { type: 'string' },
    host: { type: 'string' },
    api: { type: 'string', default: join(ROOT, '../acdert/web/packages/acde-api/dist') },
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
const out = resolve(values.out!)
if (!TRIPLES.includes(triple)) throw new Error(`--triple ${triple}: one of ${TRIPLES.join(', ')}`)
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--version ${version}: x.y.z`)
if (!statSync(acdert).isFile()) throw new Error(`--acdert ${acdert}: not a file`)
if (!existsSync(join(host, 'broker.js'))) throw new Error(`--host ${host}: no broker.js in it`)
if (!existsSync(join(api, 'package.json')) || !existsSync(join(api, 'src', 'index.js'))) {
  throw new Error(`--api ${api}: not a built acde-api (run bun run build in acdert's web/packages/acde-api)`)
}
if (!existsSync(join(desktop, 'package.json')) || !existsSync(join(desktop, 'dist'))) {
  throw new Error(`--desktop ${desktop}: a built desktop package (package.json and dist/), `
    + 'e.g. acde-dopame\'s packages/dopame after bun run build')
}

const windows = triple.endsWith('-windows-msvc')
const name = `acde-${version}-${triple}`
const dir = join(out, version)
const stage = join(dir, `.stage-${triple}`)
const top = join(stage, name)
const lib = join(top, 'lib', 'acde')
rmSync(stage, { recursive: true, force: true })

mkdirSync(join(top, 'bin', 'app', 'dist'), { recursive: true })
mkdirSync(join(lib, 'dist'), { recursive: true })
const crlf = (from: string, to: string) => writeFileSync(to, readFileSync(from, 'utf8').replace(/\r?\n/g, '\r\n'))
if (windows) {
  crlf(join(ROOT, 'scripts', 'acde.cmd'), join(top, 'bin', 'acde.cmd'))
  copyFileSync(acdert, join(top, 'bin', 'acdert.exe'))
} else {
  copyFileSync(join(ROOT, 'scripts', 'acde.sh'), join(top, 'bin', 'acde'))
  copyFileSync(acdert, join(top, 'bin', 'acdert'))
  for (const file of ['acde', 'acdert']) chmodSync(join(top, 'bin', file), 0o755)
}
for (const file of readdirSync(host)) {
  if (file.endsWith('.js')) copyFileSync(join(host, file), join(top, 'bin', 'app', 'dist', file))
}
const shipped = join(top, 'bin', 'app', 'packages', basename(desktop))
mkdirSync(shipped, { recursive: true })
copyFileSync(join(desktop, 'package.json'), join(shipped, 'package.json'))
cpSync(join(desktop, 'dist'), join(shipped, 'dist'), { recursive: true, filter: (from) => !from.endsWith('.map') })

for (const path of ['templates', 'LICENSE', 'launcher.d.mts']) {
  cpSync(join(ROOT, path), join(lib, path), { recursive: true })
}
for (const { entry, file, target } of BUNDLES) await bundle(entry, join(lib, 'dist'), file, target)
await bundle('launcher.mjs', lib, 'launcher.mjs', 'node')
declarations(join(lib, 'dist', 'types'))
writeFileSync(join(lib, 'package.json'), `${JSON.stringify(published(), null, 2)}\n`)
const skipped = (from: string) => !/[\\/](node_modules|test)$/.test(from)
cpSync(api, join(top, 'lib', 'acde-api'), { recursive: true, filter: skipped })

const leaking = leaks(top)
if (leaking.length > 0) {
  rmSync(stage, { recursive: true, force: true })
  throw new Error(`dist would ship sources or source maps:\n${leaking.join('\n')}`)
}

const tarball = join(dir, `${name}.tar.gz`)
const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
const tarExe = process.platform === 'win32' ? join(systemRoot, 'System32', 'tar.exe') : 'tar'
const tarFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
const tar = spawnSync(tarExe, ['-czf', tarball, ...tarFlags, '-C', stage, name], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
if (tar.status !== 0) throw new Error(`tar for ${tarball} failed`)
rmSync(stage, { recursive: true, force: true })

const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const sums = join(dir, 'SHA256SUMS')
const otherLines = (path: string) => readFileSync(path, 'utf8').split('\n')
  .filter((line) => line && !line.endsWith(`  ${name}.tar.gz`))
const lines = existsSync(sums) ? otherLines(sums) : []
const entries = [...lines, `${sum}  ${name}.tar.gz`].sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
writeFileSync(sums, `${entries.join('\n')}\n`)
writeFileSync(join(out, 'latest'), `${version}\n`)
copyFileSync(join(ROOT, 'install.sh'), join(out, 'install.sh'))
copyFileSync(join(ROOT, 'install.ps1'), join(out, 'install.ps1'))
console.log(`${tarball}\n${sum}`)

async function bundle(entry: string, outdir: string, file: string, target: 'node' | 'bun'): Promise<void> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, entry)],
    outdir,
    target,
    format: 'esm',
    naming: { entry: file },
    minify: true,
    sourcemap: 'none',
    external: ['acde/launcher'],
  })
  if (!built.success) throw new AggregateError(built.logs, `bundling ${entry} failed`)
  const path = join(outdir, file)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^#!.*\n(\/\/ @bun.*\n)?/, ''))
}

function declarations(outDir: string): void {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT)
  const program = ts.createProgram([join(ROOT, 'src/driver/index.ts'), join(ROOT, 'src/e2e/index.ts')], {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    rootDir: join(ROOT, 'src'),
    outDir,
  })
  const formatHost = {
    getCanonicalFileName: (file: string) => file,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => '\n',
  }
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) throw new Error(ts.formatDiagnostics(diagnostics, formatHost))
  if (program.emit().emitSkipped) throw new Error('declaration emit skipped')
}

function published() {
  return {
    name: 'acde',
    version,
    description: SELF.description,
    license: SELF.license,
    repository: SELF.repository,
    type: 'module',
    engines: SELF.engines,
    exports: {
      './launcher': { types: './launcher.d.mts', default: './launcher.mjs' },
      './driver': { types: './dist/types/driver/index.d.ts', default: './dist/driver.js' },
      './test': { types: './dist/types/e2e/index.d.ts', default: './dist/test.js' },
      './package.json': './package.json',
    },
  }
}

function leaks(root: string): string[] {
  const files: string[] = []
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else files.push(child)
    }
  }
  walk(root)
  const found = ['lib/acde/src', 'lib/acde/test', 'lib/acde-api/test']
    .filter((path) => existsSync(join(root, path)))
    .map((path) => `${path}: source directory`)
  const isSource = (file: string) => /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file)
  for (const file of files) {
    const path = relative(root, file).split(sep).join('/')
    if (path.endsWith('.map')) found.push(`${path}: source map`)
    else if (isSource(path) && !path.startsWith('lib/acde/templates/')) found.push(`${path}: TypeScript source`)
    if (!/\.(m?js|cjs|json|d\.ts)$/.test(path)) continue
    const text = readFileSync(file, 'utf8')
    if (/sourcesContent/.test(text)) found.push(`${path}: sourcesContent`)
    if (path.startsWith('lib/') && /sourceMappingURL/.test(text)) found.push(`${path}: source map reference`)
  }
  return found
}
