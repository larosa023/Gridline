// Region finder: label every closed zone inside an area of a sheet, describe each one
// (area, box, hatch pattern, tags inside), and turn chosen zones into exact outlines with
// their interior openings as deductions. This is how the assistant measures facades and
// anything else made of closed shapes, without guessing coordinates.
import { getMask, hatchFlags, traceFrom, simplifyRing } from './fill.js';
import { findSnap } from './snap.js';

/**
 * Pure labeling core (exported for tests).
 * mask: 1 = line. Restricted to rect [x0, y0, x1, y1) in pixels.
 * Returns { labels: Int32Array (0 = not visited/line, k = region k), regions: [{ id, count, minx, miny, maxx, maxy, sx, sy, open, start }] }
 */
export function labelRegions(mask, w, h, rect) {
  const [x0, y0, x1, y1] = rect;
  const labels = new Int32Array(w * h);
  const regions = [];
  const stack = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i0 = y * w + x;
      if (mask[i0] || labels[i0]) continue;
      const id = regions.length + 1;
      const r = { id, count: 0, minx: x, miny: y, maxx: x, maxy: y, sx: 0, sy: 0, open: false, start: i0 };
      stack.length = 0;
      stack.push(x, y);
      labels[i0] = id;
      while (stack.length) {
        const cy = stack.pop();
        const cx = stack.pop();
        r.count++;
        r.sx += cx;
        r.sy += cy;
        if (cx < r.minx) r.minx = cx;
        if (cx > r.maxx) r.maxx = cx;
        if (cy < r.miny) r.miny = cy;
        if (cy > r.maxy) r.maxy = cy;
        if (cx === x0 || cy === y0 || cx === x1 - 1 || cy === y1 - 1) r.open = true;
        if (cx > x0) {
          const j = cy * w + cx - 1;
          if (!mask[j] && !labels[j]) {
            labels[j] = id;
            stack.push(cx - 1, cy);
          }
        }
        if (cx < x1 - 1) {
          const j = cy * w + cx + 1;
          if (!mask[j] && !labels[j]) {
            labels[j] = id;
            stack.push(cx + 1, cy);
          }
        }
        if (cy > y0) {
          const j = (cy - 1) * w + cx;
          if (!mask[j] && !labels[j]) {
            labels[j] = id;
            stack.push(cx, cy - 1);
          }
        }
        if (cy < y1 - 1) {
          const j = (cy + 1) * w + cx;
          if (!mask[j] && !labels[j]) {
            labels[j] = id;
            stack.push(cx, cy + 1);
          }
        }
      }
      // The start pixel must be the region's first pixel in raster order for tracing.
      regions.push(r);
    }
  return { labels, regions };
}

/**
 * Openings inside region `id`: connected groups of non-region pixels within its box that
 * don't reach the box edge. Returns arrays of raster indices' starting pixels with sizes.
 */
export function findHoles(labels, w, id, box, mask = null) {
  const [minx, miny, maxx, maxy] = box;
  const bw = maxx - minx + 1,
    bh = maxy - miny + 1;
  const seen = new Uint8Array(bw * bh); // 1 = outside-connected or region, 2+ = hole id
  const inR = (x, y) => labels[y * w + x] === id;
  const stack = [];
  // Mark everything reachable from the box border (without crossing region pixels) as outside.
  const flood = (sx, sy, mark) => {
    stack.length = 0;
    stack.push(sx, sy);
    seen[(sy - miny) * bw + (sx - minx)] = mark;
    let count = 0;
    let solid = 0; // pixels that are open space (not drawn lines)
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      count++;
      if (mask && !mask[y * w + x]) solid++;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < minx || ny < miny || nx > maxx || ny > maxy) continue;
        const k = (ny - miny) * bw + (nx - minx);
        if (seen[k] || inR(nx, ny)) continue;
        seen[k] = mark;
        stack.push(nx, ny);
      }
    }
    return { count, solid };
  };
  for (let x = minx; x <= maxx; x++)
    for (const y of [miny, maxy]) if (!inR(x, y) && !seen[(y - miny) * bw + (x - minx)]) flood(x, y, 1);
  for (let y = miny; y <= maxy; y++)
    for (const x of [minx, maxx]) if (!inR(x, y) && !seen[(y - miny) * bw + (x - minx)]) flood(x, y, 1);
  const holes = [];
  let mark = 2;
  for (let y = miny; y <= maxy; y++)
    for (let x = minx; x <= maxx; x++) {
      const k = (y - miny) * bw + (x - minx);
      if (seen[k] || inR(x, y)) continue;
      const f = flood(x, y, mark);
      holes.push({ mark, count: f.count, solid: f.solid, start: [x, y] });
      mark++;
      if (mark > 250) return { holes, seen, bw, bh }; // plenty
    }
  return { holes, seen, bw, bh };
}

// ---------- High level ----------

const cache = new Map(); // token -> { pageKey, m, labels, regions, index }
const fullCache = new Map(); // `${pageKey}|${gap}|${mode}` -> full-sheet labeling
let tokenN = 0;

function angleOf(index, i) {
  const k = i * 4;
  let a = (Math.atan2(index.seg[k + 3] - index.seg[k + 1], index.seg[k + 2] - index.seg[k]) * 180) / Math.PI;
  a = ((a % 180) + 180) % 180;
  return Math.round(a / 15) * 15 % 180;
}

/**
 * Find closed regions inside rectPt ([x, y, w, h] page points) of a sheet.
 * k: points per real unit (for area). Returns { token, regions: [...] } sorted by area.
 */
export function findRegions(pageKey, index, pageW, pageH, rectPt, { k, mode = 'outline', minArea = 4, textItems = [], gap = 'small' } = {}) {
  const m = getMask(pageKey, index, pageW, pageH, gap, mode);
  const s = m.s;
  // Label the whole sheet (cached), then keep the zones that belong to the requested area.
  // This way a zone is never cut off by an imprecise view box.
  const fkey = `${pageKey}|${gap}|${mode}`;
  let full = fullCache.get(fkey);
  if (!full || full.m !== m) {
    full = { m, ...labelRegions(m.mask, m.w, m.h, [0, 0, m.w, m.h]) };
    fullCache.set(fkey, full);
    while (fullCache.size > 2) fullCache.delete(fullCache.keys().next().value);
  }
  const { labels } = full;
  // A zone belongs to the area when its centre is inside it and it doesn't sprawl far beyond it
  // (that rules out the paper background inside the sheet border).
  const mx0 = rectPt[0] - Math.min(rectPt[2] * 0.25, 120),
    my0 = rectPt[1] - Math.min(rectPt[3] * 0.25, 120);
  const mx1 = rectPt[0] + rectPt[2] + Math.min(rectPt[2] * 0.25, 120),
    my1 = rectPt[1] + rectPt[3] + Math.min(rectPt[3] * 0.25, 120);
  const regions = full.regions.filter((r) => {
    const cx = r.sx / r.count / s,
      cy = r.sy / r.count / s;
    if (cx < rectPt[0] || cy < rectPt[1] || cx > rectPt[0] + rectPt[2] || cy > rectPt[1] + rectPt[3]) return false;
    return r.minx / s >= mx0 && r.miny / s >= my0 && r.maxx / s <= mx1 && r.maxy / s <= my1;
  });
  const rx0 = Math.max(0, Math.floor(mx0 * s)),
    ry0 = Math.max(0, Math.floor(my0 * s));
  const rx1 = Math.min(m.w, Math.ceil(mx1 * s)),
    ry1 = Math.min(m.h, Math.ceil(my1 * s));
  const token = 'R' + ++tokenN;
  cache.set(token, { pageKey, m, labels, regions, index, k, textItems });
  // Each entry holds a full-sheet label map (~25 MB); keep only the latest few.
  while (cache.size > 3) cache.delete(cache.keys().next().value);

  // Hatch inside each region: segments flagged as hatching whose midpoint lies in it.
  const hatch = hatchFlags(index);
  const per = new Map();
  for (let i = 0; i < index.n; i++) {
    if (!hatch[i]) continue;
    const q = i * 4;
    const mx = Math.floor(((index.seg[q] + index.seg[q + 2]) / 2) * s);
    const my = Math.floor(((index.seg[q + 1] + index.seg[q + 3]) / 2) * s);
    if (mx < rx0 || my < ry0 || mx >= rx1 || my >= ry1) continue;
    let id = labels[my * m.w + mx];
    if (!id) {
      // midpoint on a drawn pixel in 'all' mode; look one pixel around
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = labels[(my + dy) * m.w + mx + dx];
        if (v) {
          id = v;
          break;
        }
      }
    }
    if (!id) continue;
    let e = per.get(id);
    if (!e) per.set(id, (e = { n: 0, len: 0, angles: new Map() }));
    const L = Math.hypot(index.seg[q + 2] - index.seg[q], index.seg[q + 3] - index.seg[q + 1]);
    e.n++;
    e.len += L;
    const a = angleOf(index, i);
    e.angles.set(a, (e.angles.get(a) || 0) + L);
  }

  const ptsArea = (count) => count / (s * s) / (k * k);
  const byId = new Map(full.regions.map((r) => [r.id, r]));
  const kept = new Set(regions.map((r) => r.id));
  // Which zone does each piece of text belong to? Text inside a small closed shape (a tag
  // bubble) belongs to the zone surrounding that bubble.
  const tagsOf = new Map();
  const labelAt = (x, y) => (x >= 0 && y >= 0 && x < m.w && y < m.h ? labels[y * m.w + x] : 0);
  for (const t of textItems) {
    const cx = Math.floor((t.x + t.w / 2) * s),
      cy = Math.floor((t.y - t.h * 0.35) * s);
    if (cx < rx0 || cy < ry0 || cx >= rx1 || cy >= ry1) continue;
    let id = labelAt(cx, cy);
    let r = byId.get(id);
    if (r && ptsArea(r.count) < Math.max(minArea, 12)) {
      // vote among pixels just outside the bubble's box
      const votes = new Map();
      const pad = 3;
      for (let x = r.minx - pad; x <= r.maxx + pad; x += 2)
        for (const y of [r.miny - pad, r.maxy + pad]) {
          const v = labelAt(x, y);
          if (v && v !== id) votes.set(v, (votes.get(v) || 0) + 1);
        }
      for (let y = r.miny - pad; y <= r.maxy + pad; y += 2)
        for (const x of [r.minx - pad, r.maxx + pad]) {
          const v = labelAt(x, y);
          if (v && v !== id) votes.set(v, (votes.get(v) || 0) + 1);
        }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      id = best ? best[0] : 0;
      r = byId.get(id);
    }
    if (!r || r.open || !kept.has(id)) continue;
    if (!tagsOf.has(id)) tagsOf.set(id, []);
    const arr = tagsOf.get(id);
    if (arr.length < 8 && !arr.includes(t.str)) arr.push(t.str);
  }

  const out = [];
  const entry = cache.get(token);
  entry.outlines = new Map();
  for (const r of regions) {
    const area = ptsArea(r.count);
    if (area < minArea) continue;
    const e = per.get(r.id);
    const areaPt = r.count / (s * s);
    const density = e ? e.len / areaPt : 0; // hatch line length per pt² of zone
    const angles = e ? [...e.angles.entries()].sort((a, b) => b[1] - a[1]).filter(([, v], i, arr) => i === 0 || v > arr[0][1] * 0.3).map(([a]) => a) : [];
    const box = [r.minx / s, r.miny / s, (r.maxx - r.minx + 1) / s, (r.maxy - r.miny + 1) / s];
    const tags = tagsOf.get(r.id) || [];
    // Exact areas from the traced outline snapped to the linework, openings subtracted.
    let gross = area,
      openings = 0,
      nOpen = 0;
    if (!r.open) {
      try {
        const o = regionOutline(`${token}.${r.id}`);
        entry.outlines.set(r.id, o);
        gross = polyArea(o.outer) / (k * k);
        for (const hle of o.holes) openings += polyArea(hle) / (k * k);
        nOpen = o.holes.length;
      } catch {}
    }
    out.push({
      id: `${token}.${r.id}`,
      area_sf: +(gross - openings).toFixed(1),
      gross_sf: +gross.toFixed(1),
      openings: nOpen,
      openings_sf: +openings.toFixed(1),
      box_pt: box.map((v) => Math.round(v)),
      centre_pt: [Math.round(r.sx / r.count / s), Math.round(r.sy / r.count / s)],
      open: r.open,
      hatch: describeHatch(density, angles),
      signature: { density: +density.toFixed(3), angles },
      tags,
    });
  }
  out.sort((a, b) => b.area_sf - a.area_sf);
  return { token, regions: out };
}

function describeHatch(density, angles) {
  if (!density) return 'none (plain)';
  const dir = angles
    .map((a) => (a === 0 ? 'horizontal' : a === 90 ? 'vertical' : `${a}°`))
    .join(' + ');
  const d = density > 0.6 ? 'dense' : density > 0.2 ? 'medium' : 'light';
  return `${d} ${dir || ''} hatch`.replace(/\s+/g, ' ').trim();
}

/** Same pattern? Used for "measure every zone like this one". */
export function similarSignature(a, b) {
  if (!a || !b) return false;
  if (!a.density && !b.density) return true;
  if (!a.density || !b.density) return false;
  // Hatch density ~ 1 / line spacing, so this compares spacing: brick coursing vs siding
  // laps differ by far more than 20%.
  const ratio = a.density / b.density;
  if (ratio < 0.83 || ratio > 1.2) return false;
  const sa = [...a.angles].sort().join(','),
    sb = [...b.angles].sort().join(',');
  return sa === sb;
}

/**
 * Exact outline (page points) of a region, plus its openings as separate outlines.
 * Corners are snapped onto the sheet's real line geometry.
 */
function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}

export function regionOutline(regionId, { minHoleArea = 1 } = {}) {
  const [token, n] = String(regionId).split('.');
  const c = cache.get(token);
  if (!c) throw new Error(`Region ${regionId} has expired — call find_regions again.`);
  const id = +n;
  if (c.outlines && c.outlines.has(id)) return c.outlines.get(id);
  const r = c.regions.find((x) => x.id === id);
  if (!r) throw new Error(`No region ${regionId}.`);
  const { m, labels, index } = c;
  const w = m.w;
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < m.h && labels[y * w + x] === id;
  const snapRing = (ring) => {
    const tol = (m.gapPx / 2 + 2.5) / m.s;
    let pts = ring.map(([x, y]) => [x / m.s, y / m.s]);
    pts = pts.map((q) => {
      const hit = findSnap(index, q, tol);
      return hit && hit.kind !== 'line' ? hit.point : q;
    });
    return pts;
  };
  const outer = snapRing(simplifyRing(traceFrom(at, w, m.h, r.start), 1.25));
  const holes = [];
  const H = findHoles(labels, w, id, [r.minx, r.miny, r.maxx, r.maxy], m.mask);
  const k2 = (c.k * c.k) * (m.s * m.s);
  for (const hole of H.holes) {
    if (hole.count / k2 < minHoleArea) continue;
    // A real opening encloses open space; a stray line or leader inside the zone doesn't.
    if (hole.solid < hole.count * 0.5) continue;
    const { seen, bw } = H;
    // Finish tags and keynote bubbles are small closed shapes with text in them — not openings.
    if (hole.count / k2 < 15) {
      const hasText = (c.textItems || []).some((t) => {
        const cx = Math.floor((t.x + t.w / 2) * m.s),
          cy = Math.floor((t.y - t.h * 0.35) * m.s);
        return cx >= r.minx && cy >= r.miny && cx <= r.maxx && cy <= r.maxy && seen[(cy - r.miny) * bw + (cx - r.minx)] === hole.mark;
      });
      if (hasText) continue;
    }
    const hat = (x, y) => x >= r.minx && y >= r.miny && x <= r.maxx && y <= r.maxy && seen[(y - r.miny) * bw + (x - r.minx)] === hole.mark;
    // first pixel of the hole in raster order
    let start = -1;
    for (let y = r.miny; y <= r.maxy && start < 0; y++)
      for (let x = r.minx; x <= r.maxx; x++)
        if (hat(x, y)) {
          start = y * w + x;
          break;
        }
    if (start < 0) continue;
    const ring = simplifyRing(traceFrom(hat, w, m.h, start), 1.25);
    if (ring.length >= 3) holes.push(snapRing(ring));
  }
  return { pageKey: c.pageKey, outer, holes };
}

/** Regions from a find_regions call whose hatch matches the given one. */
export function regionsLike(regionId, list) {
  const ref = list.find((r) => r.id === regionId);
  if (!ref) return [];
  return list.filter((r) => !r.open && similarSignature(ref.signature, r.signature));
}
