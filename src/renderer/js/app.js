// Gridline renderer entry: wires the viewer, tools, panels, files and updater together.
import { store, commit, undo, redo, on, emit, uid, blankProject, resetHistory, markDirty, condition, nextColor } from './store.js';
import * as viewer from './viewer.js';
import { view } from './viewer.js';
import { initOverlay, drawOverlay, drawSnapLayer, setAux, scaleFor, lengthLabel, areaLabel, lineFactor } from './overlay.js';
import { findSnap } from './snap.js';
import { initAssistant, renderAssistant } from './assistant.js';
import { fillAt, clearFillCache } from './fill.js';
import { markupPitch } from './geometry.js';
import { initPanels, renderSheets, renderConditions, renderInspector, setSheetMode } from './panels.js';
import { initEstimate, renderEstimate, estimateCsv } from './estimate.js';
import { conditionDialog, calibrateDialog, scaleOptionsHtml, presetToScale, shortcutsDialog, aboutDialog, settingsDialog, appearancePopover, libraryDialog, TYPE_INFO } from './dialogs.js';
import { openPalette } from './palette.js';
import { initAppearance, onAppearance, appearance, set as setAppearance, cycleBase, toggleDarkDrawings, THEMES, DRAWING_MODES } from './appearance.js';
import { SCALE_PRESETS, pickSheetScale } from './units.js';
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
const pref = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v;
  } catch {
    return d;
  }
};
const setPref = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
let snapOn = pref('gridline-snap', 'on') !== 'off';
let snapRadius = +pref('gridline-snap-radius', '10') || 10;
let autoUpdate = pref('gridline-auto-update', 'on') !== 'off';
let autoScale = pref('gridline-auto-scale', 'on') !== 'off';
let fillGap = pref('gridline-fill-gap', 'small');
let snapIndex = null; // line geometry of the current sheet
let snapHit = null; // current snap target, shown as a marker
const DRAW_TOOLS = ['linear', 'area', 'roof', 'count', 'measure', 'calibrate', 'fill'];
const TAKEOFF_TOOLS = ['linear', 'area', 'roof', 'count'];
const SNAP_TOOLS = ['linear', 'area', 'roof', 'measure', 'calibrate'];
const vpEl = $('#viewport');
hydrateIcons();
viewer.initViewer({ canvasEl: $('#pdfCanvas'), stageEl: $('#stage'), viewport: vpEl, onViewChange });
initOverlay($('#overlay'), $('#snapLayer'));
store.ui.lastByType = {};
store.ui.sheetMode = pref('gridline-sheets', 'all') === 'current' ? 'current' : 'all';
const panelActions = {
  goToPage,
  removeDocument,
  copyScaleToAll,
  detectScales,
  saveToLibrary: (ids) => saveToLibrary(ids),
  reviewNext: (afterClear) => reviewNext(afterClear),
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

initAppearance();
onAppearance(() => {
  $('#btnTheme').innerHTML = icon(document.documentElement.dataset.base === 'dark' ? 'sun' : 'moon');
});
$('#btnTheme').innerHTML = icon(document.documentElement.dataset.base === 'dark' ? 'sun' : 'moon');
if (api.updater.setAuto) api.updater.setAuto(autoUpdate);
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
      fill: 'Click inside a room to fill its area automatically · Alt+click for a deduction · uses the active area or roof condition',
      roof: draft ? 'Trace the roof outline in plan · Enter to close · hold Alt for a deduction (skylight, chimney)' : 'Trace a roof plane in plan view — pitch converts it to true roof area',
      count: 'Click to place counts · drag a box around one symbol to find all matching ones',
      measure: 'Click two points to measure',
      calibrate: 'Click both ends of a known dimension',
    }[t] || ''
  );
}

// ---------- Theme ----------
const toggleTheme = () => cycleBase();

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
    // The PDF bytes live in PDF.js; they're read back only when saving.
    store.project.documents.push({ id, name: f.name.replace(/\.pdf$/i, '') });
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
  if (autoScale) {
    const keys = Array.from({ length: numPages }, (_, i) => `${docId}:${i + 1}`);
    detectScales(keys, false);
  }
}

/**
 * Read each sheet's scale from its title-block text. When `force`, overwrites existing
 * scales; otherwise only fills unscaled sheets. Not undoable as a group with the import,
 * but individual sheets can be changed afterwards.
 */
async function detectScales(keys, force = false) {
  const found = {};
  let ambiguous = 0;
  for (const key of keys) {
    const pg = store.project.pages[key];
    if (!pg || (pg.scale && !force)) continue;
    const { text } = await viewer.getPageText(key);
    if (/\b(NTS|N\.T\.S\.|NOT TO SCALE)\b/i.test(text) && !/scale\s*:?\s*\d/i.test(text)) continue;
    const r = pickSheetScale(text);
    if (!r) continue;
    if (r.ambiguous) ambiguous++;
    const preset = SCALE_PRESETS.find((p) => Math.abs(presetToScale(p).ptPerUnit - r.scale.ptPerUnit) < 1e-6 && presetToScale(p).unit === r.scale.unit);
    found[key] = { ...(preset ? presetToScale(preset) : r.scale), auto: true };
  }
  const n = Object.keys(found).length;
  if (n) {
    commit((p) => {
      for (const [k, sc] of Object.entries(found)) if (p.pages[k]) p.pages[k].scale = sc;
    }, 'pages');
    toast(`Read the scale from the title block on ${n} of ${keys.length} sheet${keys.length === 1 ? '' : 's'}${ambiguous ? ` (${ambiguous} had more than one scale)` : ''}. Spot-check one with Measure.`, { kind: 'ok', timeout: 6000 });
  } else if (force) {
    toast("Couldn't find a scale in that sheet's text. Pick one or calibrate.", { kind: 'err' });
  }
  return n;
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
  if (api.autosave) await api.autosave.clear(store.project.id); // chose not to keep it
  return true;
}

async function newProject(action = 'start a new project') {
  if (!(await confirmDiscard(action))) return false;
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
  return true;
}

async function closeProject() {
  if (!store.project.documents.length && !store.project.conditions.length && !store.filePath) return;
  const name = store.project.name;
  if (await newProject('close it')) toast(`Closed ${name}`, { timeout: 1800 });
}

function closeCurrentDrawing() {
  const key = store.ui.pageKey || orderedPageKeys()[0];
  if (!key) return toast('No drawing is open.');
  removeDocument(key.split(':')[0]);
}

async function openSettings() {
  const s = store.project.settings;
  const r = await settingsDialog({
    app: { theme: appearance().system ? 'system' : appearance().theme, accent: appearance().accent, drawing: appearance().drawing, snap: snapOn, snapRadius, sheetMode: store.ui.sheetMode, autoUpdate, fillGap, autoScale },
    proj: { unit: store.project.unit, labelStyle: s.labelStyle, showLabels: s.showLabels, taxPct: s.taxPct, overheadPct: s.overheadPct, profitPct: s.profitPct },
    version: store.version,
    hasProject: true,
    onCheckUpdates: () => {
      manualCheck = true;
      api.updater.check();
    },
  });
  if (!r) return;
  setAppearance(r.app.theme === 'system' ? { system: true, accent: r.app.accent, drawing: r.app.drawing } : { theme: r.app.theme, system: false, accent: r.app.accent, drawing: r.app.drawing });
  snapOn = r.app.snap;
  setPref('gridline-snap', snapOn ? 'on' : 'off');
  snapRadius = r.app.snapRadius;
  setPref('gridline-snap-radius', String(snapRadius));
  autoUpdate = r.app.autoUpdate;
  setPref('gridline-auto-update', autoUpdate ? 'on' : 'off');
  if (api.updater.setAuto) api.updater.setAuto(autoUpdate);
  if (r.app.sheetMode !== store.ui.sheetMode) setSheetMode(r.app.sheetMode);
  fillGap = r.app.fillGap;
  setPref('gridline-fill-gap', fillGap);
  autoScale = r.app.autoScale;
  setPref('gridline-auto-scale', autoScale ? 'on' : 'off');
  const { unit, ...rest } = r.proj;
  const changed = unit !== store.project.unit || Object.keys(rest).some((k) => s[k] !== rest[k]);
  if (changed)
    commit((p) => {
      p.unit = unit;
      Object.assign(p.settings, rest);
    }, 'settings');
  if (r.makeDefault) setPref('gridline-project-defaults', JSON.stringify(r.proj));
  snapHit = null;
  refresh('all');
  toast('Settings saved', { kind: 'ok', timeout: 1500 });
}

async function openProject(path) {
  if (!(await confirmDiscard('open another project'))) return;
  let res;
  try {
    res = await api.openProject(path);
  } catch (e) {
    if (path && api.recent) api.recent.remove(path);
    return toast("Couldn't open that file.", { kind: 'err' });
  }
  if (!res) return;
  await loadProjectText(res.text, res.path);
}

/** Load a project from its saved text. `recovered` marks it as unsaved work from autosave. */
async function loadProjectText(text, filePath, { recovered = false } = {}) {
  let data;
  try {
    data = JSON.parse(text);
    if (data.app !== 'gridline') throw new Error('not a gridline file');
  } catch {
    return toast("That file isn't a Gridline project.", { kind: 'err' });
  }
  if (!data.id) data.id = uid('proj');
  const res = { path: filePath };
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
      delete d.data; // now held by PDF.js; re-encoded on save
    } catch (e) {
      console.error(e);
      toast(`Drawing "${d.name}" couldn't be loaded.`, { kind: 'err' });
    }
  }
  resetHistory();
  markDirty(recovered);
  const first = orderedPageKeys()[0];
  if (first) await goToPage(first);
  emit('all');
  toast(recovered ? `Recovered ${store.project.name}. Save it to keep it.` : `Opened ${store.project.name}`, { kind: 'ok', timeout: recovered ? 6000 : 2500 });
}

async function projectText() {
  const documents = [];
  for (const d of store.project.documents) {
    if (d.data) documents.push(d); // a drawing that failed to load keeps its original data
    else {
      const bytes = await viewer.documentBytes(d.id);
      if (!bytes) throw new Error(`Drawing "${d.name}" isn't loaded`);
      documents.push({ ...d, data: toBase64(bytes) });
    }
  }
  return JSON.stringify({ ...store.project, documents });
}

async function saveProject(saveAs = false) {
  let text;
  try {
    text = await projectText();
  } catch (e) {
    toast('Save failed: ' + (e.message || e), { kind: 'err' });
    return false;
  }
  try {
    const p = await api.saveProject({ text, path: store.filePath, name: store.project.name, saveAs });
    if (p === null && !api.__shim) return false;
    store.filePath = p || store.filePath;
    markDirty(false);
    if (api.autosave) api.autosave.clear(store.project.id);
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
  if (n) {
    const r = await api.message({
      type: 'warning',
      message: `Close "${d.name}"? Its ${n} markup${n > 1 ? 's' : ''} will be removed.`,
      detail: "This can't be undone. Save a copy first if you want to keep them.",
      buttons: ['Close PDF', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r !== 0) return;
  }
  viewer.unloadDocument(docId);
  clearFillCache(docId + ':');
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
  toast(`Closed ${d.name}`, { timeout: 1600 });
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
  if (proposals && proposals.pageKey !== key) {
    proposals = null;
    showProposals();
  }
  viewer.getSnapIndex(key).then((idx) => {
    if (store.ui.pageKey === key) snapIndex = idx;
  });
  try {
    await viewer.showPage(key);
  } catch (e) {
    console.error(e);
    toast("Couldn't render that sheet.", { kind: 'err' });
  }
  renderSheets();
  refresh('ui');
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
  if (v === 'detect') {
    updateToolbar();
    return detectScales([store.ui.pageKey], true);
  }
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
  if (tool === 'fill') {
    const c = condition(store.ui.activeConditionId);
    if (!c || (c.type !== 'area' && c.type !== 'roof')) {
      const last = condition(store.ui.lastByType.area);
      const any = last || [...store.project.conditions].reverse().find((x) => x.type === 'area');
      if (any) {
        store.ui.activeConditionId = any.id;
        store.ui.lastByType.area = any.id;
      } else {
        const base = 'Area';
        let n = 1;
        while (store.project.conditions.some((x) => x.name === `${base} ${n}`)) n++;
        const nc = { id: uid('cond'), name: `${base} ${n}`, type: 'area', color: nextColor(), group: '', height: 0, depth: 0, pitch: 0, roofLine: '', waste: 0, matCost: 0, laborCost: 0, costBasis: null, notes: '' };
        commit((p) => p.conditions.push(nc), 'conditions');
        store.ui.activeConditionId = nc.id;
        store.ui.lastByType.area = nc.id;
      }
    }
  }
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
  setPref('gridline-snap', snapOn ? 'on' : 'off');
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
  const hit = findSnap(snapIndex, raw, snapRadius / view.zoom, extra);
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
  if (tool === 'fill') {
    if (!c) return;
    return autoFill(p, e.altKey);
  }
  if (tool === 'count') {
    if (!c) return;
    if (proposals && toggleProposalAt(p)) return;
    // Click = place a count. Drag = box one symbol and find all the matching ones.
    drag = { kind: 'box', start: viewer.toPage(e.clientX, e.clientY), cx: e.clientX, cy: e.clientY, moved: false };
    vpEl.setPointerCapture(e.pointerId);
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
    if (drag.kind === 'box') {
      if (!drag.moved && Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 6) return;
      drag.moved = true;
      const q = viewer.toPage(e.clientX, e.clientY);
      setAux({ box: [drag.start[0], drag.start[1], q[0], q[1]] });
      drawSnapLayer(null);
      return;
    }
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
  if (d.kind === 'box') {
    setAux({ box: null });
    drawSnapLayer(null);
    const c = condition(store.ui.activeConditionId);
    if (!c) return;
    if (!d.moved) {
      const m = { id: uid('mk'), conditionId: c.id, pageKey: store.ui.pageKey, type: 'count', points: [d.start] };
      commit((pp) => pp.markups.push(m), 'markups-live');
      return;
    }
    const q = viewer.toPage(e.clientX, e.clientY);
    findMatches(store.ui.pageKey, [Math.min(d.start[0], q[0]), Math.min(d.start[1], q[1]), Math.abs(q[0] - d.start[0]), Math.abs(q[1] - d.start[1])], c.id);
    return;
  }
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

// ---------- Find matching symbols ----------
let proposals = null; // { pageKey, conditionId, items: [{ p, score, off }], cutoff, color, radius }
let matchWorker = null;
let matchSeq = 0;

function runMatchInWorker(payload) {
  if (!matchWorker) matchWorker = new Worker(new URL('./match-worker.js', import.meta.url), { type: 'module' });
  const id = ++matchSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progress != null) return payload.onProgress && payload.onProgress(e.data.progress);
      matchWorker.removeEventListener('message', onMsg);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    matchWorker.addEventListener('message', onMsg);
    const { onProgress, ...msg } = payload;
    matchWorker.postMessage({ id, ...msg }, [msg.img.buffer]);
  });
}

/**
 * Find symbols matching the one inside `rect` ([x, y, w, h] page points) on a sheet.
 * Interactive by default (shows the review bar); with { auto: true } returns the matches.
 */
async function findMatches(pageKey, rect, conditionId, { auto = false, cutoff = 0.75 } = {}) {
  const [rx, ry, rw, rh] = rect;
  if (rw < 3 || rh < 3) return auto ? [] : toast('Drag a box around one symbol.');
  const ps = await viewer.pageSize(pageKey);
  // Resolution: aim for ~28 px across the symbol, but keep the sheet image under ~14 MP.
  let r = 28 / Math.max(rw, rh);
  r = Math.min(r, 3, Math.sqrt(14e6 / (ps.w * ps.h)));
  r = Math.max(r, 0.5);
  const t0 = performance.now();
  const busy = auto ? null : toast('Looking for matching symbols…', { timeout: 0 });
  try {
    const g = await viewer.renderGray(pageKey, r);
    const tx = Math.max(0, Math.round(rx * r)),
      ty = Math.max(0, Math.round(ry * r));
    const tw = Math.min(g.W - tx, Math.round(rw * r)),
      th = Math.min(g.H - ty, Math.round(rh * r));
    const t = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) t[y * tw + x] = g.img[(ty + y) * g.W + tx + x];
    const found = await runMatchInWorker({
      img: g.img,
      W: g.W,
      H: g.H,
      tpl: { t, w: tw, h: th },
      opts: { minScore: 0.55, rotations: true },
      onProgress: (p) => busy && (busy.querySelector('.msg').textContent = `Looking for matching symbols… ${Math.round(p * 100)}%`),
    });
    if (busy) busy.remove();
    // Skip spots already counted for this condition.
    const existing = store.project.markups.filter((m) => m.pageKey === pageKey && m.conditionId === conditionId && m.type === 'count').flatMap((m) => m.points);
    const minD = Math.max(rw, rh) * 0.5;
    const items = found
      .map((f) => ({ p: [f.x / r, f.y / r], score: f.score }))
      .filter((f) => !existing.some((q) => Math.hypot(q[0] - f.p[0], q[1] - f.p[1]) < minD));
    console.info(`match: ${items.length} candidates in ${Math.round(performance.now() - t0)} ms @ ${r.toFixed(2)} px/pt`);
    if (auto) return items.filter((i) => i.score >= cutoff);
    const c = condition(conditionId);
    proposals = { pageKey, conditionId, items, cutoff: +$('#matchSens').value, color: c ? c.color : '#ff8a24', radius: Math.max(rw, rh) / 2 };
    showProposals();
  } catch (err) {
    if (busy) busy.remove();
    console.error(err);
    if (!auto) toast("Couldn't search this sheet.", { kind: 'err' });
    return [];
  }
}

function proposalsOn() {
  return proposals ? proposals.items.filter((c) => c.score >= proposals.cutoff && !c.off) : [];
}

function showProposals() {
  const bar = $('#matchBar');
  if (!proposals) {
    bar.hidden = true;
    setAux({ proposals: null });
    drawSnapLayer(snapHit);
    return;
  }
  const n = proposalsOn().length;
  $('#matchText').innerHTML = `<b>${n}</b> match${n === 1 ? '' : 'es'} · click a ring to skip it`;
  $('#matchAccept').textContent = `Add ${n} count${n === 1 ? '' : 's'}`;
  $('#matchAccept').disabled = !n;
  bar.hidden = false;
  setAux({ proposals });
  drawSnapLayer(snapHit);
}

function toggleProposalAt(p) {
  if (!proposals || proposals.pageKey !== store.ui.pageKey) return false;
  const r = Math.max(9 / view.zoom, proposals.radius);
  const hit = proposals.items.find((c) => c.score >= proposals.cutoff - 0.001 && Math.hypot(c.p[0] - p[0], c.p[1] - p[1]) <= r);
  if (!hit) return false;
  hit.off = !hit.off;
  showProposals();
  return true;
}

function acceptProposals() {
  if (!proposals) return;
  const on = proposalsOn();
  const { pageKey, conditionId } = proposals;
  proposals = null;
  showProposals();
  if (!on.length) return;
  commit((p) => {
    for (const c of on) p.markups.push({ id: uid('mk'), conditionId, pageKey, type: 'count', points: [c.p] });
  }, 'markups-live');
  toast(`Added ${on.length} counts`, { kind: 'ok', timeout: 2000 });
}

$('#matchSens').addEventListener('input', (e) => {
  if (!proposals) return;
  proposals.cutoff = +e.target.value;
  showProposals();
});
$('#matchAccept').onclick = acceptProposals;
$('#matchCancel').onclick = () => {
  proposals = null;
  showProposals();
};

async function autoFill(p, deduct = false, { quiet = false, pageKey = store.ui.pageKey, conditionId = store.ui.activeConditionId } = {}) {
  const c = condition(conditionId);
  if (!c || (c.type !== 'area' && c.type !== 'roof')) return { error: 'cond' };
  vpEl.style.cursor = 'progress';
  const idx = await viewer.getSnapIndex(pageKey);
  const pg = await viewer.pageSize(pageKey);
  const r = fillAt(pageKey, idx, pg.w, pg.h, p, fillGap);
  vpEl.style.cursor = '';
  if (r.error) {
    if (!quiet) {
      const msg = {
        leak: "That space isn't closed — there's a gap in the walls (often a door opening with no swing drawn). Try Settings → Fill gap: Medium or Large, or trace it with SF.",
        nolines: "This sheet has no vector linework (it's probably a scan), so Fill can't see the walls. Trace it with SF instead.",
        online: 'Click inside the room, not on a wall.',
      }[r.error];
      toast(msg || "Couldn't fill there.", { kind: 'err', timeout: 6000 });
    }
    return r;
  }
  const m = { id: uid('mk'), conditionId: c.id, pageKey, type: c.type, points: r.points };
  if (deduct) m.deduct = true;
  if (!quiet) commit((pp) => pp.markups.push(m), 'markups-live');
  return { markup: m };
}

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
    const map = { s: () => saveProject(e.shiftKey), o: () => openProject(), z: () => menuCmd('undo'), y: () => menuCmd('redo'), e: () => exportCsv(), w: () => closeProject(), ',': () => openSettings(), k: () => showPalette(), d: () => e.shiftKey && toggleDarkDrawings() };
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
  if (k === '/') {
    e.preventDefault();
    return openAssistant();
  }
  if (k === '[') return togglePanel('left');
  if (k === ']') return togglePanel('right');
  if (k === '\\') return togglePanel('both');
  const tools = { v: 'select', h: 'pan', l: 'linear', a: 'area', r: 'roof', c: 'count', m: 'measure', k: 'calibrate', b: 'fill' };
  if (tools[k.toLowerCase()] && !e.altKey) return setTool(tools[k.toLowerCase()]);
  switch (k) {
    case 'Escape':
      if (proposals) {
        proposals = null;
        showProposals();
      } else if (draft || measure) {
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
      if (proposals) acceptProposals();
      else if (draft) finishDraft(e.altKey);
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
$('#btnTheme').onclick = (e) => appearancePopover(e.currentTarget);
$('#btnSettings').onclick = openSettings;

// ---------- Right panel: Properties / Assistant ----------
function setRightTab(tab) {
  store.ui.rightTab = tab;
  $$('.tab[data-right]').forEach((x) => x.classList.toggle('active', x.dataset.right === tab));
  $('#inspector').hidden = tab !== 'props';
  $('#aiPanel').hidden = tab !== 'ai';
  if (tab === 'ai') renderAssistant();
}
$$('.tab[data-right]').forEach((t) => (t.onclick = () => setRightTab(t.dataset.right)));
function openAssistant() {
  if (store.ui.view !== 'takeoff') setView('takeoff');
  if (panels.right) togglePanel('right');
  setRightTab('ai');
  setTimeout(() => {
    const i = document.getElementById('aiInput');
    if (i && !i.closest('[hidden]')) i.focus();
  }, 50);
}
$('#btnAsk').onclick = openAssistant;
initAssistant(api, {
  orderedPageKeys,
  goToPage,
  detectScales,
  autoFill,
  findMatches,
  refresh: () => refresh('all'),
  markDirty: () => markDirty(),
  reviewNext: () => reviewNext(),
});

// ---------- Collapsible side panels ----------
const panels = { left: pref('gridline-hide-left', 'off') === 'on', right: pref('gridline-hide-right', 'off') === 'on' };
function applyPanels() {
  const ws = $('#workspace');
  ws.classList.toggle('hide-left', panels.left);
  ws.classList.toggle('hide-right', panels.right);
  const l = $('#toggleLeft');
  const r = $('#toggleRight');
  l.innerHTML = icon(panels.left ? 'chevronR' : 'chevronL', 14);
  r.innerHTML = icon(panels.right ? 'chevronL' : 'chevronR', 14);
  l.classList.toggle('collapsed', panels.left);
  r.classList.toggle('collapsed', panels.right);
  l.title = panels.left ? 'Show sheets & conditions ( [ )' : 'Hide sheets & conditions ( [ )';
  r.title = panels.right ? 'Show properties ( ] )' : 'Hide properties ( ] )';
  setPref('gridline-hide-left', panels.left ? 'on' : 'off');
  setPref('gridline-hide-right', panels.right ? 'on' : 'off');
}
function togglePanel(side) {
  if (side === 'both') {
    const hide = !(panels.left && panels.right);
    panels.left = panels.right = hide;
  } else panels[side] = !panels[side];
  applyPanels();
}
$('#toggleLeft').onclick = () => togglePanel('left');
$('#toggleRight').onclick = () => togglePanel('right');
$('#toggleLeft').addEventListener('pointerdown', (e) => e.stopPropagation());
$('#toggleRight').addEventListener('pointerdown', (e) => e.stopPropagation());
applyPanels();
$('#btnNewCond').onclick = () => newCondition();
$('#btnLibrary').onclick = () => openLibrary();

// ---------- Condition library ----------
const LIB_FIELDS = ['name', 'type', 'tag', 'group', 'height', 'depth', 'pitch', 'roofLine', 'waste', 'matCost', 'laborCost', 'color', 'costBasis', 'notes'];
async function getLibrary() {
  if (api.library) return (await api.library.get()) || [];
  try {
    return JSON.parse(localStorage.getItem('gridline-library') || '[]');
  } catch {
    return [];
  }
}
async function setLibrary(list) {
  if (api.library) return api.library.set(list);
  try {
    localStorage.setItem('gridline-library', JSON.stringify(list));
  } catch {}
}
async function saveToLibrary(ids) {
  const lib = await getLibrary();
  let n = 0;
  for (const id of ids) {
    const c = condition(id);
    if (!c) continue;
    const entry = Object.fromEntries(LIB_FIELDS.map((k) => [k, c[k]]));
    entry.savedAt = new Date().toISOString();
    const i = lib.findIndex((x) => x.type === c.type && x.name.toLowerCase() === c.name.toLowerCase());
    if (i >= 0) lib[i] = entry;
    else lib.push(entry);
    n++;
  }
  await setLibrary(lib);
  toast(n === 1 ? `Saved "${condition(ids[0]).name}" to your library` : `Saved ${n} conditions to your library`, { kind: 'ok', timeout: 2200 });
}
async function openLibrary() {
  const lib = await getLibrary();
  const r = await libraryDialog(lib, store.project.conditions);
  if (!r) return;
  if (r.changed) await setLibrary(r.library);
  if (r.add && r.add.length) {
    const used = new Set(store.project.conditions.map((c) => c.color));
    commit((p) => {
      for (const e of r.add) {
        const c = { id: uid('cond'), ...Object.fromEntries(LIB_FIELDS.map((k) => [k, e[k]])) };
        if (!c.color || used.has(c.color)) c.color = nextColor();
        used.add(c.color);
        p.conditions.push(c);
      }
    }, 'conditions');
    toast(`Added ${r.add.length} condition${r.add.length === 1 ? '' : 's'} from your library`, { kind: 'ok', timeout: 2200 });
  } else if (r.changed) toast('Library updated', { timeout: 1500 });
}

// ---------- Flagged markups (assistant work that needs a human look) ----------
async function reviewNext() {
  const order = orderedPageKeys();
  const flagged = store.project.markups
    .filter((m) => m.review)
    .sort((a, b) => order.indexOf(a.pageKey) - order.indexOf(b.pageKey));
  if (!flagged.length) return toast('Nothing flagged for review.', { kind: 'ok', timeout: 2000 });
  const cur = flagged.findIndex((m) => m.id === store.ui.selectedMarkupId);
  const m = flagged[(cur + 1) % flagged.length] || flagged[0];
  if (store.ui.view !== 'takeoff') setView('takeoff');
  if (store.ui.pageKey !== m.pageKey) await goToPage(m.pageKey);
  if (store.ui.tool !== 'select') await setTool('select');
  store.ui.selectedMarkupId = m.id;
  store.ui.activeConditionId = m.conditionId;
  if (panels.right) togglePanel('right');
  setRightTab('props');
  const xs = m.points.map((q) => q[0]),
    ys = m.points.map((q) => q[1]);
  const x0 = Math.min(...xs),
    y0 = Math.min(...ys);
  viewer.fitRect([x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0], 0.35);
  refresh('ui');
  toast(`Flagged ${flagged.indexOf(m) + 1} of ${flagged.length}: ${m.review}`, { timeout: 3500 });
}

// ---------- Command palette ----------
function paletteItems() {
  const items = [];
  const A = (label, run, o = {}) => items.push({ label, run, group: o.group || 'Actions', icon: o.icon, keys: o.keys, hint: o.hint, top: o.top });
  A('Linear takeoff (LF)', () => setTool('linear'), { icon: 'linear', keys: 'L', top: true });
  A('Area takeoff (SF)', () => setTool('area'), { icon: 'area', keys: 'A', top: true });
  A('Fill a room / zone', () => setTool('fill'), { icon: 'bucket', keys: 'B', top: true });
  A('Ask the assistant', () => openAssistant(), { icon: 'sparkle', keys: '/', top: true });
  A('Roof takeoff', () => setTool('roof'), { icon: 'roof', keys: 'R' });
  A('Count takeoff', () => setTool('count'), { icon: 'count', keys: 'C' });
  A('Quick measure', () => setTool('measure'), { icon: 'measure', keys: 'M' });
  A('Calibrate scale', () => setTool('calibrate'), { icon: 'calibrate', keys: 'K' });
  A('Read scales from title blocks (all sheets)', () => detectScales(orderedPageKeys(), true), { icon: 'calibrate' });
  A('New condition…', () => newCondition(), { icon: 'plus' });
  A('Condition library…', () => openLibrary(), { icon: 'layers' });
  A('Next flagged markup (assistant review)', () => reviewNext(), { icon: 'search' });
  A('Save all conditions to library', () => saveToLibrary(store.project.conditions.map((c) => c.id)), { icon: 'layers' });
  A('Add drawings (PDF)…', addPdfs, { icon: 'filePlus', keys: 'Ctrl+Shift+O' });
  A('Open project…', () => openProject(), { icon: 'folder', keys: 'Ctrl+O' });
  A('Save', () => saveProject(), { icon: 'save', keys: 'Ctrl+S' });
  A('Save as…', () => saveProject(true), { icon: 'save', keys: 'Ctrl+Shift+S' });
  A('Export estimate (CSV)', exportCsv, { icon: 'download', keys: 'Ctrl+E' });
  A('Go to estimate', () => setView('estimate'), { icon: 'table', keys: 'Ctrl+2' });
  A('Go to takeoff', () => setView('takeoff'), { icon: 'layers', keys: 'Ctrl+1' });
  A('Toggle snap to plan lines', toggleSnap, { icon: 'magnet', keys: 'S' });
  A('Toggle dark drawings', toggleDarkDrawings, { icon: 'moon', keys: 'Ctrl+Shift+D', group: 'Appearance' });
  A('Toggle light / dark theme', () => cycleBase(), { icon: 'sun', keys: 'Ctrl+Shift+T', group: 'Appearance' });
  for (const t of THEMES) A(`Theme: ${t.name}`, () => setAppearance({ theme: t.id, system: false }), { icon: 'sun', group: 'Appearance' });
  for (const m of DRAWING_MODES) A(`Drawings: ${m.name}`, () => setAppearance({ drawing: m.id }), { icon: 'file', group: 'Appearance', hint: m.hint });
  A('Hide / show both side panels', () => togglePanel('both'), { icon: 'fit', keys: '\\' });
  A('Settings…', openSettings, { icon: 'gear', keys: 'Ctrl+,' });
  A('Keyboard shortcuts', shortcutsDialog, { icon: 'tag', keys: 'F1' });
  A('Check for updates', () => {
    manualCheck = true;
    api.updater.check();
  }, { icon: 'refresh' });
  A('Close current PDF', closeCurrentDrawing, { icon: 'x' });
  A('Close project', closeProject, { icon: 'x', keys: 'Ctrl+W' });
  for (const k of orderedPageKeys()) {
    const pg = store.project.pages[k];
    items.push({ label: pg.name, hint: pg.scale ? pg.scale.label : 'no scale', group: 'Sheets', icon: 'sheets', run: () => goToPage(k) });
  }
  for (const c of store.project.conditions) {
    items.push({ label: c.name, hint: (c.group ? c.group + ' · ' : '') + TYPE_INFO[c.type].label, group: 'Conditions', dot: c.color, run: () => activateCondition(c.id) });
  }
  return items;
}
async function showPalette() {
  const items = paletteItems();
  if (api.recent) {
    for (const r of (await api.recent.list()).slice(0, 8)) items.push({ label: r.name, hint: r.path, group: 'Recent projects', icon: 'folder', run: () => openProject(r.path) });
  }
  openPalette(items);
}
$('#condSearch').addEventListener('input', renderConditions);
$('#projectName').addEventListener('change', (e) => {
  const v = e.target.value.trim() || 'Untitled project';
  commit((p) => (p.name = v), 'settings');
});
$('#projectName').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());

$$('.tab[data-left]').forEach(
  (t) =>
    (t.onclick = () => {
      store.ui.leftTab = t.dataset.left;
      $$('.tab[data-left]').forEach((x) => x.classList.toggle('active', x === t));
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
    case 'close-project':
      return closeProject();
    case 'close-drawing':
      return closeCurrentDrawing();
    case 'settings':
      return openSettings();
    case 'palette':
      return showPalette();
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
    case 'toggle-left':
      return togglePanel('left');
    case 'toggle-right':
      return togglePanel('right');
    case 'toggle-both':
      return togglePanel('both');
    case 'toggle-theme':
      return toggleTheme();
    case 'toggle-dark-drawings':
      return toggleDarkDrawings();
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

// ---------- Autosave & recovery ----------
let autosaving = false;
async function autosaveNow() {
  if (!api.autosave || autosaving || !store.dirty || !store.project.documents.length) return;
  autosaving = true;
  try {
    const text = await projectText();
    await api.autosave.write({ id: store.project.id, name: store.project.name, path: store.filePath, text });
    $('#statusSaved').textContent = 'Autosaved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    console.warn('autosave', e);
  }
  autosaving = false;
}
setInterval(autosaveNow, 90 * 1000);

async function offerRecovery() {
  if (!api.autosave) return;
  const list = await api.autosave.list();
  if (!list.length) return;
  const a = list[0];
  const when = new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  toast(`Unsaved work found: "${a.name}" from ${when}.`, {
    actionLabel: 'Recover',
    timeout: 0,
    action: async () => {
      const text = await api.autosave.read(a.id);
      if (!text) return toast('That recovery copy is no longer available.', { kind: 'err' });
      await loadProjectText(text, a.path, { recovered: true });
    },
  });
}
setTimeout(offerRecovery, 800);

// ---------- Recent projects (start screen) ----------
async function renderRecent() {
  const box = $('#recentList');
  if (!box || !api.recent) return;
  const list = await api.recent.list();
  box.hidden = !list.length;
  box.innerHTML = list.length
    ? `<div class="recent-head">Recent projects</div>` +
      list
        .slice(0, 6)
        .map(
          (r) => `<button class="recent-item" data-path="${esc(r.path)}" title="${esc(r.path)}">${icon('file', 15)}<span class="r-name">${esc(r.name)}</span><span class="r-when">${esc(new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span></button>`
        )
        .join('')
    : '';
  box.querySelectorAll('[data-path]').forEach((b) => (b.onclick = () => openProject(b.dataset.path)));
}
renderRecent();
on((what) => {
  if (what === 'all' && !store.project.documents.length) renderRecent();
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
window.__gridline = { store, view, viewer, setAppearance, appearancePopover, showPalette, openLibrary, saveToLibrary, addPdfFiles, setTool, goToPage, newCondition, setView, menuCmd };
