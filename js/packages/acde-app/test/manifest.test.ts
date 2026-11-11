import { expect, test } from 'bun:test'
import { Manifest } from '../src/manifest'

const app = { id: 'console', label: 'Console', icon: 'dash', entry: '/ui/console.js' }

test('an app\'s services grant those desktop services, its capabilities win', () => {
  const parsed = Manifest.app({ ...app, services: ['agentrt', 'npu'], capabilities: { npu: false, fs: true } })
  expect(typeof parsed).toBe('object')
  expect((parsed as { capabilities: unknown }).capabilities).toEqual({ agentrt: true, npu: false, fs: true })
})

test('services must be service names', () => {
  expect(Manifest.app({ ...app, services: 'npu' })).toBe('app console: services must be the names of the desktop services it calls')
  expect(Manifest.app({ ...app, services: [''] })).toBe('app console: services must be the names of the desktop services it calls')
})
