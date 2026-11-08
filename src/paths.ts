import { dirname, isAbsolute, relative, sep } from 'node:path'

export const SKIPPED = new Set(['.acde', 'node_modules', '.git', 'dist', 'build', 'out', '.next', '.output', '.nuxt', '.svelte-kit', '.astro', '.turbo', '.cache'])

export function contains(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

export function up<T>(from: string, found: (dir: string) => T | null | undefined | false): T | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const value = found(dir)
    if (value !== null && value !== undefined && value !== false) return value
    if (dirname(dir) === dir) return null
  }
}

export function slug(text: string): string {
  return text.replace(/[<>:"/\\|?*\s]+/g, '-').replace(/^-+|-+$/g, '')
}
