// App themes, accent colours, and how drawings are displayed (normal / dark / blueprint / low glare).
// Drawing modes are GPU colour filters on the sheet image only — the PDF, measurements,
// markups and anything sent to the assistant are untouched.

export const THEMES = [
  { id: 'dark', name: 'Dark', base: 'dark', swatch: ['#161a20', '#0e1114'] },
  { id: 'midnight', name: 'Midnight', base: 'dark', swatch: ['#0b0d10', '#000000'] },
  { id: 'slate', name: 'Slate', base: 'dark', swatch: ['#1f2937', '#111827'] },
  { id: 'light', name: 'Light', base: 'light', swatch: ['#ffffff', '#eef0f3'] },
  { id: 'paper', name: 'Paper', base: 'light', swatch: ['#fbf8f2', '#efe9dd'] },
  { id: 'contrast', name: 'High contrast', base: 'dark', swatch: ['#000000', '#000000'] },
];

export const ACCENTS = [
  { id: 'orange', name: 'Safety orange', c: '#ff8a24' },
  { id: 'blue', name: 'Blue', c: '#3b9eff' },
  { id: 'green', name: 'Green', c: '#2fbf71' },
  { id: 'teal', name: 'Teal', c: '#14b8a6' },
  { id: 'violet', name: 'Violet', c: '#a879ff' },
  { id: 'red', name: 'Red', c: '#f05252' },
  { id: 'yellow', name: 'Yellow', c: '#f5c400' },
  { id: 'pink', name: 'Pink', c: '#ff5fa2' },
];

export const DRAWING_MODES = [
  { id: 'normal', name: 'Normal', hint: 'As printed' },
  { id: 'dark', name: 'Dark', hint: 'Dark paper, light linework; colours keep their hue' },
  { id: 'blueprint', name: 'Blueprint', hint: 'White linework on blue' },
  { id: 'dim', name: 'Low glare', hint: 'Warm, dimmed paper' },
];

// Paper colour each mode turns white into (also used behind the sheet while it renders).
const PAPER = { normal: '#ffffff', dark: '#1b1f25', blueprint: '#0e2a4f', dim: '#d9d3c6' };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function mix(a, b, t) {
  const A = hex(a),
    B = hex(b);
  return '#' + A.map((v, i) => Math.round((v + (B[i] - v) * t) * 255).toString(16).padStart(2, '0')).join('');
}

function luminance(h) {
  const [r, g, b] = hex(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * SVG filters for the drawing modes. `boost` (0..1) lifts faint linework so light-gray
 * hatching and small text stay readable after inversion.
 */
export function drawingFilterSvg(boost = 0.35) {
  const [dr, dg, db] = hex(PAPER.dark);
  const ink = hex('#eef1f4');
  const [br, bg, bb] = hex(PAPER.blueprint);
  const bInk = hex('#e9f3ff');
  const [mr, mg, mb] = hex(PAPER.dim);
  const g = (1 - 0.6 * boost).toFixed(3); // gamma exponent < 1 lifts faint ink
  const lin = (lo, hi) => `type="gamma" amplitude="${(hi - lo).toFixed(4)}" exponent="${g}" offset="${lo.toFixed(4)}"`;
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <filter id="gl-dark" color-interpolation-filters="sRGB">
    <feComponentTransfer><feFuncR type="linear" slope="-1" intercept="1"/><feFuncG type="linear" slope="-1" intercept="1"/><feFuncB type="linear" slope="-1" intercept="1"/></feComponentTransfer>
    <feColorMatrix type="hueRotate" values="180"/>
    <feComponentTransfer><feFuncR ${lin(dr, ink[0])}/><feFuncG ${lin(dg, ink[1])}/><feFuncB ${lin(db, ink[2])}/></feComponentTransfer>
  </filter>
  <filter id="gl-blueprint" color-interpolation-filters="sRGB">
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncR type="linear" slope="-1" intercept="1"/><feFuncG type="linear" slope="-1" intercept="1"/><feFuncB type="linear" slope="-1" intercept="1"/></feComponentTransfer>
    <feComponentTransfer><feFuncR ${lin(br, bInk[0])}/><feFuncG ${lin(bg, bInk[1])}/><feFuncB ${lin(bb, bInk[2])}/></feComponentTransfer>
  </filter>
  <filter id="gl-dim" color-interpolation-filters="sRGB">
    <feComponentTransfer><feFuncR type="linear" slope="${mr.toFixed(4)}"/><feFuncG type="linear" slope="${mg.toFixed(4)}"/><feFuncB type="linear" slope="${mb.toFixed(4)}"/></feComponentTransfer>
  </filter>
</defs></svg>`;
}

let state = { theme: 'dark', accent: 'orange', drawing: 'normal', boost: 0.35, system: false };
const listeners = new Set();
const media = window.matchMedia('(prefers-color-scheme: dark)');

const load = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v;
  } catch {
    return d;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

export function initAppearance() {
  let theme = load('gridline-theme', 'dark');
  const system = theme === 'system';
  if (!THEMES.some((t) => t.id === theme) && !system) theme = 'dark';
  state = {
    theme: system ? (media.matches ? 'dark' : 'light') : theme,
    system,
    accent: load('gridline-accent', 'orange'),
    drawing: load('gridline-drawing', 'normal'),
    boost: +load('gridline-drawing-boost', '0.35'),
  };
  // Filters live once in the document.
  const holder = document.createElement('div');
  holder.id = 'drawingFilters';
  holder.innerHTML = drawingFilterSvg(state.boost);
  document.body.append(holder);
  media.addEventListener('change', () => state.system && set({ theme: media.matches ? 'dark' : 'light' }, false));
  apply();
}

export const appearance = () => ({ ...state });
export const onAppearance = (fn) => listeners.add(fn);

export function set(next, persist = true) {
  if (next.system === true) next.theme = media.matches ? 'dark' : 'light';
  state = { ...state, ...next };
  if (persist) {
    save('gridline-theme', state.system ? 'system' : state.theme);
    save('gridline-accent', state.accent);
    save('gridline-drawing', state.drawing);
    save('gridline-drawing-boost', String(state.boost));
  }
  if ('boost' in next) {
    const h = document.getElementById('drawingFilters');
    if (h) h.innerHTML = drawingFilterSvg(state.boost);
  }
  apply();
}

function apply() {
  const root = document.documentElement;
  const t = THEMES.find((x) => x.id === state.theme) || THEMES[0];
  root.dataset.theme = t.id;
  root.dataset.base = t.base;
  // Accent colour and its derived tones
  const a = (ACCENTS.find((x) => x.id === state.accent) || ACCENTS[0]).c;
  const dark = t.base === 'dark';
  const accent = t.id === 'contrast' ? mix(a, '#ffffff', 0.15) : dark ? a : mix(a, '#000000', 0.12);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-2', mix(accent, '#ffffff', 0.2));
  root.style.setProperty('--accent-ink', luminance(accent) > 0.42 ? '#141007' : '#ffffff');
  root.style.setProperty('--accent-soft', accent + (dark ? '24' : '1a'));
  root.style.setProperty('--focus', `0 0 0 2px ${accent}73`);
  // Drawing display
  const mode = DRAWING_MODES.some((m) => m.id === state.drawing) ? state.drawing : 'normal';
  root.dataset.drawing = mode;
  root.style.setProperty('--paper', PAPER[mode]);
  root.style.setProperty('--drawing-filter', mode === 'normal' ? 'none' : `url(#gl-${mode})`);
  // Markup label halos: light on light paper, dark on dark paper
  root.style.setProperty('--label-halo', mode === 'dark' || mode === 'blueprint' ? '#0b0d10' : '#ffffff');
  for (const fn of listeners) fn(state);
}

export function cycleBase() {
  const t = THEMES.find((x) => x.id === state.theme) || THEMES[0];
  set({ theme: t.base === 'dark' ? 'light' : 'dark', system: false });
}

export function toggleDarkDrawings() {
  set({ drawing: state.drawing === 'normal' ? 'dark' : 'normal' });
}
