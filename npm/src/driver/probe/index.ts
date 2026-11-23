export type Raster =
  | { readonly path: 'gpu'; readonly adapter: string; readonly driver: string; readonly backend: string; readonly software: boolean }
  | { readonly path: 'cpu'; readonly canvases: string | null }
  | { readonly path: 'lost'; readonly adapter: string }
  | { readonly path: 'none' }
  | { readonly path: 'pending' }

export interface RenderLayer {
  readonly panel?: number
  readonly rect: readonly [number, number, number, number]
  readonly kind: 'glass' | 'frost'
  readonly group?: string
  readonly pieces?: number
  readonly element?: string
  readonly drawn: string
  readonly degraded?: string
}

export interface CompositorArea {
  readonly window: number
  readonly surface: number
  readonly rect: readonly [number, number, number, number]
  readonly drawn: string
}

export type CompositorRender =
  | { readonly composer: 'gpu' | 'cpu'; readonly device: string; readonly driver: string; readonly areas: readonly CompositorArea[] }
  | { readonly error: string }

export type CompositorHit =
  | {
    readonly window: number
    readonly role: string
    readonly surface: number
    readonly local: readonly [number, number]
    readonly beneath: readonly number[]
  }
  | { readonly error: string }

export interface Render {
  readonly web: string
  readonly window: string | null
  readonly raster: Raster & { readonly degraded?: string }
  readonly composedBy: 'host-window' | 'compositor'
  readonly layers: readonly RenderLayer[]
  readonly compositor?: CompositorRender
}

export interface HitElement {
  readonly ref: string
  readonly line: string
  readonly tag: string
}

export interface Hit {
  readonly x: number
  readonly y: number
  readonly window: { readonly ref: string; readonly app: string | null; readonly title: string | null } | null
  readonly surface: 'page' | 'decoration' | 'panel' | 'native' | 'none'
  readonly local?: readonly [number, number]
  readonly element?: HitElement & { readonly chain: readonly HitElement[]; readonly through: readonly HitElement[] }
  readonly gone?: true
  readonly note?: string
  readonly compositor?: CompositorHit
}

export interface Prober {
  webList(): Promise<{ readonly webs: readonly { readonly name: string }[] }>
  render(web: string): Promise<Render>
}

export const CHAIN_SHOWN = 4

export function point(args: readonly string[]): { x: number; y: number } {
  const [x, y] = args.map(Number) as [number, number]
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`hit: ${args.join(' ')}: x and y are numbers (acdev hit --help)`)
  return { x, y }
}

export interface Wanted {
  readonly web?: string
  readonly window?: string
}

export function wanted(flags: ReadonlyMap<string, string>): Wanted {
  const [web, window] = [flags.get('web'), flags.get('window')]
  return { ...(web !== undefined && { web }), ...(window !== undefined && { window }) }
}

export async function renders(acde: Prober, wanted: Wanted): Promise<Render[]> {
  const names = wanted.web === undefined ? (await acde.webList()).webs.map((w) => w.name) : [wanted.web]
  const answers: Render[] = []
  for (const name of names) answers.push(await acde.render(name))
  const shown = wanted.window === undefined ? answers : answers.filter((a) => a.window === wanted.window)
  if (!shown.length && wanted.window !== undefined) throw new Error(`render: no page shows window ${wanted.window} (acdev webs lists them)`)
  return shown
}

export function rasterText(raster: Render['raster']): string {
  switch (raster.path) {
    case 'gpu':
      return `gpu (${[raster.adapter, raster.backend, raster.driver].filter(Boolean).join(', ')}${raster.software ? ', a software adapter' : ''})`
    case 'cpu':
      return `cpu${raster.canvases ? ` (canvases on ${raster.canvases})` : ''}, degraded: no-gpu`
    case 'lost':
      return `lost (${raster.adapter} went away), degraded: no-gpu`
    case 'none':
      return 'none (no device: the page shows nothing), degraded: no-gpu'
    case 'pending':
      return 'pending (the device is not published yet)'
  }
}

export function renderText(answers: readonly Render[]): string {
  const lines: string[] = []
  for (const a of answers) {
    const by = a.composedBy === 'host-window' ? 'the host window composes the glass' : 'the compositor composes the glass'
    lines.push(`${a.window ?? '-'} ${a.web}: raster ${rasterText(a.raster)}; ${by}`)
    if (!a.layers.length) lines.push('  (no layer with a backdrop-filter)')
    else lines.push(...layerRows(a))
    if (a.compositor) lines.push(...composed(a.compositor))
  }
  return lines.join('\n')
}

function layerRows(a: Render): string[] {
  const rows = a.layers.map((l) => [
    l.panel === undefined ? (a.window ?? '-') : `panel ${l.panel}`,
    l.element ?? '-',
    l.kind,
    l.group ? `${l.group} (${l.pieces ?? 1})` : '-',
    l.rect.map(Math.round).join(','),
    l.drawn,
    l.degraded ?? '-',
  ])
  return table([['window', 'element', 'kind', 'group', 'rect', 'page', 'degraded'], ...rows])
}

function composed(compositor: CompositorRender): string[] {
  if ('error' in compositor) return [`  compositor: not asked (${compositor.error})`]
  const device = compositor.composer === 'gpu' ? ` (${[compositor.device, compositor.driver].filter(Boolean).join(', ')})` : ''
  const head = `  compositor: ${compositor.composer}${device}`
  if (!compositor.areas.length) return [`${head}; no glass or frost of this window`]
  const rows = compositor.areas.map((area) => [`acompositor-${area.window}`, String(area.surface), area.rect.join(','), area.drawn])
  return [head, ...table([['window', 'surface', 'rect (pixels)', 'drawn'], ...rows]).map((row) => `  ${row}`)]
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)))
  return rows.map((r) => `  ${r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  ')}`)
}

export function hitText(hit: Hit): string {
  const at = `${hit.x},${hit.y}`
  const tail = hit.compositor ? `\n${landedText(hit.compositor)}` : ''
  if (!hit.window) return `${at}: no window there${tail}`
  const window = `${hit.window.ref} (${hit.window.title ?? hit.window.app ?? 'untitled'})`
  const local = hit.local ? ` at ${hit.local.join(',')}` : ''
  const head = `${at}: ${window} ${surfaceText(hit.surface)}${local}`
  return `${pageText(hit, head)}${tail}`
}

function pageText(hit: Hit, head: string): string {
  if (hit.gone) return `${head}: the page went away before it answered; ask again`
  if (hit.note) return `${head} (${hit.note})`
  if (!hit.element) return head
  const { line, chain, through } = hit.element
  const parents = chain.slice(0, CHAIN_SHOWN).map((e) => e.line)
  const more = chain.length > CHAIN_SHOWN ? ` < … ${chain.length - CHAIN_SHOWN} more` : ''
  const passed = through.length ? `\n  passed through (pointer-events: none): ${through.map((e) => e.line).join('; ')}` : ''
  return `${head}\n  ${[line, ...parents].join(' < ')}${more}${passed}`
}

function landedText(compositor: CompositorHit): string {
  if ('error' in compositor) return `  compositor: not asked (${compositor.error})`
  if (!compositor.window) return `  compositor: ${compositor.role === 'none' ? 'nothing there' : `a ${compositor.role} surface`}`
  const covers = compositor.beneath.length ? `; covers ${compositor.beneath.map((n) => `acompositor-${n}`).join(', ')}` : ''
  return `  compositor: acompositor-${compositor.window} ${compositor.role} at ${compositor.local.map(Math.round).join(',')}${covers}`
}

function surfaceText(surface: Hit['surface']): string {
  switch (surface) {
    case 'page':
      return 'page'
    case 'decoration':
      return 'title bar'
    case 'panel':
      return 'desktop panel'
    case 'native':
      return 'native window'
    case 'none':
      return 'nothing'
  }
}
