// Find the drawing views on a sheet (elevations, plans, sections, details) from their titles,
// and estimate each view's area. Architectural sheets title each view underneath it, often
// with a numbered bubble ("1  PROPOSED PARTIAL FRONT ELEVATION", then "SCALE: 1/8" = 1'-0"").
import { pickSheetScale } from './units.js';

const TITLE_RE = /\b(ELEVATION|ELEV\.|PLAN|SECTION|DETAIL|ENLARGED|PARTIAL|SCHEDULE|LEGEND|NOTES|DIAGRAM|SITE|ROOF)\b/i;

/**
 * items: page text items { str, x, y, w, h } (top-left origin).
 * frameRight: x where the title block begins (content area right edge).
 * Returns [{ number, title, scale, box: [x, y, w, h], titleAt: [x, y] }] top-to-bottom, left-to-right.
 */
export function detectViews(items, pageW, pageH, frameRight = pageW * 0.8) {
  // Title lines: uppercase text containing a view word, reasonably large, left of the title block.
  const cands = items.filter((it) => it.x < frameRight - 10 && TITLE_RE.test(it.str) && it.str === it.str.toUpperCase() && it.str.length >= 4 && it.str.length <= 80);
  if (!cands.length) return [];
  // Prefer the larger title text if the sheet uses several text sizes.
  const sizes = cands.map((c) => c.h).sort((a, b) => b - a);
  const big = sizes[Math.floor(sizes.length * 0.25)] || sizes[0];
  const titles = cands.filter((c) => c.h >= big * 0.75);

  const views = titles.map((t) => {
    // Numbered bubble: a short number just left of the title on the same line.
    const num = items.find((n) => /^\d{1,2}[A-Z]?$/.test(n.str) && Math.abs(n.y - t.y) < t.h * 1.5 && n.x < t.x && t.x - (n.x + n.w) < t.h * 4);
    // Scale written under the title.
    const sc = items.find((s) => /scale/i.test(s.str) && s.y > t.y && s.y - t.y < t.h * 3 && Math.abs(s.x - t.x) < t.h * 10);
    let scale = null;
    if (sc) {
      const near = items.filter((s) => Math.abs(s.y - sc.y) < sc.h && s.x >= sc.x - 2 && s.x < sc.x + 300).map((s) => s.str).join(' ');
      const r = pickSheetScale(near);
      if (r) scale = r.scale.label;
    }
    return { number: num ? num.str : null, title: t.str, scale, titleAt: [Math.round(t.x), Math.round(t.y)], t };
  });

  // Boxes: a view's title sits under the drawing. Each view extends up to the nearest title
  // above it that overlaps it horizontally, and sideways to its neighbours on the same row.
  // Schedules, legends and notes are listed but never clip a drawing.
  const isTable = (v) => /SCHEDULE|LEGEND|NOTES|ABBREVIATIONS/i.test(v.title);
  views.sort((a, b) => a.t.y - b.t.y || a.t.x - b.t.x);
  const drawings = views.filter((v) => !isTable(v));
  const sameRow = (a, b) => Math.abs(a.t.y - b.t.y) < Math.max(a.t.h, b.t.h) * 2;
  const xr = (v) => {
    const row = drawings.filter((o) => sameRow(o, v)).sort((a, b) => a.t.x - b.t.x);
    const i = row.indexOf(v);
    const left = Math.max(0, v.t.x - v.t.h * 6);
    const next = row[i + 1];
    const right = next ? Math.max(left + 20, next.t.x - next.t.h * 6) : frameRight;
    return [left, right];
  };
  const out = [];
  for (const v of views) {
    const [left, right] = isTable(v) ? [Math.max(0, v.t.x - v.t.h), Math.min(frameRight, v.t.x + Math.max(v.t.w * 1.6, v.t.h * 40))] : xr(v);
    const above = drawings.filter((o) => o !== v && o.t.y < v.t.y - v.t.h * 2).filter((o) => {
      const [l2, r2] = xr(o);
      return l2 < right && r2 > left;
    });
    const bottom = v.t.y + v.t.h * 2.5;
    let top = above.length ? Math.max(...above.map((o) => o.t.y + o.t.h * 2.5)) : 0;
    if (isTable(v)) top = v.t.y - v.t.h * 1.5; // tables read downward from their title
    out.push({
      number: v.number,
      title: v.title,
      scale: v.scale,
      kind: isTable(v) ? 'table' : 'drawing',
      box: isTable(v) ? [Math.round(left), Math.round(top), Math.round(right - left), Math.round(Math.min(pageH, v.t.y + v.t.h * 40) - top)] : [Math.round(left), Math.round(top), Math.round(right - left), Math.round(bottom - top)],
      titleAt: v.titleAt,
    });
  }
  return out;
}

/**
 * Where the title block starts: a long vertical line in the right part of the sheet.
 * index: SnapIndex. Falls back to 80% of the sheet width.
 */
export function titleBlockLeft(index, pageW, pageH) {
  let best = null;
  if (index) {
    for (let i = 0; i < index.n; i++) {
      const k = i * 4;
      const x1 = index.seg[k],
        y1 = index.seg[k + 1],
        x2 = index.seg[k + 2],
        y2 = index.seg[k + 3];
      if (Math.abs(x1 - x2) > 1) continue;
      if (x1 < pageW * 0.6) continue;
      if (Math.abs(y2 - y1) < pageH * 0.6) continue;
      if (!best || x1 < best) best = x1;
    }
  }
  return best || pageW * 0.8;
}
