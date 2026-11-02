export function fileURLToPath(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url
  if (parsed.protocol !== 'file:') throw new TypeError(`not a file URL: ${parsed.href}`)
  return decodeURIComponent(parsed.pathname)
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.split('/').map(encodeURIComponent).join('/')}`)
}
