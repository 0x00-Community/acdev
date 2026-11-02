import { drawMark, drawSparkle } from './mark.mjs'

function fit(canvas) {
  const ratio = globalThis.devicePixelRatio || 1
  const { width, height } = canvas.getBoundingClientRect()
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  return canvas.getContext('2d')
}

export function lockup(root) {
  const mark = root.querySelector('canvas.mark')
  const sparkle = root.querySelector('canvas.sparkle')
  const draw = () => {
    if (mark) drawMark(fit(mark), 0, 0, mark.width, 'gradient')
    if (sparkle) drawSparkle(fit(sparkle), sparkle.width / 2, sparkle.height / 2, sparkle.width / 2, getComputedStyle(sparkle).color)
  }
  draw()
  addEventListener('resize', draw)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw)
  return draw
}
