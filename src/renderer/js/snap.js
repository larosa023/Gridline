// Snap engine: extracts line geometry from the PDF's vector drawing and finds the best
// snap target near the cursor (endpoint > intersection > nearest point on a line).
// All coordinates are page points in viewer space (same as markups).

const CELL = 24; // grid cell size in page points
const MAX_SEGMENTS = 400000;
const MIN_LEN = 0.6; // ignore specks / zero-length dashes

export class SnapIndex {
  constructor() {
    this.seg = new Float32Array(4096 * 4);
    // Per-segment drawing attributes, used to tell outlines from hatching:
    this.width = new Float32Array(4096); // stroke width in page points (0 = hairline)
    this.lum = new Uint8Array(4096); // stroke darkness 0 (black) .. 255 (white)
    this.kind = new Uint8Array(4096); // 1 = stroked line, 2 = edge of a filled shape
    this.n = 0;
    this.grid = new Map();
  }

  add(x1, y1, x2, y2, width = 0.5, lum = 0, kind = 1) {
    if (this.n >= MAX_SEGMENTS || this.frozen) return;
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx * dx + dy * dy < MIN_LEN * MIN_LEN) return;
    if (this.n * 4 + 4 > this.seg.length) {
      const g = new Float32Array(this.seg.length * 2);
      g.set(this.seg);
      this.seg = g;
      const w = new Float32Array(this.width.length * 2);
      w.set(this.width);
      this.width = w;
      const l = new Uint8Array(this.lum.length * 2);
      l.set(this.lum);
      this.lum = l;
      const k = new Uint8Array(this.kind.length * 2);
      k.set(this.kind);
      this.kind = k;
    }
    const i = this.n++;
    this.seg.set([x1, y1, x2, y2], i * 4);
    this.width[i] = width;
    this.lum[i] = lum;
    this.kind[i] = kind;
    // Walk the segment through grid cells (handles long diagonals without huge bboxes).
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
    let last = '';
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const key = cellKey(Math.floor((x1 + dx * t) / CELL), Math.floor((y1 + dy * t) / CELL));
      if (key === last) continue;
      last = key;
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      if (arr[arr.length - 1] !== i) arr.push(i);
    }
  }

  /**
   * Pack the grid into flat typed arrays once building is done. A sheet can have hundreds of
   * thousands of segments; thousands of small JS arrays cost far more memory than this.
   */
  freeze() {
    if (this.frozen) return;
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity,
      total = 0;
    for (const [k, arr] of this.grid) {
      const cx = Math.floor(k / 65536) - 1024,
        cy = (k % 65536) - 1024;
      if (cx < minx) minx = cx;
      if (cy < miny) miny = cy;
      if (cx > maxx) maxx = cx;
      if (cy > maxy) maxy = cy;
      total += arr.length;
    }
    if (!isFinite(minx)) minx = miny = maxx = maxy = 0;
    const cols = maxx - minx + 1,
      rows = maxy - miny + 1;
    const start = new Int32Array(cols * rows + 1);
    for (const [k, arr] of this.grid) {
      const cx = Math.floor(k / 65536) - 1024 - minx,
        cy = (k % 65536) - 1024 - miny;
      start[cy * cols + cx + 1] = arr.length;
    }
    for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
    const items = new Int32Array(total);
    for (const [k, arr] of this.grid) {
      const cx = Math.floor(k / 65536) - 1024 - minx,
        cy = (k % 65536) - 1024 - miny;
      items.set(arr, start[cy * cols + cx]);
    }
    this.packed = { minx, miny, cols, rows, start, items };
    this.grid = null;
    // trim attribute arrays to size
    this.seg = this.seg.slice(0, this.n * 4);
    this.width = this.width.slice(0, this.n);
    this.lum = this.lum.slice(0, this.n);
    this.kind = this.kind.slice(0, this.n);
    this.frozen = true;
  }

  /** Segment ids whose cells fall within r of p. */
  near(p, r) {
    const out = new Set();
    const x0 = Math.floor((p[0] - r) / CELL);
    const x1 = Math.floor((p[0] + r) / CELL);
    const y0 = Math.floor((p[1] - r) / CELL);
    const y1 = Math.floor((p[1] + r) / CELL);
    if (this.packed) {
      const { minx, miny, cols, rows, start, items } = this.packed;
      for (let cy = Math.max(y0, miny); cy <= Math.min(y1, miny + rows - 1); cy++)
        for (let cx = Math.max(x0, minx); cx <= Math.min(x1, minx + cols - 1); cx++) {
          const c = (cy - miny) * cols + (cx - minx);
          for (let i = start[c]; i < start[c + 1]; i++) out.add(items[i]);
        }
      return out;
    }
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const arr = this.grid.get(cellKey(cx, cy));
        if (arr) for (const id of arr) out.add(id);
      }
    return out;
  }

  get(id) {
    const s = this.seg;
    const k = id * 4;
    return [s[k], s[k + 1], s[k + 2], s[k + 3]];
  }
}

// Numeric cell keys (cells span roughly -1000..64000 in either axis).
const cellKey = (x, y) => (x + 1024) * 65536 + (y + 1024);

// ---------- Geometry extraction from a PDF.js page ----------

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Build a SnapIndex from a page's drawing operators.
 * `OPS` is pdfjs.OPS; `viewportTransform` maps PDF space to viewer space at scale 1.
 */
function colorLum(c) {
  if (typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c)) {
    const n = parseInt(c.slice(1, 7), 16);
    return Math.round(0.3 * ((n >> 16) & 255) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255));
  }
  if (Array.isArray(c) || ArrayBuffer.isView(c)) {
    const [r, g, b] = c;
    const scale = Math.max(r, g, b) <= 1 ? 255 : 1;
    return Math.round((0.3 * r + 0.59 * g + 0.11 * b) * scale);
  }
  return 0;
}

export async function buildSnapIndex(page, OPS, viewportTransform) {
  const list = await page.getOperatorList();
  const idx = new SnapIndex();
  const { fnArray, argsArray } = list;
  // Graphics state we care about: transform, line width, stroke/fill darkness.
  let gs = { ctm: viewportTransform.slice(), lw: 1, slum: 0, flum: 0 };
  const stack = [];

  const tx = (x, y) => [gs.ctm[0] * x + gs.ctm[2] * y + gs.ctm[4], gs.ctm[1] * x + gs.ctm[3] * y + gs.ctm[5]];
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push({ ...gs });
    else if (fn === OPS.restore) gs = stack.pop() || gs;
    else if (fn === OPS.transform) gs.ctm = mul(gs.ctm, args);
    else if (fn === OPS.setLineWidth) gs.lw = +args[0] || 0;
    else if (fn === OPS.setGState && args && Array.isArray(args[0])) {
      for (const [k, v] of args[0]) if (k === 'LW') gs.lw = +v || 0;
    } else if (fn === OPS.setStrokeRGBColor || fn === OPS.setStrokeGray || fn === OPS.setStrokeColor || fn === OPS.setStrokeColorN) gs.slum = colorLum(args && args.length === 1 ? args[0] : args);
    else if (fn === OPS.setFillRGBColor || fn === OPS.setFillGray || fn === OPS.setFillColor || fn === OPS.setFillColorN) gs.flum = colorLum(args && args.length === 1 ? args[0] : args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...gs });
      if (args && args[0]) gs.ctm = mul(gs.ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) gs = stack.pop() || gs;
    else if (fn === OPS.constructPath) {
      const paintOp = args[0];
      if (paintOp === OPS.endPath) continue; // clipping paths aren't visible lines
      const data = args[1] && args[1][0];
      if (!data || typeof data.length !== 'number') continue;
      const stroked = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paintOp);
      const width = stroked ? gs.lw * scaleOf(gs.ctm) : 0;
      addPathData(idx, data, tx, width, stroked ? gs.slum : gs.flum, stroked ? 1 : 2);
      if (idx.n >= MAX_SEGMENTS) break;
    }
  }
  return idx;
}

function addPathData(idx, d, tx, width, lum, kind) {
  let cur = null;
  let start = null;
  for (let i = 0; i < d.length; ) {
    switch (d[i++]) {
      case 0: // moveTo
        cur = tx(d[i++], d[i++]);
        start = cur;
        break;
      case 1: {
        // lineTo
        const p = tx(d[i++], d[i++]);
        if (cur) idx.add(cur[0], cur[1], p[0], p[1], width, lum, kind);
        cur = p;
        break;
      }
      case 2: {
        // curveTo: approximate with a few chords so arcs (doors, curved walls) still snap
        const c1 = tx(d[i++], d[i++]);
        const c2 = tx(d[i++], d[i++]);
        const p = tx(d[i++], d[i++]);
        if (cur) bezierChords(idx, cur, c1, c2, p, width, lum, kind);
        cur = p;
        break;
      }
      case 3: {
        const c = tx(d[i++], d[i++]);
        const p = tx(d[i++], d[i++]);
        if (cur) bezierChords(idx, cur, c, c, p, width, lum, kind);
        cur = p;
        break;
      }
      case 4: // closePath
        if (cur && start) idx.add(cur[0], cur[1], start[0], start[1], width, lum, kind);
        cur = start;
        break;
      default:
        return; // unknown op — stop rather than misread coordinates
    }
  }
}

function bezierChords(idx, a, b, c, d, width, lum, kind) {
  const N = 6;
  let prev = a;
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const u = 1 - t;
    const p = [
      u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
      u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
    ];
    idx.add(prev[0], prev[1], p[0], p[1], width, lum, kind);
    prev = p;
  }
}

// ---------- Snap query ----------

function nearestOnSeg(p, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - x1) * dx + (p[1] - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [x1 + t * dx, y1 + t * dy];
}

function intersect(a, b) {
  const [x1, y1, x2, y2] = a;
  const [x3, y3, x4, y4] = b;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/**
 * Find the best snap for p within radius r (page points).
 * extraPoints: [[x,y]] (e.g. vertices of existing markups) treated as endpoints.
 * Returns { point, kind: 'endpoint'|'intersection'|'line', seg?: [x1,y1,x2,y2] } or null.
 */
export function findSnap(index, p, r, extraPoints = []) {
  const d2 = (q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
  const r2 = r * r;
  let bestPt = null; // endpoint or intersection
  let bestPtD = r2;
  let bestPtKind = null;
  let bestPtSeg = null;

  for (const q of extraPoints) {
    const dd = d2(q);
    if (dd <= bestPtD) {
      bestPtD = dd;
      bestPt = q;
      bestPtKind = 'endpoint';
    }
  }

  let bestLine = null;
  let bestLineD = r2;
  let bestLineSeg = null;
  const cands = [];

  if (index) {
    for (const id of index.near(p, r)) {
      const s = index.get(id);
      const a = [s[0], s[1]];
      const b = [s[2], s[3]];
      for (const e of [a, b]) {
        const dd = d2(e);
        if (dd < bestPtD) {
          bestPtD = dd;
          bestPt = e;
          bestPtKind = 'endpoint';
          bestPtSeg = s;
        }
      }
      const n = nearestOnSeg(p, s[0], s[1], s[2], s[3]);
      const dn = d2(n);
      if (dn < r2) {
        cands.push([dn, s]);
        if (dn < bestLineD) {
          bestLineD = dn;
          bestLine = n;
          bestLineSeg = s;
        }
      }
    }
    // Intersections among the closest few lines (wall corners, grid crossings).
    cands.sort((x, y) => x[0] - y[0]);
    const top = cands.slice(0, 24);
    for (let i = 0; i < top.length; i++)
      for (let j = i + 1; j < top.length; j++) {
        const q = intersect(top[i][1], top[j][1]);
        if (!q) continue;
        const dd = d2(q);
        // Prefer a true crossing over an endpoint only when it's clearly closer.
        if (dd < bestPtD * 0.8 || (!bestPt && dd < r2)) {
          bestPtD = dd;
          bestPt = q;
          bestPtKind = 'intersection';
          bestPtSeg = top[i][1];
        }
      }
  }

  if (bestPt) return { point: [bestPt[0], bestPt[1]], kind: bestPtKind, seg: bestPtSeg };
  if (bestLine) return { point: bestLine, kind: 'line', seg: bestLineSeg };
  return null;
}
