// Gridline renderer entry: wires the viewer, tools, panels, files and updater together.
import { store, commit, undo, redo, on, emit, uid, blankProject, resetHistory, markDirty, condition, nextColor } from './store.js';
import * as viewer from './viewer.js';
import { view } from './viewer.js';
import { initOverlay, drawOverlay, drawSnapLayer, scaleFor, lengthLabel, areaLabel, lineFactor } from './overlay.js';
import { findSnap } from './snap.js';
import { markupPitch } from './geometry.js';
import { initPanels, renderSheets, renderConditions, renderInspector, markSheetActive } from './panels.js';
import { initEstimate, renderEstimate, estimateCsv } from './estimate.js';
import { conditionDialog, calibrateDialog, scaleOptionsHtml, presetToScale, shortcutsDialog, aboutDialog, TYPE_INFO } from './dialogs.js';
import { SCALE_PRESETS } from './units.js';
import { $, $$, h, esc, toast, modal, contextMenu, closeContextMenu } from './dom.js';
import { hydrateIcons, icon } from './icons.js';
import { dist, distToSegment, pointInPolygon, orthoSnap } from './geometry.js';

// ---------- Platform bridge (falls back to a browser shim for development) ----------
const api = window.gridline || browserShim();
function browserShim() {
  return {
    __shim: true,
    version: async () => 'dev',
    openPdfs: () => pickFiles('.pdf', true).then((fs) => Promise.all(fs.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))),
    openProject: () => pickFiles('.gridline', false).then(async ([f]) => (f ? { path: null, text: await f.text() } : null)),
    saveProject: async ({ text, name }) => (download(text, (name || 'project') + '.gridline'), null),
    exportFile: async ({ text, defaultName }) => (download(text, defaultName), defaultName),
    message: async ({ message, buttons }) => (confirm(message) ? 0 : buttons.length - 1),
    openExternal: (u) => window.open(u),
    confirmClose: () => {},
    onCloseRequested: () => {},
    onMenu: () => {},
    updater: { check: async () => {}, state: async () => ({}), install: () => {}, onState: () => {} },
  };
}
function pickFiles(accept, multiple) {
  return new Promise((res) => {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept, multiple });
    i.onchange = () => res([...i.files]);
    i.click();
  });
}
function download(text, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text])), download: name });
  a.click();
}

// ---------- Init ----------
let draft = null; // shape being drawn: { type, points, hover, color }
let measure = null; // quick-measure: { points: [] }
let manualCheck = false;
let snapOn = localStorage.getItem('gridline-snap') !== 'off';
let snapIndex = null; // line geometry of the current sheet
let snapHit = null; // current snap target, shown as a marker
const DRAW_TOOLS = ['linear', 'area', 'roof', 'count', 'measure', 'calibrate'];
const TAKEOFF_TOOLS = ['linear', 'area', 'roof', 'count'];
const SNAP_TOOLS = ['linear', 'area', 'roof', 'measure', 'calibrate'];
const vpEl = $('#viewport');
hydrateIcons();
viewer.initViewer({ canvasEl: $('#pdfCanvas'), stageEl: $('#stage'), viewport: vpEl, onViewChange });
initOverlay($('#overlay'), $('#snapLayer'));
store.ui.lastByType = {};
const panelActions = {
  goToPage,
  removeDocument,
  copyScaleToAll,
  activateCondition,
  editCondition,
  duplicateCondition,
  deleteCondition,
  newCondition: () => newCondition(),
  deleteSelected,
  refresh: () => refresh('ui'),
};
initPanels(panelActions);
initEstimate({ setUnit, exportCsv });

applyTheme(localStorage.getItem('gridline-theme') || 'dark');
api.version().then((v) => {
  store.version = v;
  $('#statusVersion').textContent = 'v' + v;
});

on((what) => refresh(what));
refresh('all');
markDirty(false);

// ---------- Rendering ----------

function refresh(what = 'all') {
  const p = store.project;
  if (document.activeElement !== $('#projectName')) $('#projectName').value = p.name;
  // Keep selection valid.
  if (store.ui.pageKey && !p.pages[store.ui.pageKey]) store.ui.pageKey = null;
  if (!['ui', 'markups-live'].includes(what)) {
    renderSheets();
  }
  renderConditions();
  renderInspector();
  updateToolbar();
  redraw();
  if (store.ui.view === 'estimate') renderEstimate();
  $('#emptyState').hidden = !!p.documents.length;
  $('#pageNav').hidden = !store.ui.pageKey;
}

function redraw() {
  drawOverlay(draft, measure);
  drawSnapLayer(snapHit);
}

function onViewChange() {
  redraw();
  $('#zoomReadout').textContent = Math.round(view.zoom * 100) + '%';
}

function updateToolbar() {
  const p = store.project;
  $$('#toolGroup .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === store.ui.tool));
  $('#btnCalibrate').classList.toggle('active', store.ui.tool === 'calibrate');
  vpEl.className = 'viewport ' + (store.ui.tool === 'pan' ? 'tool-pan' : DRAW_TOOLS.includes(store.ui.tool) ? 'tool-draw' : '');
  const snapBtn = $('#btnSnap');
  snapBtn.classList.toggle('on', snapOn);
  snapBtn.title = `Snap to plan lines: ${snapOn ? 'ON' : 'OFF'} (S) — hold Ctrl to bypass`;

  const c = condition(store.ui.activeConditionId);
  $('#activeCond').innerHTML = c ? `<div class="swatch" style="background:${c.color}">${icon(TYPE_INFO[c.type].icon, 13)}</div><span title="${esc(c.name)}">${esc(c.name)}</span>` : '';

  const pg = store.ui.pageKey && p.pages[store.ui.pageKey];
  const sel = $('#scaleSelect');
  sel.innerHTML = scaleOptionsHtml(pg && pg.scale);
  sel.disabled = !pg;
  sel.classList.toggle('unset', !!pg && !pg.scale);
  $('#btnCalibrate').disabled = !pg;
  $('#scaleBanner').hidden = !(pg && !pg.scale && ['linear', 'area', 'roof', 'measure'].includes(store.ui.tool));
  $('#statusScale').textContent = pg ? (pg.scale ? 'Scale: ' + pg.scale.label : 'Scale: not set') : '';

  const keys = orderedPageKeys();
  const i = keys.indexOf(store.ui.pageKey);
  $('#pageNavLabel').textContent = pg ? `${pg.name} · ${i + 1} / ${keys.length}` : '';
  $('#statusCursor').textContent = snapOn ? 'Snap on' : 'Snap off';
  $('#statusHint').textContent = toolHint();
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === store.ui.view));
}

function toolHint() {
  const t = store.ui.tool;
  if (!store.project.documents.length) return 'Add drawings to begin';
  return (
    {
      select: 'Click a markup to select it · drag handles to edit · Del to delete',
      pan: 'Drag to pan · wheel to zoom',
      linear: draft ? 'Click to add points · Enter / double-click to finish · Backspace undoes a point · Shift for 90°' : 'Click to start a linear run · Tab flips to Area',
      area: draft ? 'Click to add corners · Enter / double-click to close · hold Alt to finish as a deduction' : 'Click to start an area · Tab flips to Linear',
      roof: draft ? 'Trace the roof outline in plan · Enter to close · hold Alt for a deduction (skylight, chimney)' : 'Trace a roof plane in plan view — pitch converts it to true roof area',
      count: 'Click to place counts · Esc when done',
      measure: 'Click two points to measure',
      calibrate: 'Click both ends of a known dimension',
    }[t] || ''
  );
}

// ---------- Theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('gridline-theme', t);
  const b = $('#btnTheme');
  b.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
}
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// ---------- Files ----------
function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function addPdfFiles(files) {
  if (!files || !files.length) return;
  let firstKey = null;
  for (const f of files) {
    const id = uid('doc');
    let info;
    try {
      info = await viewer.loadDocument(id, f.data.slice());
    } catch (e) {
      console.error(e);
      toast(`Couldn't open ${f.name}. Is it a valid PDF?`, { kind: 'err' });
      continue;
    }
    store.project.documents.push({ id, name: f.name.replace(/\.pdf$/i, ''), data: toBase64(f.data) });
    for (let n = 1; n <= info.numPages; n++) {
      const key = `${id}:${n}`;
      const label = info.labels && info.labels[n - 1];
      store.project.pages[key] = { name: label && !/^\d+$/.test(label) ? label : `Page ${n}` };
      if (!firstKey) firstKey = key;
    }
    guessNames(id, info.numPages);
  }
  resetHistory();
  markDirty();
  if (store.project.name === 'Untitled project' && store.project.documents.length) {
    store.project.name = store.project.documents[0].name;
  }
  if (firstKey && !store.ui.pageKey) await goToPage(firstKey);
  emit('documents');
  if (firstKey) toast(`Added ${files.length} drawing set${files.length > 1 ? 's' : ''}. Set the scale for each sheet before measuring.`, { kind: 'ok' });
}

async function guessNames(docId, numPages) {
  for (let n = 1; n <= numPages; n++) {
    const key = `${docId}:${n}`;
    const pg = store.project.pages[key];
    if (!pg || !/^Page \d+$/.test(pg.name)) continue;
    const g = await viewer.guessSheetName(key);
    if (g && store.project.pages[key]) {
      pg.name = g;
      if (n % 5 === 0 || n === numPages) {
        renderSheets();
        updateToolbar();
      }
    }
  }
  renderSheets();
  updateToolbar();
}

async function addPdfs() {
  await addPdfFiles(await api.openPdfs());
}

async function confirmDiscard(action = 'continue') {
  if (!store.dirty) return true;
  const r = await api.message({
    type: 'question',
    message: `Save changes to "${store.project.name}" before you ${action}?`,
    buttons: ['Save', "Don't save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r === 2) return false;
  if (r === 0) return await saveProject();
  return true;
}

async function newProject() {
  if (!(await confirmDiscard('start a new project'))) return;
  viewer.unloadAll();
  viewer.clearCanvas();
  store.project = blankProject();
  store.filePath = null;
  Object.assign(store.ui, { pageKey: null, activeConditionId: null, selectedMarkupId: null, tool: 'select' });
  store.ui.hiddenConditions.clear();
  draft = measure = null;
  resetHistory();
  markDirty(false);
  emit('all');
}

async function openProject(path) {
  if (!(await confirmDiscard('open another project'))) return;
  let res;
  try {
    res = await api.openProject(path);
  } catch (e) {
    return toast("Couldn't open that file.", { kind: 'err' });
  }
  if (!res) return;
  let data;
  try {
    data = JSON.parse(res.text);
    if (data.app !== 'gridline') throw new Error('not a gridline file');
  } catch {
    return toast("That file isn't a Gridline project.", { kind: 'err' });
  }
  viewer.unloadAll();
  viewer.clearCanvas();
  store.project = Object.assign(blankProject(), data);
  store.project.settings = Object.assign(blankProject().settings, data.settings || {});
  store.filePath = res.path;
  Object.assign(store.ui, { pageKey: null, activeConditionId: null, selectedMarkupId: null, tool: 'select' });
  store.ui.hiddenConditions.clear();
  draft = measure = null;
  for (const d of store.project.documents) {
    try {
      await viewer.loadDocument(d.id, fromBase64(d.data));
    } catch (e) {
      console.error(e);
      toast(`Drawing "${d.name}" couldn't be loaded.`, { kind: 'err' });
    }
  }
  resetHistory();
  markDirty(false);
  const first = orderedPageKeys()[0];
  if (first) await goToPage(first);
  emit('all');
  toast(`Opened ${store.project.name}`, { kind: 'ok', timeout: 2500 });
}

async function saveProject(saveAs = false) {
  const text = JSON.stringify(store.project);
  try {
    const p = await api.saveProject({ text, path: store.filePath, name: store.project.name, saveAs });
    if (p === null && !api.__shim) return false;
    store.filePath = p || store.filePath;
    markDirty(false);
    toast('Saved', { kind: 'ok', timeout: 1600 });
    return true;
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + (e.message || e), { kind: 'err' });
    return false;
  }
}

async function exportCsv() {
  if (!store.project.conditions.length) return toast('Nothing to export yet — create some conditions first.');
  const p = await api.exportFile({ text: estimateCsv(), defaultName: `${store.project.name} - Estimate.csv`, ext: 'csv', label: 'CSV (Excel)' });
  if (p) toast('Estimate exported', { kind: 'ok', timeout: 2000 });
}

async function removeDocument(docId) {
  const d = store.project.documents.find((x) => x.id === docId);
  const n = store.project.markups.filter((m) => m.pageKey.startsWith(docId + ':')).length;
  const r = await api.message({
    type: 'warning',
    message: `Remove "${d.name}"${n ? ` and its ${n} markup${n > 1 ? 's' : ''}` : ''}? This can't be undone.`,
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (r !== 0) return;
  viewer.unloadDocument(docId);
  const p = store.project;
  p.documents = p.documents.filter((x) => x.id !== docId);
  for (const k of Object.keys(p.pages)) if (k.startsWith(docId + ':')) delete p.pages[k];
  p.markups = p.markups.filter((m) => !m.pageKey.startsWith(docId + ':'));
  resetHistory();
  markDirty();
  if (store.ui.pageKey && store.ui.pageKey.startsWith(docId + ':')) {
    store.ui.pageKey = null;
    viewer.clearCanvas();
    const first = orderedPageKeys()[0];
    if (first) await goToPage(first);
  }
  emit('documents');
}

// ---------- Pages ----------
function orderedPageKeys() {
  const out = [];
  for (const d of store.project.documents) {
    const ks = Object.keys(store.project.pages).filter((k) => k.startsWith(d.id + ':'));
    ks.sort((a, b) => +a.split(':')[1] - +b.split(':')[1]);
    out.push(...ks);
  }
  return out;
}

async function goToPage(key) {
  if (!key || !store.project.pages[key]) return;
  cancelDraft();
  measure = null;
  store.ui.pageKey = key;
  store.ui.selectedMarkupId = null;
  snapIndex = null;
  snapHit = null;
  viewer.getSnapIndex(key).then((idx) => {
    if (store.ui.pageKey === key) snapIndex = idx;
  });
  try {
    await viewer.showPage(key);
  } catch (e) {
    console.error(e);
    toast("Couldn't render that sheet.", { kind: 'err' });
  }
  markSheetActive();
  refresh('ui');
  const el = document.querySelector(`.sheet[data-key="${key}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function stepPage(d) {
  const keys = orderedPageKeys();
  const i = keys.indexOf(store.ui.pageKey);
  if (i < 0) return;
  goToPage(keys[Math.max(0, Math.min(keys.length - 1, i + d))]);
}

// ---------- Scale ----------
$('#scaleSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'calibrate') return setTool('calibrate');
  if (v === '' || v === 'cal') return updateToolbar();
  const preset = SCALE_PRESETS[+v];
  const key = store.ui.pageKey;
  commit((p) => (p.pages[key].scale = presetToScale(preset)), 'pages');
  vpEl.focus();
  const unscaled = orderedPageKeys().filter((k) => !store.project.pages[k].scale);
  if (unscaled.length) {
    toast(`Scale set to ${preset.label}.`, { action: () => copyScaleToAll(key, true), actionLabel: `Apply to ${unscaled.length} unscaled`, timeout: 7000 });
  }
});

function copyScaleToAll(fromKey, onlyUnscaled = false) {
  const s = store.project.pages[fromKey] && store.project.pages[fromKey].scale;
  if (!s) return toast('This sheet has no scale to copy.');
  commit((p) => {
    for (const k of Object.keys(p.pages)) if (!onlyUnscaled || !p.pages[k].scale) p.pages[k].scale = { ...s };
  }, 'pages');
  toast('Scale applied', { kind: 'ok', timeout: 1800 });
}

async function finishCalibration(points) {
  const ptLen = dist(points[0], points[1]);
  draft = null;
  redraw();
  if (ptLen < 2) return setTool('select');
  const r = await calibrateDialog(ptLen);
  setTool('select');
  if (!r) return;
  const key = store.ui.pageKey;
  const docId = key.split(':')[0];
  commit((p) => {
    if (r.all) {
      for (const k of Object.keys(p.pages)) if (k.startsWith(docId + ':')) p.pages[k].scale = { ...r.scale };
    } else p.pages[key].scale = r.scale;
  }, 'pages');
  toast('Scale calibrated', { kind: 'ok', timeout: 2000 });
}

function setUnit(u) {
  if (u === store.project.unit) return;
  commit((p) => (p.unit = u), 'settings');
}

// ---------- Conditions ----------
async function newCondition(type) {
  const r = await conditionDialog(type ? { type } : {});
  if (!r) return null;
  const c = { id: uid('cond'), costBasis: null, notes: '', ...r };
  commit((p) => p.conditions.push(c), 'conditions');
  activateCondition(c.id);
  return c;
}

async function editCondition(id) {
  const c = condition(id);
  if (!c) return;
  const r = await conditionDialog(c);
  if (!r) return;
  commit(() => Object.assign(c, r), 'conditions');
}

function duplicateCondition(id) {
  const c = condition(id);
  const copy = { ...c, id: uid('cond'), name: c.name + ' (copy)', color: nextColor() };
  commit((p) => p.conditions.splice(p.conditions.indexOf(c) + 1, 0, copy), 'conditions');
  activateCondition(copy.id);
}

async function deleteCondition(id) {
  const c = condition(id);
  const n = store.project.markups.filter((m) => m.conditionId === id).length;
  if (n) {
    const r = await api.message({ type: 'warning', message: `Delete "${c.name}" and its ${n} markup${n > 1 ? 's' : ''}?`, detail: 'You can undo this with Ctrl+Z.', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (r !== 0) return;
  }
  commit((p) => {
    p.conditions = p.conditions.filter((x) => x.id !== id);
    p.markups = p.markups.filter((m) => m.conditionId !== id);
  }, 'conditions');
  if (store.ui.activeConditionId === id) {
    store.ui.activeConditionId = null;
    setTool('select');
  }
}

function activateCondition(id) {
  const c = condition(id);
  if (!c) return;
  store.ui.activeConditionId = id;
  store.ui.lastByType[c.type] = id;
  store.ui.hiddenConditions.delete(id);
  store.ui.selectedMarkupId = null;
  setTool(c.type, true);
}

// ---------- Tools ----------
async function setTool(tool, fromCondition = false) {
  cancelDraft();
  snapHit = null;
  if (tool !== 'measure') measure = null;
  if (TAKEOFF_TOOLS.includes(tool) && !fromCondition) {
    const c = condition(store.ui.activeConditionId);
    if (!c || c.type !== tool) {
      // Quick toggle: go back to the last condition used with this tool, then the newest one.
      const last = condition(store.ui.lastByType[tool]);
      const existing = last && last.type === tool ? last : [...store.project.conditions].reverse().find((x) => x.type === tool);
      if (existing) return activateCondition(existing.id);
      if (tool === 'linear' || tool === 'area') return quickCreate(tool);
      const created = await newCondition(tool);
      if (!created) {
        store.ui.tool = 'select';
        refresh('ui');
      }
      return;
    }
  }
  if (DRAW_TOOLS.includes(tool) && !store.ui.pageKey) {
    store.ui.tool = 'select';
    refresh('ui');
    return toast('Add drawings first.');
  }
  store.ui.tool = tool;
  if (tool !== 'select') store.ui.selectedMarkupId = null;
  refresh('ui');
  vpEl.focus();
}

/** Start measuring immediately with a plain condition — no dialog. */
function quickCreate(type) {
  const base = type === 'linear' ? 'Linear' : 'Area';
  let n = 1;
  while (store.project.conditions.some((c) => c.name === `${base} ${n}`)) n++;
  const c = { id: uid('cond'), name: `${base} ${n}`, type, color: nextColor(), group: '', height: 0, depth: 0, pitch: 0, roofLine: '', waste: 0, matCost: 0, laborCost: 0, costBasis: null, notes: '' };
  commit((p) => p.conditions.push(c), 'conditions');
  activateCondition(c.id);
  toast(`Measuring "${c.name}". Rename it or add costs anytime.`, { action: () => editCondition(c.id), actionLabel: 'Edit', timeout: 3500 });
}

function pickCondition(type, anchor) {
  const r = anchor.getBoundingClientRect();
  const list = store.project.conditions.filter((c) => c.type === type);
  const items = [{ head: type === 'linear' ? 'Linear conditions' : 'Area conditions' }];
  for (const c of list) items.push({ label: c.name, dot: c.color, current: c.id === store.ui.activeConditionId, run: () => activateCondition(c.id) });
  if (list.length) items.push('-');
  items.push({ label: `Quick ${type === 'linear' ? 'linear' : 'area'} (no setup)`, icon: 'plus', run: () => quickCreate(type) });
  items.push({ label: `New ${type} condition…`, icon: 'tag', run: () => newCondition(type) });
  contextMenu(r.left, r.bottom + 4, items);
}

function toggleSnap() {
  snapOn = !snapOn;
  localStorage.setItem('gridline-snap', snapOn ? 'on' : 'off');
  snapHit = null;
  redraw();
  updateToolbar();
  toast(snapOn ? 'Snap to plan lines on' : 'Snap off', { timeout: 1200 });
}

function cancelDraft() {
  draft = null;
  $('#hud').hidden = true;
}

$$('#toolGroup [data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$$('#toolGroup [data-pick]').forEach((b) => (b.onclick = () => pickCondition(b.dataset.pick, b)));
$('#btnSnap').onclick = toggleSnap;
$('#btnCalibrate').onclick = () => setTool('calibrate');
$('#bannerCalibrate').onclick = () => setTool('calibrate');

// ---------- Viewer interaction ----------
let drag = null; // { kind: 'pan'|'vertex'|'move', ... }
let spaceDown = false;
let lastClick = { t: 0, x: 0, y: 0 };

/**
 * Cursor -> page point. Shift locks to 45°/90° from `anchor`; otherwise, when snapping is
 * on (and Ctrl isn't held), the point jumps to nearby plan geometry or existing markup vertices.
 */
function pagePoint(e, anchor, { snap = false, exclude = null } = {}) {
  const raw = viewer.toPage(e.clientX, e.clientY);
  snapHit = null;
  if (e.shiftKey && anchor) return orthoSnap(anchor, raw);
  if (!snap || !snapOn || e.ctrlKey) return raw;
  const extra = [];
  for (const m of store.project.markups) {
    if (m.pageKey !== store.ui.pageKey || m === exclude || m.type === 'count' || store.ui.hiddenConditions.has(m.conditionId)) continue;
    for (const q of m.points) extra.push(q);
  }
  if (draft && draft.points.length > 1) extra.push(draft.points[0]); // close back onto the start
  const hit = findSnap(snapIndex, raw, 10 / view.zoom, extra);
  snapHit = hit;
  return hit ? hit.point : raw;
}

function hitTest(p) {
  const tol = 8 / view.zoom;
  const ms = store.project.markups;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.pageKey !== store.ui.pageKey || store.ui.hiddenConditions.has(m.conditionId)) continue;
    if (m.type === 'count') {
      if (m.points.some((q) => dist(p, q) <= tol)) return m;
    } else if (m.type === 'linear') {
      for (let j = 1; j < m.points.length; j++) if (distToSegment(p, m.points[j - 1], m.points[j]) <= tol) return m;
    } else if (m.type === 'area' || m.type === 'roof') {
      if (pointInPolygon(p, m.points)) return m;
      const n = m.points.length;
      for (let j = 0; j < n; j++) if (distToSegment(p, m.points[j], m.points[(j + 1) % n]) <= tol) return m;
    }
  }
  return null;
}

vpEl.addEventListener('wheel', (e) => {
  if (!view.pageKey) return;
  e.preventDefault();
  const r = vpEl.getBoundingClientRect();
  if (e.ctrlKey || !e.shiftKey) {
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    viewer.zoomAt(Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
  } else {
    viewer.panBy(-e.deltaY, 0);
  }
}, { passive: false });

vpEl.addEventListener('pointerdown', (e) => {
  closeContextMenu();
  if (!view.pageKey) return;
  vpEl.focus();
  const tool = store.ui.tool;

  if (e.button === 1 || (e.button === 0 && (spaceDown || tool === 'pan'))) {
    e.preventDefault();
    drag = { kind: 'pan', x: e.clientX, y: e.clientY };
    vpEl.setPointerCapture(e.pointerId);
    vpEl.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;
  const p = pagePoint(e, draft && draft.points[draft.points.length - 1], { snap: SNAP_TOOLS.includes(tool) });

  if (tool === 'select') {
    const sel = store.project.markups.find((m) => m.id === store.ui.selectedMarkupId);
    const tol = 8 / view.zoom;
    if (sel && sel.type !== 'count') {
      const vi = sel.points.findIndex((q) => dist(p, q) <= tol);
      if (vi >= 0) {
        drag = { kind: 'vertex', m: sel, i: vi, orig: sel.points.map((q) => [...q]), moved: false };
        vpEl.setPointerCapture(e.pointerId);
        return;
      }
    }
    const hit = hitTest(p);
    if (hit) {
      store.ui.selectedMarkupId = hit.id;
      store.ui.activeConditionId = hit.conditionId;
      drag = { kind: 'move', m: hit, start: p, orig: hit.points.map((q) => [...q]), moved: false };
      vpEl.setPointerCapture(e.pointerId);
      refresh('ui');
    } else {
      if (store.ui.selectedMarkupId) {
        store.ui.selectedMarkupId = null;
        refresh('ui');
      }
      drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      vpEl.setPointerCapture(e.pointerId);
    }
    return;
  }

  // Ignore the second press of a double-click; dblclick handles finishing.
  const now = performance.now();
  const isDouble = now - lastClick.t < 320 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6;
  lastClick = { t: now, x: e.clientX, y: e.clientY };
  if (isDouble && (tool === 'linear' || tool === 'area' || tool === 'roof')) return;

  const c = condition(store.ui.activeConditionId);
  if (tool === 'count') {
    if (!c) return;
    const m = { id: uid('mk'), conditionId: c.id, pageKey: store.ui.pageKey, type: 'count', points: [p] };
    commit((pp) => pp.markups.push(m), 'markups-live');
    return;
  }
  if (tool === 'measure') {
    if (!measure || measure.points.length === 2) measure = { points: [p] };
    else measure.points.push(p);
    if (measure.points.length === 1) draft = { type: 'measure', points: [p], color: '#1d8cff' };
    else {
      draft = null;
      $('#hud').hidden = true;
    }
    redraw();
    return;
  }
  if (tool === 'calibrate') {
    if (!draft) draft = { type: 'calibrate', points: [p], color: '#1d8cff' };
    else {
      draft.points.push(p);
      return finishCalibration(draft.points);
    }
    redraw();
    return;
  }
  if (tool === 'linear' || tool === 'area' || tool === 'roof') {
    if (!c) return;
    if (!draft) draft = { type: tool, points: [], color: c.color };
    draft.points.push(p);
    redraw();
    updateToolbar();
  }
});

vpEl.addEventListener('pointermove', (e) => {
  if (drag) {
    if (drag.kind === 'pan') {
      viewer.panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else if (drag.kind === 'vertex') {
      const prev = drag.m.points[(drag.i - 1 + drag.m.points.length) % drag.m.points.length];
      drag.m.points[drag.i] = pagePoint(e, prev, { snap: true, exclude: drag.m });
      drag.moved = true;
      redraw();
    } else if (drag.kind === 'move') {
      const p = viewer.toPage(e.clientX, e.clientY);
      const dx = p[0] - drag.start[0];
      const dy = p[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
      drag.moved = true;
      drag.m.points = drag.orig.map(([x, y]) => [x + dx, y + dy]);
      redraw();
    }
    return;
  }
  if (!view.pageKey) return;
  const hud = $('#hud');
  const r = vpEl.getBoundingClientRect();
  const snapping = SNAP_TOOLS.includes(store.ui.tool);
  if (draft && draft.points.length) {
    const last = draft.points[draft.points.length - 1];
    draft.hover = pagePoint(e, last, { snap: snapping });
    const key = store.ui.pageKey;
    const c = condition(store.ui.activeConditionId);
    let html;
    if (draft.type === 'area' || draft.type === 'roof') {
      const pts = [...draft.points, draft.hover];
      const pitch = draft.type === 'roof' ? markupPitch({}, c) : null;
      html = `${pts.length >= 3 ? areaLabel(pts, key, pitch) : '—'}<small>Seg ${lengthLabel([last, draft.hover], key)}</small>`;
    } else if (draft.type === 'linear') {
      const f = lineFactor(c);
      html = `${lengthLabel([...draft.points, draft.hover], key, false, f)}<small>${f !== 1 ? 'True length · ' : ''}Seg ${lengthLabel([last, draft.hover], key, false, f)}</small>`;
    } else {
      html = `${lengthLabel([last, draft.hover], key)}`;
    }
    hud.innerHTML = html;
    hud.style.left = e.clientX - r.left + 'px';
    hud.style.top = e.clientY - r.top + 'px';
    hud.hidden = false;
    redraw();
  } else {
    hud.hidden = true;
    if (snapping) {
      const before = snapHit;
      pagePoint(e, null, { snap: true });
      if (before || snapHit) drawSnapLayer(snapHit);
    }
  }
});

vpEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  vpEl.classList.remove('panning');
  try {
    vpEl.releasePointerCapture(e.pointerId);
  } catch {}
  if ((d.kind === 'vertex' || d.kind === 'move') && d.moved) {
    const next = d.m.points.map((q) => [...q]);
    d.m.points = d.orig;
    commit(() => (d.m.points = next), 'markups-live');
  }
});

vpEl.addEventListener('dblclick', (e) => {
  if (draft && (draft.type === 'linear' || draft.type === 'area' || draft.type === 'roof')) {
    e.preventDefault();
    finishDraft(e.altKey);
  }
});

vpEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (draft && (draft.type === 'linear' || draft.type === 'area' || draft.type === 'roof')) return finishDraft(e.altKey);
  if (!view.pageKey) return;
  const hit = hitTest(viewer.toPage(e.clientX, e.clientY));
  if (!hit) return;
  store.ui.selectedMarkupId = hit.id;
  store.ui.activeConditionId = hit.conditionId;
  if (store.ui.tool !== 'select') store.ui.tool = 'select';
  refresh('ui');
  const others = store.project.conditions.filter((c) => c.type === hit.type && c.id !== hit.conditionId);
  const items = [];
  if (hit.type === 'area' || hit.type === 'roof') items.push({ label: hit.deduct ? 'Make additive' : 'Make deduction', icon: 'minus', run: () => commit(() => (hit.deduct = !hit.deduct), 'markups') });
  for (const o of others.slice(0, 8)) items.push({ label: `Move to: ${o.name}`, icon: 'layers', run: () => commit(() => (hit.conditionId = o.id), 'markups') });
  if (items.length) items.push('-');
  items.push({ label: 'Delete markup', icon: 'trash', danger: true, run: deleteSelected });
  contextMenu(e.clientX, e.clientY, items);
});

function finishDraft(deduct = false) {
  if (!draft) return;
  const c = condition(store.ui.activeConditionId);
  // Drop duplicate trailing points (from double-click).
  const pts = draft.points.filter((p, i, a) => i === 0 || dist(p, a[i - 1]) > 0.5);
  const need = draft.type === 'area' || draft.type === 'roof' ? 3 : 2;
  if (!c || pts.length < need) {
    cancelDraft();
    redraw();
    updateToolbar();
    return;
  }
  const m = { id: uid('mk'), conditionId: c.id, pageKey: store.ui.pageKey, type: draft.type, points: pts };
  if ((draft.type === 'area' || draft.type === 'roof') && deduct) m.deduct = true;
  snapHit = null;
  cancelDraft();
  commit((p) => p.markups.push(m), 'markups-live');
}

function deleteSelected() {
  const id = store.ui.selectedMarkupId;
  if (!id) return;
  store.ui.selectedMarkupId = null;
  commit((p) => (p.markups = p.markups.filter((m) => m.id !== id)), 'markups-live');
}

// ---------- Keyboard ----------
const isTyping = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
};

document.addEventListener('keydown', (e) => {
  if ($('#modalRoot').children.length) return;
  if (isTyping()) return;
  const k = e.key;
  if (e.ctrlKey || e.metaKey) {
    if (!api.__shim) return; // Electron menu accelerators handle these.
    const map = { s: () => saveProject(e.shiftKey), o: () => openProject(), z: () => menuCmd('undo'), y: () => menuCmd('redo'), e: () => exportCsv() };
    if (map[k.toLowerCase()]) {
      e.preventDefault();
      map[k.toLowerCase()]();
    }
    return;
  }
  if (k === ' ') {
    if (!spaceDown) {
      spaceDown = true;
      vpEl.classList.add('panning');
    }
    e.preventDefault();
    return;
  }
  if (store.ui.view !== 'takeoff') return;
  if (k === 'Tab') {
    e.preventDefault();
    return setTool(store.ui.tool === 'linear' ? 'area' : 'linear');
  }
  if (k.toLowerCase() === 's' && !e.altKey) return toggleSnap();
  const tools = { v: 'select', h: 'pan', l: 'linear', a: 'area', r: 'roof', c: 'count', m: 'measure', k: 'calibrate' };
  if (tools[k.toLowerCase()] && !e.altKey) return setTool(tools[k.toLowerCase()]);
  switch (k) {
    case 'Escape':
      if (draft || measure) {
        cancelDraft();
        measure = null;
        snapHit = null;
        redraw();
        updateToolbar();
      } else if (store.ui.selectedMarkupId) {
        store.ui.selectedMarkupId = null;
        refresh('ui');
      } else if (store.ui.tool !== 'select') setTool('select');
      break;
    case 'Enter':
      if (draft) finishDraft(e.altKey);
      break;
    case 'Backspace':
      if (draft) {
        draft.points.pop();
        if (!draft.points.length) cancelDraft();
        redraw();
        updateToolbar();
      } else deleteSelected();
      break;
    case 'Delete':
      deleteSelected();
      break;
    case 'f':
    case 'F':
      viewer.fit();
      break;
    case '+':
    case '=':
      viewer.zoomCenter(1.25);
      break;
    case '-':
    case '_':
      viewer.zoomCenter(0.8);
      break;
    case 'PageDown':
      stepPage(1);
      break;
    case 'PageUp':
      stepPage(-1);
      break;
    case 'F1':
      shortcutsDialog();
      break;
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    if (!drag) vpEl.classList.remove('panning');
  }
});

// ---------- Chrome / buttons ----------
$('#btnZoomIn').onclick = () => viewer.zoomCenter(1.25);
$('#btnZoomOut').onclick = () => viewer.zoomCenter(0.8);
$('#btnFit').onclick = () => viewer.fit();
$('#zoomReadout').onclick = () => viewer.fit();
$('#btnPrevPage').onclick = () => stepPage(-1);
$('#btnNextPage').onclick = () => stepPage(1);
$('#btnAddPdf').onclick = addPdfs;
$('#emptyAdd').onclick = addPdfs;
$('#btnOpen').onclick = () => openProject();
$('#emptyOpen').onclick = () => openProject();
$('#btnSave').onclick = () => saveProject();
$('#btnTheme').onclick = toggleTheme;
$('#btnNewCond').onclick = () => newCondition();
$('#condSearch').addEventListener('input', renderConditions);
$('#projectName').addEventListener('change', (e) => {
  const v = e.target.value.trim() || 'Untitled project';
  commit((p) => (p.name = v), 'settings');
});
$('#projectName').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());

$$('.tab').forEach(
  (t) =>
    (t.onclick = () => {
      store.ui.leftTab = t.dataset.left;
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('#sheetsPanel').hidden = t.dataset.left !== 'sheets';
      $('#conditionsPanel').hidden = t.dataset.left !== 'conditions';
    })
);
$$('.seg-btn').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

function setView(v) {
  store.ui.view = v;
  $('#workspace').classList.toggle('estimate-mode', v === 'estimate');
  $('#estimateView').hidden = v !== 'estimate';
  if (v === 'estimate') renderEstimate();
  else requestAnimationFrame(redraw);
  updateToolbar();
}

// Drag & drop PDFs or a project file.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer.types || [])].includes('Files')) return;
  dragDepth++;
  $('#dropOverlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files];
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const proj = files.find((f) => /\.gridline$/i.test(f.name));
  if (pdfs.length) {
    await addPdfFiles(await Promise.all(pdfs.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
  } else if (proj) {
    toast('Use Open to load a project file.');
  }
});

// ---------- Menu commands from the main process ----------
function menuCmd(name, arg) {
  const typing = isTyping();
  switch (name) {
    case 'new':
      return newProject();
    case 'open':
      return openProject();
    case 'open-project-path':
      return openProject(arg);
    case 'add-pdf':
      return addPdfs();
    case 'save':
      return saveProject(false);
    case 'save-as':
      return saveProject(true);
    case 'export-csv':
      return exportCsv();
    case 'undo':
      if (typing) return document.execCommand('undo');
      if (undo()) toast('Undone', { timeout: 1000 });
      return;
    case 'redo':
      if (typing) return document.execCommand('redo');
      if (redo()) toast('Redone', { timeout: 1000 });
      return;
    case 'view-takeoff':
      return setView('takeoff');
    case 'view-estimate':
      return setView('estimate');
    case 'fit':
      return viewer.fit();
    case 'toggle-theme':
      return toggleTheme();
    case 'shortcuts':
      return shortcutsDialog();
    case 'about':
      return aboutDialog(store.version || '', () => {
        manualCheck = true;
        api.updater.check();
      });
  }
}
api.onMenu(menuCmd);

api.onCloseRequested(async () => {
  if (await confirmDiscard('close')) api.confirmClose();
});

// ---------- Updater UI ----------
let readyToastShown = false;
const pill = $('#updatePill');

api.updater.onState((s) => {
  const manual = manualCheck || s.manual;
  switch (s.status) {
    case 'checking':
      if (manual) showPill(`${icon('refresh', 14)} Checking for updates…`);
      break;
    case 'downloading':
      showPill(`${icon('download', 14)} Updating to v${esc(s.version || '')}<span class="bar"><i style="width:${s.percent || 0}%"></i></span>${s.percent || 0}%`);
      break;
    case 'ready':
      showPill(`${icon('refresh', 14)} Restart to update`, true);
      pill.title = `Gridline ${s.version} is ready to install`;
      if (!readyToastShown) {
        readyToastShown = true;
        toast(`Gridline ${s.version} is ready. Restart to finish updating.`, { action: installUpdate, actionLabel: 'Restart now', timeout: 0 });
      }
      manualCheck = false;
      break;
    case 'current':
      pill.hidden = true;
      if (manual) toast(`You're on the latest version (v${store.version}).`, { kind: 'ok' });
      manualCheck = false;
      break;
    case 'dev':
      pill.hidden = true;
      if (manual) toast(s.message);
      manualCheck = false;
      break;
    case 'error':
      pill.hidden = true;
      if (manual) toast(s.message || 'Update check failed.', { kind: 'err' });
      manualCheck = false;
      break;
    default:
      if (!manual) pill.hidden = true;
  }
});

function showPill(html, ready = false) {
  pill.innerHTML = html;
  pill.classList.toggle('ready', ready);
  pill.hidden = false;
  pill.onclick = ready ? installUpdate : null;
}

async function installUpdate() {
  if (store.dirty) {
    const r = await api.message({
      type: 'question',
      message: 'Save your project before restarting to update?',
      buttons: ['Save & restart', 'Restart without saving', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (r === 2) return;
    if (r === 0 && !(await saveProject())) return;
  }
  api.updater.install();
}

// Expose a tiny hook for automated smoke tests.
window.__gridline = { store, view, addPdfFiles, setTool, goToPage, newCondition, setView, menuCmd };
