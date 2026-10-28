// Snap engine: extracts line geometry from the PDF's vector drawing and finds the best
// snap target near the cursor (endpoint > intersection > nearest point on a line).
// All coordinates are page points in viewer space (same as markups).

const CELL = 24; // grid cell size in page points
const MAX_SEGMENTS = 400000;
const MIN_LEN = 0.6; // ignore specks / zero-length dashes

export class SnapIndex {
  constructor() {
    this.seg = new Float32Array(4096 * 4);
    this.n = 0;
    this.grid = new Map();
  }

  add(x1, y1, x2, y2) {
    if (this.n >= MAX_SEGMENTS) return;
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx * dx + dy * dy < MIN_LEN * MIN_LEN) return;
    if (this.n * 4 + 4 > this.seg.length) {
      const g = new Float32Array(this.seg.length * 2);
      g.set(this.seg);
      this.seg = g;
    }
    const i = this.n++;
    this.seg.set([x1, y1, x2, y2], i * 4);
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

  /** Segment ids whose cells fall within r of p. */
  near(p, r) {
    const out = new Set();
    const x0 = Math.floor((p[0] - r) / CELL);
    const x1 = Math.floor((p[0] + r) / CELL);
    const y0 = Math.floor((p[1] - r) / CELL);
    const y1 = Math.floor((p[1] + r) / CELL);
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

const cellKey = (x, y) => x + ',' + y;

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
export async function buildSnapIndex(page, OPS, viewportTransform) {
  const list = await page.getOperatorList();
  const idx = new SnapIndex();
  const { fnArray, argsArray } = list;
  let ctm = viewportTransform.slice();
  const stack = [];

  const tx = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args && args[0]) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      const paintOp = args[0];
      if (paintOp === OPS.endPath) continue; // clipping paths aren't visible lines
      const data = args[1] && args[1][0];
      if (!data || typeof data.length !== 'number') continue;
      addPathData(idx, data, tx);
      if (idx.n >= MAX_SEGMENTS) break;
    }
  }
  return idx;
}

function addPathData(idx, d, tx) {
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
        if (cur) idx.add(cur[0], cur[1], p[0], p[1]);
        cur = p;
        break;
      }
      case 2: {
        // curveTo: approximate with a few chords so arcs (doors, curved walls) still snap
        const c1 = tx(d[i++], d[i++]);
        const c2 = tx(d[i++], d[i++]);
        const p = tx(d[i++], d[i++]);
        if (cur) bezierChords(idx, cur, c1, c2, p);
        cur = p;
        break;
      }
      case 3: {
        const c = tx(d[i++], d[i++]);
        const p = tx(d[i++], d[i++]);
        if (cur) bezierChords(idx, cur, c, c, p);
        cur = p;
        break;
      }
      case 4: // closePath
        if (cur && start) idx.add(cur[0], cur[1], start[0], start[1]);
        cur = start;
        break;
      default:
        return; // unknown op — stop rather than misread coordinates
    }
  }
}

function bezierChords(idx, a, b, c, d) {
  const N = 6;
  let prev = a;
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const u = 1 - t;
    const p = [
      u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
      u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
    ];
    idx.add(prev[0], prev[1], p[0], p[1]);
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
