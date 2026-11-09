import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MimeDb } from '../src/mimedb.ts'

const globs2 = `# comment
80:application/x-heavy:*.foo
50:text/x-light:*.foo
50:text/x-makefile:Makefile
50:text/x-makefile:makefile
10:text/x-makefile:*.mk
50:application/gzip:*.gz
50:application/x-compressed-tar:*.tar.gz
50:text/markdown:*.md
50:text/x-c++src:*.C:cs
50:text/x-csrc:*.c
50:text/vnd.trolltech.linguist:*.ts
50:video/mp2t:*.ts
50:text/troff:*.[1-9]
40:text/x-readme:README*
50:application/x-gone:*.gone
`
const subclasses = `text/vnd.trolltech.linguist application/xml
application/xml text/plain
`

const db = MimeDb.parse([{ globs2, subclasses }])!

describe('MimeDb', () => {
  test('no database at all', () => {
    assert.equal(MimeDb.parse([{ globs2: null, subclasses: null }]), null)
  })

  test('literal names beat patterns', () => {
    assert.deepEqual(db.candidates('Makefile'), ['text/x-makefile'])
    assert.deepEqual(db.candidates('MAKEFILE'), ['text/x-makefile'])
  })

  test('higher weight, then the longer pattern', () => {
    assert.deepEqual(db.candidates('a.foo'), ['application/x-heavy'])
    assert.deepEqual(db.candidates('a.tar.gz'), ['application/x-compressed-tar'])
    assert.deepEqual(db.candidates('a.gz'), ['application/gzip'])
  })

  test('case-insensitive unless marked cs, and cs wins a tie', () => {
    assert.deepEqual(db.candidates('NOTES.MD'), ['text/markdown'])
    assert.deepEqual(db.candidates('a.C'), ['text/x-c++src'])
    assert.deepEqual(db.candidates('a.c'), ['text/x-csrc'])
  })

  test('full globs and classes', () => {
    assert.deepEqual(db.candidates('ls.1'), ['text/troff'])
    assert.deepEqual(db.candidates('README.txt'), ['text/x-readme'])
  })

  test('ties stay ambiguous', () => {
    assert.deepEqual(db.candidates('main.ts'), ['text/vnd.trolltech.linguist', 'video/mp2t'])
  })

  test('nothing matches', () => {
    assert.deepEqual(db.candidates('archive.unknownext'), [])
  })

  test('text is text/* or a subclass of text/plain', () => {
    assert.equal(db.isText('text/markdown'), true)
    assert.equal(db.isText('application/xml'), true)
    assert.equal(db.isText('text/vnd.trolltech.linguist'), true)
    assert.equal(db.isText('video/mp2t'), false)
  })

  test('__NOGLOBS__ in a more important directory drops the globs below it', () => {
    const user = '50:application/x-gone:__NOGLOBS__\n50:text/x-mine:*.gone\n'
    const merged = MimeDb.parse([{ globs2: user, subclasses: null }, { globs2, subclasses }])!
    assert.deepEqual(merged.candidates('a.gone'), ['text/x-mine'])
    assert.deepEqual(merged.candidates('a.md'), ['text/markdown'])
  })
})
