import { sys } from './natives'

export function normalize(path: string): string {
  if (!path) return '.'
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else out.push(part)
  }
  const joined = out.join('/')
  const trailing = path.endsWith('/') && joined ? '/' : ''
  return absolute ? `/${joined}${trailing}` : (joined || '.') + trailing
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== '').join('/'))
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

export function resolve(...parts: string[]): string {
  let path = ''
  for (let i = parts.length - 1; i >= 0 && !path.startsWith('/'); i--) path = parts[i] ? `${parts[i]}/${path}` : path
  if (!path.startsWith('/')) path = `${sys().cwd()}/${path}`
  const out = normalize(path)
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out
}

export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const at = trimmed.lastIndexOf('/')
  if (at < 0) return '.'
  if (at === 0) return '/'
  return trimmed.slice(0, at)
}

export function basename(path: string, ext?: string): string {
  const name = path.replace(/\/+$/, '').split('/').pop() ?? ''
  return ext && name.endsWith(ext) && name !== ext ? name.slice(0, -ext.length) : name
}
