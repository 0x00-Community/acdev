import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../src/pkgs.ts'

const ROOT = join(import.meta.dir, '..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

describe('the download address', () => {
  test('the install scripts default to Pkgs.ACDE and Pkgs.ACDERT', () => {
    expect(Pkgs.scriptProblems(read('install.sh'), read('install.ps1'))).toEqual([])
    expect(Pkgs.scriptProblems(read('install.sh').replaceAll(Pkgs.BASE, 'https://elsewhere'), read('install.ps1')))
      .toEqual([
        `install.sh: the default download address is not ACDE_DIST=\${ACDE_DIST:-${Pkgs.ACDE}}`,
        `install.sh: the default download address is not ACDERT_DIST=\${ACDERT_DIST:-${Pkgs.ACDERT}}`,
      ])
  })

  test('install.md, AGENTS.md and the skill name no other address for acde or acdert', () => {
    const skill = join('skills', 'acde')
    const pages = ['install.md', 'AGENTS.md', join(skill, 'SKILL.md'),
      ...readdirSync(join(ROOT, skill, 'references'), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.md')).map((file) => join(skill, 'references', file))]
    const stale = pages.filter((page) => /https?:\/\/[^\s`'"]+\/(?:acde|acdert)\/install\.(?:sh|ps1|md)/.test(
      read(page).replaceAll(`${Pkgs.ACDE}/install.`, '')))
    expect(stale).toEqual([])
    expect(read('install.md')).toContain(`curl -fsSL ${Pkgs.ACDE}/install.sh | sh`)
    expect(read('install.md')).toContain(`irm ${Pkgs.ACDE}/install.ps1 | iex`)
  })
})
