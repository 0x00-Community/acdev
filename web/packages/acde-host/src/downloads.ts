import { existsSync, mkdirSync, writeFileSync } from './sys/fs'
import { userDir } from './sys/os'
import { join } from './sys/path'

const EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html', 'text/markdown': 'md', 'text/css': 'css', 'text/javascript': 'js',
  'application/json': 'json', 'application/pdf': 'pdf', 'application/zip': 'zip', 'application/xml': 'xml', 'image/png': 'png',
  'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm',
}

export class Downloads {
  static save(name: string, type: string, bytes: Uint8Array): string {
    const dir = userDir('DOWNLOAD', 'Downloads')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, Downloads.unique(Downloads.fileName(name, type), (candidate) => existsSync(join(dir, candidate))))
    writeFileSync(path, bytes)
    return path
  }

  static fileName(name: string, type: string): string {
    let clean = String(name).split(/[/\\]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/^\.+/, '')
    if (clean.length > 200) {
      const ext = /\.[a-z0-9]{1,8}$/i.exec(clean)?.[0] ?? ''
      clean = clean.slice(0, 200 - ext.length) + ext
    }
    if (!clean) clean = 'download'
    const ext = EXTENSIONS[type.split(';')[0]!.trim().toLowerCase()]
    if (ext && !/\.[a-z0-9]{1,8}$/i.test(clean)) clean = `${clean}.${ext}`
    return clean
  }

  static unique(name: string, taken: (name: string) => boolean): string {
    if (!taken(name)) return name
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    for (let n = 1; ; n++) {
      const candidate = `${stem} (${n})${ext}`
      if (!taken(candidate)) return candidate
    }
  }
}
