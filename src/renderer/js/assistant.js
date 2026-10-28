// Local AI assistant: a chat panel whose model (running in Ollama on this PC) drives Gridline
// through a fixed set of tools. Every change it makes is grouped into one undo step.
import { store, commit, condition, uid, nextColor, historyMark, squashHistory, undo } from './store.js';
import { $, h, esc, toast, contextMenu } from './dom.js';
import { icon } from './icons.js';
import * as viewer from './viewer.js';
import { pickSheetScale, parsePitch, fmtNum, fmtMoney, UNIT_LABELS, SCALE_PRESETS, presetToScale, formatPitch } from './units.js';
import { polygonArea, centroid } from './geometry.js';
import { totalsFor, primaryQty } from './panels.js';
import { computeLines } from './estimate.js';
import { estimateSummary } from './geometry.js';
import { scaleFor } from './overlay.js';
import { findRegions, regionOutline, regionsLike } from './regions.js';
import { detectViews, titleBlockLeft } from './views.js';
import { pointInPolygon } from './geometry.js';

export const RECOMMENDED_MODEL = 'qwen3.8:27b';
export const RECOMMENDED_LABEL = 'Qwen 3.8 27B';
export const RECOMMENDED_SIZE = '≈18 GB';

let ctx = null; // app hooks
let api = null;
const state = {
  status: null, // ai:status result
  model: null,
  caps: {}, // model -> capabilities[]
  history: [], // chat messages sent to the model (without the system prompt)
  busy: false,
  reqId: 0,
  pull: null, // { id, model, pct, status }
  debug: [], // what the model did, for troubleshooting (Copy log)
  regionLists: new Map(), // find_regions token -> region list
  viewCache: new Map(), // pageKey -> views
};

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

export function initAssistant(appApi, hooks) {
  api = appApi;
  ctx = hooks;
  state.model = pref('gridline-ai-model', RECOMMENDED_MODEL);
  if (api.ai) {
    api.ai.setBase(pref('gridline-ai-base', 'http://127.0.0.1:11434'));
    api.ai.onPullProgress((p) => {
      if (!state.pull || p.id !== state.pull.id) return;
      state.pull.status = p.status;
      if (p.total) state.pull.pct = Math.round((p.completed / p.total) * 100);
      renderSetupProgress();
    });
  }
}

export const aiAvailable = () => !!(api && api.ai);

// ---------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------

function sheetList() {
  return ctx.orderedPageKeys().map((key, i) => ({ key, i, pg: store.project.pages[key] }));
}

function resolveSheet(ref) {
  const list = sheetList();
  if (ref == null || ref === '' || /^(current|this)( sheet)?$/i.test(String(ref))) return store.ui.pageKey || (list[0] && list[0].key);
  const s = String(ref).trim().toLowerCase();
  let hit = list.find((x) => (x.pg.name || '').toLowerCase() === s);
  if (!hit && /^\d+$/.test(s)) hit = list[+s - 1];
  if (!hit) hit = list.find((x) => (x.pg.name || '').toLowerCase().includes(s));
  if (!hit) throw new Error(`No sheet named "${ref}". Sheets: ${list.map((x) => x.pg.name).join(', ')}`);
  return hit.key;
}

function resolveSheets(ref) {
  if (ref === 'all' || (Array.isArray(ref) && ref.length === 1 && ref[0] === 'all')) return sheetList().map((x) => x.key);
  const arr = Array.isArray(ref) ? ref : [ref];
  return arr.map(resolveSheet);
}

function resolveCondition(name, type) {
  if (!name) throw new Error('A condition name is required.');
  const s = String(name).trim().toLowerCase();
  const c =
    store.project.conditions.find((x) => x.name.toLowerCase() === s) ||
    store.project.conditions.find((x) => x.name.toLowerCase().includes(s));
  if (!c) throw new Error(`No condition named "${name}". Create it first with create_condition.`);
  if (type && ![].concat(type).includes(c.type)) throw new Error(`"${c.name}" is a ${c.type} condition; this needs ${[].concat(type).join(' or ')}.`);
  return c;
}

const sheetName = (key) => (store.project.pages[key] && store.project.pages[key].name) || key;

function parseScaleText(text) {
  const t = String(text || '').trim();
  const r = pickSheetScale(/scale/i.test(t) ? t : `SCALE: ${t}`);
  if (r) {
    const preset = SCALE_PRESETS.find((p) => Math.abs(presetToScale(p).ptPerUnit - r.scale.ptPerUnit) < 1e-6 && presetToScale(p).unit === r.scale.unit);
    return preset ? presetToScale(preset) : r.scale;
  }
  const preset = SCALE_PRESETS.find((p) => p.label.replace(/\s/g, '').toLowerCase() === t.replace(/\s/g, '').toLowerCase());
  if (preset) return presetToScale(preset);
  throw new Error(`Couldn't read the scale "${text}". Use a form like 1/4" = 1'-0", 1" = 20', or 1:100.`);
}

function roomLabelItems(items, pageW, pageH) {
  // Room tags: text with a 3–4 digit room number, outside the title block corner.
  return items.filter(
    (it) =>
      it.str.length <= 32 &&
      /(^|\s)\d{3,4}[A-Z]?(\s|$)/.test(it.str) &&
      !(it.x > pageW * 0.72 && it.y > pageH * 0.8)
  );
}

const textCenter = (it) => [it.x + it.w / 2, it.y - it.h * 0.35];

function summarizeCondition(c) {
  const t = totalsFor(c);
  const u = UNIT_LABELS[store.project.unit];
  const o = { name: c.name, type: c.type, group: c.group || '', markups: t.markups, quantity: primaryQty(c, t) };
  if (c.type === 'linear') o.length = +t.length.toFixed(2);
  if (c.type === 'area') Object.assign(o, { area: +t.area.toFixed(2), perimeter: +t.perimeter.toFixed(2) });
  if (c.type === 'roof') Object.assign(o, { pitch: formatPitch(+c.pitch || 0), roof_area: +t.area.toFixed(2), squares: +t.squares.toFixed(2), plan_area: +t.planArea.toFixed(2) });
  if (c.type === 'count') o.count = t.count;
  if (t.unscaled) o.warning = `${t.unscaled} markup(s) are on unscaled sheets and not counted`;
  o.units = u;
  if (c.matCost || c.laborCost) Object.assign(o, { material_cost: c.matCost, labor_cost: c.laborCost, waste_pct: c.waste || 0 });
  return o;
}

async function viewsFor(key) {
  if (state.viewCache.has(key)) return state.viewCache.get(key);
  const [{ items }, sz, idx] = await Promise.all([viewer.getPageText(key), viewer.pageSize(key), viewer.getSnapIndex(key)]);
  const v = detectViews(items, sz.w, sz.h, titleBlockLeft(idx, sz.w, sz.h));
  state.viewCache.set(key, v);
  return v;
}

async function resolveArea(key, args) {
  if (Array.isArray(args.box) && args.box.length === 4) return { box: args.box.map(Number), name: null };
  if (args.view != null && args.view !== '') {
    const vs = await viewsFor(key);
    const q = String(args.view).toLowerCase();
    const v = vs.find((x) => x.number && x.number.toLowerCase() === q) || vs.find((x) => x.title.toLowerCase().includes(q));
    if (!v) throw new Error(`No view "${args.view}" on this sheet. Views: ${vs.map((x) => `${x.number || '?'} ${x.title}`).join('; ') || 'none found'}`);
    return { box: v.box, name: `${v.number ? v.number + ' – ' : ''}${v.title}` };
  }
  const sz = await viewer.pageSize(key);
  return { box: [0, 0, sz.w, sz.h], name: null };
}

function addMarkups(list) {
  if (!list.length) return;
  commit((pp) => list.forEach((m) => pp.markups.push(m)), 'markups');
}

const LABEL_PROP = { label: { type: 'string', description: 'Where this is, e.g. "Elev 1 – Front" or "Unit 2B". Shown in the estimate breakdown.' } };

const TOOL_DEFS = [
  {
    name: 'get_overview',
    description: 'Get the project: sheets (name, scale, markup count), conditions with quantities, the current sheet, units and sheet size in points.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'go_to_sheet',
    description: 'Show a sheet in the main view.',
    parameters: { type: 'object', properties: { sheet: { type: 'string', description: 'Sheet name like "A-101", a 1-based number, or "current"' } }, required: ['sheet'] },
  },
  {
    name: 'read_sheet_text',
    description: 'Read the text on a sheet grouped into lines, with positions. Use for schedules, room names, notes, title blocks.',
    parameters: { type: 'object', properties: { sheet: { type: 'string' }, contains: { type: 'string', description: 'Only lines containing this text (optional)' } }, required: ['sheet'] },
  },
  {
    name: 'find_text',
    description: 'Find text on a sheet (case-insensitive). Returns each match with its centre point in page coordinates.',
    parameters: { type: 'object', properties: { sheet: { type: 'string' }, text: { type: 'string' }, whole_word: { type: 'boolean' } }, required: ['sheet', 'text'] },
  },
  {
    name: 'look_at_sheet',
    description: 'See an image of the sheet (or a region of it). Use when text alone is not enough. Region is [x, y, width, height] in page points.',
    parameters: { type: 'object', properties: { sheet: { type: 'string' }, region: { type: 'array', items: { type: 'number' } } }, required: ['sheet'] },
    vision: true,
  },
  {
    name: 'set_scale',
    description: 'Set the drawing scale on sheets. Use scale "detect" to read each sheet\'s scale from its title block.',
    parameters: {
      type: 'object',
      properties: {
        sheets: { type: 'array', items: { type: 'string' }, description: 'Sheet names, or ["all"]' },
        scale: { type: 'string', description: 'e.g. 1/4" = 1\'-0", 1" = 20\', 1:100, or "detect"' },
      },
      required: ['sheets', 'scale'],
    },
  },
  {
    name: 'create_condition',
    description: 'Create a takeoff condition (a line item). Types: linear (LF), area (SF), roof (sloped SF / squares, needs pitch), count (EA).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['linear', 'area', 'roof', 'count'] },
        group: { type: 'string', description: 'CSI division or trade, e.g. "09 – Finishes"' },
        height_ft: { type: 'number', description: 'Linear: wall height for wall SF' },
        depth_in: { type: 'number', description: 'Area: thickness in inches for CY' },
        pitch: { type: 'string', description: 'Roof: e.g. 6/12' },
        waste_pct: { type: 'number' },
        material_cost: { type: 'number', description: 'Per unit (LF, SF, SQ, CY or EA)' },
        labor_cost: { type: 'number' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'update_condition',
    description: 'Change a condition: rename, costs, waste, height, depth, pitch, group.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Existing condition name' },
        new_name: { type: 'string' },
        group: { type: 'string' },
        height_ft: { type: 'number' },
        depth_in: { type: 'number' },
        pitch: { type: 'string' },
        waste_pct: { type: 'number' },
        material_cost: { type: 'number' },
        labor_cost: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'fill_rooms',
    description:
      'Measure room areas automatically by filling the enclosed space around room labels. rooms: list of label text (e.g. "OFFICE 101" or "101"), or ["all"] for every room-numbered label on the sheet. Or give points [[x,y],...] inside rooms.',
    parameters: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        condition: { type: 'string', description: 'Area or roof condition name' },
        rooms: { type: 'array', items: { type: 'string' } },
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        ...LABEL_PROP,
      },
      required: ['sheet', 'condition'],
    },
  },
  {
    name: 'count_text',
    description: 'Place a count at every place a tag or label appears on a sheet (door tags, fixture tags, keynotes).',
    parameters: { type: 'object', properties: { sheet: { type: 'string' }, condition: { type: 'string' }, text: { type: 'string' }, whole_word: { type: 'boolean' }, ...LABEL_PROP }, required: ['sheet', 'condition', 'text'] },
  },
  {
    name: 'count_symbols',
    description: 'Find every symbol matching the one inside a box and count them. box is [x, y, width, height] in page points tightly around one example symbol.',
    parameters: { type: 'object', properties: { sheet: { type: 'string' }, condition: { type: 'string' }, box: { type: 'array', items: { type: 'number' } }, ...LABEL_PROP }, required: ['sheet', 'condition', 'box'] },
  },
  {
    name: 'draw_markup',
    description: 'Draw a takeoff shape from page-point coordinates: a run of points for linear, a closed outline for area/roof, or points for count.',
    parameters: {
      type: 'object',
      properties: { sheet: { type: 'string' }, condition: { type: 'string' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, deduct: { type: 'boolean' }, ...LABEL_PROP },
      required: ['sheet', 'condition', 'points'],
    },
  },
  {
    name: 'list_views',
    description: 'List the drawing views on a sheet (elevations, plans, sections, details) with their number, title, scale and approximate box in page points.',
    parameters: { type: 'object', properties: { sheet: { type: 'string' } }, required: ['sheet'] },
  },
  {
    name: 'find_regions',
    description:
      'Find every closed zone inside a view (or box) using the drawing linework, ignoring hatch patterns. Returns zones with exact area (SF), box, centre, hatch description, and any tags/text inside. Use this to measure facades, panels, rooms and any closed shapes accurately instead of drawing by eye.',
    parameters: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        view: { type: 'string', description: 'View number or title from list_views (optional)' },
        box: { type: 'array', items: { type: 'number' }, description: '[x, y, width, height] page points (optional, instead of view)' },
        min_sf: { type: 'number', description: 'Ignore zones smaller than this (default 4)' },
        include_hatch_lines: { type: 'boolean', description: 'true = treat hatch lines as boundaries too (rarely needed)' },
      },
      required: ['sheet'],
    },
  },
  {
    name: 'measure_regions',
    description: 'Add exact area takeoffs for zones from find_regions. Openings inside each zone (windows, doors, louvers) are deducted automatically unless deduct_openings is false.',
    parameters: {
      type: 'object',
      properties: {
        condition: { type: 'string' },
        regions: { type: 'array', items: { type: 'string' }, description: 'Zone ids from find_regions, e.g. ["R2.14", "R2.20"]' },
        deduct_openings: { type: 'boolean' },
        ...LABEL_PROP,
      },
      required: ['condition', 'regions'],
    },
  },
  {
    name: 'measure_similar',
    description: 'Measure every zone in the same find_regions result that has the same hatch pattern as the given zone (e.g. all brick zones on an elevation). Skips zones already measured.',
    parameters: {
      type: 'object',
      properties: { condition: { type: 'string' }, region: { type: 'string', description: 'An example zone id' }, deduct_openings: { type: 'boolean' }, ...LABEL_PROP },
      required: ['condition', 'region'],
    },
  },
  {
    name: 'review_markups',
    description: 'See the sheet (or a view/box) with all takeoff markups drawn on it in their condition colours, plus a list of possible problems (overlaps, unlabeled, unscaled). Use it to check your work and fix gaps or double counts.',
    parameters: { type: 'object', properties: { sheet: { type: 'string' }, view: { type: 'string' }, box: { type: 'array', items: { type: 'number' } } }, required: ['sheet'] },
    vision: true,
  },
  {
    name: 'get_estimate',
    description: 'Get the priced estimate: every condition with quantity, waste, unit costs and totals, plus tax, overhead, profit and bid total.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_markups',
    description: 'Set estimate markups in percent.',
    parameters: { type: 'object', properties: { tax_pct: { type: 'number' }, overhead_pct: { type: 'number' }, profit_pct: { type: 'number' } } },
  },
];

function toolSchemas(vision) {
  return TOOL_DEFS.filter((t) => !t.vision || vision).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function runTool(name, args, out) {
  args = args || {};
  const p = store.project;
  switch (name) {
    case 'get_overview': {
      const sheets = [];
      for (const x of sheetList()) {
        const sz = await viewer.pageSize(x.key);
        sheets.push({ sheet: x.pg.name, number: x.i + 1, scale: x.pg.scale ? x.pg.scale.label : null, markups: p.markups.filter((m) => m.pageKey === x.key).length, size_pt: [Math.round(sz.w), Math.round(sz.h)] });
      }
      return {
        project: p.name,
        units: p.unit === 'm' ? 'metric' : 'imperial',
        current_sheet: store.ui.pageKey ? sheetName(store.ui.pageKey) : null,
        sheets,
        conditions: p.conditions.map(summarizeCondition),
        coordinates: 'Page points, origin top-left, x right, y down. 72 points = 1 paper inch.',
      };
    }
    case 'go_to_sheet': {
      const key = resolveSheet(args.sheet);
      await ctx.goToPage(key);
      return { ok: true, sheet: sheetName(key) };
    }
    case 'read_sheet_text': {
      const key = resolveSheet(args.sheet);
      const { items } = await viewer.getPageText(key);
      // Group into lines by baseline.
      const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
      const lines = [];
      for (const it of sorted) {
        const L = lines[lines.length - 1];
        if (L && Math.abs(L.y - it.y) < Math.max(2, it.h * 0.4)) L.parts.push(it);
        else lines.push({ y: it.y, parts: [it] });
      }
      let txt = lines
        .map((L) => {
          L.parts.sort((a, b) => a.x - b.x);
          return { y: Math.round(L.y), x: Math.round(L.parts[0].x), text: L.parts.map((q) => q.str).join('  ') };
        })
        .filter((L) => !args.contains || L.text.toLowerCase().includes(String(args.contains).toLowerCase()));
      const total = txt.length;
      let s = txt.map((L) => `(${L.x},${L.y}) ${L.text}`).join('\n');
      if (s.length > 12000) s = s.slice(0, 12000) + `\n… (${total} lines, truncated — use "contains" to narrow)`;
      return { sheet: sheetName(key), lines: total, text: s || '(no text on this sheet — it may be a scan; try look_at_sheet)' };
    }
    case 'find_text': {
      const key = resolveSheet(args.sheet);
      const { items } = await viewer.getPageText(key);
      const q = String(args.text || '').toLowerCase();
      const re = args.whole_word ? new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i') : null;
      const hits = items.filter((it) => (re ? re.test(it.str) : it.str.toLowerCase().includes(q)));
      return { sheet: sheetName(key), count: hits.length, matches: hits.slice(0, 200).map((it) => ({ text: it.str, at: textCenter(it).map(Math.round), size: Math.round(it.h) })) };
    }
    case 'look_at_sheet': {
      const key = resolveSheet(args.sheet);
      const region = Array.isArray(args.region) && args.region.length === 4 ? args.region.map(Number) : null;
      const img = await viewer.renderJpeg(key, 1536, region);
      out.image = { sheet: sheetName(key), data: img.dataUrl.split(',')[1] };
      const sz = await viewer.pageSize(key);
      return {
        sheet: sheetName(key),
        image_px: [img.w, img.h],
        note: `The image follows. To convert image pixels to page points: x_pt = ${region ? region[0] : 0} + x_px / ${img.scale.toFixed(4)}, y_pt = ${region ? region[1] : 0} + y_px / ${img.scale.toFixed(4)}. Full sheet is ${Math.round(sz.w)}×${Math.round(sz.h)} pt.`,
      };
    }
    case 'set_scale': {
      const keys = resolveSheets(args.sheets || 'all');
      if (/^detect$/i.test(String(args.scale))) {
        const n = await ctx.detectScales(keys, true);
        return { detected_on: n, of: keys.length, sheets: keys.map((k) => ({ sheet: sheetName(k), scale: p.pages[k].scale ? p.pages[k].scale.label : null })) };
      }
      const sc = parseScaleText(args.scale);
      commit((pp) => keys.forEach((k) => (pp.pages[k].scale = { ...sc })), 'pages');
      return { ok: true, scale: sc.label, sheets: keys.map(sheetName) };
    }
    case 'create_condition': {
      const type = args.type;
      if (!['linear', 'area', 'roof', 'count'].includes(type)) throw new Error('type must be linear, area, roof or count');
      const existing = p.conditions.find((c) => c.name.toLowerCase() === String(args.name).toLowerCase());
      if (existing) return { ok: true, note: 'Already exists; using it.', condition: summarizeCondition(existing) };
      let pitch = 0;
      if (type === 'roof') {
        pitch = parsePitch(args.pitch ?? '6/12');
        if (!isFinite(pitch)) throw new Error('Pitch must look like 6/12');
      }
      const c = {
        id: uid('cond'),
        name: String(args.name).trim(),
        type,
        color: nextColor(),
        group: args.group || '',
        height: type === 'linear' || type === 'area' ? +args.height_ft || 0 : 0,
        depth: type === 'area' ? +args.depth_in || 0 : 0,
        pitch,
        roofLine: '',
        waste: args.waste_pct != null ? +args.waste_pct : type === 'roof' ? 10 : 0,
        matCost: +args.material_cost || 0,
        laborCost: +args.labor_cost || 0,
        costBasis: null,
        notes: 'Created by the assistant',
      };
      commit((pp) => pp.conditions.push(c), 'conditions');
      out.changed = true;
      return { ok: true, condition: summarizeCondition(c) };
    }
    case 'update_condition': {
      const c = resolveCondition(args.name);
      const patch = {};
      if (args.new_name) patch.name = String(args.new_name).trim();
      if (args.group != null) patch.group = String(args.group);
      if (args.height_ft != null) patch.height = +args.height_ft || 0;
      if (args.depth_in != null) patch.depth = +args.depth_in || 0;
      if (args.pitch != null) {
        const v = parsePitch(args.pitch);
        if (!isFinite(v)) throw new Error('Pitch must look like 6/12');
        patch.pitch = v;
      }
      if (args.waste_pct != null) patch.waste = +args.waste_pct || 0;
      if (args.material_cost != null) patch.matCost = +args.material_cost || 0;
      if (args.labor_cost != null) patch.laborCost = +args.labor_cost || 0;
      commit(() => Object.assign(c, patch), 'conditions');
      out.changed = true;
      return { ok: true, condition: summarizeCondition(c) };
    }
    case 'fill_rooms': {
      const key = resolveSheet(args.sheet);
      const c = resolveCondition(args.condition, ['area', 'roof']);
      if (!p.pages[key].scale) throw new Error(`Sheet ${sheetName(key)} has no scale yet. Set it first.`);
      const sz = await viewer.pageSize(key);
      const seeds = [];
      if (Array.isArray(args.points) && args.points.length) for (const q of args.points) seeds.push({ label: `point ${q.map(Math.round).join(',')}`, p: q.map(Number) });
      if (Array.isArray(args.rooms) && args.rooms.length) {
        const { items } = await viewer.getPageText(key);
        if (args.rooms.some((r) => String(r).toLowerCase() === 'all')) {
          for (const it of roomLabelItems(items, sz.w, sz.h)) seeds.push({ label: it.str, p: textCenter(it) });
        } else {
          for (const r of args.rooms) {
            const q = String(r).toLowerCase();
            const hits = items.filter((it) => it.str.toLowerCase() === q).concat(items.filter((it) => it.str.toLowerCase() !== q && it.str.toLowerCase().includes(q)));
            if (!hits.length) seeds.push({ label: r, missing: true });
            else seeds.push({ label: hits[0].str, p: textCenter(hits[0]) });
          }
        }
      }
      if (!seeds.length) throw new Error('Give rooms (labels or ["all"]) or points.');
      const made = [];
      const results = [];
      const k = scaleFor(key).ptPerUnit;
      for (const s of seeds) {
        if (s.missing) {
          results.push({ room: s.label, result: 'label not found on sheet' });
          continue;
        }
        const r = await ctx.autoFill(s.p, false, { quiet: true, pageKey: key, conditionId: c.id });
        if (r.error) {
          results.push({ room: s.label, result: r.error === 'leak' ? 'not enclosed (gap in walls, often an open doorway)' : r.error });
          continue;
        }
        const a = polygonArea(r.markup.points);
        const cen = centroid(r.markup.points);
        // Skip a room already filled (two labels in one room, or filled before).
        const dup = made.concat(p.markups.filter((m) => m.pageKey === key && m.conditionId === c.id)).find((m) => {
          const a2 = polygonArea(m.points);
          const c2 = centroid(m.points);
          return Math.abs(a2 - a) < a * 0.01 && Math.hypot(c2[0] - cen[0], c2[1] - cen[1]) < 3;
        });
        if (dup) {
          results.push({ room: s.label, result: 'already measured' });
          continue;
        }
        if (args.label) r.markup.label = String(args.label);
        else if (s.label && !/^point /.test(s.label)) r.markup.label = s.label;
        made.push(r.markup);
        results.push({ room: s.label, sf: +(a / (k * k)).toFixed(1) });
      }
      if (made.length) {
        commit((pp) => made.forEach((m) => pp.markups.push(m)), 'markups');
        out.changed = true;
        if (store.ui.pageKey !== key) await ctx.goToPage(key);
      }
      const total = results.reduce((s, r) => s + (r.sf || 0), 0);
      return { sheet: sheetName(key), condition: c.name, filled: made.length, total_sf: +total.toFixed(1), rooms: results };
    }
    case 'count_text': {
      const key = resolveSheet(args.sheet);
      const c = resolveCondition(args.condition, 'count');
      const { items } = await viewer.getPageText(key);
      const q = String(args.text || '');
      const esc2 = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = args.whole_word === false ? new RegExp(esc2, 'i') : new RegExp(`(^|[^A-Za-z0-9])${esc2}([^A-Za-z0-9]|$)`, 'i');
      const hits = items.filter((it) => re.test(it.str));
      const existing = p.markups.filter((m) => m.pageKey === key && m.conditionId === c.id).flatMap((m) => m.points);
      const pts = hits.map(textCenter).filter((pt) => !existing.some((e) => Math.hypot(e[0] - pt[0], e[1] - pt[1]) < 4));
      if (pts.length) {
        commit((pp) => pts.forEach((pt) => pp.markups.push({ id: uid('mk'), conditionId: c.id, pageKey: key, type: 'count', points: [pt], ...(args.label ? { label: String(args.label) } : {}) })), 'markups');
        out.changed = true;
        if (store.ui.pageKey !== key) await ctx.goToPage(key);
      }
      return { sheet: sheetName(key), condition: c.name, found: hits.length, added: pts.length };
    }
    case 'count_symbols': {
      const key = resolveSheet(args.sheet);
      const c = resolveCondition(args.condition, 'count');
      const b = (args.box || []).map(Number);
      if (b.length !== 4 || b.some((v) => !isFinite(v))) throw new Error('box must be [x, y, width, height] in page points');
      const found = await ctx.findMatches(key, b, c.id, { auto: true, cutoff: 0.75 });
      if (found.length) {
        commit((pp) => found.forEach((f) => pp.markups.push({ id: uid('mk'), conditionId: c.id, pageKey: key, type: 'count', points: [f.p], ...(args.label ? { label: String(args.label) } : {}) })), 'markups');
        out.changed = true;
        if (store.ui.pageKey !== key) await ctx.goToPage(key);
      }
      return { sheet: sheetName(key), condition: c.name, added: found.length };
    }
    case 'draw_markup': {
      const key = resolveSheet(args.sheet);
      const c = resolveCondition(args.condition);
      const pts = (args.points || []).map((q) => [Number(q[0]), Number(q[1])]).filter((q) => q.every(isFinite));
      const need = c.type === 'linear' ? 2 : c.type === 'count' ? 1 : 3;
      if (pts.length < need) throw new Error(`${c.type} needs at least ${need} points`);
      const extra = { ...(args.label ? { label: String(args.label) } : {}), ...(args.deduct && c.type !== 'linear' && c.type !== 'count' ? { deduct: true } : {}) };
      const ms = c.type === 'count' ? pts.map((q) => ({ id: uid('mk'), conditionId: c.id, pageKey: key, type: 'count', points: [q], ...extra })) : [{ id: uid('mk'), conditionId: c.id, pageKey: key, type: c.type, points: pts, ...extra }];
      commit((pp) => ms.forEach((m) => pp.markups.push(m)), 'markups');
      out.changed = true;
      return { ok: true, condition: summarizeCondition(c) };
    }
    case 'list_views': {
      const key = resolveSheet(args.sheet);
      const vs = await viewsFor(key);
      const sheetScale = p.pages[key].scale ? p.pages[key].scale.label : null;
      return {
        sheet: sheetName(key),
        sheet_scale: sheetScale,
        views: vs.map((v) => ({ number: v.number, title: v.title, scale: v.scale, box_pt: v.box, ...(v.scale && sheetScale && v.scale !== sheetScale ? { warning: `view scale ${v.scale} differs from sheet scale ${sheetScale}` } : {}) })),
      };
    }
    case 'find_regions': {
      const key = resolveSheet(args.sheet);
      const sc = scaleFor(key);
      if (!sc) throw new Error(`Sheet ${sheetName(key)} has no scale yet. Set it first.`);
      const area = await resolveArea(key, args);
      const [idx, sz, { items }] = await Promise.all([viewer.getSnapIndex(key), viewer.pageSize(key), viewer.getPageText(key)]);
      if (!idx || !idx.n) throw new Error('This sheet has no vector linework (probably a scan), so zones can\'t be found. Use look_at_sheet and draw_markup instead.');
      const r = findRegions(key, idx, sz.w, sz.h, area.box, { k: sc.ptPerUnit, mode: args.include_hatch_lines ? 'all' : 'outline', minArea: +args.min_sf || 4, textItems: items });
      state.regionLists.set(r.token, { list: r.regions, key, view: area.name });
      const closed = r.regions.filter((x) => !x.open);
      return {
        sheet: sheetName(key),
        view: area.name,
        zones_found: closed.length,
        zones: closed.slice(0, 60).map((z) => ({ id: z.id, net_sf: z.area_sf, gross_sf: z.gross_sf, openings: z.openings, box_pt: z.box_pt, centre_pt: z.centre_pt, hatch: z.hatch, tags: z.tags })),
        note: closed.length > 60 ? `Showing the 60 largest of ${closed.length}. Narrow with view/box or min_sf.` : 'Zones are listed largest first. Tags inside a zone usually name its material.',
      };
    }
    case 'measure_regions':
    case 'measure_similar': {
      const c = resolveCondition(args.condition, ['area', 'roof']);
      let ids = name === 'measure_regions' ? [].concat(args.regions || []) : [];
      if (name === 'measure_similar') {
        const token = String(args.region || '').split('.')[0];
        const L = state.regionLists.get(token);
        if (!L) throw new Error('Unknown zone id. Call find_regions first.');
        ids = regionsLike(args.region, L.list).map((z) => z.id);
      }
      if (!ids.length) throw new Error('No zones to measure.');
      const made = [];
      const results = [];
      for (const id of ids) {
        let o;
        try {
          o = regionOutline(id);
        } catch (e) {
          results.push({ zone: id, error: e.message });
          continue;
        }
        const k = scaleFor(o.pageKey).ptPerUnit;
        const gross = polygonArea(o.outer) / (k * k);
        const cen = centroid(o.outer);
        const dup = made.concat(p.markups.filter((m) => m.pageKey === o.pageKey && m.conditionId === c.id && !m.deduct)).find((m) => {
          const a2 = polygonArea(m.points) / (k * k);
          return Math.abs(a2 - gross) < Math.max(0.5, gross * 0.01) && pointInPolygon(cen, m.points);
        });
        if (dup) {
          results.push({ zone: id, result: 'already measured' });
          continue;
        }
        const label = args.label ? String(args.label) : undefined;
        made.push({ id: uid('mk'), conditionId: c.id, pageKey: o.pageKey, type: c.type, points: o.outer, ...(label ? { label } : {}) });
        let ded = 0;
        if (args.deduct_openings !== false) {
          for (const hole of o.holes) {
            const a = polygonArea(hole) / (k * k);
            ded += a;
            made.push({ id: uid('mk'), conditionId: c.id, pageKey: o.pageKey, type: c.type, points: hole, deduct: true, ...(label ? { label } : {}) });
          }
        }
        results.push({ zone: id, gross_sf: +gross.toFixed(1), openings: args.deduct_openings === false ? 0 : o.holes.length, openings_sf: +ded.toFixed(1), net_sf: +(gross - ded).toFixed(1) });
      }
      addMarkups(made);
      if (made.length) {
        out.changed = true;
        const key = made[0].pageKey;
        if (store.ui.pageKey !== key) await ctx.goToPage(key);
      }
      const net = results.reduce((s2, r) => s2 + (r.net_sf || 0), 0);
      return { condition: c.name, label: args.label || null, measured: results.filter((r) => r.net_sf != null).length, net_sf: +net.toFixed(1), zones: results };
    }
    case 'review_markups': {
      const key = resolveSheet(args.sheet);
      const area = await resolveArea(key, args);
      const ms = p.markups.filter((m) => m.pageKey === key);
      const sz = await viewer.pageSize(key);
      const full = area.box[0] === 0 && area.box[1] === 0 && area.box[2] >= sz.w - 1;
      const img = await viewer.renderJpeg(key, 1536, full ? null : area.box, (g, s2) => {
        for (const m of ms) {
          const c = condition(m.conditionId);
          const col = c ? c.color : '#888';
          g.lineWidth = 2.5 / s2;
          g.strokeStyle = col;
          g.fillStyle = col + (m.deduct ? '00' : '55');
          if (m.type === 'count') {
            for (const [x, y] of m.points) {
              g.beginPath();
              g.arc(x, y, 6 / s2, 0, Math.PI * 2);
              g.fillStyle = col;
              g.fill();
            }
            continue;
          }
          g.beginPath();
          m.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          if (m.type !== 'linear') g.closePath();
          if (m.deduct) g.setLineDash([6 / s2, 4 / s2]);
          if (m.type !== 'linear') g.fill();
          g.stroke();
          g.setLineDash([]);
        }
      });
      out.image = { sheet: sheetName(key), data: img.dataUrl.split(',')[1] };
      // Problems worth checking
      const issues = [];
      if (!p.pages[key].scale) issues.push('Sheet has no scale — quantities are not counted.');
      const byCond = new Map();
      for (const m of ms) {
        if (!byCond.has(m.conditionId)) byCond.set(m.conditionId, []);
        byCond.get(m.conditionId).push(m);
      }
      for (const [cid, list] of byCond) {
        const c = condition(cid);
        const shapes = list.filter((m) => !m.deduct && m.type !== 'linear' && m.type !== 'count');
        for (let i = 0; i < shapes.length; i++)
          for (let j = i + 1; j < shapes.length; j++) {
            if (pointInPolygon(centroid(shapes[i].points), shapes[j].points) || pointInPolygon(centroid(shapes[j].points), shapes[i].points)) {
              issues.push(`${c ? c.name : '?'}: two markups overlap (possible double count)${shapes[i].label ? ' in ' + shapes[i].label : ''}.`);
              break;
            }
          }
        const unl = list.filter((m) => !m.label && !m.deduct).length;
        if (unl) issues.push(`${c ? c.name : '?'}: ${unl} markup(s) without a label.`);
      }
      // Conditions measured on this sheet
      const totals = [...byCond.keys()].map((cid) => {
        const c = condition(cid);
        return c ? { condition: c.name, colour: c.color, markups: byCond.get(cid).length } : null;
      }).filter(Boolean);
      return { sheet: sheetName(key), view: area.name, image_px: [img.w, img.h], markups_on_sheet: ms.length, conditions: totals, issues: issues.slice(0, 20), note: 'The image follows: coloured shapes are your markups (dashed = deductions).' };
    }
    case 'get_estimate': {
      const lines = computeLines();
      const sum = estimateSummary(lines, p.settings);
      return {
        lines: lines.map((l) => ({ condition: l.c.name, group: l.c.group || '', priced_by: l.basis, quantity: +l.qty.toFixed(2), with_waste: +l.qtyW.toFixed(2), material: +l.mat.toFixed(2), labor: +l.lab.toFixed(2), total: +l.total.toFixed(2) })),
        material: +sum.mat.toFixed(2),
        labor: +sum.lab.toFixed(2),
        tax: +sum.tax.toFixed(2),
        overhead: +sum.overhead.toFixed(2),
        profit: +sum.profit.toFixed(2),
        bid_total: +sum.total.toFixed(2),
        markups_pct: { tax: p.settings.taxPct, overhead: p.settings.overheadPct, profit: p.settings.profitPct },
      };
    }
    case 'set_markups': {
      commit((pp) => {
        if (args.tax_pct != null) pp.settings.taxPct = +args.tax_pct || 0;
        if (args.overhead_pct != null) pp.settings.overheadPct = +args.overhead_pct || 0;
        if (args.profit_pct != null) pp.settings.profitPct = +args.profit_pct || 0;
      }, 'settings');
      out.changed = true;
      return { ok: true, tax_pct: p.settings.taxPct, overhead_pct: p.settings.overheadPct, profit_pct: p.settings.profitPct };
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

function systemPrompt(vision) {
  return `You are the takeoff assistant built into Gridline, a construction quantity takeoff and estimating app. You work for a professional estimator. You run entirely on their PC.

Rules:
- Do the work with the tools. Keep calling tools until the request is complete; never reply "done" before you have actually made changes or found the answer.
- Use only sheet and condition names that exist (get_overview lists them) or that you just created. Never invent names to test tools.
- Never invent quantities. Report numbers only from tool results, with units (LF, SF, SQ, CY, EA).
- Create a condition before measuring into it. Use clear trade names (e.g. "Fiber cement siding", "Brick veneer", "EIFS", "5/8\\" GWB partition") and a group (CSI division).
- Sheets need a scale before measuring. If a sheet has none, call set_scale with "detect".
- ${vision ? 'Call look_at_sheet to see the drawing whenever text alone is not enough. Image pixels convert to page points with the formula it gives you.' : 'You cannot see images; rely on text and geometry tools.'}

Floor plans: measure rooms with fill_rooms using room labels (or ["all"]). Count tags with count_text; count repeated symbols with count_symbols.

Accuracy first:
- Prefer the geometry tools (find_regions + measure_regions/measure_similar, fill_rooms, count_text, count_symbols). They measure the real linework exactly. Use draw_markup only when a zone is not closed, and say that it is approximate.
- Always pass a label (view or area name) so the estimate shows a detailed breakdown.
- Deduct openings (windows, doors, louvers, storefront) from wall finishes — measure_regions does this automatically.

Exterior elevations and facades (and any sheet of closed shapes):
1. list_views on the sheet to get each elevation's number, title, scale and box. Check the view scale matches the sheet scale.
2. Work out the materials: tags on the elevation (e.g. P-1, BR-1, MP-2, EIFS-1, FC-1) and the finish schedule or legend that defines them (find it with read_sheet_text using contains "SCHEDULE" or "LEGEND", on this sheet or the sheet a note points to).
3. Create one area condition per exterior material, named from the schedule, group "Exterior finishes".
4. For each view, one at a time: find_regions with that view. Assign each zone a material using the tags inside it, its hatch description, and look_at_sheet of the view box when unsure. Measure with measure_regions (or measure_similar for every zone with the same pattern), label "<number> – <view title>". Glazing/storefront zones are openings, not wall finish.
5. Keep going until every view on the sheet is done, then review.

When finished, reply with a plain summary: each condition with its total, then the breakdown by view or label (one line each), the openings deducted, and anything you could not measure so the estimator can check it. No tables.`;
}

// ---------------------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------------------

async function capsFor(model) {
  if (state.caps[model]) return state.caps[model];
  const r = await api.ai.show(model);
  state.caps[model] = r.capabilities || [];
  return state.caps[model];
}

const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/**
 * Some models write tool calls into their text instead of the structured field
 * (e.g. <tool_call>{"name": ..., "arguments": {...}}</tool_call> or a bare JSON object).
 * Recover those so the request still runs.
 */
function recoverToolCalls(text) {
  if (!text) return [];
  const out = [];
  const tryAdd = (raw) => {
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : [j];
      for (const c of list) {
        const name = c.name || (c.function && c.function.name);
        const args = c.arguments || c.parameters || (c.function && c.function.arguments) || {};
        if (name && TOOL_DEFS.some((t) => t.name === name)) out.push({ function: { name, arguments: args } });
      }
    } catch {}
  };
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) tryAdd(m[1]);
  if (!out.length) for (const m of text.matchAll(/```(?:json)?\s*([\[{][\s\S]*?[\]}])\s*```/g)) tryAdd(m[1]);
  if (!out.length) {
    const t = text.trim();
    if (/^[\[{][\s\S]*[\]}]$/.test(t)) tryAdd(t);
  }
  return out;
}

async function ask(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  renderInput();
  const caps = await capsFor(state.model);
  const vision = caps.includes('vision');
  const think = caps.includes('thinking') ? true : undefined;
  addBubble('user', text);
  state.history.push({ role: 'user', content: text });
  const mark = historyMark();
  const thinking = addBubble('pending', 'Thinking…');
  const id = 'chat' + ++state.reqId;
  state.currentId = id;
  state.debug.push({ t: new Date().toISOString(), user: text, model: state.model, caps });
  let finalText = '';
  let actions = 0;
  let changes = 0;
  let nudges = 0;
  let reviewed = false;
  const MAX_STEPS = 60;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Only the newest image stays in context, to keep requests fast.
      let seenImage = false;
      for (let i = state.history.length - 1; i >= 0; i--) {
        if (state.history[i].images) {
          if (seenImage) delete state.history[i].images;
          seenImage = true;
        }
      }
      const res = await api.ai.chat({
        id,
        model: state.model,
        think,
        messages: [{ role: 'system', content: systemPrompt(vision) }, ...state.history.slice(-60)],
        tools: toolSchemas(vision),
      });
      if (res.cancelled) {
        finalText = actions ? 'Stopped. The changes made so far are kept (you can undo them below).' : 'Stopped.';
        break;
      }
      if (res.error) throw new Error(res.error);
      const msg = res.message || {};
      let calls = msg.tool_calls || [];
      const content = stripThink(msg.content);
      if (!calls.length) {
        calls = recoverToolCalls(content);
        if (!calls.length) calls = recoverToolCalls(msg.thinking || '');
      }
      state.debug.push({ step, content: (msg.content || '').slice(0, 2000), thinking: (msg.thinking || '').slice(0, 2000), tool_calls: calls });
      state.history.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) {
        if (content && changes && vision && !reviewed) {
          // Before reporting, make the model check its own markups against the drawing.
          reviewed = true;
          thinking.querySelector('.txt').textContent = 'Checking its work…';
          state.history.push({
            role: 'user',
            content:
              'Before you report: call review_markups for each sheet (and view) you changed. Compare the coloured markups with the drawing. Fix anything wrong — missed zones, zones in the wrong material, double counts, unlabeled markups — using the tools. Then give the final summary: each condition with its total and the breakdown by view/label, plus anything you could not measure.',
          });
          continue;
        }
        if (content) {
          finalText = content;
          break;
        }
        // Empty reply: push the model to continue instead of silently ending.
        if (nudges < 2) {
          nudges++;
          state.history.push({
            role: 'user',
            content: actions
              ? 'Continue the task with the tools until it is complete, then reply with a short summary of what you did and the quantities.'
              : 'You have not done anything yet. Start now: call the tools needed for my request (begin with get_overview if you need names). Do not reply until you have made progress.',
          });
          continue;
        }
        finalText = changes
          ? 'Done — the changes are listed above.'
          : "The model stopped without doing anything. Try a more specific request — name the sheet and the material, e.g. “On A-203, create a condition for each exterior finish in the schedule”. If it keeps happening, use Copy log (top of this panel) and send it to me.";
        break;
      }
      for (const call of calls) {
        const fn = call.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        thinking.querySelector('.txt').textContent = toolLabel(fn.name, args);
        const out = {};
        let result;
        try {
          console.info('[ai] tool start', fn.name);
          const t0 = performance.now();
          result = await runTool(fn.name, args, out);
          console.info('[ai] tool done', fn.name, Math.round(performance.now() - t0) + 'ms');
          addActivity(fn.name, args, result);
        } catch (e) {
          result = { error: String(e.message || e) };
          addActivity(fn.name, args, result, true);
        }
        actions++;
        if (out.changed) changes++;
        state.debug.push({ tool: fn.name, args, result: JSON.stringify(result).slice(0, 1500) });
        state.history.push({ role: 'tool', tool_name: fn.name, name: fn.name, content: JSON.stringify(result) });
        if (out.image) state.history.push({ role: 'user', content: `Image of sheet ${out.image.sheet}:`, images: [out.image.data] });
      }
      thinking.querySelector('.txt').textContent = 'Thinking…';
      if (step === MAX_STEPS - 1) finalText = "I've done a lot of steps, so I'm pausing here — tell me to keep going and I'll continue.";
    }
  } catch (e) {
    finalText = '';
    addBubble('error', friendlyError(e));
    state.debug.push({ error: String(e.message || e) });
    if (!actions) state.history.pop(); // drop the failed turn so a retry starts clean
  }
  thinking.remove();
  const grouped = squashHistory(mark);
  if (finalText) {
    const b = addBubble('assistant', finalText);
    if (grouped) {
      const u = h(`<button class="btn small ai-undo">${icon('refresh', 13)} Undo these changes</button>`);
      u.onclick = () => {
        undo();
        u.disabled = true;
        u.textContent = 'Undone';
        ctx.refresh();
      };
      b.append(u);
    }
  }
  ctx.refresh();
  state.busy = false;
  renderInput();
}

function copyLog() {
  const text = JSON.stringify({ app: 'Gridline', model: state.model, entries: state.debug.slice(-200) }, null, 2);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  toast(ok ? 'Assistant log copied — paste it into a message.' : "Couldn't copy the log.", { kind: ok ? 'ok' : 'err' });
}

function friendlyError(e) {
  const m = String(e.message || e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(m)) return "Couldn't reach Ollama. Make sure it's running (look for the llama icon in the system tray), then try again.";
  if (/not found|pull/i.test(m) && /model/i.test(m)) return `The model "${state.model}" isn't downloaded yet. Open the assistant setup to download it.`;
  if (/does not support tools/i.test(m)) return `"${state.model}" can't use tools. Pick a different model in the assistant's model menu.`;
  return 'The assistant hit a problem: ' + m;
}

function toolLabel(name, a) {
  const s = a && a.sheet ? ` on ${a.sheet}` : '';
  return (
    {
      get_overview: 'Looking at the project…',
      go_to_sheet: `Opening ${a && a.sheet}…`,
      read_sheet_text: `Reading the text${s}…`,
      find_text: `Searching for "${a && a.text}"${s}…`,
      look_at_sheet: `Looking at the drawing${s}…`,
      set_scale: 'Setting scales…',
      create_condition: `Creating "${a && a.name}"…`,
      update_condition: `Updating "${a && a.name}"…`,
      fill_rooms: `Measuring rooms${s}…`,
      count_text: `Counting "${a && a.text}"${s}…`,
      count_symbols: `Counting symbols${s}…`,
      draw_markup: 'Drawing…',
      get_estimate: 'Checking the estimate…',
      list_views: `Finding the views${s}…`,
      find_regions: `Finding zones${a && a.view ? ` in view ${a.view}` : ''}${s}…`,
      measure_regions: `Measuring zones into ${a && a.condition}…`,
      measure_similar: `Measuring matching zones into ${a && a.condition}…`,
      review_markups: `Checking the work${s}…`,
      set_markups: 'Setting markups…',
    }[name] || 'Working…'
  );
}

function activitySummary(name, a, r) {
  if (r.error) return r.error;
  switch (name) {
    case 'fill_rooms': {
      const failed = (r.rooms || []).filter((x) => !x.sf && x.result !== 'already measured').length;
      return `Filled ${r.filled} room${r.filled === 1 ? '' : 's'} on ${r.sheet} into ${r.condition} — ${fmtNum(r.total_sf, 1)} SF${failed ? ` · ${failed} couldn't be closed` : ''}`;
    }
    case 'count_text':
      return `Counted ${r.added} × "${a.text}" on ${r.sheet}`;
    case 'measure_regions':
    case 'measure_similar':
      return `Measured ${r.measured} zone${r.measured === 1 ? '' : 's'} into ${r.condition}${r.label ? ` (${r.label})` : ''} — ${fmtNum(r.net_sf, 1)} SF net`;
    case 'count_symbols':
      return `Counted ${r.added} matching symbols on ${r.sheet}`;
    case 'create_condition':
      return `Created ${r.condition.name} (${r.condition.type})`;
    case 'update_condition':
      return `Updated ${r.condition.name}`;
    case 'set_scale':
      return r.detected_on != null ? `Read the scale on ${r.detected_on} of ${r.of} sheets` : `Set ${r.scale} on ${r.sheets.length} sheet${r.sheets.length === 1 ? '' : 's'}`;
    case 'draw_markup':
      return `Drew a ${r.condition.type} markup`;
    case 'set_markups':
      return `Markups: tax ${r.tax_pct}% · OH ${r.overhead_pct}% · profit ${r.profit_pct}%`;
    default:
      return null; // read-only tools stay quiet
  }
}

// ---------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------

let panel = null;

export async function renderAssistant() {
  panel = $('#aiPanel');
  if (!aiAvailable()) {
    panel.innerHTML = `<div class="insp-empty">${icon('sparkle', 30)}<h3>Assistant</h3><p>The assistant works in the installed Gridline app.</p></div>`;
    return;
  }
  if (!panel.dataset.built) {
    panel.innerHTML = `
      <div class="ai-head">
        <span class="ai-title">${icon('sparkle', 16)} Assistant</span>
        <span class="ai-model" id="aiModel"></span>
        <button class="icon-btn" id="aiLog2" title="Copy log (for troubleshooting)">${icon('copy', 15)}</button>
        <button class="icon-btn" id="aiClear" title="New conversation">${icon('refresh', 15)}</button>
      </div>
      <div class="ai-setup" id="aiSetup" hidden></div>
      <div class="ai-log" id="aiLog"></div>
      <div class="ai-input" id="aiInputWrap">
        <textarea id="aiInput" rows="2" placeholder="Tell me what to take off…"></textarea>
        <button class="btn primary icon-only" id="aiSend" title="Send (Enter)">${icon('send', 16)}</button>
      </div>
      <div class="ai-foot muted small">Runs on this PC with Ollama · nothing leaves your computer</div>`;
    panel.dataset.built = '1';
    const inp = $('#aiInput');
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    $('#aiSend').onclick = () => (state.busy ? stop() : send());
    $('#aiModel').onclick = async (e) => {
      const st = await api.ai.status();
      if (!st.running) return refreshStatus();
      const r = e.currentTarget.getBoundingClientRect();
      const items = [{ head: 'Model (on this PC)' }];
      for (const m of st.models) {
        const caps = await capsFor(m.name);
        const tags = [caps.includes('tools') ? 'tools' : 'no tools', caps.includes('vision') ? 'vision' : ''].filter(Boolean).join(' · ');
        items.push({ label: `${m.name}  —  ${tags}`, current: m.name === state.model, run: () => setModel(m.name) });
      }
      if (!st.models.some((m) => m.name === RECOMMENDED_MODEL)) items.push('-', { label: `Download ${RECOMMENDED_LABEL} (${RECOMMENDED_SIZE})`, icon: 'download', run: () => { $('#aiInputWrap').hidden = true; pullModel(RECOMMENDED_MODEL); refreshStatus(); } });
      contextMenu(r.left - 120, r.bottom + 4, items);
    };
    $('#aiLog2').onclick = copyLog;
    $('#aiClear').onclick = () => {
      if (state.busy) return;
      state.history = [];
      $('#aiLog').innerHTML = '';
      renderEmpty();
    };
    renderEmpty();
  }
  await refreshStatus();
}

function send() {
  const inp = $('#aiInput');
  const t = inp.value;
  if (!t.trim()) return;
  inp.value = '';
  const empty = $('#aiLog .ai-empty');
  if (empty) empty.remove();
  ask(t);
}

function stop() {
  if (state.currentId) api.ai.cancel(state.currentId);
}

function renderInput() {
  const b = $('#aiSend');
  if (!b) return;
  b.innerHTML = state.busy ? icon('x', 16) : icon('send', 16);
  b.title = state.busy ? 'Stop' : 'Send (Enter)';
  b.classList.toggle('stop', state.busy);
}

function renderEmpty() {
  const log = $('#aiLog');
  if (log.children.length) return;
  const ex = [
    'Read the scale on every sheet from the title blocks',
    'Fill every room on this sheet as Carpet tile',
    'Count all the door tags on this sheet',
    'Make a roof condition at 6/12 with architectural shingles at $145 a square',
    'What are my totals so far?',
  ];
  const n = h(`<div class="ai-empty"><p>Tell me what to do and I'll do the clicking. Everything I change is one undo away.</p>${ex.map((x) => `<button class="ai-chip">${esc(x)}</button>`).join('')}</div>`);
  n.querySelectorAll('.ai-chip').forEach(
    (b) =>
      (b.onclick = () => {
        $('#aiInput').value = b.textContent;
        $('#aiInput').focus();
      })
  );
  log.append(n);
}

function md(s) {
  // Minimal formatting: escape, **bold**, line breaks, "- " lists.
  let t = esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = t.split('\n');
  let html = '';
  let inList = false;
  for (const L of lines) {
    const m = L.match(/^\s*[-•*]\s+(.*)/);
    if (m) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${m[1]}</li>`;
    } else {
      if (inList) html += '</ul>';
      inList = false;
      if (L.trim()) html += `<p>${L}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function addBubble(kind, text) {
  const log = $('#aiLog');
  const b = h(`<div class="ai-msg ${kind}">${kind === 'pending' ? `<span class="spin"></span><span class="txt">${esc(text)}</span>` : kind === 'assistant' ? md(text) : `<p>${esc(text)}</p>`}</div>`);
  log.append(b);
  log.scrollTop = log.scrollHeight;
  return b;
}

function addActivity(name, args, result, isErr = false) {
  let s = activitySummary(name, args, result);
  let quiet = false;
  if (!s) {
    s = toolLabel(name, args).replace(/…$/, '');
    quiet = true;
  }
  const log = $('#aiLog');
  const pending = log.querySelector('.ai-msg.pending');
  const n = h(`<div class="ai-act ${isErr || result.error ? 'err' : quiet ? 'quiet' : ''}">${icon(isErr || result.error ? 'x' : quiet ? 'search' : 'layers', 13)}<span>${esc(s)}</span></div>`);
  pending ? log.insertBefore(n, pending) : log.append(n);
  log.scrollTop = log.scrollHeight;
}

async function refreshStatus() {
  const setup = $('#aiSetup');
  const st = await api.ai.status();
  state.status = st;
  const names = st.running ? st.models.map((m) => m.name) : [];
  const has = (n) => names.includes(n) || names.includes(n + ':latest');
  if (st.running && !has(state.model) && names.length && !state.pull) {
    // Selected model missing but others exist: keep the selection; setup offers both paths.
  }
  const ready = st.running && has(state.model);
  $('#aiModel').textContent = ready ? state.model : '';
  $('#aiInputWrap').hidden = !ready;
  $('#aiLog').hidden = !ready;
  setup.hidden = ready;
  if (ready) {
    const caps = await capsFor(state.model);
    if (!caps.includes('tools')) {
      setup.hidden = false;
      setup.innerHTML = `<div class="ai-card warn"><b>${esc(state.model)} can't use tools</b><p>Pick a model that supports tools, or download the recommended one.</p>${modelPicker(st.models)}<button class="btn primary" data-pull>${icon('download', 15)} Download ${RECOMMENDED_LABEL} (${RECOMMENDED_SIZE})</button></div>`;
      wireSetup(setup);
    }
    return;
  }
  if (!st.running) {
    setup.innerHTML = `<div class="ai-card">
      <b>Start Ollama</b>
      <p>The assistant runs on your PC through Ollama. Open <b>Ollama</b> from the Start menu (it sits in the system tray), then retry.</p>
      <div class="row"><button class="btn primary" data-retry>${icon('refresh', 15)} Retry</button><button class="btn" data-get>Get Ollama</button></div></div>`;
  } else {
    const others = st.models.filter((m) => m.name !== state.model);
    setup.innerHTML = `<div class="ai-card">
      <b>One-time setup: download the model</b>
      <p>${RECOMMENDED_LABEL} reads drawings and uses Gridline's tools. It's a ${RECOMMENDED_SIZE} download and runs on your graphics card.</p>
      <div id="aiPullBox"></div>
      <button class="btn primary" data-pull>${icon('download', 15)} Download ${RECOMMENDED_LABEL}</button>
      ${others.length ? `<p class="muted small" style="margin-top:12px">Or use a model you already have:</p>${modelPicker(st.models)}` : ''}
    </div>`;
  }
  wireSetup(setup);
  renderSetupProgress();
}

function modelPicker(models) {
  return `<select class="ai-select" data-pick>${models.map((m) => `<option value="${esc(m.name)}" ${m.name === state.model ? 'selected' : ''}>${esc(m.name)}${m.params ? ` · ${esc(m.params)}` : ''}</option>`).join('')}</select>`;
}

function wireSetup(el) {
  const q = (s) => el.querySelector(s);
  if (q('[data-retry]')) q('[data-retry]').onclick = refreshStatus;
  if (q('[data-get]')) q('[data-get]').onclick = () => api.openExternal('https://ollama.com/download');
  if (q('[data-pick]'))
    q('[data-pick]').onchange = (e) => {
      setModel(e.target.value);
    };
  if (q('[data-pull]')) q('[data-pull]').onclick = () => pullModel(RECOMMENDED_MODEL);
}

export function setModel(name) {
  state.model = name;
  setPref('gridline-ai-model', name);
  refreshStatus();
}

export function currentModel() {
  return state.model;
}

export async function listModels() {
  const st = await api.ai.status();
  return st;
}

async function pullModel(model) {
  if (state.pull) return;
  state.pull = { id: 'pull' + Date.now(), model, pct: 0, status: 'Starting…' };
  renderSetupProgress();
  const r = await api.ai.pull(state.pull.id, model);
  state.pull = null;
  if (r.error) toast(`Download failed: ${r.error}`, { kind: 'err', timeout: 8000 });
  else if (!r.cancelled) {
    toast(`${RECOMMENDED_LABEL} is ready.`, { kind: 'ok' });
    state.model = model;
    setPref('gridline-ai-model', model);
  }
  refreshStatus();
}

function renderSetupProgress() {
  const box = document.getElementById('aiPullBox');
  const btn = document.querySelector('#aiSetup [data-pull]');
  if (!box) return;
  if (!state.pull) {
    box.innerHTML = '';
    if (btn) btn.hidden = false;
    return;
  }
  if (btn) btn.hidden = true;
  box.innerHTML = `<div class="ai-progress"><div class="bar"><i style="width:${state.pull.pct || 0}%"></i></div><span>${esc(state.pull.status || '')}${state.pull.pct ? ` · ${state.pull.pct}%` : ''}</span><button class="btn small ghost" data-cancel>Cancel</button></div>`;
  box.querySelector('[data-cancel]').onclick = () => api.ai.cancel(state.pull.id);
}
