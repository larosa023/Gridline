// Estimate view: priced condition lines, grouped by division, plus markups and CSV export.
import { store, commit } from './store.js';
import { $, h, esc } from './dom.js';
import { icon } from './icons.js';
import { priceLine, estimateSummary, costBasisOptions, basisLabel, basisUnit } from './geometry.js';
import { fmtNum, fmtMoney } from './units.js';
import { totalsFor } from './panels.js';
import { TYPE_INFO } from './dialogs.js';

let actions = {};
export function initEstimate(a) {
  actions = a;
}

export function computeLines() {
  return store.project.conditions.map((c) => {
    const t = totalsFor(c);
    return { c, t, ...priceLine(c, t) };
  });
}

export function renderEstimate() {
  const el = $('#estimateView');
  const p = store.project;
  const lines = computeLines();
  const sum = estimateSummary(lines, p.settings);

  const groups = new Map();
  for (const l of lines) {
    const g = l.c.group || 'Ungrouped';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }

  let rows = '';
  for (const [g, ls] of [...groups].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const gt = ls.reduce((s, l) => s + l.total, 0);
    rows += `<tr class="group"><td colspan="9">${esc(g)}</td><td class="num">${fmtMoney(gt)}</td></tr>`;
    for (const l of ls) {
      const c = l.c;
      const opts = costBasisOptions(c);
      const unit = basisUnit(l.basis, p.unit);
      rows += `<tr class="line" data-id="${c.id}">
        <td><div class="name-cell"><span class="dot" style="background:${c.color}"></span><input class="wide" data-f="name" value="${esc(c.name)}" /></div></td>
        <td class="muted">${TYPE_INFO[c.type].label}</td>
        <td class="num">${
          opts.length > 1
            ? `<select data-f="costBasis">${opts.map((o) => `<option value="${o}" ${o === l.basis ? 'selected' : ''}>${basisLabel(o)}</option>`).join('')}</select>`
            : basisLabel(l.basis)
        }</td>
        <td class="num">${fmtNum(l.qty, 2)}</td>
        <td class="num"><input data-f="waste" type="number" step="any" min="0" value="${c.waste || 0}" style="width:56px" />%</td>
        <td class="num"><b>${fmtNum(l.qtyW, 2)}</b> <span class="muted">${unit}</span></td>
        <td class="num"><input data-f="matCost" type="number" step="any" min="0" value="${c.matCost || ''}" placeholder="0.00" /></td>
        <td class="num"><input data-f="laborCost" type="number" step="any" min="0" value="${c.laborCost || ''}" placeholder="0.00" /></td>
        <td class="num">${fmtMoney(l.mat)}<br/><span class="muted small">${fmtMoney(l.lab)} labor</span></td>
        <td class="num"><b>${fmtMoney(l.total)}</b></td>
      </tr>`;
    }
  }

  el.innerHTML = `
    <div class="est-head">
      <div><h2>${esc(p.name)}</h2><p>${p.conditions.length} conditions · ${p.markups.length} markups · ${Object.keys(p.pages).length} sheets</p></div>
      <div class="spacer"></div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px"><span>Units</span>
        <select id="unitSelect" style="width:auto"><option value="ft" ${p.unit === 'ft' ? 'selected' : ''}>Imperial (ft)</option><option value="m" ${p.unit === 'm' ? 'selected' : ''}>Metric (m)</option></select></label>
      <button class="btn" id="btnExportCsv">${icon('download', 16)} Export CSV</button>
    </div>
    <div class="est-layout">
      <div class="card" style="overflow:auto">
        ${
          lines.length
            ? `<table class="est">
          <thead><tr><th>Condition</th><th>Type</th><th class="num">Price by</th><th class="num">Quantity</th><th class="num">Waste</th><th class="num">Qty w/ waste</th><th class="num">Mat $/unit</th><th class="num">Labor $/unit</th><th class="num">Mat / Labor</th><th class="num">Total</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="8">Direct cost</td><td class="num">${fmtMoney(sum.mat)}<br/><span class="muted small">${fmtMoney(sum.lab)} labor</span></td><td class="num">${fmtMoney(sum.mat + sum.lab)}</td></tr></tfoot>
        </table>`
            : `<div class="insp-empty" style="padding:60px 20px">${icon('table', 34)}<h3>Nothing to price yet</h3><p>Create conditions and take off quantities in the Takeoff view — they'll roll up here automatically.</p></div>`
        }
      </div>
      <div class="card summary">
        <h3>Summary</h3>
        <div class="kv"><span>Material</span><b>${fmtMoney(sum.mat)}</b></div>
        <div class="kv"><span>Labor</span><b>${fmtMoney(sum.lab)}</b></div>
        <div class="kv"><span>Sales tax on material <input data-s="taxPct" type="number" step="any" min="0" value="${p.settings.taxPct}" />%</span><b>${fmtMoney(sum.tax)}</b></div>
        <div class="kv" style="border-top:1px solid var(--border);margin-top:6px;padding-top:10px"><span>Subtotal</span><b>${fmtMoney(sum.sub)}</b></div>
        <div class="kv"><span>Overhead <input data-s="overheadPct" type="number" step="any" min="0" value="${p.settings.overheadPct}" />%</span><b>${fmtMoney(sum.overhead)}</b></div>
        <div class="kv"><span>Profit <input data-s="profitPct" type="number" step="any" min="0" value="${p.settings.profitPct}" />%</span><b>${fmtMoney(sum.profit)}</b></div>
        <div class="kv total"><span>Bid total</span><b>${fmtMoney(sum.total)}</b></div>
      </div>
    </div>`;

  el.querySelectorAll('tr.line [data-f]').forEach((inp) => {
    const c = p.conditions.find((x) => x.id === inp.closest('tr').dataset.id);
    const f = inp.dataset.f;
    inp.addEventListener('change', () => {
      let v = inp.value;
      if (f !== 'name' && f !== 'costBasis') v = +v || 0;
      if (f === 'name' && !v.trim()) return renderEstimate();
      commit(() => (c[f] = f === 'name' ? v.trim() : v), 'conditions');
    });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') inp.blur();
    });
  });
  el.querySelectorAll('[data-s]').forEach((inp) => {
    inp.addEventListener('change', () => commit((pp) => (pp.settings[inp.dataset.s] = +inp.value || 0), 'settings'));
    inp.addEventListener('keydown', (e) => e.stopPropagation());
  });
  $('#unitSelect', el).onchange = (e) => actions.setUnit(e.target.value);
  $('#btnExportCsv', el).onclick = () => actions.exportCsv();
}

export function estimateCsv() {
  const p = store.project;
  const lines = computeLines();
  const sum = estimateSummary(lines, p.settings);
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const r2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const rows = [['Group', 'Condition', 'Type', 'Priced by', 'Quantity', 'Unit', 'Waste %', 'Qty w/ waste', 'Material $/unit', 'Labor $/unit', 'Material', 'Labor', 'Total', 'Markups']];
  for (const l of lines) {
    rows.push([
      l.c.group || '',
      l.c.name,
      TYPE_INFO[l.c.type].label,
      basisLabel(l.basis),
      r2(l.qty),
      basisUnit(l.basis, p.unit),
      l.c.waste || 0,
      r2(l.qtyW),
      r2(l.c.matCost || 0),
      r2(l.c.laborCost || 0),
      r2(l.mat),
      r2(l.lab),
      r2(l.total),
      l.t.markups,
    ]);
  }
  rows.push([]);
  rows.push(['', 'Material', '', '', '', '', '', '', '', '', r2(sum.mat)]);
  rows.push(['', 'Labor', '', '', '', '', '', '', '', '', '', r2(sum.lab)]);
  rows.push(['', `Sales tax (${p.settings.taxPct}%)`, '', '', '', '', '', '', '', '', '', '', r2(sum.tax)]);
  rows.push(['', `Overhead (${p.settings.overheadPct}%)`, '', '', '', '', '', '', '', '', '', '', r2(sum.overhead)]);
  rows.push(['', `Profit (${p.settings.profitPct}%)`, '', '', '', '', '', '', '', '', '', '', r2(sum.profit)]);
  rows.push(['', 'Bid total', '', '', '', '', '', '', '', '', '', '', r2(sum.total)]);
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}
