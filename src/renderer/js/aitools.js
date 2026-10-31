// Pure helpers that make the assistant precise: argument checking against tool schemas,
// exact arithmetic, reading schedules/tables from sheet text, and "did you mean" suggestions.

// ---------- Argument validation ----------

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * Check args against a JSON-schema-like `schema` (object/properties/required/type/enum/items).
 * Coerces harmless mismatches (numeric strings, single value -> array, "true"/"false").
 * Returns { args, errors: [string] }.
 */
export function validateArgs(schema, input) {
  const errors = [];
  let args = input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return { args: {}, errors: ['Arguments must be a JSON object.'] };
    }
  }
  if (!args || typeOf(args) !== 'object') args = {};
  const out = { ...args };
  const props = (schema && schema.properties) || {};
  for (const req of (schema && schema.required) || []) {
    if (out[req] == null || out[req] === '') errors.push(`Missing required "${req}".`);
  }
  for (const [k, v] of Object.entries(out)) {
    const p = props[k];
    if (!p) continue; // extra keys are ignored
    const fixed = coerce(v, p);
    if (fixed.error) errors.push(`"${k}" ${fixed.error}`);
    else out[k] = fixed.value;
  }
  return { args: out, errors };
}

function coerce(v, p) {
  const t = typeOf(v);
  if (v == null) return { value: v };
  switch (p.type) {
    case 'number': {
      if (t === 'number' && isFinite(v)) return { value: v };
      if (t === 'string' && v.trim() !== '' && isFinite(+v.replace(/[$,]/g, ''))) return { value: +v.replace(/[$,]/g, '') };
      return { error: `should be a number (got ${JSON.stringify(v).slice(0, 40)}).` };
    }
    case 'boolean':
      if (t === 'boolean') return { value: v };
      if (v === 'true' || v === 'false') return { value: v === 'true' };
      return { error: 'should be true or false.' };
    case 'string':
      if (p.enum && !p.enum.includes(String(v))) return { error: `should be one of ${p.enum.join(', ')}.` };
      if (t === 'string') return { value: v };
      if (t === 'number') return { value: String(v) };
      return { error: 'should be text.' };
    case 'array': {
      const arr = t === 'array' ? v : [v];
      if (p.items) {
        const items = [];
        for (const it of arr) {
          const r = coerce(it, p.items);
          if (r.error) return { error: `has an item that ${r.error}` };
          items.push(r.value);
        }
        return { value: items };
      }
      return { value: arr };
    }
    default:
      return { value: v };
  }
}

// ---------- Exact arithmetic ----------

/**
 * Evaluate an arithmetic expression safely (no code execution): + - * / ^ ( ), decimals,
 * thousands separators, percentages ("5%" = 0.05), and feet-inch values like 12'-6".
 */
export function calc(expr) {
  const src = String(expr || '');
  const toks = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)\s*'\s*-?\s*(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?)?\s*"?|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+)(%?)|([-+*/^()]))/y;
  let m;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m || m[0].length === 0) {
      if (/\s/.test(src[i])) {
        i++;
        continue;
      }
      throw new Error(`Unexpected "${src[i]}" in expression`);
    }
    i = re.lastIndex;
    if (m[1] != null) {
      let inches = 0;
      if (m[2]) {
        const [w, f] = m[2].split(/\s+/);
        inches = parseFloat(w) + (f ? eval_frac(f) : 0);
      }
      toks.push({ n: parseFloat(m[1]) + inches / 12 });
    } else if (m[3] != null) toks.push({ n: parseFloat(m[3].replace(/,/g, '')) * (m[4] ? 0.01 : 1) });
    else toks.push({ op: m[5] });
  }
  let p = 0;
  const peek = () => toks[p];
  const expect = (op) => {
    if (!toks[p] || toks[p].op !== op) throw new Error(`Expected "${op}"`);
    p++;
  };
  const primary = () => {
    const t = toks[p++];
    if (!t) throw new Error('Unexpected end of expression');
    if (t.n != null) return t.n;
    if (t.op === '(') {
      const v = sum();
      expect(')');
      return v;
    }
    if (t.op === '-') return -power();
    if (t.op === '+') return power();
    throw new Error(`Unexpected "${t.op}"`);
  };
  const power = () => {
    const b = primary();
    if (peek() && peek().op === '^') {
      p++;
      return Math.pow(b, power());
    }
    return b;
  };
  const product = () => {
    let v = power();
    while (peek() && (peek().op === '*' || peek().op === '/')) {
      const op = toks[p++].op;
      const r = power();
      if (op === '/' && r === 0) throw new Error('Division by zero');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (peek() && (peek().op === '+' || peek().op === '-')) {
      const op = toks[p++].op;
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  if (!toks.length) throw new Error('Empty expression');
  const v = sum();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].op ?? toks[p].n}"`);
  if (!isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

function eval_frac(f) {
  const [a, b] = f.split('/').map(Number);
  return b ? a / b : 0;
}

// ---------- Schedules / tables from positioned text ----------

/**
 * Turn positioned text into table rows. items: [{ str, x, y, w, h }] (top-left origin).
 * title: optional text to anchor on (e.g. "FINISH SCHEDULE"); the table is read below it.
 * Returns { title, columns: [header names], rows: [[cells]], box: [x, y, w, h] } or null.
 */
export function parseSchedule(items, { title = null, maxRows = 200 } = {}) {
  if (!items || !items.length) return null;
  let anchor = null;
  if (title) {
    const t = title.toLowerCase();
    anchor = items
      .filter((it) => it.str.toLowerCase().includes(t))
      .sort((a, b) => b.h - a.h)[0];
    if (!anchor) return null;
  }
  // Candidate region: below the anchor, roughly within its column band.
  const h0 = anchor ? anchor.h : median(items.map((i) => i.h));
  let pool = items;
  if (anchor) {
    pool = items.filter((it) => it !== anchor && it.y > anchor.y + anchor.h * 0.2 && it.x > anchor.x - anchor.h * 30 && it.x < anchor.x + Math.max(anchor.w * 6, anchor.h * 120));
  }
  // Group into lines by baseline.
  const sorted = [...pool].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - it.y) < Math.max(1.5, it.h * 0.45)) L.items.push(it);
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  if (!lines.length) return null;
  // Stop at a big vertical gap (end of the table).
  const rowsLines = [lines[0]];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
  const typical = median(gaps.slice(0, Math.min(gaps.length, 12))) || h0 * 1.6;
  for (let i = 1; i < lines.length && rowsLines.length < maxRows + 1; i++) {
    if (lines[i].y - lines[i - 1].y > Math.max(typical * 3, h0 * 4)) break;
    rowsLines.push(lines[i]);
  }
  // Column starts: cluster left edges of text across rows.
  const xs = [];
  for (const L of rowsLines) {
    L.items.sort((a, b) => a.x - b.x);
    // merge words close together into cells
    const cells = [];
    for (const it of L.items) {
      const c = cells[cells.length - 1];
      if (c && it.x - (c.x + c.w) < Math.max(it.h * 0.9, 3)) {
        c.str += ' ' + it.str;
        c.w = it.x + it.w - c.x;
      } else cells.push({ str: it.str, x: it.x, w: it.w, h: it.h });
    }
    L.cells = cells;
    for (const c of cells) xs.push(c.x);
  }
  xs.sort((a, b) => a - b);
  const cols = [];
  const tol = h0 * 1.2;
  for (const x of xs) {
    const c = cols[cols.length - 1];
    if (c && x - c.max <= tol) {
      c.max = x;
      c.n++;
    } else cols.push({ min: x, max: x, n: 1 });
  }
  const keep = cols.filter((c) => c.n >= Math.max(2, rowsLines.length * 0.2));
  const colStarts = (keep.length ? keep : cols).map((c) => c.min);
  const colOf = (x) => {
    let k = 0;
    for (let i = 0; i < colStarts.length; i++) if (x >= colStarts[i] - tol / 2) k = i;
    return k;
  };
  const table = rowsLines.map((L) => {
    const row = new Array(colStarts.length).fill('');
    for (const c of L.cells) {
      const k = colOf(c.x);
      row[k] = row[k] ? row[k] + ' ' + c.str : c.str;
    }
    return row;
  });
  // Header row: first row that is mostly uppercase words without leading tag-like codes.
  let header = null;
  if (table.length > 1 && table[0].filter(Boolean).length >= Math.min(2, colStarts.length) && table[0].join(' ') === table[0].join(' ').toUpperCase() && !/^[A-Z]{1,4}-?\d/.test(table[0][0])) {
    header = table.shift();
  }
  const allItems = rowsLines.flatMap((L) => L.items);
  const x0 = Math.min(...allItems.map((i) => i.x)),
    x1 = Math.max(...allItems.map((i) => i.x + i.w));
  const y0 = Math.min(...allItems.map((i) => i.y - i.h)),
    y1 = Math.max(...allItems.map((i) => i.y));
  return {
    title: anchor ? anchor.str : null,
    columns: header || colStarts.map((_, i) => `col${i + 1}`),
    rows: table.filter((r) => r.some(Boolean)),
    box: [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)],
  };
}

/** Finish/material tags in text: P-1, BR-1, MP-2, EIFS-1, FC-1A, ACT-2, CPT1, etc. */
export const TAG_RE = /\b([A-Z]{1,5})-?(\d{1,3}[A-Z]?)\b/;

export function normTag(s) {
  const m = String(s || '').toUpperCase().match(TAG_RE);
  return m ? `${m[1]}-${m[2]}` : null;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// ---------- Suggestions ----------

export function editDistance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Closest names to `q` (by containment, then edit distance). */
export function suggest(q, names, n = 3) {
  const ql = String(q || '').toLowerCase();
  return names
    .map((name) => {
      const l = name.toLowerCase();
      const score = l.includes(ql) || ql.includes(l) ? 0 : editDistance(ql, l) / Math.max(ql.length, l.length);
      return { name, score };
    })
    .filter((x) => x.score < 0.6)
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.name);
}
