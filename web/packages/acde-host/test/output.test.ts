import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Outputs } from '../src/broker/output.ts'

const primary = { mode: 'fullscreen', appId: 'solo' }
const other = { mode: 'free', appId: 'solo' }

test('the standalone primary window gets the host monitor once the host reports it', () => {
  const outputs = new Outputs(1024, 768, 1)
  const main = outputs.update({ type: 'output', width: 1280, height: 800, scale: 1 }, 'solo')!
  assert.deepEqual([main.to(primary), main.to(other)], [true, true], 'before a host output everyone shares the host window')
  const host = outputs.update({ type: 'hostoutput', width: 3840, height: 2160, scale: 1.5 }, 'solo')!
  assert.deepEqual([host.to(primary), host.to(other)], [true, false])
  assert.deepEqual(host.screen, { width: 2560, height: 1440, scale: 1.5, workArea: { x: 0, y: 0, width: 2560, height: 1440 } })
  const work = outputs.update({ type: 'hostworkarea', x: 0, y: 0, width: 2560, height: 1392 }, 'solo')!
  assert.equal(work.screen.workArea.height, 1392)
  const resized = outputs.update({ type: 'output', width: 1000, height: 700, scale: 1 }, 'solo')!
  assert.deepEqual([resized.to(primary), resized.to(other)], [false, true])
  assert.equal(outputs.screen(true).width, 2560)
  assert.equal(outputs.screen(false).width, 1000)
  assert.equal(Outputs.host(primary, null), false, 'no primary outside standalone mode')
})

test('an output and its work area that change together reach the pages as one screen', () => {
  const outputs = new Outputs(1024, 768, 2)
  outputs.update({ type: 'workarea', x: 0, y: 0, width: 1361, height: 835 }, 'solo')
  outputs.update({ type: 'output', width: 2722, height: 1670, scale: 2 }, 'solo')
  assert.deepEqual(outputs.take().map((change) => change.screen), [{ width: 1361, height: 835, scale: 2, workArea: { x: 0, y: 0, width: 1361, height: 835 } }])
  assert.deepEqual(outputs.take(), [], 'told once')
  outputs.update({ type: 'workarea', x: 0, y: 0, width: 400, height: 300 }, 'solo')
  outputs.update({ type: 'output', width: 800, height: 600, scale: 2 }, 'solo')
  const changes = outputs.take()
  assert.deepEqual(changes.map((change) => change.screen), [{ width: 400, height: 300, scale: 2, workArea: { x: 0, y: 0, width: 400, height: 300 } }])
  assert.deepEqual([changes[0]!.to(primary), changes[0]!.to(other)], [true, true])
  outputs.update({ type: 'output', width: 800, height: 600, scale: 2 }, 'solo')
  assert.deepEqual(outputs.take(), [], 'an event that changes nothing tells nobody')
  outputs.update({ type: 'hostoutput', width: 3840, height: 2160, scale: 2 }, 'solo')
  outputs.update({ type: 'workarea', x: 0, y: 30, width: 400, height: 270 }, 'solo')
  assert.deepEqual(outputs.take().map((change) => [change.screen.width, change.screen.workArea.height, change.to(primary)]), [[1920, 1080, true], [400, 270, false]])
})
