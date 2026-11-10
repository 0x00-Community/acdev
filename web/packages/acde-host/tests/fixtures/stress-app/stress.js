import win from 'acde:window'
import { open } from 'acde:open'

let keep = false
export default {
  mount(element, host) {
    host.setTitle('压力测试')
    host.setMenus([{ id: 'stress', label: '压力', items: [{ id: 'title', label: '改标题', onSelect: () => host.setTitle('改过了') }] }])
    element.innerHTML = '<div style="height: 100%; background: #702CDB; color: #fff; font: 600 40px/1 sans-serif; padding: 40px; box-sizing: border-box">running <span id="n">0</span></div>'
    let n = 0
    const tick = () => { element.querySelector('#n').textContent = String(++n); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    win.on('beforeclose', () => { if (keep) { keep = false; return false } return true })
    win.on('request', async (detail) => {
      if (detail.keep) keep = true
      if (detail.action === 'oom') { const hold = []; for (;;) hold.push(new Array(1e6).fill(Math.random())) }
      if (detail.action === 'hang') for (;;) {}
      if (detail.action === 'throw') setTimeout(() => { throw new Error('stress: thrown on purpose') }, 0)
      if (detail.action === 'minimize') win.minimize()
      if (detail.action === 'probe') {
        const fs = await import('acde:fs').then(() => 'object', () => 'undefined')
        open('term').then(() => host.setTitle(`probe opened fs=${fs}`), (e) => host.setTitle(`probe refused ${e.status} fs=${fs}`))
      }
    })
    return () => {}
  },
}
