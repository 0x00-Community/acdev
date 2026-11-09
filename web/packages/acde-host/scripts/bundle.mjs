import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'
import { releaseObfuscation } from './release-options.mjs'
import { checkRelease } from './check-release.mjs'

const release = process.argv.includes('--release')
const outdir = release ? 'dist-release' : 'dist'
const entryPoints = { broker: 'src/main.ts', web: 'src/worker.ts' }
const shared = {
  entryPoints,
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  conditions: ['source'],
  mainFields: ['module', 'main'],
  minifyWhitespace: true,
  minifySyntax: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
}

if (!release) {
  await build({ ...shared, sourcemap: 'linked' })
} else {
  await mkdir(outdir, { recursive: true })
  await build({ ...shared, minifyIdentifiers: true, sourcemap: false })
  for (const name of Object.keys(entryPoints)) {
    const file = join(outdir, `${name}.js`)
    const source = await readFile(file, 'utf8')
    const result = JavaScriptObfuscator.obfuscate(source, releaseObfuscation)
    await writeFile(file, result.getObfuscatedCode())
    console.log(`obfuscated ${file} (${source.length} -> ${result.getObfuscatedCode().length} bytes)`)
  }
  await checkRelease(outdir)
}
