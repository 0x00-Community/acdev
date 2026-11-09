import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import JavaScriptObfuscator from 'javascript-obfuscator'
import ts from 'typescript'
import { shipLeaks } from './shipped.ts'

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
const CLI = 'src/cli.ts'
const SHARED = ['src/driver/index.ts', 'src/e2e/index.ts']
const OBFUSCATION = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal' as const,
  renameGlobals: true,
  reservedStrings: ['getBuiltinModule'],
  selfDefending: false,
  simplify: true,
  sourceMap: false,
  stringArray: true,
  stringArrayEncoding: ['base64' as const],
  stringArrayThreshold: 0.75,
  target: 'node' as const,
  unicodeEscapeSequence: false,
}

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
const host = resolve(need('host', values.host, 'the acdert host bundle: the app/ directory of acdert-host'))
const api = resolve(values.api!)
const desktop = resolve(values.desktop!)
const triple = need('triple', values.triple, `rust target triple: ${TRIPLES.join(', ')}`)
const version = values.version!
const out = resolve(values.out!)
if (!TRIPLES.includes(triple)) throw new Error(`--triple ${triple}: one of ${TRIPLES.join(', ')}`)
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--version ${version}: x.y.z`)
if (!statSync(acdert).isFile()) throw new Error(`--acdert ${acdert}: not a file`)
if (!existsSync(join(host, 'dist', 'broker.js'))) throw new Error(`--host ${host}: no dist/broker.js in it`)
const hostVersion = (JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')) as { version?: string }).version
if (hostVersion !== version) {
  throw new Error(`--host ${host} is version ${hostVersion ?? 'unknown'}, not ${version}: `
    + 'only the host of the same release ships')
}
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

mkdirSync(join(top, 'bin'), { recursive: true })
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
cpSync(host, join(top, 'bin', 'app'), { recursive: true, filter: (from) => !from.endsWith('.map') })
const shipped = join(top, 'bin', 'app', 'packages', basename(desktop))
mkdirSync(shipped, { recursive: true })
copyFileSync(join(desktop, 'package.json'), join(shipped, 'package.json'))
cpSync(join(desktop, 'dist'), join(shipped, 'dist'), { recursive: true, filter: (from) => !from.endsWith('.map') })

for (const path of ['templates', 'LICENSE', 'launcher.d.mts']) {
  cpSync(join(ROOT, path), join(lib, path), { recursive: true })
}
copyFileSync(join(ROOT, 'LICENSE'), join(top, 'LICENSE'))
await bundle([CLI], join(lib, 'dist'), 'cli.js', 'node')
await bundle(SHARED, join(lib, 'dist'), undefined, 'bun')
await bundle(['launcher.mjs'], lib, 'launcher.mjs', 'node')
declarations(join(lib, 'dist', 'types'))
writeFileSync(join(lib, 'package.json'), `${JSON.stringify(published(), null, 2)}\n`)
const skipped = (from: string) => !/[\\/](node_modules|test)$/.test(from)
cpSync(api, join(top, 'lib', 'acde-api'), { recursive: true, filter: skipped })

const leaking = shipLeaks(top)
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

async function bundle(
  entries: string[], outdir: string, file: string | undefined, target: 'node' | 'bun',
): Promise<void> {
  const shared = entries.length > 1
  const built = await Bun.build({
    entrypoints: entries.map((entry) => join(ROOT, entry)),
    outdir,
    target,
    format: 'esm',
    splitting: shared,
    root: shared ? join(ROOT, 'src') : ROOT,
    naming: shared ? { entry: '[dir]/[name].js', chunk: 'chunk-[hash].js' } : { entry: file! },
    minify: true,
    sourcemap: 'none',
    external: ['acde/launcher'],
  })
  if (!built.success) throw new AggregateError(built.logs, `bundling ${entries.join(', ')} failed`)
  for (const output of built.outputs) {
    if (output.kind !== 'entry-point' && output.kind !== 'chunk') continue
    const minified = (await output.text()).replace(/^#!.*\n(\/\/ @bun.*\n)?/, '')
    writeFileSync(output.path, JavaScriptObfuscator.obfuscate(minified, OBFUSCATION).getObfuscatedCode())
  }
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
      './driver': { types: './dist/types/driver/index.d.ts', default: './dist/driver/index.js' },
      './test': { types: './dist/types/e2e/index.d.ts', default: './dist/e2e/index.js' },
      './package.json': './package.json',
    },
  }
}

