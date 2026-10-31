// Exports: Excel estimate workbook (live formulas) and marked-up PDF (vector markups drawn
// onto the original drawing pages, with a legend on each sheet and a summary page).
import { store, condition } from './store.js';
import { buildXlsx, ST, colName } from './xlsx.js';
import { computeLines, breakdown } from './estimate.js';
import { estimateSummary, basisLabel, basisUnit, centroid, midpointOfPolyline, markupQuantities } from './geometry.js';
import { scaleFor } from './overlay.js';
import { fmtNum, UNIT_LABELS } from './units.js';
import * as viewer from './viewer.js';
import { TYPE_INFO } from './dialogs.js';

// ---------------------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------------------

/** Rows for the estimate workbook. Pure apart from reading project state; exported for tests. */
export function estimateWorkbook() {
  const p = store.project;
  const lines = computeLines();
  const sum = estimateSummary(lines, p.settings);
  const H = (v) => ({ v, s: ST.header });
  const rows = [];
  rows.push([{ v: p.name, s: ST.title }]);
  rows.push([`Estimate · ${new Date().toLocaleDateString()} · ${p.unit === 'm' ? 'metric' : 'imperial'} units · Gridline`]);
  rows.push([]);
  const head = ['Group', 'Condition', 'Tag', 'Type', 'Priced by', 'Quantity', 'Unit', 'Waste %', 'Qty w/ waste', 'Material $/unit', 'Labor $/unit', 'Material', 'Labor', 'Total'];
  rows.push(head.map(H));
  const first = rows.length + 1; // 1-based row of first line
  const groups = new Map();
  for (const l of lines) {
    const g = l.c.group || 'Ungrouped';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  const lineRows = [];
  for (const [g, ls] of [...groups].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    for (const l of ls) {
      const r = rows.length + 1;
      lineRows.push(r);
      rows.push([
        g,
        l.c.name,
        l.c.tag || '',
        TYPE_INFO[l.c.type] ? TYPE_INFO[l.c.type].label : l.c.type,
        basisLabel(l.basis, l.c),
        { v: +l.qty.toFixed(4), s: ST.num },
        basisUnit(l.basis, p.unit),
        { v: +(l.c.waste || 0), s: ST.num },
        { f: `F${r}*(1+H${r}/100)`, v: +l.qtyW.toFixed(4), s: ST.num },
        { v: +(l.c.matCost || 0), s: ST.money },
        { v: +(l.c.laborCost || 0), s: ST.money },
        { f: `I${r}*J${r}`, v: +l.mat.toFixed(2), s: ST.money },
        { f: `I${r}*K${r}`, v: +l.lab.toFixed(2), s: ST.money },
        { f: `L${r}+M${r}`, v: +l.total.toFixed(2), s: ST.money },
      ]);
    }
  }
  const last = rows.length;
  rows.push([]);
  const R = () => rows.length + 1;
  const rng = (c) => (lineRows.length ? `SUM(${c}${first}:${c}${last})` : '0');
  const rMat = R();
  rows.push([{ v: 'Material', s: ST.bold }, '', '', '', '', '', '', '', '', '', '', { f: rng('L'), v: +sum.mat.toFixed(2), s: ST.boldMoney }]);
  const rLab = R();
  rows.push([{ v: 'Labor', s: ST.bold }, '', '', '', '', '', '', '', '', '', '', '', { f: rng('M'), v: +sum.lab.toFixed(2), s: ST.boldMoney }]);
  const rTaxPct = R();
  rows.push(['Sales tax on material %', '', '', '', '', '', '', { v: +p.settings.taxPct || 0, s: ST.num }, '', '', '', '', '', { f: `L${rMat}*H${rTaxPct}/100`, v: +sum.tax.toFixed(2), s: ST.money }]);
  const rSub = R();
  rows.push([{ v: 'Subtotal', s: ST.bold }, '', '', '', '', '', '', '', '', '', '', '', '', { f: `L${rMat}+M${rLab}+N${rTaxPct}`, v: +sum.sub.toFixed(2), s: ST.boldMoney }]);
  const rOh = R();
  rows.push(['Overhead %', '', '', '', '', '', '', { v: +p.settings.overheadPct || 0, s: ST.num }, '', '', '', '', '', { f: `N${rSub}*H${rOh}/100`, v: +sum.overhead.toFixed(2), s: ST.money }]);
  const rPr = R();
  rows.push(['Profit %', '', '', '', '', '', '', { v: +p.settings.profitPct || 0, s: ST.num }, '', '', '', '', '', { f: `(N${rSub}+N${rOh})*H${rPr}/100`, v: +sum.profit.toFixed(2), s: ST.money }]);
  rows.push([{ v: 'Bid total', s: ST.bold }, '', '', '', '', '', '', '', '', '', '', '', '', { f: `N${rSub}+N${rOh}+N${rPr}`, v: +sum.total.toFixed(2), s: ST.boldMoney }]);

  // Takeoff detail
  const detail = [[H('Group'), H('Condition'), H('Tag'), H('Sheet'), H('Label / view'), H('Markups'), H('Quantity'), H('Unit')]];
  for (const l of lines) {
    const unit = l.c.type === 'linear' ? UNIT_LABELS[p.unit].length : l.c.type === 'count' ? 'EA' : UNIT_LABELS[p.unit].area;
    for (const b of breakdown(l.c)) detail.push([l.c.group || '', l.c.name, l.c.tag || '', b.sheet, b.label, { v: b.n, s: ST.int }, b.unscaled === b.n ? 'unscaled' : { v: +b.qty.toFixed(2), s: ST.num }, unit]);
  }
  // Sheets
  const sheets = [[H('Sheet'), H('Scale'), H('Markups')]];
  for (const d of p.documents) {
    for (const k of Object.keys(p.pages).filter((x) => x.startsWith(d.id + ':')).sort((a, b) => +a.split(':')[1] - +b.split(':')[1])) {
      const pg = p.pages[k];
      sheets.push([pg.name, pg.scale ? pg.scale.label : 'not set', { v: p.markups.filter((m) => m.pageKey === k).length, s: ST.int }]);
    }
  }
  return [
    { name: 'Estimate', rows, widths: [20, 34, 9, 9, 12, 12, 7, 9, 13, 14, 13, 14, 14, 15], freezeRow: 4 },
    { name: 'Takeoff detail', rows: detail, widths: [20, 34, 9, 12, 30, 9, 13, 7], freezeRow: 1 },
    { name: 'Sheets', rows: sheets, widths: [16, 20, 10], freezeRow: 1 },
  ];
}

export function estimateXlsx() {
  return buildXlsx(estimateWorkbook());
}

// ---------------------------------------------------------------------------------------
// Marked-up PDF
// ---------------------------------------------------------------------------------------

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) / 255 || 0);

/** Invert an affine transform [a b c d e f]. */
function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Make text safe for the built-in PDF font (WinAnsi). */
function ansi(font, s) {
  let out = '';
  for (const ch of String(s)) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === '²' ? '2' : ch === '′' ? "'" : ch === '″' ? '"' : '?';
    }
  }
  return out;
}

/**
 * Build a PDF of the chosen sheets with markups drawn as vectors.
 * opts: { pageKeys, legend: true, summary: true, labels: true }
 */
export async function markedUpPdf(opts) {
  const lib = await import('../vendor/pdf-lib.min.mjs');
  const { PDFDocument, StandardFonts, rgb, degrees } = lib;
  const p = store.project;
  const out = await PDFDocument.create();
  out.setTitle(`${p.name} — takeoff`);
  out.setCreator('Gridline');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const srcCache = new Map();
  const unitL = UNIT_LABELS[p.unit];

  for (const key of opts.pageKeys) {
    const docId = key.split(':')[0];
    if (!srcCache.has(docId)) {
      const bytes = await viewer.documentBytes(docId);
      srcCache.set(docId, await PDFDocument.load(bytes, { ignoreEncryption: true }));
    }
    const src = srcCache.get(docId);
    const t = await viewer.pageTransform(key);
    const [page] = await out.copyPages(src, [t.index]);
    out.addPage(page);
    const toPdf = invert(t.transform); // Gridline points -> PDF user space
    const rot = page.getRotation().angle || 0;
    const ms = p.markups.filter((m) => m.pageKey === key);
    const k = scaleFor(key);
    const lw = Math.max(t.w, t.h) / 1100; // line weight that reads at sheet size
    const path = (pts, close) => {
      let d = '';
      pts.forEach((q, i) => {
        const [x, y] = apply(toPdf, q);
        d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${(-y).toFixed(2)} `;
      });
      return d + (close ? 'Z' : '');
    };
    const textAt = (q, str, size, color, f = bold) => {
      const s = ansi(f, str);
      const [x, y] = apply(toPdf, q);
      const w = f.widthOfTextAtSize(s, size);
      // halo for readability over linework
      page.drawRectangle({ x: x - w / 2 - size * 0.2, y: y - size * 0.35, width: w + size * 0.4, height: size * 1.2, color: rgb(1, 1, 1), opacity: 0.78, rotate: degrees(rot) });
      page.drawText(s, { x: x - w / 2, y: y - size * 0.1, size, font: f, color, rotate: degrees(rot) });
    };
    for (const m of ms) {
      const c = condition(m.conditionId);
      if (!c) continue;
      const [r, g, b] = hexRgb(c.color);
      const col = rgb(r, g, b);
      if (m.type === 'count') {
        for (const q of m.points) {
          const [x, y] = apply(toPdf, q);
          page.drawCircle({ x, y, size: lw * 5, color: col, opacity: 0.9, borderColor: rgb(1, 1, 1), borderWidth: lw });
        }
        continue;
      }
      if (m.type === 'linear') {
        page.drawSvgPath(path(m.points, false), { x: 0, y: 0, borderColor: col, borderWidth: lw * 2.6, borderOpacity: 0.9 });
      } else {
        page.drawSvgPath(path(m.points, true), {
          x: 0,
          y: 0,
          color: m.deduct ? rgb(1, 1, 1) : col,
          opacity: m.deduct ? 0.55 : 0.25,
          borderColor: m.deduct ? rgb(0.9, 0.28, 0.3) : col,
          borderWidth: lw * 1.6,
          borderOpacity: 0.95,
          ...(m.deduct ? { borderDashArray: [lw * 5, lw * 3] } : {}),
        });
      }
      if (opts.labels !== false && k && !m.deduct) {
        const q = markupQuantities(m, k, c);
        const txt =
          m.type === 'linear'
            ? `${fmtNum(q.length, 1)} ${unitL.length}`
            : m.type === 'roof'
              ? `${fmtNum(q.area, 0)} ${unitL.area}`
              : `${fmtNum(q.area, 0)} ${unitL.area}`;
        const at = m.type === 'linear' ? midpointOfPolyline(m.points) : centroid(m.points);
        textAt(at, (m.label ? m.label + ': ' : '') + txt + (+m.mult > 1 ? ` x${+m.mult}` : ''), lw * 9, col);
      }
    }
    // Legend: conditions on this sheet with this sheet's quantity.
    if (opts.legend !== false && ms.length) {
      const ids = [...new Set(ms.map((m) => m.conditionId))].map(condition).filter(Boolean);
      const size = lw * 9;
      const rowH = size * 1.7;
      const lines = ids.map((c) => {
        let qty = 0;
        for (const m of ms) if (m.conditionId === c.id) {
          const q = k ? markupQuantities(m, k, c) : { count: m.points.length };
          qty += c.type === 'linear' ? q.length || 0 : c.type === 'count' ? q.count || 0 : q.area || 0;
        }
        const u = c.type === 'linear' ? unitL.length : c.type === 'count' ? 'EA' : unitL.area;
        return { c, text: ansi(font, `${c.name}${c.tag ? ' (' + c.tag + ')' : ''}  —  ${fmtNum(qty, c.type === 'count' ? 0 : 1)} ${u}`) };
      });
      const wMax = Math.max(bold.widthOfTextAtSize('TAKEOFF LEGEND', size), ...lines.map((l) => font.widthOfTextAtSize(l.text, size))) + size * 3.2;
      const hBox = rowH * (lines.length + 1.6);
      // top-left of the sheet (in Gridline space), mapped to PDF
      const [lx, ly] = apply(toPdf, [t.w * 0.02, t.h * 0.03]);
      const yTop = ly;
      page.drawRectangle({ x: lx, y: yTop - hBox, width: wMax, height: hBox, color: rgb(1, 1, 1), opacity: 0.92, borderColor: rgb(0.2, 0.22, 0.26), borderWidth: lw });
      page.drawText('TAKEOFF LEGEND', { x: lx + size * 0.8, y: yTop - rowH, size, font: bold, color: rgb(0.1, 0.1, 0.12) });
      lines.forEach((l, i) => {
        const yy = yTop - rowH * (i + 2.1);
        const [r, g, b] = hexRgb(l.c.color);
        page.drawRectangle({ x: lx + size * 0.8, y: yy - size * 0.1, width: size * 1.1, height: size * 1.1, color: rgb(r, g, b) });
        page.drawText(l.text, { x: lx + size * 2.4, y: yy, size, font, color: rgb(0.1, 0.1, 0.12) });
      });
    }
  }

  // Summary page
  if (opts.summary !== false) {
    const pg = out.addPage([792, 612]);
    const lines = computeLines();
    const sum = estimateSummary(lines, p.settings);
    let y = 560;
    pg.drawText(ansi(bold, p.name), { x: 40, y, size: 18, font: bold });
    y -= 20;
    pg.drawText(`Takeoff summary · ${new Date().toLocaleDateString()} · Gridline`, { x: 40, y, size: 10, font, color: rgb(0.35, 0.38, 0.42) });
    y -= 28;
    const cols = [40, 300, 380, 470, 560, 660];
    ['Condition', 'Quantity', 'w/ waste', 'Material', 'Labor', 'Total'].forEach((h, i) => pg.drawText(h, { x: cols[i], y, size: 9, font: bold }));
    y -= 6;
    pg.drawLine({ start: { x: 40, y }, end: { x: 752, y }, thickness: 0.6, color: rgb(0.6, 0.62, 0.66) });
    y -= 14;
    const money = (v) => '$' + fmtNum(v, 2);
    for (const l of lines) {
      if (y < 70) break;
      const [r, g, b] = hexRgb(l.c.color);
      pg.drawRectangle({ x: 40, y: y - 1, width: 7, height: 7, color: rgb(r, g, b) });
      const u = basisUnit(l.basis, p.unit);
      [ansi(font, l.c.name).slice(0, 44), `${fmtNum(l.qty, 1)} ${u}`, `${fmtNum(l.qtyW, 1)}`, money(l.mat), money(l.lab), money(l.total)].forEach((v, i) => pg.drawText(v, { x: cols[i] + (i ? 0 : 12), y, size: 9, font }));
      y -= 14;
    }
    y -= 6;
    pg.drawLine({ start: { x: 40, y }, end: { x: 752, y }, thickness: 0.6, color: rgb(0.6, 0.62, 0.66) });
    y -= 16;
    for (const [lab, v] of [['Material', sum.mat], ['Labor', sum.lab], [`Tax (${p.settings.taxPct}%)`, sum.tax], [`Overhead (${p.settings.overheadPct}%)`, sum.overhead], [`Profit (${p.settings.profitPct}%)`, sum.profit], ['Bid total', sum.total]]) {
      const f = lab === 'Bid total' ? bold : font;
      pg.drawText(lab, { x: 470, y, size: lab === 'Bid total' ? 11 : 9, font: f });
      pg.drawText(money(v), { x: 660, y, size: lab === 'Bid total' ? 11 : 9, font: f });
      y -= lab === 'Material' || lab === 'Labor' ? 13 : 15;
    }
  }
  return await out.save();
}

export { colName };
