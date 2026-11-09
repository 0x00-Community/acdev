import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXPECTED = ['broker.js', 'web.js']
const FORBIDDEN = [
  { name: 'sourceMappingURL', pattern: /sourceMappingURL/ },
  { name: 'sourcesContent', pattern: /sourcesContent/ },
  { name: 'sourceURL', pattern: /sourceURL\s*=/ },
  { name: 'source map JSON', pattern: /"mappings"\s*:/ },
]

export async function checkRelease(dir) {
  const problems = []
  const files = (await readdir(dir)).sort()
  for (const file of files) {
    if (!EXPECTED.includes(file)) problems.push(`unexpected file ${file}`)
    if (file.endsWith('.map')) problems.push(`source map ${file}`)
  }
  for (const name of EXPECTED) {
    if (!files.includes(name)) {
      problems.push(`missing ${name}`)
      continue
    }
    const text = await readFile(join(dir, name), 'utf8')
    for (const { name: label, pattern } of FORBIDDEN) {
      if (pattern.test(text)) problems.push(`${name} contains ${label}`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`release leak check failed for ${dir}:\n  ${problems.join('\n  ')}`)
  }
  console.log(`release leak check passed for ${dir}: ${files.join(', ')}`)
}

if (import.meta.main) {
  await checkRelease(resolve(process.argv[2] ?? 'dist-release'))
}
