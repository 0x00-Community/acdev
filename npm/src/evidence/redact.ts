import type { InspectMatch, InspectNode, InspectWindow } from '@acde/api'
import { Png } from '../driver/png.ts'
import type { QueryOptions, QueryResult, Snapshot } from '../driver/types.ts'
import { BLOCK_RGBA, PLACEHOLDER, SECRET_REFERENCE, SYSTEM_WINDOW_MODES, TOKEN_SHAPES, USER_ONLY_SELECTOR } from '../redaction/index.ts'

type Box = readonly [number, number, number, number]

export interface PrivacyScene {
  snapshot(options: { readonly all: boolean; readonly offscreen: boolean }): Promise<Snapshot>
  query(options: QueryOptions): Promise<QueryResult>
}

export interface Private {
  readonly snapshot: Snapshot
  readonly userOnly: readonly { readonly window: InspectWindow; readonly match: InspectMatch }[]
}

export class Tally {
  readonly counts: Record<string, number> = {}

  add(kind: string, n = 1): void {
    if (n > 0) this.counts[kind] = (this.counts[kind] ?? 0) + n
  }
}

type SystemMode = (typeof SYSTEM_WINDOW_MODES)[number]
const system = (window: InspectWindow): SystemMode | null => SYSTEM_WINDOW_MODES.find((mode) => mode === window.mode) ?? null

export async function gather(scene: PrivacyScene): Promise<Private> {
  const snapshot = await scene.snapshot({ all: true, offscreen: true })
  const pages = snapshot.windows.filter((w) => w.kind !== 'native' && !w.hidden && !system(w))
  const userOnly: { window: InspectWindow; match: InspectMatch }[] = []
  for (const window of pages) {
    const found = await scene.query({ selector: USER_ONLY_SELECTOR, window: window.ref }).catch(() => null)
    for (const match of found?.nodes ?? []) userOnly.push({ window, match })
  }
  return { snapshot, userOnly }
}

export function text(body: string, tally: Tally): string {
  let out = body
  const [reference, called] = SECRET_REFERENCE
  out = out.replace(new RegExp(reference.source, 'g'), () => {
    tally.add(`text: ${called}`)
    return `secret://${PLACEHOLDER}`
  })
  for (const [shape, name] of TOKEN_SHAPES) {
    out = out.replace(new RegExp(shape.source, `${shape.flags.replace('g', '')}g`), () => {
      tally.add(`text: ${name}`)
      return `${PLACEHOLDER} (${name})`
    })
  }
  return out
}

function refsUnder(nodes: readonly InspectNode[], into: Set<string>): void {
  for (const node of nodes) {
    into.add(node.ref)
    refsUnder(node.children ?? [], into)
  }
}

function hiddenRefs(seen: Private, tally: Tally): Set<string> {
  const hidden = new Set<string>()
  const roots = new Set(seen.userOnly.map((u) => u.match.ref))
  const walk = (nodes: readonly InspectNode[]) => {
    for (const node of nodes) {
      if (roots.has(node.ref)) {
        const before = hidden.size
        refsUnder([node], hidden)
        tally.add('snapshot: data-user-only', hidden.size - before)
      } else walk(node.children ?? [])
    }
  }
  for (const window of seen.snapshot.windows) {
    const tree = seen.snapshot.trees[window.ref] ?? []
    const kind = system(window)
    if (!kind) {
      walk(tree)
      continue
    }
    const before = hidden.size
    refsUnder(tree, hidden)
    tally.add(`snapshot: ${kind}`, hidden.size - before)
  }
  return hidden
}

export function snapshot(seen: Private, tally: Tally): string {
  const hidden = hiddenRefs(seen, tally)
  return seen.snapshot.text
    .split('\n')
    .map((line) => {
      const ref = /\[(w\d+\.\d+)\]\s*$/.exec(line)?.[1]
      return ref && hidden.has(ref) ? line.replace(/"(?:[^"\\]|\\.)*"/g, `"${PLACEHOLDER}"`) : line
    })
    .join('\n')
}

export function regions(seen: Private, tally: Tally): Box[] {
  const boxes: Box[] = []
  for (const window of seen.snapshot.windows) {
    const kind = system(window)
    if (kind && !window.hidden) {
      boxes.push(window.rect)
      tally.add(`screen: ${kind}`)
    }
  }
  for (const { match } of seen.userOnly) {
    if (!match.rect || !match.visible) continue
    boxes.push(match.rect)
    tally.add('screen: data-user-only')
  }
  return boxes
}

function screenSize(windows: readonly InspectWindow[]): readonly [number, number] {
  const desktop = windows.find((w) => w.kind === 'desktop')
  if (desktop) return [desktop.rect[0] + desktop.rect[2], desktop.rect[1] + desktop.rect[3]]
  return [Math.max(1, ...windows.map((w) => w.rect[0] + w.rect[2])), Math.max(1, ...windows.map((w) => w.rect[1] + w.rect[3]))]
}

export function cover(png: Buffer, boxes: readonly Box[], windows: readonly InspectWindow[]): Buffer {
  if (!boxes.length) return png
  let image = Png.decode(png)
  const [width, height] = screenSize(windows)
  const sx = image.width / width
  const sy = image.height / height
  for (const [x, y, w, h] of boxes) image = Png.fill(image, Math.floor(x * sx), Math.floor(y * sy), Math.ceil(w * sx), Math.ceil(h * sy), BLOCK_RGBA)
  return Png.encode(image)
}
