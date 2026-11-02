export const COLORS = {
  pink: '#F24FD3',
  coral: '#FF6F8E',
  orange: '#FF9A3C',
  yellow: '#FFC21C',
  ink: '#12141C',
  paper: '#FFFFFF',
  night: '#0E0F14',
};

export const GRADIENT = [
  [0, COLORS.pink],
  [0.45, COLORS.coral],
  [0.75, COLORS.orange],
  [1, COLORS.yellow],
];

const RAYS = 36;
const SMALL = 64;
const TINY = 28;
const CENTER = 0.5;
const D = { left: 0.07, top: 0.07, bottom: 0.93, radius: 0.43, corner: 0.2 };
const STAR = 0.2;
const WIDTH = { inner: 0.011, outer: 0.03 };

function insideD(x, y) {
  if (x >= CENTER) return Math.hypot(x - CENTER, y - CENTER) <= D.radius;
  if (x < D.left || y < D.top || y > D.bottom) return false;
  const cx = D.left + D.corner;
  const cyTop = D.top + D.corner;
  const cyBottom = D.bottom - D.corner;
  if (x < cx && y < cyTop) return Math.hypot(x - cx, y - cyTop) <= D.corner;
  if (x < cx && y > cyBottom) return Math.hypot(x - cx, y - cyBottom) <= D.corner;
  return true;
}

function edgeD(dx, dy) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (insideD(CENTER + dx * t, CENTER + dy * t)) lo = t;
    else hi = t;
  }
  return lo;
}

function edgeStar(dx, dy) {
  const c = Math.pow(Math.abs(dx), 2 / 3) + Math.pow(Math.abs(dy), 2 / 3);
  return STAR / Math.pow(c, 1.5);
}

export function rays(count, weight) {
  const n = count || RAYS;
  const w = weight || 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const r0 = WIDTH.inner / 2 * w;
    const outer = edgeD(dx, dy);
    const span = outer - edgeStar(dx, dy);
    const r1 = (WIDTH.inner / 2 + (WIDTH.outer - WIDTH.inner) / 2 * Math.min(1, span / 0.3)) * w;
    const t0 = edgeStar(dx, dy) + 0.035 + r0;
    const t1 = outer - r1;
    out.push({ x0: CENTER + dx * t0, y0: CENTER + dy * t0, x1: CENTER + dx * t1, y1: CENTER + dy * t1, r0, r1 });
  }
  return out;
}

function rayPath(ctx, ray, x, y, s) {
  const x0 = x + ray.x0 * s;
  const y0 = y + ray.y0 * s;
  const x1 = x + ray.x1 * s;
  const y1 = y + ray.y1 * s;
  const r0 = ray.r0 * s;
  const r1 = ray.r1 * s;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const a = Math.atan2(y1 - y0, x1 - x0);
  const tilt = Math.asin(Math.max(-1, Math.min(1, (r1 - r0) / len)));
  const side = Math.PI / 2 + tilt;
  ctx.moveTo(x0 + Math.cos(a + side) * r0, y0 + Math.sin(a + side) * r0);
  ctx.lineTo(x1 + Math.cos(a + side) * r1, y1 + Math.sin(a + side) * r1);
  ctx.arc(x1, y1, r1, a + side, a - side, true);
  ctx.lineTo(x0 + Math.cos(a - side) * r0, y0 + Math.sin(a - side) * r0);
  ctx.arc(x0, y0, r0, a - side, a + side - Math.PI * 2, true);
  ctx.closePath();
}

export function gradient(ctx, x, y, s) {
  const g = ctx.createLinearGradient(x + 0.12 * s, y + 0.9 * s, x + 0.9 * s, y + 0.12 * s);
  for (const [at, color] of GRADIENT) g.addColorStop(at, color);
  return g;
}

export function drawMark(ctx, x, y, size, fill) {
  ctx.save();
  ctx.beginPath();
  const [count, weight] = size < TINY ? [RAYS / 3, 2.6] : size < SMALL ? [RAYS / 2, 1.7] : [RAYS, 1];
  for (const ray of rays(count, weight)) rayPath(ctx, ray, x, y, size);
  ctx.fillStyle = !fill || fill === 'gradient' ? gradient(ctx, x, y, size) : fill;
  ctx.fill();
  ctx.restore();
}

export function drawSparkle(ctx, cx, cy, r, fill) {
  const steps = 48;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const px = cx + r * Math.sign(c) * Math.pow(Math.abs(c), 3);
    const py = cy + r * Math.sign(s) * Math.pow(Math.abs(s), 3);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

export function drawIcon(ctx, x, y, size, dark) {
  const r = size * 0.225;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + size, y, x + size, y + size, r);
  ctx.arcTo(x + size, y + size, x, y + size, r);
  ctx.arcTo(x, y + size, x, y, r);
  ctx.arcTo(x, y, x + size, y, r);
  ctx.closePath();
  ctx.fillStyle = dark ? COLORS.night : COLORS.paper;
  ctx.fill();
  ctx.restore();
  drawMark(ctx, x + size * 0.17, y + size * 0.17, size * 0.66, 'gradient');
}

export const WORDMARK = { name: 'Dopame', family: 'Outfit', weight: 500 };

export function drawLockup(ctx, x, y, height, ink, family) {
  const mark = height;
  drawMark(ctx, x, y, mark, 'gradient');
  const size = height * 0.94;
  ctx.save();
  ctx.font = `${WORDMARK.weight} ${size}px ${family || WORDMARK.family}`;
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  const tx = x + mark * 1.3;
  const base = y + height * 0.83;
  ctx.fillText(WORDMARK.name, tx, base);
  const w = ctx.measureText(WORDMARK.name).width;
  ctx.restore();
  drawSparkle(ctx, tx + w + size * 0.12, base - size * 0.74, size * 0.14, ink);
  return tx + w + size * 0.26 - x;
}
