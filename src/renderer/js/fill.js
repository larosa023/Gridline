// Click-to-fill: find the closed region (room) around a point using the sheet's vector linework.
// 1. Rasterize all line segments into a mask (lines thickened by a gap tolerance).
// 2. Flood fill from the click. If it escapes to the sheet edge or floods most of the sheet,
//    the room isn't closed (a door opening without a swing, a gap) and we report that.
// 3. Trace the outer boundary of the filled pixels, simplify it, then snap each corner
//    onto the exact wall-line geometry so quantities aren't limited by raster resolution.
import { findSnap } from './snap.js';

const MAX_SIDE = 3200; // raster resolution cap (px on the long side)

/** Pure raster core, exported for tests. mask: Uint8Array (1 = line), w × h. */
export function floodRegion(mask, w, h, sx, sy, maxFrac = 0.6) {
  const idx = (x, y) => y * w + x;
  // If the click landed on a line, try the open pixels around it and keep the first side
  // that is a closed region (clicking right on a wall usually means "this room").
  if (mask[idx(sx, sy)]) {
    for (let r = 1; r <= 6; r++) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        const x = sx + dx,
          y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || mask[idx(x, y)]) continue;
        const res = floodRegion(mask, w, h, x, y, maxFrac);
        if (!res.error) return res;
      }
    }
    return { error: 'online' };
  }
  const fill = new Uint8Array(w * h);
  const stack = [sx, sy];
  let count = 0;
  const limit = maxFrac * w * h;
  let touchesEdge = false;
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    // Scanline fill
    while (x > 0 && !mask[idx(x - 1, y)] && !fill[idx(x - 1, y)]) x--;
    let up = false,
      down = false;
    for (; x < w && !mask[idx(x, y)] && !fill[idx(x, y)]; x++) {
      fill[idx(x, y)] = 1;
      count++;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touchesEdge = true;
      if (y > 0) {
        const open = !mask[idx(x, y - 1)] && !fill[idx(x, y - 1)];
        if (open && !up) stack.push(x, y - 1);
        up = open;
      }
      if (y < h - 1) {
        const open = !mask[idx(x, y + 1)] && !fill[idx(x, y + 1)];
        if (open && !down) stack.push(x, y + 1);
        down = open;
      }
    }
    if (count > limit) return { error: 'leak' };
  }
  if (touchesEdge) return { error: 'leak' };
  return { fill, count };
}

/** Moore-neighbour trace of the outer boundary of a filled region. Returns pixel corner points. */
export function traceOuter(fill, w, h) {
  // Start: first filled pixel in raster order (top-most, then left-most).
  let start = -1;
  for (let i = 0; i < fill.length; i++)
    if (fill[i]) {
      start = i;
      break;
    }
  if (start < 0) return [];
  return traceFrom((x, y) => x >= 0 && y >= 0 && x < w && y < h && fill[y * w + x] === 1, w, h, start);
}

/** Crack-following trace of the outer boundary of the region `at` belongs to, from raster index `start`. */
export function traceFrom(at, w, h, start) {
  // Trace along pixel edges (crack following) so the outline encloses the pixels exactly.
  // State: current vertex (x, y) on the pixel-corner grid and direction d (0 right, 1 down, 2 left, 3 up).
  const sx0 = start % w;
  const sy0 = (start / w) | 0;
  let x = sx0,
    y = sy0,
    d = 0;
  const pts = [[x, y]];
  const dx = [1, 0, -1, 0];
  const dy = [0, 1, 0, -1];
  // For a vertex and direction, the pixel on the left/right of the next edge.
  const leftPix = (x, y, d) => [
    [x, y - 1],
    [x, y],
    [x - 1, y],
    [x - 1, y - 1],
  ][d];
  const rightPix = (x, y, d) => [
    [x, y],
    [x - 1, y],
    [x - 1, y - 1],
    [x, y - 1],
  ][d];
  const guard = 8 * (w + h) * 50;
  for (let step = 0; step < guard; step++) {
    // Keep filled pixels on the right: prefer turning left, then straight, then right.
    let turned = false;
    for (const nd of [(d + 3) % 4, d, (d + 1) % 4, (d + 2) % 4]) {
      const [lx, ly] = leftPix(x, y, nd);
      const [rx, ry] = rightPix(x, y, nd);
      if (at(rx, ry) && !at(lx, ly)) {
        if (nd !== d) pts.push([x, y]);
        d = nd;
        x += dx[d];
        y += dy[d];
        turned = true;
        break;
      }
    }
    if (!turned) break;
    if (x === sx0 && y === sy0) break;
  }
  return dedupe(pts);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0],
      b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

/** Douglas–Peucker on a closed ring. */
export function simplifyRing(pts, eps) {
  if (pts.length <= 4) return pts;
  // Split at the two farthest-apart points so the ring simplifies symmetrically.
  let a = 0,
    b = 0,
    best = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) {
      best = d;
      b = i;
    }
  }
  const half1 = dp(pts.slice(a, b + 1), eps);
  const half2 = dp(pts.slice(b).concat([pts[0]]), eps);
  return half1.slice(0, -1).concat(half2.slice(0, -1));
}

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const L = Math.hypot(x2 - x1, y2 - y1) || 1;
  let idx = -1,
    max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((y2 - y1) * pts[i][0] - (x2 - x1) * pts[i][1] + x2 * y1 - y2 * x1) / L;
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return dp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(dp(pts.slice(idx), eps));
}

// ---------- Mask cache per sheet ----------
const maskCache = new Map(); // `${pageKey}|${gap}` -> { mask, w, h, s }

export function clearFillCache(prefix = '') {
  for (const k of [...maskCache.keys()]) if (k.startsWith(prefix)) maskCache.delete(k);
}

/**
 * Flag hatch-pattern segments: ones with at least two close, parallel, overlapping neighbours
 * (brick coursing, siding laps, diagonal hatching), plus light-gray linework. Outlines rarely
 * have tightly spaced parallel copies, so this separates "what a zone is made of" from
 * "where the zone ends". Cached on the index.
 */
export function hatchFlags(index, spacing = 8) {
  if (index._hatch) return index._hatch;
  const n = index.n;
  const seg = index.seg;
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (index.lum && index.lum[i] > 165) {
      flags[i] = 1;
      continue;
    }
    const k = i * 4;
    const x1 = seg[k],
      y1 = seg[k + 1],
      x2 = seg[k + 2],
      y2 = seg[k + 3];
    const dx = x2 - x1,
      dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    if (L < 0.5) continue;
    const ux = dx / L,
      uy = dy / L;
    const mx = (x1 + x2) / 2,
      my = (y1 + y2) / 2;
    // Hatching = a family of parallel lines with neighbours on BOTH sides. A zone's
    // boundary sits next to the first hatch line but has nothing parallel beyond it.
    let pos = Infinity,
      neg = Infinity; // nearest parallel neighbour distance on each side
    for (const j of index.near([mx, my], spacing + Math.min(L / 2, 24))) {
      if (j === i) continue;
      const q = j * 4;
      const ex = seg[q + 2] - seg[q],
        ey = seg[q + 3] - seg[q + 1];
      const Lj = Math.hypot(ex, ey);
      if (Lj < 0.5) continue;
      const cos = Math.abs((ux * ex + uy * ey) / Lj);
      if (cos < 0.9986) continue; // within ~3°
      const jmx = (seg[q] + seg[q + 2]) / 2 - x1,
        jmy = (seg[q + 1] + seg[q + 3]) / 2 - y1;
      const side = jmx * uy - jmy * ux;
      const perp = Math.abs(side);
      if (perp < 0.05 || perp > spacing) continue;
      // overlapping along the line direction
      const t1 = (seg[q] - x1) * ux + (seg[q + 1] - y1) * uy;
      const t2 = (seg[q + 2] - x1) * ux + (seg[q + 3] - y1) * uy;
      // Real side-by-side overlap, not just touching end to end (hatch stopped at a window).
      const ov = Math.min(L, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      if (ov < Math.min(L, Lj) * 0.25) continue;
      if (side > 0) pos = Math.min(pos, perp);
      else neg = Math.min(neg, perp);
    }
    // Evenly spaced on both sides = a hatch line. A boundary between two different
    // patterns has neighbours on both sides but at different spacings.
    if (isFinite(pos) && isFinite(neg)) {
      const r = pos / neg;
      if (r > 0.4 && r < 2.5) flags[i] = 1;
    }
  }
  index._hatch = flags;
  return flags;
}

export function buildMask(index, pageW, pageH, gapPx, mode = 'all') {
  const s = Math.min(2, MAX_SIDE / Math.max(pageW, pageH));
  const w = Math.ceil(pageW * s);
  const h = Math.ceil(pageH * s);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#000';
  ctx.lineWidth = gapPx;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const seg = index.seg;
  const hatch = mode === 'outline' ? hatchFlags(index) : null;
  for (let i = 0; i < index.n; i++) {
    if (hatch && hatch[i]) continue;
    const k = i * 4;
    ctx.moveTo(seg[k] * s, seg[k + 1] * s);
    ctx.lineTo(seg[k + 2] * s, seg[k + 3] * s);
  }
  ctx.stroke();
  const data = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 40 ? 1 : 0;
  return { mask, w, h, s };
}

export function getMask(pageKey, index, pageW, pageH, gap = 'small', mode = 'all') {
  const gapPx = { small: 2, medium: 5, large: 10 }[gap] || 2;
  const key = `${pageKey}|${gapPx}|${mode}`;
  let m = maskCache.get(key);
  if (m) {
    maskCache.delete(key); // most recent last
    maskCache.set(key, m);
    return m;
  }
  // Masks are ~7 MB each; keep only the few most recently used.
  while (maskCache.size >= 3) maskCache.delete(maskCache.keys().next().value);
  m = buildMask(index, pageW, pageH, gapPx, mode);
  m.gapPx = gapPx;
  maskCache.set(key, m);
  return m;
}

/**
 * Find the room polygon around page point p.
 * gap: 'small' | 'medium' | 'large' — how big a gap in the walls to bridge.
 * Returns { points } in page coordinates, or { error: 'leak'|'online'|'nolines' }.
 */
export function fillAt(pageKey, index, pageW, pageH, p, gap = 'small', mode = 'smart') {
  if (!index || !index.n) return { error: 'nolines' };
  if (mode === 'smart') {
    // Ignore hatching first (so a brick or siding zone fills whole); if that leaks,
    // the boundary itself was drawn like hatching, so fall back to every line.
    const a = fillAt(pageKey, index, pageW, pageH, p, gap, 'outline');
    if (!a.error) return a;
    return fillAt(pageKey, index, pageW, pageH, p, gap, 'all');
  }
  const m = getMask(pageKey, index, pageW, pageH, gap, mode);
  const gapPx = m.gapPx;
  const sx = Math.floor(p[0] * m.s);
  const sy = Math.floor(p[1] * m.s);
  if (sx < 0 || sy < 0 || sx >= m.w || sy >= m.h) return { error: 'leak' };
  const r = floodRegion(m.mask, m.w, m.h, sx, sy);
  if (r.error) return r;
  let ring = simplifyRing(traceOuter(r.fill, m.w, m.h), 1.25);
  if (ring.length < 3) return { error: 'leak' };
  // Back to page space, then pull corners onto the true wall-line geometry.
  const tol = (gapPx / 2 + 2.5) / m.s;
  let pts = ring.map(([x, y]) => [x / m.s, y / m.s]);
  pts = pts.map((q) => {
    const hit = findSnap(index, q, tol);
    return hit && hit.kind !== 'line' ? hit.point : q;
  });
  // Drop vertices that collapsed onto each other or became collinear.
  pts = cleanRing(pts, 0.25);
  if (pts.length < 3) return { error: 'leak' };
  return { points: pts, mode };
}

function cleanRing(pts, eps) {
  let out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  // Remove collinear middle points
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / L < eps) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}
