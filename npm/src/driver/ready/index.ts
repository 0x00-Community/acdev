import type { InspectWindow } from '@acde/api'
import type { Web } from '../types.ts'

export const BACKEND_PREFIX = 'backend:'

export function ordinary(web: Web): boolean {
  if (web.lock === true) return false
  if (web.kind !== 'app' && web.kind !== 'desktop') return false
  return !web.app?.startsWith(BACKEND_PREFIX)
}

export function ready(webs: readonly Web[], windows: readonly InspectWindow[]): boolean {
  return windows.length > 0 && webs.filter(ordinary).every((web) => windows.some((w) => w.id === web.window))
}
