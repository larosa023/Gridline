// Draws markups, the in-progress shape and labels into the SVG overlay.
import { store, condition } from './store.js';
import { view } from './viewer.js';
import { centroid, midpointOfPolyline, polygonArea, polylineLength, polygonPerimeter } from './geometry.js';
import { fmtLength, fmtNum, UNIT_LABELS } from './units.js';
import { esc } from './dom.js';

let svg;
export function initOverlay(el) {
  svg = el;
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

export function lengthLabel(pts, pageKey, closed = false) {
  const sc = scaleFor(pageKey);
  const L = closed ? polygonPerimeter(pts) : polylineLength(pts);
  if (!sc) return `${fmtNum(L / 72, 2)} in (paper)`;
  return fmtLength(L / sc.ptPerUnit, store.project.unit, store.project.settings.labelStyle);
}

export function areaLabel(pts, pageKey) {
  const sc = scaleFor(pageKey);
  if (!sc) return 'unscaled';
  const a = polygonArea(pts) / (sc.ptPerUnit * sc.ptPerUnit);
  return `${fmtNum(a, 1)} ${UNIT_LABELS[store.project.unit].area}`;
}

/** Full redraw. `draft` = { type, points, hover, color } for the shape being drawn. */
export function drawOverlay(draft = null, measure = null) {
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

  for (const m of store.project.markups) {
    if (m.pageKey !== view.pageKey || hidden.has(m.conditionId)) continue;
    const c = condition(m.conditionId);
    const color = c ? c.color : '#888';
    const isSel = m.id === sel;
    const pts = m.points.map((p) => p.join(',')).join(' ');
    if (m.type === 'area') {
      const fill = m.deduct ? 'url(#hatch)' : color;
      out += `<polygon class="mk" data-id="${m.id}" points="${pts}" fill="${fill}" fill-opacity="${m.deduct ? 1 : isSel ? 0.42 : 0.28}" stroke="${color}" stroke-width="${isSel ? 3 : 2}" vector-effect="non-scaling-stroke" stroke-linejoin="round" ${m.deduct ? 'stroke-dasharray="6 4"' : ''}/>`;
      if (showLabels) {
        const [cx, cy] = centroid(m.points);
        labels += label(cx, cy, (m.deduct ? '− ' : '') + areaLabel(m.points, m.pageKey), color, fs, z);
      }
    } else if (m.type === 'linear') {
      out += `<polyline class="mk" data-id="${m.id}" points="${pts}" fill="none" stroke="transparent" stroke-width="14" vector-effect="non-scaling-stroke"/>`;
      out += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${isSel ? 5 : 3.5}" stroke-opacity="0.9" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
      if (showLabels) {
        const [mx, my] = midpointOfPolyline(m.points);
        labels += label(mx, my - px(10), lengthLabel(m.points, m.pageKey), color, fs, z);
      }
    } else if (m.type === 'count') {
      const r = px(isSel ? 8 : 7);
      for (const [x, y] of m.points) {
        out += `<circle class="mk" data-id="${m.id}" cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="0.9" stroke="#fff" stroke-width="${isSel ? 2.5 : 1.5}" vector-effect="non-scaling-stroke"/>`;
      }
    }
    if (isSel && m.type !== 'count') out += handles(m.points, color, px);
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
    if (draft.type === 'area') {
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

  svg.innerHTML = `<defs><pattern id="hatch" width="${px(8)}" height="${px(8)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="${px(8)}" height="${px(8)}" fill="#fff" fill-opacity="0.35"/><line x1="0" y1="0" x2="0" y2="${px(8)}" stroke="#e5484d" stroke-width="${px(2)}"/></pattern></defs>${out}${labels}`;
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
