// The stress app's WindowApp: a counter it paints every frame, and on a request {action} it misbehaves or reports:
//   oom       allocates until its Worker's heap limit          hang      loops forever
//   throw     throws from a timer (a page error, contained)    minimize  asks for its window to be minimised
//   probe     calls what its manifest does not allow (acde.open('term'), acde.fs) and titles the window with what it got
//   keep: true   refuses the next beforeclose once
// It suspends with its count (acde.window 'suspend') and, resumed, titles the window 「resumed <count>」.
let keep = false
export default {
  id: 'stress',
  label: '压力测试',
  icon: 'bug_report',
  mount(element, host) {
    const win = globalThis.acde.window
    host.setTitle('压力测试')
    host.setMenus([{ id: 'stress', label: '压力', items: [{ id: 'title', label: '改标题', onSelect: () => host.setTitle('改过了') }] }])
    element.innerHTML = '<div style="height: 100%; background: #702CDB; color: #fff; font: 600 40px/1 sans-serif; padding: 40px; box-sizing: border-box">running <span id="n">0</span></div>'
    let n = 0
    const tick = () => { element.querySelector('#n').textContent = String(++n); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    win.on('beforeclose', () => { if (keep) { keep = false; return false } return true })
    win.on('suspend', () => ({ n }))
    win.on('resume', (state) => host.setTitle(`resumed ${state?.n ?? '?'}`))
    const act = (detail) => {
      if (detail.keep) keep = true
      if (detail.action === 'oom') { const hold = []; for (;;) hold.push(new Array(1e6).fill(Math.random())) }
      if (detail.action === 'hang') for (;;) {}
      if (detail.action === 'throw') setTimeout(() => { throw new Error('stress: thrown on purpose') }, 0)
      if (detail.action === 'minimize') win.minimize()
      if (detail.action === 'probe') {
        globalThis.acde.open('term', {}).then(() => host.setTitle(`probe opened fs=${typeof globalThis.acde.fs}`), (e) => host.setTitle(`probe refused ${e.status} fs=${typeof globalThis.acde.fs}`))
      }
    }
    addEventListener('agentrt:open-app', (e) => { if (e.detail?.app === 'stress') act(e.detail) })
    for (const ask of globalThis.__agentrtAsks ?? []) if (ask.app === 'stress') act(ask.detail)
    return () => {}
  },
}
