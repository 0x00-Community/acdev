// Self time per function in V8 CPU profiles written by acde with ACDE_PROFILE_DIR (see AGENTS.md "日志和计时").
// Usage: bun packaging/qemu/profile-top.mjs [--top N] [--callers NAME] FILE.cpuprofile...   (several files of one web add up)
// --callers: where NAME's self time comes from (its callers, 4 frames up)
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let top = 30
let callers = null
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top') top = Number(args[++i])
  else if (args[i] === '--callers') callers = args[++i]
  else files.push(args[i])
}
if (files.length === 0) {
  console.error('usage: profile-top.mjs [--top N] [--callers NAME] FILE.cpuprofile...')
  process.exit(2)
}

const self = new Map()
let total = 0
let idle = 0
for (const file of files) {
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  const frames = new Map(profile.nodes.map((node) => {
    const { functionName, url, lineNumber } = node.callFrame
    const where = url ? `${url.split('/').slice(-2).join('/')}:${lineNumber + 1}` : ''
    return [node.id, `${functionName || '(anonymous)'} ${where}`.trim()]
  }))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000
    total += ms
    let frame = frames.get(id)
    if (frame === '(idle)') idle += ms
    if (callers !== null) {
      if (!frame.startsWith(`${callers} `) && frame !== callers) return
      const chain = []
      for (let up = parents.get(id); up !== undefined && chain.length < 4; up = parents.get(up)) chain.push(frames.get(up).split(' ')[0])
      frame = chain.join(' < ')
    }
    self.set(frame, (self.get(frame) ?? 0) + ms)
  })
}

const busy = total - idle
console.log(`${files.length} profile(s), ${total.toFixed(0)} ms sampled, ${busy.toFixed(0)} ms not idle`)
for (const [frame, ms] of [...self].filter(([frame]) => frame !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${ms.toFixed(1).padStart(9)} ms ${((ms / busy) * 100).toFixed(1).padStart(5)}%  ${frame}`)
}
