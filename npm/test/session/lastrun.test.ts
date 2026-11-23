import { describe, expect as check, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as LastRun from '../../src/e2e/lastrun.ts'
import { prune } from '../../src/e2e/archive.ts'

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="2" skipped="0">
  <testsuite name="a.e2e.ts" file="a.e2e.ts" tests="3" failures="2" skipped="0">
    <testsuite name="group &lt;x&gt;" file="a.e2e.ts" tests="2" failures="1" skipped="0">
      <testcase name="fails &amp; &quot;quoted&quot;" classname="group &lt;x&gt;" time="0.1" file="a.e2e.ts">
        <failure type="AssertionError" message="no">AssertionError</failure>
      </testcase>
      <testcase name="passes" classname="group &lt;x&gt;" time="0.1" file="a.e2e.ts" />
    </testsuite>
    <testcase name="top fails" classname="" time="0.1" file="a.e2e.ts">
      <failure type="AssertionError" message="no">AssertionError</failure>
    </testcase>
  </testsuite>
</testsuites>`

describe('the last run', () => {
  test('the failed tests are read from the JUnit report bun writes, names unescaped', () => {
    check(LastRun.failedIn(JUNIT)).toEqual(['fails & "quoted"', 'top fails'])
    check(LastRun.failedIn('<testsuites tests="1" failures="0"><testcase name="ok" /></testsuites>')).toEqual([])
  })

  test('the pattern matches exactly those names at the end of the full name, regex characters taken literally', () => {
    const pattern = new RegExp(LastRun.pattern(['fails & "quoted"', 'a (b)', 'a (b)']))
    check(pattern.test('group <x> fails & "quoted"')).toBe(true)
    check(pattern.test('a (b)')).toBe(true)
    check(pattern.test('a b')).toBe(false)
    check(pattern.test('top fails and more')).toBe(false)
  })

  test('it is written beside the runs, read back, and survives pruning the runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'acdev-last-run-'))
    try {
      check(LastRun.read(root)).toBeNull()
      LastRun.write(root, [{ file: 'e2e/a.e2e.ts', test: 'top fails' }])
      check(LastRun.read(root)).toEqual({ status: 'failed', failed: [{ file: 'e2e/a.e2e.ts', test: 'top fails' }] })
      prune(root, 0)
      check(JSON.parse(readFileSync(join(root, LastRun.FILE), 'utf8')).status).toBe('failed')
      LastRun.write(root, [])
      check(LastRun.read(root)).toEqual({ status: 'passed', failed: [] })
      writeFileSync(join(root, LastRun.FILE), 'not json')
      check(LastRun.read(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
