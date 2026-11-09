import { build } from 'esbuild'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
const out = join(root, 'dist')
const outSrc = join(out, 'src')

await rm(out, { recursive: true, force: true })
await mkdir(outSrc, { recursive: true })

const sources = (await readdir(src, { recursive: true })).map((name) => name.split('\\').join('/')).filter((name) => /\.(js|ts)$/.test(name))
const scripts = sources.filter((name) => (name.endsWith('.js') || name.endsWith('.ts')) && !name.endsWith('.d.ts'))
const declarations = sources.filter((name) => name.endsWith('.d.ts'))

await build({
  entryPoints: scripts.map((name) => join(src, name)),
  outdir: outSrc,
  outbase: src,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  bundle: false,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
})

for (const name of declarations) {
  await mkdir(dirname(join(outSrc, name)), { recursive: true })
  await copyFile(join(src, name), join(outSrc, name))
}

const tsconfig = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
const config = ts.readConfigFile(tsconfig, ts.sys.readFile).config
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(tsconfig))
const typed = scripts.filter((name) => name.endsWith('.ts')).map((name) => join(src, name))
const program = ts.createProgram(typed, {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  declarationMap: false,
  sourceMap: false,
  rootDir: src,
  outDir: outSrc,
})
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length > 0) {
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }
  console.error(ts.formatDiagnostics(diagnostics, host))
  process.exit(1)
}
const expected = new Set(typed.map((file) => join(outSrc, relative(src, file).replace(/\.ts$/, '.d.ts'))))
const emitted = program.emit(undefined, (file, text) => {
  if (!expected.has(resolve(file))) throw new Error(`unexpected declaration output ${file}`)
  ts.sys.writeFile(file, text)
})
if (emitted.emitSkipped) throw new Error('declaration emit skipped')

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { private: _, scripts: __, devDependencies: ___, ...published } = manifest
published.exports = Object.fromEntries(
  Object.entries(manifest.exports).map(([path, target]) => [
    path,
    typeof target === 'string' && target.endsWith('.ts') && !target.endsWith('.d.ts')
      ? { types: target.replace(/\.ts$/, '.d.ts'), default: target.replace(/\.ts$/, '.js') }
      : target,
  ]),
)
await writeFile(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

for (const file of manifest.files) {
  if (file === 'src') continue
  await copyFile(join(root, file), join(out, file))
}

const license = await readFile(join(root, '../../../LICENSE'), 'utf8')
const notice = license.split(/\n\s*\n/).filter((paragraph) => !paragraph.startsWith('Third-party')).join('\n\n').trim()
await writeFile(join(out, 'LICENSE'), `${notice}\n`)

const shipped = []
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else shipped.push(path)
  }
}
await walk(out)

const leaks = []
for (const file of shipped) {
  const name = relative(out, file)
  if (name.endsWith('.map')) leaks.push(`${name}: source map`)
  else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) leaks.push(`${name}: TypeScript source`)
  else if (!/\.(js|d\.ts|json)$/.test(name) && name !== 'LICENSE') leaks.push(`${name}: unexpected file`)
  const text = await readFile(file, 'utf8')
  if (/sourceMappingURL|sourcesContent/.test(text)) leaks.push(`${name}: source map reference`)
}
if (leaks.length > 0) {
  console.error(`dist would leak sources:\n${leaks.join('\n')}`)
  process.exit(1)
}

console.log(`${relative(process.cwd(), out) || '.'}: ${shipped.length} files, ${published.name}@${published.version}`)
