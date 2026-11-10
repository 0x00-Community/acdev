export interface MimeSource {
  readonly globs2: string | null
  readonly subclasses: string | null
}

interface Glob {
  readonly weight: number
  readonly mime: string
  readonly pattern: string
  readonly literal: boolean
  readonly cs: boolean
  readonly test: (name: string) => boolean
}

const WILDCARD = /[*?[]/

function matcher(pattern: string, caseSensitive: boolean): (name: string) => boolean {
  const fold = (text: string) => (caseSensitive ? text : text.toLowerCase())
  const wanted = fold(pattern)
  if (!WILDCARD.test(pattern)) return (name) => fold(name) === wanted
  if (wanted.startsWith('*') && !WILDCARD.test(wanted.slice(1))) {
    const suffix = wanted.slice(1)
    return (name) => fold(name).endsWith(suffix)
  }
  let source = ''
  for (let i = 0; i < wanted.length; i++) {
    const c = wanted[i]!
    if (c === '*') source += '.*'
    else if (c === '?') source += '.'
    else if (c === '[') {
      const end = wanted.indexOf(']', i + 2)
      if (end < 0) source += '\\['
      else {
        const body = wanted.slice(i + 1, end)
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`.replace(/\\/g, '\\\\')
        i = end
      }
    } else source += c.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  const re = new RegExp(`^${source}$`, 's')
  return (name) => re.test(fold(name))
}

export class MimeDb {
  readonly #globs: readonly Glob[]
  readonly #parents: ReadonlyMap<string, readonly string[]>

  private constructor(globs: readonly Glob[], parents: ReadonlyMap<string, readonly string[]>) {
    this.#globs = globs
    this.#parents = parents
  }

  static parse(sources: readonly MimeSource[]): MimeDb | null {
    if (!sources.some((s) => s.globs2 !== null)) return null
    const globs: Glob[] = []
    const cleared = new Set<string>()
    const parents = new Map<string, string[]>()
    for (const source of sources) {
      const here: Glob[] = []
      const clearing = new Set<string>()
      for (const line of (source.globs2 ?? '').split('\n')) {
        if (!line || line.startsWith('#')) continue
        const [weight, mime, pattern, flags] = line.split(':')
        if (!weight || !mime || pattern === undefined || pattern === '') continue
        if (cleared.has(mime)) continue
        if (pattern === '__NOGLOBS__') {
          clearing.add(mime)
          continue
        }
        const literal = !WILDCARD.test(pattern)
        const cs = (flags ?? '').split(',').includes('cs')
        here.push({ weight: Number(weight) || 50, mime, pattern, literal, cs, test: matcher(pattern, cs) })
      }
      globs.push(...here)
      for (const mime of clearing) cleared.add(mime)
      for (const line of (source.subclasses ?? '').split('\n')) {
        const [child, parent] = line.trim().split(/\s+/)
        if (!child || !parent || child.startsWith('#')) continue
        const list = parents.get(child) ?? []
        if (!list.includes(parent)) list.push(parent)
        parents.set(child, list)
      }
    }
    return new MimeDb(globs, parents)
  }

  candidates(name: string): string[] {
    const matched = this.#globs.filter((g) => g.test(name))
    const literal = matched.filter((g) => g.literal)
    const pool = literal.length ? literal : matched
    if (!pool.length) return []
    const rank = (g: Glob) => [g.weight, g.pattern.length, g.cs ? 1 : 0] as const
    const better = (a: readonly number[], b: readonly number[]) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!
    const top = pool.map(rank).sort(better)[0]!
    return [...new Set(pool.filter((g) => better(rank(g), top) === 0).map((g) => g.mime))]
  }

  isText(mime: string): boolean {
    const seen = new Set<string>()
    const walk = (m: string): boolean => {
      if (m === 'text/plain' || m.startsWith('text/')) return true
      if (seen.has(m)) return false
      seen.add(m)
      return (this.#parents.get(m) ?? []).some(walk)
    }
    return walk(mime)
  }
}

// Common file name extensions with the type shared-mime-info 2.4 gives them on Linux (`gio info`), for hosts without
// that database (Windows, macOS without Homebrew's). Each extension has one type; where Linux decides by content
// (`.ogg`, `.otf`, text files with no glob) this is the type of the usual content.
const TYPES: Readonly<Record<string, string>> = {
  'text/plain': 'txt cjs jsx less ini conf cfg bash cmd swift vue',
  'text/markdown': 'md markdown',
  'application/json': 'json',
  'text/javascript': 'js mjs',
  'text/vnd.trolltech.linguist': 'ts',
  'application/x-tiled-tsx': 'tsx',
  'text/html': 'html htm',
  'application/xhtml+xml': 'xhtml',
  'application/xml': 'xml',
  'text/css': 'css',
  'text/x-scss': 'scss',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/yaml': 'yaml yml',
  'application/toml': 'toml',
  'text/x-log': 'log',
  'application/x-shellscript': 'sh',
  'application/x-powershell': 'ps1',
  'application/x-bat': 'bat',
  'text/x-python': 'py',
  'application/x-ruby': 'rb',
  'text/rust': 'rs',
  'text/x-go': 'go',
  'text/x-csrc': 'c',
  'text/x-chdr': 'h',
  'text/x-c++src': 'cpp cc cxx',
  'text/x-c++hdr': 'hpp',
  'text/x-java': 'java',
  'text/x-kotlin': 'kt',
  'application/x-php': 'php',
  'application/x-perl': 'pl',
  'text/x-lua': 'lua',
  'application/sql': 'sql',
  'text/x-tex': 'tex',
  'application/rtf': 'rtf',
  'text/x-patch': 'diff patch',
  'text/calendar': 'ics',
  'text/vcard': 'vcf',
  'message/rfc822': 'eml',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tif tiff',
  'image/heif': 'heic',
  'image/avif': 'avif',
  'image/vnd.adobe.photoshop': 'psd',
  'audio/mpeg': 'mp3',
  'audio/vnd.wave': 'wav',
  'audio/x-vorbis+ogg': 'ogg oga',
  'audio/x-opus+ogg': 'opus',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/midi': 'mid midi',
  'audio/x-ms-wma': 'wma',
  'video/mp4': 'mp4 m4v',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/vnd.avi': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/mpeg': 'mpg mpeg',
  'video/3gpp': '3gp',
  'video/x-flv': 'flv',
  'application/zip': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-compressed-tar': 'tgz tar.gz',
  'application/x-bzip2': 'bz2',
  'application/x-bzip2-compressed-tar': 'tar.bz2',
  'application/x-xz': 'xz',
  'application/x-xz-compressed-tar': 'tar.xz',
  'application/zstd': 'zst',
  'application/x-zstd-compressed-tar': 'tar.zst',
  'application/x-7z-compressed': '7z',
  'application/vnd.rar': 'rar',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.graphics': 'odg',
  'application/epub+zip': 'epub',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/vnd.efi.iso': 'iso',
  'application/vnd.android.package-archive': 'apk',
  'application/java-archive': 'jar',
  'application/wasm': 'wasm',
  'application/vnd.debian.binary-package': 'deb',
  'application/x-rpm': 'rpm',
}

/** The table above as a shared-mime-info source (`globs2` lines, no subclasses). */
export const BUILTIN_MIME: MimeSource = {
  globs2: Object.entries(TYPES)
    .flatMap(([mime, exts]) => exts.split(' ').map((ext) => `50:${mime}:*.${ext}`))
    .join('\n'),
  subclasses: null,
}
