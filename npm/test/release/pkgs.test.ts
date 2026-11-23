import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../../src/pkgs.ts'

const ROOT = join(import.meta.dir, '../..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')
const INSTALLERS = '../scripts'

describe('the download address', () => {
  test('the install scripts default to Pkgs.ACDEV', () => {
    expect(Pkgs.scriptProblems(read(`${INSTALLERS}/install.sh`), read(`${INSTALLERS}/install.ps1`))).toEqual([])
    expect(Pkgs.scriptProblems(read(`${INSTALLERS}/install.sh`).replaceAll(Pkgs.BASE, 'https://elsewhere'), read(`${INSTALLERS}/install.ps1`)))
      .toEqual([
        `install.sh: the default download address is not ACDEV_DIST=\${ACDEV_DIST:-${Pkgs.ACDEV}}`,
      ])
  })

  test('install.md, AGENTS.md, docs/ and the skill name no other address for acde or acdert', () => {
    const skill = join('skills', 'acdev')
    const markdown = (dir: string) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.md')).map((file) => join(dir, file))
    const pages = [`${INSTALLERS}/install.md`, '../AGENTS.md', join(skill, 'SKILL.md'),
      ...markdown(join(skill, 'references')), ...markdown('../docs')]
    const stale = pages.filter((page) => /https?:\/\/[^\s`'"]+\/(?:acde|acdert)\/install\.(?:sh|ps1|md)/.test(
      read(page).replaceAll(`${Pkgs.ACDEV}/install.`, '')))
    expect(stale).toEqual([])
    expect(read(`${INSTALLERS}/install.md`)).toContain(`curl -fsSL ${Pkgs.ACDEV}/install.sh | sh`)
    expect(read(`${INSTALLERS}/install.md`)).toContain(`irm ${Pkgs.ACDEV}/install.ps1 | iex`)
  })
})
