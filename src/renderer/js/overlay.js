// Draws markups, the in-progress shape and labels into the SVG overlay.
import { store, condition } from './store.js';
import { view } from './viewer.js';
import { centroid, midpointOfPolyline, polygonArea, polylineLength, polygonPerimeter, markupPitch, pointInPolygon } from './geometry.js';
import { fmtLength, fmtNum, UNIT_LABELS, slopeFactor, hipFactor, formatPitch } from './units.js';
import { esc } from './dom.js';

let svg, snapSvg;
export function initOverlay(el, snapEl) {
  svg = el;
  snapSvg = snapEl;
}

/** Cheap redraw of just the snap marker (runs on every mouse move). */
let auxState = { box: null, proposals: null };
/** Extra things drawn on the light layer: a selection box and match proposals. */
export function setAux(next) {
  auxState = { ...auxState, ...next };
}

export function drawSnapLayer(snap) {
  if (!snapSvg) return;
  const z = view.zoom;
  const px = (n) => n / z;
  snapSvg.setAttribute('width', view.pageW * z);
  snapSvg.setAttribute('height', view.pageH * z);
  snapSvg.setAttribute('viewBox', `0 0 ${view.pageW} ${view.pageH}`);
  if (!view.pageKey) return (snapSvg.innerHTML = '');
  let s = '';
  const { box, proposals } = auxState;
  if (proposals && proposals.pageKey === view.pageKey) {
    const r = Math.max(px(9), proposals.radius || 0);
    for (const c of proposals.items) {
      const on = c.score >= proposals.cutoff && !c.off;
      s += `<circle cx="${c.p[0]}" cy="${c.p[1]}" r="${r}" fill="${on ? proposals.color : 'none'}" fill-opacity="0.18" stroke="${on ? proposals.color : '#8d9bb0'}" stroke-width="${on ? 2.5 : 1.5}" stroke-dasharray="${on ? '0' : '4 3'}" vector-effect="non-scaling-stroke"/>`;
      if (on) s += `<path d="M${c.p[0] - r * 0.35} ${c.p[1]} l${r * 0.25} ${r * 0.28} l${r * 0.45} ${-r * 0.55}" fill="none" stroke="${proposals.color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
    }
  }
  if (box) {
    const [x0, y0, x1, y1] = box;
    s += `<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="rgba(34,184,207,0.08)" stroke="#22b8cf" stroke-width="1.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>`;
  }
  if (snap) s += snapMarker(snap, px);
  snapSvg.innerHTML = s;
}

export function scaleFor(pageKey) {
  const s = store.project.pages[pageKey] && store.project.pages[pageKey].scale;
  if (!s) return null;
  // Normalize to the project's unit.
  if (s.unit === store.project.unit) return s;
  if (s.unit === 'm' && store.project.unit === 'ft') return { ...s, ptPerUnit: s.ptPerUnit * 0.3048, unit: 'ft' };
  if (s.unit === 'ft' && store.project.unit === 'm') return { ...s, ptPerUnit: s.ptPerUnit / 0.3048, unit: 'm' };
  return s;
}

export function lengthLabel(pts, pageKey, closed = false, factor = 1) {
  const sc = scaleFor(pageKey);
  const L = (closed ? polygonPerimeter(pts) : polylineLength(pts)) * factor;
  if (!sc) return `${fmtNum(L / 72, 2)} in (paper)`;
  return fmtLength(L / sc.ptPerUnit, store.project.unit, store.project.settings.labelStyle);
}

export function areaLabel(pts, pageKey, pitch = null) {
  const sc = scaleFor(pageKey);
  if (!sc) return 'unscaled';
  let a = polygonArea(pts) / (sc.ptPerUnit * sc.ptPerUnit);
  if (pitch != null) a *= slopeFactor(pitch);
  const s = `${fmtNum(a, 1)} ${UNIT_LABELS[store.project.unit].area}`;
  return pitch != null ? `${s} @ ${formatPitch(pitch)}` : s;
}

/** Plan-to-true multiplier for a linear condition's roof line setting. */
export function lineFactor(c, m) {
  if (!c || !c.roofLine) return 1;
  const p = markupPitch(m || {}, c);
  if (!p) return 1;
  return c.roofLine === 'hip' ? hipFactor(p) : slopeFactor(p);
}

/** Full redraw. `draft` = { type, points, hover, color } for the shape being drawn. */
export function drawOverlay(draft = null, measure = null, snap = null) {
  if (!svg) return;
  const z = view.zoom;
  const W = view.pageW;
  const H = view.pageH;
  svg.setAttribute('width', W * z);
  svg.setAttribute('height', H * z);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!view.pageKey) {
    svg.innerHTML = '';
    return;
  }

  const px = (n) => n / z; // screen px -> page pts
  const sel = store.ui.selectedMarkupId;
  const hidden = store.ui.hiddenConditions;
  const showLabels = store.project.settings.showLabels;
  const fs = px(11.5);
  let out = '';
  let labels = '';
  const roofPatterns = new Map();

  for (const m of store.project.markups) {
    if (m.pageKey !== view.pageKey || hidden.has(m.conditionId)) continue;
    const c = condition(m.conditionId);
    const color = c ? c.color : '#888';
    const isSel = m.id === sel;
    const pts = m.points.map((p) => p.join(',')).join(' ');
    if (m.type === 'area' || m.type === 'roof') {
      const roof = m.type === 'roof';
      const fill = m.deduct ? 'url(#hatch)' : roof ? `url(#roof-${c ? c.id : 'x'})` : color;
      out += `<polygon class="mk" data-id="${m.id}" points="${pts}" fill="${fill}" fill-opacity="${m.deduct || roof ? 1 : isSel ? 0.42 : 0.28}" stroke="${color}" stroke-width="${isSel ? 3 : 2}" vector-effect="non-scaling-stroke" stroke-linejoin="round" ${m.deduct ? 'stroke-dasharray="6 4"' : ''}/>`;
      if (roof && c) roofPatterns.set(c.id, color);
      if (showLabels) {
        // Only label shapes big enough on screen to hold the text.
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of m.points) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        const wpx = (x1 - x0) * z, hpx = (y1 - y0) * z;
        let qty = (m.deduct ? '− ' : '') + areaLabel(m.points, m.pageKey, roof ? markupPitch(m, c) : null);
        if (!m.deduct) {
          // A zone with openings deducted inside it shows its net area.
          const holes = store.project.markups.filter((d) => d.deduct && d.conditionId === m.conditionId && d.pageKey === m.pageKey && pointInPolygon(centroid(d.points), m.points));
          const sc = scaleFor(m.pageKey);
          if (holes.length && sc) {
            const k2 = sc.ptPerUnit * sc.ptPerUnit;
            let net = polygonArea(m.points) - holes.reduce((a, d) => a + polygonArea(d.points), 0);
            if (roof) net *= slopeFactor(markupPitch(m, c));
            qty = `${fmtNum(net / k2, 1)} ${UNIT_LABELS[store.project.unit].area} net`;
          }
        }
        const text = m.label && !m.deduct ? `${m.label}: ${qty}` : qty;
        const need = text.length * 6.5;
        if (hpx >= 14 && wpx >= Math.min(need, 70)) {
          const [cx, cy] = centroid(m.points);
          labels += label(cx, cy, wpx >= need ? text : qty, color, fs, z);
        }
      }
    } else if (m.type === 'linear') {
      out += `<polyline class="mk" data-id="${m.id}" points="${pts}" fill="none" stroke="transparent" stroke-width="14" vector-effect="non-scaling-stroke"/>`;
      out += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${isSel ? 5 : 3.5}" stroke-opacity="0.9" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
      if (showLabels) {
        const [mx, my] = midpointOfPolyline(m.points);
        labels += label(mx, my - px(10), lengthLabel(m.points, m.pageKey, false, lineFactor(c, m)), color, fs, z);
      }
    } else if (m.type === 'count') {
      const r = px(isSel ? 8 : 7);
      for (const [x, y] of m.points) {
        out += `<circle class="mk" data-id="${m.id}" cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="0.9" stroke="#fff" stroke-width="${isSel ? 2.5 : 1.5}" vector-effect="non-scaling-stroke"/>`;
      }
    }
    if (isSel && m.type !== 'count') out += handles(m.points, color, px);
  }

  // Assistant markups that need a human look get an amber "?" badge.
  for (const m of store.project.markups) {
    if (!m.review || m.pageKey !== view.pageKey || hidden.has(m.conditionId)) continue;
    const [cx, cy] = m.type === 'linear' ? midpointOfPolyline(m.points) : centroid(m.points);
    const r = px(9);
    labels += `<g class="mk" data-id="${m.id}" style="cursor:pointer"><circle cx="${cx + px(14)}" cy="${cy - px(14)}" r="${r}" fill="#f5a524" stroke="#1a1204" stroke-width="1.5" vector-effect="non-scaling-stroke"/><text x="${cx + px(14)}" y="${cy - px(14) + px(4)}" text-anchor="middle" font-size="${px(12)}" fill="#1a1204" stroke="none">?</text></g>`;
  }

  // Count numbering per condition on this page (helps verify).
  if (showLabels) {
    const seen = {};
    for (const m of store.project.markups) {
      if (m.type !== 'count' || m.pageKey !== view.pageKey || hidden.has(m.conditionId)) continue;
      for (const [x, y] of m.points) {
        seen[m.conditionId] = (seen[m.conditionId] || 0) + 1;
        labels += `<text x="${x}" y="${y + px(3.8)}" text-anchor="middle" font-size="${px(9.5)}" fill="#fff" stroke="none">${seen[m.conditionId]}</text>`;
      }
    }
  }

  if (draft && draft.points.length) {
    const color = draft.color || 'var(--accent)';
    const all = draft.hover ? [...draft.points, draft.hover] : draft.points;
    const pts = all.map((p) => p.join(',')).join(' ');
    if (draft.type === 'area' || draft.type === 'roof') {
      out += `<polygon points="${pts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
    } else {
      out += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${draft.type === 'calibrate' ? '2 4' : '0'}" vector-effect="non-scaling-stroke" stroke-linecap="round" pointer-events="none"/>`;
    }
    for (const [x, y] of draft.points) {
      out += `<circle cx="${x}" cy="${y}" r="${px(4)}" fill="#fff" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
    }
  }

  if (measure && measure.points.length === 2) {
    const [a, b] = measure.points;
    out += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#1d8cff" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
    for (const [x, y] of measure.points) {
      out += `<line x1="${x - px(6)}" y1="${y}" x2="${x + px(6)}" y2="${y}" stroke="#1d8cff" stroke-width="2" vector-effect="non-scaling-stroke"/><line x1="${x}" y1="${y - px(6)}" x2="${x}" y2="${y + px(6)}" stroke="#1d8cff" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
    }
    labels += label((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - px(10), lengthLabel(measure.points, view.pageKey), '#1d8cff', fs, z);
  }


  let pats = '';
  for (const [id, color] of roofPatterns) {
    const g = px(14);
    pats += `<pattern id="roof-${id}" width="${g}" height="${g}" patternUnits="userSpaceOnUse"><rect width="${g}" height="${g}" fill="${color}" fill-opacity="0.2"/><path d="M${g * 0.2} ${g * 0.7} L${g / 2} ${g * 0.35} L${g * 0.8} ${g * 0.7}" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="${px(1)}"/></pattern>`;
  }
  svg.innerHTML = `<defs>${pats}<pattern id="hatch" width="${px(8)}" height="${px(8)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="${px(8)}" height="${px(8)}" fill="#fff" fill-opacity="0.35"/><line x1="0" y1="0" x2="0" y2="${px(8)}" stroke="#e5484d" stroke-width="${px(2)}"/></pattern></defs>${out}${labels}`;
}

function label(x, y, text, color, fs, z) {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" fill="${color}" stroke-width="${3.5 / z}">${esc(text)}</text>`;
}

function handles(points, color, px) {
  let s = '';
  points.forEach(([x, y], i) => {
    s += `<rect class="handle" data-vertex="${i}" x="${x - px(5)}" y="${y - px(5)}" width="${px(10)}" height="${px(10)}" fill="#fff" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" style="cursor:move"/>`;
  });
  return s;
}

const SNAP_COLOR = '#22b8cf';
function snapMarker(snap, px) {
  const [x, y] = snap.point;
  const r = px(7);
  const st = `fill="none" stroke="${SNAP_COLOR}" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="none"`;
  let s = '';
  if (snap.seg) {
    const [x1, y1, x2, y2] = snap.seg;
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${SNAP_COLOR}" stroke-opacity="0.55" stroke-width="3" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
  }
  if (snap.kind === 'endpoint') s += `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" ${st}/>`;
  else if (snap.kind === 'intersection') s += `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" ${st}/>`;
  else s += `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z" ${st}/>`;
  return s;
}
