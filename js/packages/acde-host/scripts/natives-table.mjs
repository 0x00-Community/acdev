import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

const sources = [
  ['DOM', '../../acde-dom/src/native.ts', 'DomNative'],
  ['SURFACE', '../src/native.ts', 'NativeSurface'],
  ['DESK', '../src/desk.ts', 'IsolateDesk'],
]

function methods(text, name) {
  const start = text.indexOf(`export interface ${name} `)
  if (start < 0) throw new Error(`natives-table: no interface ${name}`)
  const end = text.indexOf('\n}', start)
  const kinds = {}
  for (const line of text.slice(start, end).split('\n').slice(1)) {
    const m = /^\s+(\w+)\??\((.*)\): (.+)$/.exec(line)
    if (!m) continue
    const ret = m[3].trim()
    kinds[m[1]] = ret === 'void' ? 'w' : ret.startsWith('Promise<') ? 'a' : 'r'
  }
  return kinds
}

let out = ''
for (const [constant, path, name] of sources) {
  const kinds = methods(readFileSync(here(path), 'utf8'), name)
  out += `export const ${constant}: Readonly<Record<string, 'r' | 'w' | 'a'>> = ${JSON.stringify(kinds, null, 2)}\n\n`
}
writeFileSync(here('../src/kernel/natives.gen.ts'), out.trimEnd() + '\n')
