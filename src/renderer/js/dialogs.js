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
  if (current && current.calibrated) html += `<option value="cal" selected>Calibrated</option>`;
  for (const [g, list] of Object.entries(groups)) {
    html += `<optgroup label="${g}">`;
    for (const [p, i] of list) {
      const sel = current && !current.calibrated && current.label === p.label ? 'selected' : '';
      html += `<option value="${i}" ${sel}>${esc(p.label)}</option>`;
    }
    html += `</optgroup>`;
  }
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
    ['Count takeoff', 'C'],
    ['Flip Linear ⇄ Area', 'Tab'],
    ['Snap to plan lines on/off', 'S'],
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
          <label class="setting-row"><span><b>Theme</b></span><select name="theme">${opt('dark', app.theme, 'Dark')}${opt('light', app.theme, 'Light')}${opt('system', app.theme, 'Match Windows')}</select></label>
          ${toggle('snap', app.snap, 'Snap to plan lines', 'Pull points onto wall corners and lines in the PDF. Hold Ctrl to place a free point.')}
          <label class="setting-row"><span><b>Snap strength</b><small>How close the cursor has to be before it grabs a line</small></span><select name="snapRadius">${opt('6', String(app.snapRadius), 'Light')}${opt('10', String(app.snapRadius), 'Normal')}${opt('16', String(app.snapRadius), 'Strong')}</select></label>
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
          snap: on('snap'),
          snapRadius: +f.get('snapRadius'),
          sheetMode: f.get('sheetMode'),
          autoUpdate: on('autoUpdate'),
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
