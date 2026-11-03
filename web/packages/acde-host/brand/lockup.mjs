import { LOCKUP, drawLockup } from './mark.mjs'

export function lockup(root) {
  const canvas = root.querySelector('canvas')
  const draw = () => {
    const ratio = globalThis.devicePixelRatio || 1
    const h = canvas.getBoundingClientRect().height
    canvas.style.width = `${h * LOCKUP.width}px`
    canvas.width = Math.max(1, Math.round(h * LOCKUP.width * ratio))
    canvas.height = Math.max(1, Math.round(h * ratio))
    drawLockup(canvas.getContext('2d'), 0, 0, canvas.height, getComputedStyle(root).color)
  }
  draw()
  addEventListener('resize', draw)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw)
  return draw
}
