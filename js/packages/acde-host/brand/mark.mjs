import ART from './art.mjs';

const mix = (a, b, t) => {
  const p = (c, i) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return '#' + [0, 1, 2].map((i) => ('0' + Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16)).slice(-2)).join('').toUpperCase();
};

export const COLORS = {
  pink: ART.gradient.to,
  coral: mix(ART.gradient.to, ART.gradient.from, 0.3),
  orange: mix(ART.gradient.to, ART.gradient.from, 0.7),
  yellow: ART.gradient.from,
  ink: ART.ink,
  paper: '#FFFFFF',
  night: '#0E0F14',
};

export const GRADIENT = [
  [0, COLORS.pink],
  [1, COLORS.yellow],
];

export const WORDMARK = { name: ART.word.map((g) => g.char).join('') };

export const LOCKUP = {
  word: ART.word,
  spark: ART.spark,
  sparkAt: ART.wordSpark,
  baseline: ART.wordBaseline,
  width: ART.wordWidth,
};

export const RAYS = ART.rays;

function compile(d) {
  return d
    .replace(/([MLCZ])/g, '|$1')
    .split('|')
    .filter((part) => part)
    .map((part) => {
      const rest = part.slice(1).trim();
      return [part[0], rest ? rest.split(/\s+/).map(Number) : []];
    });
}

const cache = new Map();
const ops = (d) => {
  let o = cache.get(d);
  if (!o) cache.set(d, (o = compile(d)));
  return o;
};

function trace(ctx, d, x, y, s) {
  for (const [op, n] of ops(d)) {
    if (op === 'M') ctx.moveTo(x + n[0] * s, y + n[1] * s);
    else if (op === 'L') ctx.lineTo(x + n[0] * s, y + n[1] * s);
    else if (op === 'C') ctx.bezierCurveTo(x + n[0] * s, y + n[1] * s, x + n[2] * s, y + n[3] * s, x + n[4] * s, y + n[5] * s);
    else ctx.closePath();
  }
}

const SMALL = 64;
const TINY = 28;

export function drawMark(ctx, x, y, size, fill) {
  const own = !fill || fill === 'gradient';
  const bold = size < SMALL ? (size < TINY ? 0.02 : 0.012) * size : 0;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = bold;
  if (!own) {
    ctx.fillStyle = ctx.strokeStyle = fill;
    ctx.beginPath();
  }
  for (const ray of RAYS) {
    if (own) {
      ctx.fillStyle = ctx.strokeStyle = ray.color;
      ctx.beginPath();
    }
    trace(ctx, ray.d, x, y, size);
    if (own) {
      ctx.fill();
      if (bold) ctx.stroke();
    }
  }
  if (!own) {
    ctx.fill();
    if (bold) ctx.stroke();
  }
  ctx.restore();
}

export function drawSparkle(ctx, cx, cy, r, fill) {
  ctx.save();
  ctx.beginPath();
  trace(ctx, ART.spark, cx, cy, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

export function drawIcon(ctx, x, y, size, dark) {
  ctx.save();
  ctx.beginPath();
  trace(ctx, ART.tile, x, y, size);
  ctx.fillStyle = dark ? COLORS.night : COLORS.paper;
  ctx.fill();
  ctx.restore();
  const [mx, my, ms] = ART.tileMark;
  drawMark(ctx, x + mx * size, y + my * size, ms * size, 'gradient');
}

export function drawLockup(ctx, x, y, height, ink, mark) {
  drawMark(ctx, x, y, height, mark || 'gradient');
  ctx.save();
  ctx.beginPath();
  for (const g of ART.word) trace(ctx, g.d, x, y, height);
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.restore();
  const [sx, sy, sr] = ART.wordSpark;
  drawSparkle(ctx, x + sx * height, y + sy * height, sr * height, ink);
  return ART.wordWidth * height;
}
