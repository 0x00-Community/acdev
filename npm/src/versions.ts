import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from 'acde/launcher'

declare const ACDE_SDK_VERSION: string | undefined

export class Versions {
  static acde(): string {
    const file = join(import.meta.dirname, '..', 'package.json')
    return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
  }

  static sdk(): string {
    if (typeof ACDE_SDK_VERSION === 'string') return ACDE_SDK_VERSION
    const file = join(packageRoot(), 'node_modules', '@dopame', 'acde-api', 'package.json')
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
    } catch {
      return 'unknown'
    }
  }

  static newer(a: string, b: string): boolean {
    const [x, y] = [a, b].map((v) => v.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0))
    for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!
    return false
  }
}
