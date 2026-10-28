// Project state, undo/redo history, and change notifications.

const listeners = new Set();
export const COLORS = ['#ff8a24', '#3b9eff', '#2fbf71', '#e5484d', '#a879ff', '#f5c400', '#12b5b0', '#ff5fa2', '#8d9bb0', '#7bd35a'];

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

function savedDefaults() {
  try {
    return JSON.parse(localStorage.getItem('gridline-project-defaults') || 'null') || {};
  } catch {
    return {};
  }
}

export function blankProject() {
  const d = savedDefaults();
  const settings = { taxPct: 0, overheadPct: 10, profitPct: 10, labelStyle: 'ftin', showLabels: true };
  for (const k of Object.keys(settings)) if (d[k] != null) settings[k] = d[k];
  return {
    app: 'gridline',
    format: 1,
    name: 'Untitled project',
    unit: d.unit === 'm' ? 'm' : 'ft',
    settings,
    documents: [], // { id, name, data (base64) }
    pages: {}, // pageKey -> { name, scale: { ptPerUnit, unit, label } }
    conditions: [], // { id, name, type, color, group, height, depth, waste, matCost, laborCost, costBasis, notes }
    markups: [], // { id, conditionId, pageKey, type, points, deduct? }
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export const store = {
  project: blankProject(),
  filePath: null,
  dirty: false,
  // UI state (not saved)
  ui: {
    view: 'takeoff',
    pageKey: null,
    activeConditionId: null,
    selectedMarkupId: null,
    tool: 'select',
    leftTab: 'sheets',
    hiddenConditions: new Set(),
  },
};

const undoStack = [];
const redoStack = [];
const HISTORY_MAX = 150;
// Big takeoffs make big snapshots; cap undo history by size as well as count.
const HISTORY_BYTES = 24 * 1024 * 1024;
const size = (arr) => arr.reduce((n, s) => n + s.length * 2, 0);
let trimmed = 0; // entries dropped from the front, so history marks stay valid
function trimHistory() {
  while (undoStack.length > 1 && (undoStack.length > HISTORY_MAX || size(undoStack) + size(redoStack) > HISTORY_BYTES)) {
    undoStack.shift();
    trimmed++;
  }
}

function snapshot() {
  const { conditions, markups, pages, settings, unit, name } = store.project;
  return JSON.stringify({ conditions, markups, pages, settings, unit, name });
}

function restore(snap) {
  Object.assign(store.project, JSON.parse(snap));
  if (!store.project.markups.find((m) => m.id === store.ui.selectedMarkupId)) store.ui.selectedMarkupId = null;
  if (!store.project.conditions.find((c) => c.id === store.ui.activeConditionId)) store.ui.activeConditionId = null;
}

/** Wrap every user-visible mutation in commit() so it can be undone. */
export function commit(mutator, what = 'change') {
  undoStack.push(snapshot());
  redoStack.length = 0;
  trimHistory();
  mutator(store.project);
  markDirty();
  emit(what);
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  markDirty();
  emit('history');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  markDirty();
  emit('history');
  return true;
}

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}

export function markDirty(v = true) {
  store.dirty = v;
  if (v) store.project.updatedAt = new Date().toISOString();
  document.title = `${v ? '• ' : ''}${store.project.name} — Gridline`;
}

export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(what) {
  for (const fn of listeners) fn(what);
}

export function condition(id) {
  return store.project.conditions.find((c) => c.id === id);
}

export function nextColor() {
  const used = store.project.conditions.map((c) => c.color);
  return COLORS.find((c) => !used.includes(c)) || COLORS[store.project.conditions.length % COLORS.length];
}

/** Position in the undo history, for grouping several commits into one step. */
export function historyMark() {
  return trimmed + undoStack.length;
}

/** Collapse every commit made since `mark` into a single undo step. Returns true if anything changed. */
export function squashHistory(mark) {
  const at = Math.max(0, mark - trimmed);
  if (undoStack.length <= at) return false;
  const first = undoStack[at];
  undoStack.length = at;
  undoStack.push(first);
  return true;
}
