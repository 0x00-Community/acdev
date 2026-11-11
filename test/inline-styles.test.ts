import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { InlineStyles } from '../src/inline-styles.ts'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

const BASE = '/app/notes/'

function project(): { dir: string; out: string; entry: string } {
  const dir = tmp()
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets/mono.ttf'), 'font')
  writeFileSync(join(dir, 'assets/bg.png'), 'png')
  const out = join(dir, 'out')
  mkdirSync(out)
  return { dir, out, entry: join(dir, 'index.html') }
}

describe('InlineStyles', () => {
  test('an inline @font-face with a relative url() is copied and pointed under the base', () => {
    const { dir, out, entry } = project()
    const html = '<style>@font-face { font-family: Mono; src: url("./assets/mono.ttf"); }</style>'
    const done = new InlineStyles(entry, out, BASE, dir).rewrite(html)
    const [file] = readdirSync(out)
    expect(file).toMatch(/^mono-[0-9a-f]{8}\.ttf$/)
    expect(readFileSync(join(out, file!), 'utf8')).toBe('font')
    expect(done).toBe(`<style>@font-face { font-family: Mono; src: url("${BASE}${file}"); }</style>`)
  })

  test('style attributes, unquoted URLs and ?/# suffixes; one copy per file', () => {
    const { dir, out, entry } = project()
    const html = `<div style="background: url('assets/bg.png#a')"></div>` +
      '<p style=\'background: url(assets/bg.png?v=1)\'></p>'
    const done = new InlineStyles(entry, out, BASE, dir).rewrite(html)
    const files = readdirSync(out)
    expect(files).toHaveLength(1)
    expect(done).toBe(`<div style="background: url('${BASE}${files[0]}#a')"></div>` +
      `<p style='background: url(${BASE}${files[0]}?v=1)'></p>`)
  })

  test('/x, #x, data: and https: URLs stay as they are', () => {
    const { dir, out, entry } = project()
    const html = '<style>a { background: url(/fonts/x.woff2), url(#m), url("data:image/png;base64,AA"), ' +
      "url('https://example.com/x.png'); }</style>"
    expect(new InlineStyles(entry, out, BASE, dir).rewrite(html)).toBe(html)
    expect(readdirSync(out)).toEqual([])
  })

  test('a missing file fails with the URL and the entry', () => {
    const { dir, out, entry } = project()
    expect(() => new InlineStyles(entry, out, BASE, dir).rewrite('<style>a { background: url(./gone.png) }</style>'))
      .toThrow('./gone.png in an inline style in index.html: there is no gone.png')
  })
})
