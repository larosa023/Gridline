// Pure geometry + quantity math. Points are [x, y] in PDF points.
import { slopeFactor, hipFactor } from './units.js';

export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

export function polygonPerimeter(pts) {
  if (pts.length < 2) return 0;
  return polylineLength(pts) + dist(pts[pts.length - 1], pts[0]);
}

/** Shoelace formula, absolute value. */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(a / 2);
}

export function centroid(pts) {
  if (!pts.length) return [0, 0];
  if (pts.length < 3) {
    const x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [x, y];
  }
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return centroid(pts.slice(0, 2));
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

export function midpointOfPolyline(pts) {
  const total = polylineLength(pts);
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (run + seg >= total / 2) {
      const t = seg ? (total / 2 - run) / seg : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    run += seg;
  }
  return pts[0] || [0, 0];
}

/** Snap `p` relative to `anchor` to the nearest 45° direction (Shift-drawing). */
export function orthoSnap(anchor, p) {
  const dx = p[0] - anchor[0];
  const dy = p[1] - anchor[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [anchor[0] + Math.cos(ang) * len, anchor[1] + Math.sin(ang) * len];
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (!l2) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0],
      yi = pts[i][1],
      xj = pts[j][0],
      yj = pts[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Effective pitch for a markup: its own override, else its condition's. */
export function markupPitch(m, cond) {
  const own = m && m.pitch != null && m.pitch !== '' ? +m.pitch : NaN;
  if (isFinite(own)) return own;
  return cond && isFinite(+cond.pitch) ? +cond.pitch : 0;
}

/**
 * Raw quantities of one markup, in real units.
 * scale: { ptPerUnit, unit }. cond (optional) supplies pitch / roof-line settings.
 */
/** A markup's typical multiplier ("this floor plan ×4"). */
export const markupMult = (m) => (m && +m.mult > 0 ? +m.mult : 1);

export function markupQuantities(m, scale, cond) {
  const q = rawQuantities(m, scale, cond);
  const n = markupMult(m);
  if (n !== 1 && !q.unscaled) for (const k of ['length', 'planLength', 'area', 'perimeter', 'planArea', 'squares', 'count']) if (q[k] != null) q[k] *= n;
  return q;
}

function rawQuantities(m, scale, cond) {
  const k = scale && scale.ptPerUnit ? scale.ptPerUnit : null;
  if (m.type === 'count') return { count: m.points.length };
  if (!k) return { unscaled: true };
  if (m.type === 'linear') {
    let length = polylineLength(m.points) / k;
    const planLength = length;
    const pitch = markupPitch(m, cond);
    if (cond && cond.roofLine === 'rake' && pitch) length *= slopeFactor(pitch);
    if (cond && cond.roofLine === 'hip' && pitch) length *= hipFactor(pitch);
    return { length, planLength, segments: Math.max(0, m.points.length - 1) };
  }
  if (m.type === 'area' || m.type === 'roof') {
    const sign = m.deduct ? -1 : 1;
    const plan = (polygonArea(m.points) / (k * k)) * sign;
    const q = { area: plan, perimeter: polygonPerimeter(m.points) / k };
    if (m.type === 'roof') {
      const pitch = markupPitch(m, cond);
      q.pitch = pitch;
      q.planArea = plan;
      q.area = plan * slopeFactor(pitch);
      q.squares = q.area / 100;
    }
    return q;
  }
  return {};
}

/**
 * Roll up a condition's markups into its derived quantities.
 * Linear: length (LF; true length for rake/hip lines), wall area if height set (SF).
 * Area: area (SF), perimeter (LF), volume if depth (in) set (CY), perimeter x height.
 * Roof: planArea (SF), area = sloped roof area (SF), squares (SQ), perimeter (LF).
 * Count: count (EA).
 */
export function conditionTotals(cond, markups, scaleFor) {
  const t = { length: 0, area: 0, perimeter: 0, count: 0, volume: 0, planArea: 0, squares: 0, unscaled: 0, markups: 0 };
  for (const m of markups) {
    if (m.conditionId !== cond.id) continue;
    t.markups++;
    const q = markupQuantities(m, scaleFor(m.pageKey), cond);
    if (q.unscaled) {
      t.unscaled++;
      continue;
    }
    t.length += q.length || 0;
    t.area += q.area || 0;
    t.perimeter += q.perimeter || 0;
    t.count += q.count || 0;
    t.planArea += q.planArea || 0;
    t.squares += q.squares || 0;
  }
  const metric = cond.unit === 'm';
  const h = +cond.height || 0;
  if (cond.type === 'linear' && h) t.area = t.length * h;
  if (cond.type === 'area') {
    const depth = +cond.depth || 0; // inches (or mm for metric)
    if (depth) {
      t.volume = metric ? t.area * (depth / 1000) : (t.area * (depth / 12)) / 27;
    }
    if (h) t.wallArea = t.perimeter * h;
  }
  if (cond.type === 'roof' && metric) t.squares = 0;
  return t;
}

/** Which quantity a condition is priced on. */
export function costBasisOptions(cond) {
  if (cond.type === 'linear') return cond.height ? ['length', 'area'] : ['length'];
  if (cond.type === 'area') {
    const o = ['area', 'perimeter'];
    if (cond.depth) o.push('volume');
    if (cond.height) o.push('wallArea');
    return o;
  }
  if (cond.type === 'roof') return cond.unit === 'm' ? ['area', 'planArea', 'perimeter'] : ['squares', 'area', 'planArea', 'perimeter'];
  return ['count'];
}

export function basisUnit(basis, unit = 'ft') {
  const metric = unit === 'm';
  return (
    {
      length: metric ? 'm' : 'LF',
      perimeter: metric ? 'm' : 'LF',
      area: metric ? 'm²' : 'SF',
      planArea: metric ? 'm²' : 'SF',
      wallArea: metric ? 'm²' : 'SF',
      volume: metric ? 'm³' : 'CY',
      squares: 'SQ',
      count: 'EA',
    }[basis] || ''
  );
}

export function basisLabel(basis, cond) {
  if (basis === 'area' && cond && cond.type === 'roof') return 'Roof area';
  return (
    {
      length: 'Length',
      perimeter: 'Perimeter',
      area: 'Area',
      planArea: 'Plan area',
      wallArea: 'Wall area',
      volume: 'Volume',
      squares: 'Squares',
      count: 'Count',
    }[basis] || basis
  );
}

/** Priced line for a condition. */
export function priceLine(cond, totals) {
  const opts = costBasisOptions(cond);
  // A slab/fill with a thickness is normally priced per CY / m³.
  const fallback = cond.type === 'area' && cond.depth ? 'volume' : opts[0];
  const basis = cond.costBasis && opts.includes(cond.costBasis) ? cond.costBasis : fallback;
  const qty = totals[basis] || 0;
  const waste = +cond.waste || 0;
  const qtyW = qty * (1 + waste / 100);
  const mat = qtyW * (+cond.matCost || 0);
  const lab = qtyW * (+cond.laborCost || 0);
  return { basis, qty, qtyW, mat, lab, total: mat + lab };
}

export function estimateSummary(lines, settings) {
  const mat = lines.reduce((s, l) => s + l.mat, 0);
  const lab = lines.reduce((s, l) => s + l.lab, 0);
  const tax = mat * ((+settings.taxPct || 0) / 100);
  const sub = mat + lab + tax;
  const overhead = sub * ((+settings.overheadPct || 0) / 100);
  const profit = (sub + overhead) * ((+settings.profitPct || 0) / 100);
  return { mat, lab, tax, sub, overhead, profit, total: sub + overhead + profit };
}
