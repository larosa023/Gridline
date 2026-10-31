import { THEMES, ACCENTS, DRAWING_MODES, appearance, set as setAppearance } from './appearance.js';
import { modal, h, esc, $ } from './dom.js';
import { icon } from './icons.js';
import { COLORS, store, nextColor } from './store.js';
import { parseLength, formatFeetInches, presetToScale, SCALE_PRESETS, parsePitch, formatPitch } from './units.js';

const TYPE_INFO = {
  linear: { label: 'Linear', icon: 'linear', hint: 'Walls, curbs, piping, trim' },
  area: { label: 'Area', icon: 'area', hint: 'Slabs, flooring, roofing' },
  roof: { label: 'Roof', icon: 'roof', hint: 'Trace the roof in plan view — pitch converts it to true roof area and squares' },
  count: { label: 'Count', icon: 'count', hint: 'Fixtures, doors, devices' },
};
export { TYPE_INFO };

/** Create or edit a condition. Returns the condition fields or null. */
export function conditionDialog(initial = {}) {
  const isNew = !initial.id;
  const metric = store.project.unit === 'm';
  let type = initial.type || 'linear';
  let color = initial.color || nextColor();
  const groups = [...new Set(store.project.conditions.map((c) => c.group).filter(Boolean))];

  return modal({
    title: isNew ? 'New condition' : 'Edit condition',
    buttons: [
      { label: 'Cancel', value: null },
      { label: isNew ? 'Create & start takeoff' : 'Save', primary: true },
    ],
    build(body) {
      body.append(
        h(`<div>
          <div class="field full" style="margin-bottom:12px"><span>Type</span>
            <div class="type-pick four">${Object.entries(TYPE_INFO)
              .map(
                ([k, t]) =>
                  `<button type="button" data-type="${k}" class="${k === type ? 'sel' : ''}" ${isNew ? '' : 'disabled'}>${icon(t.icon, 20)}${t.label}</button>`
              )
              .join('')}</div>
            <small class="muted" id="typeHint">${TYPE_INFO[type].hint}</small>
          </div>
          <div class="fields">
            <label class="field full"><span>Name</span><input name="name" required value="${esc(initial.name || '')}" placeholder="e.g. Interior partition – 3-5/8&quot; mtl stud" /></label>
            <label class="field"><span>Finish tag <small class="muted">(optional)</small></span><input name="tag" value="${esc(initial.tag || '')}" placeholder="e.g. BR-1, P-2" /></label>
            <label class="field"><span>Group / division</span><input name="group" list="groupList" value="${esc(initial.group || '')}" placeholder="e.g. 09 – Finishes" />
              <datalist id="groupList">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
            <label class="field" data-only="linear area"><span>Height <small class="muted">(${metric ? 'm' : 'ft-in'}, optional)</small></span><input name="height" value="${initial.height ? (metric ? initial.height : formatFeetInches(initial.height)) : ''}" placeholder="${metric ? '3.0' : "10'-0\""}" /></label>
            <label class="field" data-only="roof"><span>Pitch <small class="muted">(rise per 12)</small></span><input name="pitch" value="${initial.pitch != null && initial.pitch !== '' ? formatPitch(initial.pitch) : '6/12'}" placeholder="6/12" /></label>
            <label class="field" data-only="linear"><span>Roof line <small class="muted">(optional)</small></span><select name="roofLine">
              <option value="">Flat / plan length</option>
              <option value="rake" ${initial.roofLine === 'rake' ? 'selected' : ''}>Rake / sloped run</option>
              <option value="hip" ${initial.roofLine === 'hip' ? 'selected' : ''}>Hip / valley</option></select></label>
            <label class="field" data-only="linear-roof"><span>Line pitch <small class="muted">(rise per 12)</small></span><input name="linePitch" value="${initial.type === 'linear' && initial.pitch ? formatPitch(initial.pitch) : ''}" placeholder="6/12" /></label>
            <label class="field" data-only="area"><span>Depth / thickness <small class="muted">(${metric ? 'mm' : 'in'}, optional)</small></span><input name="depth" type="number" step="any" min="0" value="${initial.depth || ''}" placeholder="${metric ? '100' : '4'}" /></label>
            <label class="field"><span>Waste</span><div class="input-affix"><input name="waste" type="number" step="any" min="0" value="${initial.waste ?? ''}" placeholder="0" /><i>%</i></div></label>
            <label class="field"><span>Material cost</span><div class="input-affix"><input name="matCost" type="number" step="any" min="0" value="${initial.matCost ?? ''}" placeholder="0.00" /><i data-unit>/LF</i></div></label>
            <label class="field"><span>Labor cost</span><div class="input-affix"><input name="laborCost" type="number" step="any" min="0" value="${initial.laborCost ?? ''}" placeholder="0.00" /><i data-unit>/LF</i></div></label>
            <div class="field full"><span>Color</span><div class="colors">${COLORS.map(
              (c) => `<button type="button" class="color-dot ${c === color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`
            ).join('')}</div></div>
          </div>
        </div>`)
      );
      const roofLine = body.querySelector('[name=roofLine]');
      const sync = () => {
        body.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('sel', b.dataset.type === type));
        body.querySelectorAll('[data-only]').forEach((f) => {
          const only = f.dataset.only.split(' ');
          f.hidden = only.includes('linear-roof') ? !(type === 'linear' && roofLine.value) : !only.includes(type);
        });
        const u =
          type === 'linear' ? (metric ? '/m' : '/LF') : type === 'area' ? (metric ? '/m²' : '/SF') : type === 'roof' ? (metric ? '/m²' : '/SQ') : '/EA';
        body.querySelectorAll('[data-unit]').forEach((i) => (i.textContent = u));
        $('#typeHint', body).textContent = TYPE_INFO[type].hint;
      };
      body.querySelectorAll('[data-type]').forEach(
        (b) =>
          (b.onclick = () => {
            type = b.dataset.type;
            sync();
          })
      );
      body.querySelectorAll('[data-color]').forEach(
        (b) =>
          (b.onclick = () => {
            color = b.dataset.color;
            body.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('sel', x === b));
          })
      );
      roofLine.onchange = sync;
      sync();
    },
    onSubmit(form) {
      const f = new FormData(form);
      const name = String(f.get('name') || '').trim();
      if (!name) return false;
      let height = 0;
      const hs = String(f.get('height') || '').trim();
      if (hs && type !== 'count') {
        height = parseLength(hs, store.project.unit);
        if (!isFinite(height) || height < 0) {
          form.querySelector('[name=height]').setCustomValidity('Enter a length like 10\'-0" or 9.5');
          form.reportValidity();
          form.querySelector('[name=height]').setCustomValidity('');
          return false;
        }
      }
      const bad = (field, msg) => {
        const el = form.querySelector(`[name=${field}]`);
        el.setCustomValidity(msg);
        form.reportValidity();
        el.setCustomValidity('');
        return false;
      };
      let pitch = 0;
      let roofLine = '';
      if (type === 'roof') {
        pitch = parsePitch(f.get('pitch'));
        if (!isFinite(pitch)) return bad('pitch', 'Enter a pitch like 6/12, 6 or 26.6°');
      }
      if (type === 'linear' && f.get('roofLine')) {
        roofLine = String(f.get('roofLine'));
        pitch = parsePitch(f.get('linePitch'));
        if (!isFinite(pitch) || !pitch) return bad('linePitch', 'Enter the roof pitch, e.g. 6/12');
      }
      return {
        name,
        type,
        pitch,
        roofLine,
        color,
        group: String(f.get('group') || '').trim(),
        tag: String(f.get('tag') || '').trim().toUpperCase(),
        height: type === 'count' ? 0 : height,
        depth: type === 'area' ? +f.get('depth') || 0 : 0,
        waste: f.get('waste') === '' ? (type === 'roof' && isNew ? 10 : 0) : +f.get('waste') || 0,
        matCost: +f.get('matCost') || 0,
        laborCost: +f.get('laborCost') || 0,
      };
    },
  });
}

/** Ask for the real length of a drawn calibration line. */
export function calibrateDialog(ptLength) {
  const metric = store.project.unit === 'm';
  const pageCount = Object.keys(store.project.pages).length;
  return modal({
    title: 'Calibrate scale',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Set scale', primary: true },
    ],
    build(body) {
      body.append(
        h(`<div>
          <p>Enter the real-world length of the line you just drew.</p>
          <div class="fields">
            <label class="field full"><span>Known length</span><input name="len" placeholder="${metric ? 'e.g. 6.0m or 6000mm' : 'e.g. 24\'-6&quot; or 24.5'}" /></label>
            <label class="field full" style="flex-direction:row;align-items:center;gap:8px">
              <input type="checkbox" name="all" style="width:auto;height:auto" ${pageCount > 1 ? '' : 'disabled'} />
              <span style="font-size:12.5px;color:var(--text-2)">Apply to all sheets in this drawing set</span></label>
          </div>
        </div>`)
      );
    },
    onSubmit(form) {
      const inp = form.querySelector('[name=len]');
      const v = parseLength(inp.value, store.project.unit);
      if (!isFinite(v) || v <= 0) {
        inp.setCustomValidity('Enter a length, e.g. 24\'-6"');
        form.reportValidity();
        inp.setCustomValidity('');
        return false;
      }
      const ptPerUnit = ptLength / v;
      return {
        scale: { ptPerUnit, unit: store.project.unit, label: 'Calibrated', calibrated: true },
        all: form.querySelector('[name=all]').checked,
      };
    },
  });
}

export function scaleOptionsHtml(current) {
  const groups = {};
  SCALE_PRESETS.forEach((p, i) => (groups[p.group] = groups[p.group] || []).push([p, i]));
  let html = `<option value="" ${!current ? 'selected' : ''}>Set scale…</option>`;
  const isPreset = current && !current.calibrated && SCALE_PRESETS.some((p) => p.label === current.label);
  if (current && !isPreset) html += `<option value="cal" selected>${esc(current.calibrated ? 'Calibrated' : current.label)}</option>`;
  for (const [g, list] of Object.entries(groups)) {
    html += `<optgroup label="${g}">`;
    for (const [p, i] of list) {
      const sel = current && !current.calibrated && current.label === p.label ? 'selected' : '';
      html += `<option value="${i}" ${sel}>${esc(p.label)}</option>`;
    }
    html += `</optgroup>`;
  }
  html += `<option value="detect">Read from title block</option>`;
  html += `<option value="calibrate">Calibrate from drawing…</option>`;
  return html;
}

export { presetToScale };

export function shortcutsDialog() {
  const rows = [
    ['Select / edit', 'V'],
    ['Pan', 'H or hold Space'],
    ['Linear takeoff', 'L'],
    ['Area takeoff', 'A'],
    ['Roof takeoff (pitched)', 'R'],
    ['Count takeoff (drag a box = find matches)', 'C'],
    ['Auto-fill a room', 'B'],
    ['Flip Linear ⇄ Area', 'Tab'],
    ['Snap to plan lines on/off', 'S'],
    ['Dark drawings on/off', 'Ctrl+Shift+D'],
    ['Command palette', 'Ctrl+K'],
    ['Hide / show left panel', '['],
    ['Hide / show right panel', ']'],
    ['Hide / show both panels', '\\'],
    ['Bypass snap while held', 'Ctrl'],
    ['Quick measure', 'M'],
    ['Calibrate scale', 'K'],
    ['Finish shape', 'Enter / double-click / right-click'],
    ['Remove last point', 'Backspace'],
    ['Cancel', 'Esc'],
    ['Snap 45° / 90°', 'hold Shift'],
    ['Deduct (area)', 'hold Alt while finishing'],
    ['Zoom', 'Mouse wheel'],
    ['Fit page', 'F'],
    ['Prev / next sheet', 'PgUp / PgDn'],
    ['Delete markup', 'Del'],
    ['Undo / redo', 'Ctrl+Z / Ctrl+Y'],
    ['Save', 'Ctrl+S'],
    ['Takeoff / Estimate', 'Ctrl+1 / Ctrl+2'],
    ['Export CSV', 'Ctrl+E'],
  ];
  return modal({
    title: 'Keyboard shortcuts',
    wide: true,
    buttons: [{ label: 'Close', value: null }],
    build(body) {
      body.append(
        h(`<div class="kbd-grid">${rows
          .map(([a, k]) => `<div><span>${a}</span><span>${k.split(' / ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</span></div>`)
          .join('')}</div>`)
      );
    },
  });
}

export function aboutDialog(version, onCheck) {
  return modal({
    title: 'About Gridline',
    buttons: [{ label: 'Close', value: null }],
    build(body) {
      const n = h(`<div style="text-align:center;padding:6px 0 4px">
        <img src="../../build/icon.png" width="64" height="64" alt="" />
        <h2 style="margin:10px 0 2px">Gridline</h2>
        <p class="muted" style="margin:0 0 14px">Version ${esc(version)} · Construction takeoff &amp; estimating</p>
        <button type="button" class="btn" data-icon="refresh">Check for updates</button>
      </div>`);
      n.querySelector('button').onclick = onCheck;
      body.append(n);
    },
  });
}

/**
 * Settings. `app` = current app preferences, `proj` = current project settings + unit.
 * Resolves to { app, proj, makeDefault } or null.
 */
export function settingsDialog({ app, proj, version, hasProject, onCheckUpdates }) {
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  const toggle = (name, on, label, hint = '') =>
    `<label class="setting-row"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" class="switch" name="${name}" ${on ? 'checked' : ''} /></label>`;
  return modal({
    title: 'Settings',
    wide: true,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save settings', primary: true },
    ],
    build(body) {
      const n = h(`<div class="settings">
        <div class="settings-group">
          <h3>App</h3>
          <label class="setting-row"><span><b>Theme</b></span><select name="theme">${THEMES.map((t) => opt(t.id, app.theme, t.name)).join('')}${opt('system', app.theme, 'Match Windows')}</select></label>
          <label class="setting-row"><span><b>Accent colour</b></span><select name="accent">${ACCENTS.map((x) => opt(x.id, app.accent, x.name)).join('')}</select></label>
          <label class="setting-row"><span><b>Drawing display</b><small>Dark and Blueprint invert the sheet for night work; text and linework stay readable</small></span><select name="drawing">${DRAWING_MODES.map((m) => opt(m.id, app.drawing, m.name)).join('')}</select></label>
          ${toggle('snap', app.snap, 'Snap to plan lines', 'Pull points onto wall corners and lines in the PDF. Hold Ctrl to place a free point.')}
          <label class="setting-row"><span><b>Snap strength</b><small>How close the cursor has to be before it grabs a line</small></span><select name="snapRadius">${opt('6', String(app.snapRadius), 'Light')}${opt('10', String(app.snapRadius), 'Normal')}${opt('16', String(app.snapRadius), 'Strong')}</select></label>
          <label class="setting-row"><span><b>Fill gap tolerance</b><small>Bigger bridges small breaks in walls; too big can merge rooms</small></span><select name="fillGap">${opt('small', app.fillGap, 'Small')}${opt('medium', app.fillGap, 'Medium')}${opt('large', app.fillGap, 'Large')}</select></label>
          ${toggle('autoScale', app.autoScale, 'Read scales from title blocks', 'When you add drawings, unscaled sheets get the scale printed on them.')}
          <label class="setting-row"><span><b>Sheet list</b><small>What the left panel shows for each PDF</small></span><select name="sheetMode">${opt('all', app.sheetMode, 'All pages')}${opt('current', app.sheetMode, 'Current page only')}</select></label>
          ${toggle('autoUpdate', app.autoUpdate, 'Check for updates automatically', 'Updates download in the background; you choose when to restart.')}
          <div class="setting-row"><span><b>Version</b><small>Gridline ${esc(version || '')}</small></span><button type="button" class="btn small" data-check>${icon('refresh', 14)} Check now</button></div>
        </div>
        <div class="settings-group ${hasProject ? '' : 'disabled'}">
          <h3>This project</h3>
          <label class="setting-row"><span><b>Units</b></span><select name="unit">${opt('ft', proj.unit, 'Imperial (ft, SF, CY)')}${opt('m', proj.unit, 'Metric (m, m², m³)')}</select></label>
          <label class="setting-row"><span><b>Length display</b></span><select name="labelStyle">${opt('ftin', proj.labelStyle, `Feet-inches (12'-6")`)}${opt('decimal', proj.labelStyle, 'Decimal (12.50 LF)')}</select></label>
          ${toggle('showLabels', proj.showLabels, 'Show quantities on the drawing')}
          <div class="setting-row"><span><b>Estimate markups</b><small>Sales tax on material, overhead, profit</small></span>
            <span class="pct-inputs">
              <label><input name="taxPct" type="number" step="any" min="0" value="${proj.taxPct}" /><i>% tax</i></label>
              <label><input name="overheadPct" type="number" step="any" min="0" value="${proj.overheadPct}" /><i>% OH</i></label>
              <label><input name="profitPct" type="number" step="any" min="0" value="${proj.profitPct}" /><i>% profit</i></label>
            </span></div>
          ${toggle('makeDefault', false, 'Use these project settings for new projects')}
        </div>
      </div>`);
      n.querySelector('[data-check]').onclick = onCheckUpdates;
      body.append(n);
    },
    onSubmit(form) {
      const f = new FormData(form);
      const on = (k) => form.querySelector(`[name=${k}]`).checked;
      return {
        app: {
          theme: f.get('theme'),
          accent: f.get('accent'),
          drawing: f.get('drawing'),
          snap: on('snap'),
          snapRadius: +f.get('snapRadius'),
          sheetMode: f.get('sheetMode'),
          autoUpdate: on('autoUpdate'),
          fillGap: f.get('fillGap'),
          autoScale: on('autoScale'),
        },
        proj: {
          unit: f.get('unit'),
          labelStyle: f.get('labelStyle'),
          showLabels: on('showLabels'),
          taxPct: +f.get('taxPct') || 0,
          overheadPct: +f.get('overheadPct') || 0,
          profitPct: +f.get('profitPct') || 0,
        },
        makeDefault: on('makeDefault'),
      };
    },
  });
}

// ---------------------------------------------------------------------------------------
// Appearance popover: theme, accent colour, drawing display
// ---------------------------------------------------------------------------------------

const DRAW_PREVIEW = {
  normal: { bg: '#ffffff', ink: '#1a1a1a', red: '#d33', f: '' },
  dark: { bg: '#1b1f25', ink: '#eef1f4', red: '#ff7b7b', f: '' },
  blueprint: { bg: '#0e2a4f', ink: '#e9f3ff', red: '#e9f3ff', f: '' },
  dim: { bg: '#d9d3c6', ink: '#1a1814', red: '#b33', f: '' },
};

function drawPreview(id) {
  const c = DRAW_PREVIEW[id];
  return `<svg viewBox="0 0 80 40" preserveAspectRatio="none"><rect width="80" height="40" fill="${c.bg}"/>
    <rect x="8" y="7" width="40" height="24" fill="none" stroke="${c.ink}" stroke-width="1.4"/>
    <path d="M28 7v24M8 19h20" stroke="${c.ink}" stroke-width="0.8"/>
    ${[0, 1, 2, 3, 4].map((i) => `<path d="M30 ${11 + i * 4}h16" stroke="${c.ink}" stroke-opacity="0.45" stroke-width="0.5"/>`).join('')}
    <rect x="54" y="25" width="20" height="9" fill="none" stroke="${c.ink}" stroke-width="0.8"/>
    <text x="57" y="31.5" font-size="5" font-family="sans-serif" font-weight="700" fill="${c.ink}">A-101</text>
    <circle cx="66" cy="12" r="4" fill="none" stroke="${c.red}" stroke-width="1"/></svg>`;
}

export function appearancePopover(anchor) {
  const old = document.getElementById('appearPop');
  if (old) return old.remove();
  const pop = document.createElement('div');
  pop.className = 'appear-pop';
  pop.id = 'appearPop';
  const render = () => {
    const a = appearance();
    pop.innerHTML = `
      <h4>Theme</h4>
      <div class="theme-grid">${THEMES.map(
        (t) => `<button class="theme-card ${!a.system && a.theme === t.id ? 'sel' : ''}" data-theme-id="${t.id}">
          <div class="sw" style="background:${t.swatch[1]}"><i style="background:${t.id === 'contrast' ? '#fff' : 'var(--accent)'}"></i><b style="background:${t.base === 'dark' ? '#fff' : '#000'}"></b></div>${esc(t.name)}</button>`
      ).join('')}</div>
      <h4>Accent</h4>
      <div class="accent-row">${ACCENTS.map((x) => `<button class="accent-dot ${a.accent === x.id ? 'sel' : ''}" data-accent="${x.id}" title="${esc(x.name)}" style="background:${x.c}"></button>`).join('')}</div>
      <h4>Drawings</h4>
      <div class="draw-grid">${DRAWING_MODES.map((m) => `<button class="draw-card ${a.drawing === m.id ? 'sel' : ''}" data-drawing="${m.id}" title="${esc(m.hint)}"><div class="pv">${drawPreview(m.id)}</div>${esc(m.name)}</button>`).join('')}</div>
      <div class="appear-row" ${a.drawing === 'dark' || a.drawing === 'blueprint' ? '' : 'hidden'}><span>Faint line boost</span><input type="range" min="0" max="1" step="0.05" value="${a.boost}" data-boost /></div>
      <div class="appear-foot"><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" data-system ${a.system ? 'checked' : ''}/> Match Windows</label><span title="Toggle dark drawings"><kbd>Ctrl+Shift+D</kbd></span></div>`;
    pop.querySelectorAll('[data-theme-id]').forEach((b) => (b.onclick = () => (setAppearance({ theme: b.dataset.themeId, system: false }), render())));
    pop.querySelectorAll('[data-accent]').forEach((b) => (b.onclick = () => (setAppearance({ accent: b.dataset.accent }), render())));
    pop.querySelectorAll('[data-drawing]').forEach((b) => (b.onclick = () => (setAppearance({ drawing: b.dataset.drawing }), render())));
    const boost = pop.querySelector('[data-boost]');
    if (boost) boost.oninput = () => setAppearance({ boost: +boost.value });
    pop.querySelector('[data-system]').onchange = (e) => (setAppearance({ system: e.target.checked }), render());
  };
  render();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 8 + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
  const close = (e) => {
    if (e.type === 'keydown' ? e.key === 'Escape' : !pop.contains(e.target) && !anchor.contains(e.target)) {
      pop.remove();
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', close, true);
  });
}

// ---------------------------------------------------------------------------------------
// Condition library: reusable conditions across projects
// ---------------------------------------------------------------------------------------
export function libraryDialog(lib, projectConds) {
  const have = new Set(projectConds.map((c) => `${c.type}|${c.name.toLowerCase()}`));
  let items = lib.slice();
  return modal({
    title: 'Condition library',
    wide: true,
    buttons: [
      { label: 'Close', value: null },
      { label: 'Add selected to project', primary: true },
    ],
    build(body) {
      const render = (q = '') => {
        const ql = q.toLowerCase();
        const groups = new Map();
        items.forEach((c, i) => {
          if (ql && !`${c.name} ${c.group || ''} ${c.type}`.toLowerCase().includes(ql)) return;
          const g = c.group || 'Ungrouped';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push([c, i]);
        });
        const listEl = body.querySelector('.lib-list');
        listEl.innerHTML = items.length
          ? [...groups]
              .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
              .map(
                ([g, arr]) =>
                  `<div class="cond-group">${esc(g)}</div>` +
                  arr
                    .map(([c, i]) => {
                      const inProj = have.has(`${c.type}|${c.name.toLowerCase()}`);
                      const cost = (+c.matCost || 0) + (+c.laborCost || 0);
                      return `<label class="lib-row ${inProj ? 'in' : ''}"><input type="checkbox" data-i="${i}" ${inProj ? 'disabled' : ''}/>
                        <span class="dot" style="background:${esc(c.color || '#888')}"></span>
                        <span class="lib-name">${esc(c.name)}</span>
                        <span class="chip">${esc(TYPE_INFO[c.type] ? TYPE_INFO[c.type].label : c.type)}</span>
                        <span class="muted small">${cost ? '$' + cost.toFixed(2) + '/unit' : ''}${inProj ? ' · in project' : ''}</span>
                        <button type="button" class="icon-btn" data-del="${i}" title="Remove from library">${icon('trash', 14)}</button></label>`;
                    })
                    .join('')
              )
              .join('')
          : `<div class="empty-list">Your library is empty.<br/>Right-click a condition → <b>Save to library</b>, or use <b>Save all</b> in the Conditions panel menu.</div>`;
        listEl.querySelectorAll('[data-del]').forEach(
          (b) =>
            (b.onclick = (e) => {
              e.preventDefault();
              items.splice(+b.dataset.del, 1);
              body.dataset.changed = '1';
              render(body.querySelector('[data-q]').value);
            })
        );
      };
      body.append(
        h(`<div><div class="search" style="margin-bottom:10px">${icon('search', 15)}<input data-q placeholder="Search library" /></div><div class="lib-list"></div>
           <p class="muted small" style="margin-top:10px">The library is saved on this PC and shared by all your projects.</p></div>`)
      );
      body.querySelector('[data-q]').addEventListener('input', (e) => render(e.target.value));
      body.querySelector('[data-q]').addEventListener('keydown', (e) => e.stopPropagation());
      render();
      body._items = () => items;
    },
    onSubmit(form) {
      const picked = [...form.querySelectorAll('[data-i]:checked')].map((x) => items[+x.dataset.i]);
      return { add: picked, library: items, changed: form.querySelector('.body').dataset.changed === '1' };
    },
  });
}
