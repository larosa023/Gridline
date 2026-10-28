// Left panel (sheets + conditions) and right inspector.
import { store, commit, condition } from './store.js';
import { $, h, esc, contextMenu } from './dom.js';
import { icon } from './icons.js';
import { requestThumb } from './viewer.js';
import { scaleFor } from './overlay.js';
import { conditionTotals, markupQuantities, priceLine, costBasisOptions, basisLabel, basisUnit } from './geometry.js';
import { fmtNum, fmtMoney, formatFeetInches, UNIT_LABELS, parseLength } from './units.js';
import { TYPE_INFO } from './dialogs.js';

let actions = {};
export function initPanels(a) {
  actions = a;
}

export function totalsFor(c) {
  return conditionTotals({ ...c, unit: store.project.unit }, store.project.markups, scaleFor);
}

export function primaryQty(c, t = totalsFor(c)) {
  const u = UNIT_LABELS[store.project.unit];
  if (c.type === 'linear') return `${fmtNum(t.length, 1)} ${u.length}`;
  if (c.type === 'area') return `${fmtNum(t.area, 1)} ${u.area}`;
  return `${fmtNum(t.count, 0)} ${u.count}`;
}

// ---------------- Sheets ----------------
export function renderSheets() {
  const list = $('#sheetList');
  const p = store.project;
  $('#sheetCount').textContent = Object.keys(p.pages).length;
  if (!p.documents.length) {
    list.innerHTML = `<div class="empty-list">No drawings yet.<br/>Add PDFs to get started.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const d of p.documents) {
    const head = h(`<div class="doc-head">${icon('file', 13)}<span title="${esc(d.name)}">${esc(d.name)}</span>
      <button class="icon-btn" title="Remove drawing set">${icon('trash', 14)}</button></div>`);
    head.querySelector('button').onclick = () => actions.removeDocument(d.id);
    frag.append(head);
    const keys = Object.keys(p.pages).filter((k) => k.startsWith(d.id + ':'));
    keys.sort((a, b) => +a.split(':')[1] - +b.split(':')[1]);
    for (const key of keys) {
      const pg = p.pages[key];
      const n = key.split(':')[1];
      const marks = p.markups.filter((m) => m.pageKey === key).length;
      const row = h(`<div class="sheet ${key === store.ui.pageKey ? 'active' : ''}" data-key="${key}">
        <div class="thumb"></div>
        <div class="sheet-meta">
          <div class="sheet-name" title="Double-click to rename">${esc(pg.name || 'Page ' + n)}</div>
          <div class="sheet-sub">
            ${pg.scale ? `<span class="chip">${esc(pg.scale.label)}</span>` : `<span class="chip warn">No scale</span>`}
            ${marks ? `<span>${marks} markup${marks > 1 ? 's' : ''}</span>` : ''}
          </div>
        </div></div>`);
      row.onclick = () => actions.goToPage(key);
      row.querySelector('.sheet-name').ondblclick = (e) => {
        e.stopPropagation();
        renameSheet(row, key);
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Rename sheet', icon: 'tag', run: () => renameSheet(row, key) },
          { label: 'Copy scale to all sheets', icon: 'copy', run: () => actions.copyScaleToAll(key) },
        ]);
      };
      frag.append(row);
      requestThumb(key, row.querySelector('.thumb'));
    }
  }
  list.replaceChildren(frag);
}

function renameSheet(row, key) {
  const nameEl = row.querySelector('.sheet-name');
  const cur = store.project.pages[key].name || '';
  nameEl.innerHTML = `<input value="${esc(cur)}" />`;
  const inp = nameEl.querySelector('input');
  inp.focus();
  inp.select();
  const done = (save) => {
    if (save && inp.value.trim() && inp.value.trim() !== cur) {
      commit((p) => (p.pages[key].name = inp.value.trim()), 'pages');
    } else renderSheets();
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
  inp.onblur = () => done(true);
  inp.onclick = (e) => e.stopPropagation();
}

export function markSheetActive() {
  document.querySelectorAll('.sheet').forEach((s) => s.classList.toggle('active', s.dataset.key === store.ui.pageKey));
}

// ---------------- Conditions ----------------
export function renderConditions() {
  const list = $('#condList');
  const p = store.project;
  $('#condCount').textContent = p.conditions.length;
  const q = ($('#condSearch').value || '').toLowerCase();
  if (!p.conditions.length) {
    list.innerHTML = `<div class="empty-list">No conditions yet.<br/>A condition is a takeoff item like a wall type, slab, or fixture.<br/><br/><b>Press New</b> or pick Linear, Area or Count in the toolbar.</div>`;
    return;
  }
  const groups = new Map();
  for (const c of p.conditions) {
    if (q && !(c.name.toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q))) continue;
    const g = c.group || 'Ungrouped';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const frag = document.createDocumentFragment();
  const showHeads = groups.size > 1 || !groups.has('Ungrouped');
  for (const [g, items] of groups) {
    if (showHeads) frag.append(h(`<div class="cond-group">${esc(g)}</div>`));
    for (const c of items) {
      const hidden = store.ui.hiddenConditions.has(c.id);
      const row = h(`<div class="cond ${c.id === store.ui.activeConditionId ? 'active' : ''} ${hidden ? 'hidden-cond' : ''}" data-id="${c.id}">
        <div class="swatch" style="background:${c.color}">${icon(TYPE_INFO[c.type].icon, 14)}</div>
        <div style="min-width:0"><div class="cond-name" title="${esc(c.name)}">${esc(c.name)}</div>
          <div class="cond-qty" style="text-align:left">${primaryQty(c)}</div></div>
        <div class="cond-actions">
          <button class="icon-btn" data-act="eye" title="${hidden ? 'Show' : 'Hide'} on drawings">${icon(hidden ? 'eyeOff' : 'eye', 15)}</button>
          <button class="icon-btn" data-act="more" title="More">${icon('dots', 15)}</button>
        </div></div>`);
      row.onclick = (e) => {
        const act = e.target.closest('[data-act]');
        if (act && act.dataset.act === 'eye') {
          store.ui.hiddenConditions.has(c.id) ? store.ui.hiddenConditions.delete(c.id) : store.ui.hiddenConditions.add(c.id);
          actions.refresh();
          return;
        }
        if (act && act.dataset.act === 'more') {
          const r = act.getBoundingClientRect();
          return condMenu(c, r.left, r.bottom + 4);
        }
        actions.activateCondition(c.id);
      };
      row.ondblclick = (e) => {
        if (!e.target.closest('[data-act]')) actions.editCondition(c.id);
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        condMenu(c, e.clientX, e.clientY);
      };
      frag.append(row);
    }
  }
  list.replaceChildren(frag);
}

function condMenu(c, x, y) {
  contextMenu(x, y, [
    { label: 'Edit condition…', icon: 'tag', run: () => actions.editCondition(c.id) },
    { label: 'Duplicate', icon: 'copy', run: () => actions.duplicateCondition(c.id) },
    '-',
    { label: 'Delete condition & markups', icon: 'trash', danger: true, run: () => actions.deleteCondition(c.id) },
  ]);
}

// ---------------- Inspector ----------------
export function renderInspector() {
  const el = $('#inspector');
  const p = store.project;
  const m = p.markups.find((x) => x.id === store.ui.selectedMarkupId);
  const c = condition(store.ui.activeConditionId) || (m && condition(m.conditionId));
  const u = UNIT_LABELS[p.unit];
  const parts = [];

  if (c) {
    const t = totalsFor(c);
    const line = priceLine(c, t);
    const pageT = conditionTotals(
      { ...c, unit: p.unit },
      p.markups.filter((x) => x.pageKey === store.ui.pageKey),
      scaleFor
    );
    const big =
      c.type === 'linear'
        ? [fmtNum(t.length, 2), u.length, 'Total length']
        : c.type === 'area'
          ? [fmtNum(t.area, 2), u.area, 'Total area']
          : [fmtNum(t.count, 0), u.count, 'Total count'];
    const pageVal =
      c.type === 'linear' ? `${fmtNum(pageT.length, 1)} ${u.length}` : c.type === 'area' ? `${fmtNum(pageT.area, 1)} ${u.area}` : `${pageT.count} ${u.count}`;
    const extra = [];
    if (c.type === 'linear' && c.height) extra.push(['Wall area', fmtNum(t.area, 1), u.area]);
    if (c.type === 'area') {
      extra.push(['Perimeter', fmtNum(t.perimeter, 1), u.length]);
      if (c.depth) extra.push(['Volume', fmtNum(t.volume, 2), u.volume]);
      if (c.height) extra.push(['Wall area', fmtNum(t.wallArea, 1), u.area]);
    }
    const opts = costBasisOptions(c);
    parts.push(`<div class="insp-section">
      <div class="insp-title">Condition <button class="icon-btn" data-act="edit" title="Edit">${icon('tag', 14)}</button></div>
      <div class="insp-head">
        <div class="swatch" style="background:${c.color}">${icon(TYPE_INFO[c.type].icon, 16)}</div>
        <input data-f="name" value="${esc(c.name)}" />
      </div>
      <div class="qty-grid">
        <div class="qty big"><label>${big[2]}</label><b>${big[0]}<small>${big[1]}</small></b></div>
        <div class="qty"><label>This sheet</label><b>${pageVal}</b></div>
        <div class="qty"><label>Markups</label><b>${t.markups}</b></div>
        ${extra.map(([l, v, un]) => `<div class="qty"><label>${l}</label><b>${v}<small>${un}</small></b></div>`).join('')}
      </div>
      ${t.unscaled ? `<p class="small" style="color:var(--accent);margin:10px 0 0">${t.unscaled} markup(s) are on unscaled sheets and aren't counted.</p>` : ''}
    </div>
    <div class="insp-section">
      <div class="insp-title">Properties</div>
      <div class="fields">
        <label class="field full"><span>Group / division</span><input data-f="group" value="${esc(c.group || '')}" placeholder="e.g. 03 – Concrete" /></label>
        ${c.type !== 'count' ? `<label class="field"><span>Height</span><input data-f="height" value="${c.height ? (p.unit === 'm' ? c.height : formatFeetInches(c.height)) : ''}" placeholder="—" /></label>` : ''}
        ${c.type === 'area' ? `<label class="field"><span>Depth (${p.unit === 'm' ? 'mm' : 'in'})</span><input data-f="depth" type="number" step="any" min="0" value="${c.depth || ''}" placeholder="—" /></label>` : ''}
        <label class="field"><span>Waste %</span><input data-f="waste" type="number" step="any" min="0" value="${c.waste || 0}" /></label>
        ${opts.length > 1 ? `<label class="field"><span>Price by</span><select data-f="costBasis">${opts.map((o) => `<option value="${o}" ${o === line.basis ? 'selected' : ''}>${basisLabel(o)} (${basisUnit(o, p.unit)})</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>Material $/${basisUnit(line.basis, p.unit)}</span><input data-f="matCost" type="number" step="any" min="0" value="${c.matCost || ''}" placeholder="0.00" /></label>
        <label class="field"><span>Labor $/${basisUnit(line.basis, p.unit)}</span><input data-f="laborCost" type="number" step="any" min="0" value="${c.laborCost || ''}" placeholder="0.00" /></label>
      </div>
      <div class="kv" style="margin-top:12px"><span>Qty incl. waste</span><b>${fmtNum(line.qtyW, 2)} ${basisUnit(line.basis, p.unit)}</b></div>
      <div class="kv"><span>Material</span><b>${fmtMoney(line.mat)}</b></div>
      <div class="kv"><span>Labor</span><b>${fmtMoney(line.lab)}</b></div>
      <div class="kv"><span>Extended total</span><b style="color:var(--accent)">${fmtMoney(line.total)}</b></div>
    </div>`);
  }

  if (m) {
    const q = markupQuantities(m, scaleFor(m.pageKey));
    let rows = '';
    if (q.unscaled) rows = `<p class="small" style="color:var(--accent)">Sheet isn't scaled.</p>`;
    if (q.length != null) rows += `<div class="kv"><span>Length</span><b>${p.unit === 'm' ? fmtNum(q.length, 2) + ' m' : formatFeetInches(q.length)}</b></div><div class="kv"><span>Segments</span><b>${q.segments}</b></div>`;
    if (q.area != null) rows += `<div class="kv"><span>Area</span><b>${fmtNum(Math.abs(q.area), 2)} ${u.area}</b></div><div class="kv"><span>Perimeter</span><b>${fmtNum(q.perimeter, 2)} ${u.length}</b></div>`;
    if (q.count != null) rows += `<div class="kv"><span>Count</span><b>${q.count}</b></div>`;
    parts.push(`<div class="insp-section">
      <div class="insp-title">Selected markup</div>
      ${rows}
      <div class="row">
        ${m.type === 'area' ? `<button class="btn small" data-act="deduct">${m.deduct ? 'Make additive' : 'Make deduction'}</button>` : ''}
        <button class="btn small danger" data-act="delete">${icon('trash', 14)} Delete</button>
      </div>
    </div>`);
  }

  if (!c && !m) {
    parts.push(`<div class="insp-empty">${icon('layers', 32)}
      <h3>No condition selected</h3>
      <p>Choose a condition from the left, or press <kbd>L</kbd>, <kbd>A</kbd> or <kbd>C</kbd> to start measuring.</p>
      <button class="btn primary" data-act="new">${icon('plus', 15)} New condition</button></div>`);
  }

  // Sheet summary
  if (store.ui.pageKey) {
    const pg = p.pages[store.ui.pageKey];
    const marks = p.markups.filter((x) => x.pageKey === store.ui.pageKey).length;
    parts.push(`<div class="insp-section">
      <div class="insp-title">Sheet</div>
      <div class="kv"><span>Name</span><b>${esc(pg.name || '')}</b></div>
      <div class="kv"><span>Scale</span><b>${pg.scale ? esc(pg.scale.label) : '<span style="color:var(--accent)">Not set</span>'}</b></div>
      <div class="kv"><span>Markups</span><b>${marks}</b></div>
      <div class="kv"><span>Labels</span><b><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" data-act="labels" ${p.settings.showLabels ? 'checked' : ''}/> Show</label></b></div>
    </div>`);
  }

  el.innerHTML = parts.join('');

  // Wire up edits
  el.querySelectorAll('[data-f]').forEach((inp) => {
    const f = inp.dataset.f;
    const save = () => {
      let v = inp.value;
      if (f === 'height') {
        v = v.trim() ? parseLength(v, p.unit) : 0;
        if (!isFinite(v) || v < 0) return renderInspector();
      } else if (['depth', 'waste', 'matCost', 'laborCost'].includes(f)) v = +v || 0;
      else v = v.trim();
      if (f === 'name' && !v) return renderInspector();
      if (c[f] === v) return;
      commit(() => (c[f] = v), 'conditions');
    };
    inp.addEventListener('change', save);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') inp.blur();
    });
  });
  const act = (name, fn) => {
    const b = el.querySelector(`[data-act="${name}"]`);
    if (b) b.onclick = fn;
  };
  act('edit', () => actions.editCondition(c.id));
  act('new', () => actions.newCondition());
  act('delete', () => actions.deleteSelected());
  act('deduct', () => commit(() => (m.deduct = !m.deduct), 'markups'));
  const lab = el.querySelector('[data-act="labels"]');
  if (lab) lab.onchange = () => commit((pp) => (pp.settings.showLabels = lab.checked), 'settings');
}
