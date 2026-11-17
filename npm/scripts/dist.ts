import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import JavaScriptObfuscator from 'javascript-obfuscator'
import ts from 'typescript'
import { Bundler } from '../src/bundler.ts'
import { API_LEVEL } from '../src/manifest/level.ts'
import { Pkgs } from '../src/pkgs.ts'
import { shipLeaks } from './shipped.ts'
import { skillProblems } from './skill.ts'

const ROOT = resolve(import.meta.dirname, '..')
const INSTALLERS = resolve(ROOT, '..', 'scripts')
const SELF = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  description: string
  license: string
  repository: object
  engines: object
}
const CLI = 'src/cli.ts'
const SHARED = ['src/driver/index.ts', 'src/e2e/index.ts']
const OBFUSCATION_SEED = 1
const PINNED_TIME = new Date('2000-01-01T00:00:00Z')
const OBFUSCATION = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal' as const,
  renameGlobals: true,
  reservedStrings: ['getBuiltinModule'],
  seed: OBFUSCATION_SEED,
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
    api: { type: 'string', default: join(ROOT, 'acde-api') },
    sdk: { type: 'string' },
    runtime: { type: 'string' },
    version: { type: 'string', default: SELF.version },
    out: { type: 'string', default: join(ROOT, '.dist') },
  },
})

const api = resolve(values.api!)
const version = values.version!
const out = resolve(values.out!)
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--version ${version}: x.y.z`)
if (!existsSync(join(api, 'package.json')) || !existsSync(join(api, 'src', 'index.js'))) {
  throw new Error(`--api ${api}: not a built @dopame/acde-api package (package.json and src/index.js)`)
}
const sdk = JSON.parse(readFileSync(join(api, 'package.json'), 'utf8')) as { name?: string; version?: string }
if (sdk.name !== '@dopame/acde-api' || (values.sdk !== undefined && sdk.version !== values.sdk)) {
  throw new Error(`--api ${api} is ${sdk.name} ${sdk.version}, not @dopame/acde-api ${values.sdk}`)
}
const runtime = values.runtime === undefined ? null : resolve(values.runtime)
if (runtime !== null && !existsSync(runtime)) throw new Error(`--runtime ${runtime}: no such directory`)

const skill = join(ROOT, 'skills', 'acdev')
const unfit = skillProblems(skill)
if (unfit.length > 0) throw new Error(`skills/acdev does not follow the skill rules:\n${unfit.join('\n')}`)

const name = `acdev-${version}`
const dir = join(out, version)
const stage = join(dir, '.stage')
const top = join(stage, name)
const lib = join(top, 'lib', 'acdev')
rmSync(stage, { recursive: true, force: true })

mkdirSync(join(top, 'bin'), { recursive: true })
mkdirSync(join(lib, 'dist'), { recursive: true })
copyFileSync(join(ROOT, 'bin', 'acdev.sh'), join(top, 'bin', 'acdev'))
chmodSync(join(top, 'bin', 'acdev'), 0o755)
const cmd = readFileSync(join(ROOT, 'bin', 'acdev.cmd'), 'utf8').replace(/\r?\n/g, '\r\n')
writeFileSync(join(top, 'bin', 'acdev.cmd'), cmd)
for (const path of ['templates', 'skills', 'launcher.d.mts']) cpSync(join(ROOT, path), join(lib, path), { recursive: true })
copyFileSync(join(ROOT, 'LICENSE'), join(top, 'LICENSE'))
copyFileSync(join(ROOT, 'LICENSE'), join(lib, 'LICENSE'))
const preload = {
  ACDEV_LISTEN_JSON: JSON.stringify(JSON.stringify(await Bundler.buildPreload())),
  ACDEV_SDK_VERSION: JSON.stringify(sdk.version),
  ACDEV_API_LEVEL: String(API_LEVEL),
}
await bundle([CLI], join(lib, 'dist'), 'cli.js', 'node')
await bundle(SHARED, join(lib, 'dist'), undefined, 'bun')
await bundle(['launcher.mjs'], lib, 'launcher.mjs', 'node')
declarations(join(lib, 'dist', 'types'))
writeFileSync(join(lib, 'package.json'), `${JSON.stringify(published(), null, 2)}\n`)
const skipped = (from: string) => !/[\\/](node_modules|test)$/.test(from)
cpSync(api, join(top, 'lib', 'acde-api'), { recursive: true, filter: skipped })
pinTimes(top)

const leaking = shipLeaks(top)
if (leaking.length > 0) {
  rmSync(stage, { recursive: true, force: true })
  throw new Error(`dist would ship sources or source maps:\n${leaking.join('\n')}`)
}

const tarball = join(dir, `${name}.tar.gz`)
const plain = join(dir, `${name}.tar`)
const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
const tarExe = process.platform === 'win32' ? join(systemRoot, 'System32', 'tar.exe') : 'tar'
const tarFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
const tar = spawnSync(tarExe, ['-cf', plain, ...tarFlags, '-C', stage, name], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
if (tar.status !== 0) throw new Error(`tar for ${tarball} failed`)
writeFileSync(tarball, gzipSync(readFileSync(plain), { level: 9 }))
rmSync(plain, { force: true })
rmSync(stage, { recursive: true, force: true })

const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const sdkStage = join(dir, '.sdk')
rmSync(sdkStage, { recursive: true, force: true })
cpSync(api, join(sdkStage, 'package'), { recursive: true, filter: skipped })
pinTimes(sdkStage)
const sdkPlain = join(dir, `acde-api-${sdk.version}.tar`)
const sdkTar = spawnSync(tarExe, ['-cf', sdkPlain, ...tarFlags, '-C', sdkStage, 'package'], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
rmSync(sdkStage, { recursive: true, force: true })
if (sdkTar.status !== 0) throw new Error(`tar for acde-api-${sdk.version}.tar.gz failed`)
writeFileSync(`${sdkPlain}.gz`, gzipSync(readFileSync(sdkPlain), { level: 9 }))
rmSync(sdkPlain, { force: true })
if (runtime !== null) for (const file of readdirSync(runtime)) copyFileSync(join(runtime, file), join(dir, file))
const sums = readdirSync(dir).filter((file) => file !== 'SHA256SUMS' && !file.startsWith('.')).sort()
  .map((file) => `${createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')}  ${file}\n`)
writeFileSync(join(dir, 'SHA256SUMS'), sums.join(''))
writeFileSync(join(out, 'latest'), `${version}\n`)
const scripts = ['install.sh', 'install.ps1'].map((file) => readFileSync(join(INSTALLERS, file), 'utf8'))
const addresses = Pkgs.scriptProblems(scripts[0]!, scripts[1]!)
if (addresses.length > 0) throw new Error(addresses.join('\n'))
copyFileSync(join(INSTALLERS, 'install.sh'), join(out, 'install.sh'))
copyFileSync(join(INSTALLERS, 'install.ps1'), join(out, 'install.ps1'))
copyFileSync(join(INSTALLERS, 'install.md'), join(out, 'install.md'))
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
    splitting: shared || file === 'cli.js',
    root: shared ? join(ROOT, 'src') : ROOT,
    naming: { entry: shared ? '[dir]/[name].js' : file!, chunk: 'chunk-[hash].js' },
    minify: true,
    sourcemap: 'none',
    external: ['acdev/launcher'],
    define: preload,
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

function pinTimes(path: string): void {
  utimesSync(path, PINNED_TIME, PINNED_TIME)
  if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) pinTimes(join(path, entry))
}

function published() {
  return {
    name: 'acdev',
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
