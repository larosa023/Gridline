// Scales, unit parsing and formatting. All drawing coordinates are PDF points (72 pt = 1 paper inch).

export const PT_PER_IN = 72;

// Preset scales: paper inches that represent `real` units.
export const SCALE_PRESETS = [
  { group: 'Architectural', label: '1/16" = 1\'-0"', paperIn: 1 / 16, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '3/32" = 1\'-0"', paperIn: 3 / 32, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '1/8" = 1\'-0"', paperIn: 1 / 8, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '3/16" = 1\'-0"', paperIn: 3 / 16, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '1/4" = 1\'-0"', paperIn: 1 / 4, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '3/8" = 1\'-0"', paperIn: 3 / 8, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '1/2" = 1\'-0"', paperIn: 1 / 2, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '3/4" = 1\'-0"', paperIn: 3 / 4, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '1" = 1\'-0"', paperIn: 1, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '1-1/2" = 1\'-0"', paperIn: 1.5, real: 1, unit: 'ft' },
  { group: 'Architectural', label: '3" = 1\'-0"', paperIn: 3, real: 1, unit: 'ft' },
  { group: 'Engineering', label: '1" = 10\'', paperIn: 1, real: 10, unit: 'ft' },
  { group: 'Engineering', label: '1" = 20\'', paperIn: 1, real: 20, unit: 'ft' },
  { group: 'Engineering', label: '1" = 30\'', paperIn: 1, real: 30, unit: 'ft' },
  { group: 'Engineering', label: '1" = 40\'', paperIn: 1, real: 40, unit: 'ft' },
  { group: 'Engineering', label: '1" = 50\'', paperIn: 1, real: 50, unit: 'ft' },
  { group: 'Engineering', label: '1" = 60\'', paperIn: 1, real: 60, unit: 'ft' },
  { group: 'Engineering', label: '1" = 100\'', paperIn: 1, real: 100, unit: 'ft' },
  { group: 'Metric', label: '1:50', ratio: 50, unit: 'm' },
  { group: 'Metric', label: '1:100', ratio: 100, unit: 'm' },
  { group: 'Metric', label: '1:200', ratio: 200, unit: 'm' },
  { group: 'Metric', label: '1:500', ratio: 500, unit: 'm' },
];

/** Points per real unit (ft or m) for a preset. */
export function presetToScale(p) {
  if (p.ratio) {
    // 1 m real = 1000/ratio mm paper; 1 mm = 72/25.4 pt
    return { ptPerUnit: (1000 / p.ratio) * (PT_PER_IN / 25.4), unit: 'm', label: p.label };
  }
  return { ptPerUnit: (PT_PER_IN * p.paperIn) / p.real, unit: p.unit, label: p.label };
}

/**
 * Parse a length typed by a user. Accepts: 12'-6", 12' 6 1/2", 12.5, 12.5', 150", 6 1/2", 3.2m, 450mm.
 * Returns value in the given base unit ('ft' or 'm'), or NaN.
 */
export function parseLength(input, unit = 'ft') {
  if (input == null) return NaN;
  let s = String(input).trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/\s+/g, ' ');
  if (!s) return NaN;

  const metric = s.match(/^(-?\d*\.?\d+)\s*(mm|cm|m)$/);
  if (metric) {
    const v = parseFloat(metric[1]);
    const m = metric[2] === 'mm' ? v / 1000 : metric[2] === 'cm' ? v / 100 : v;
    return unit === 'm' ? m : m / 0.3048;
  }

  const num = (t) => {
    t = t.trim();
    if (!t) return 0;
    // "6 1/2", "1/2", "6.25"
    const mixed = t.match(/^(\d+(?:\.\d+)?)?\s*(?:(\d+)\/(\d+))?$/);
    if (!mixed || (mixed[1] == null && mixed[2] == null)) return NaN;
    let v = mixed[1] ? parseFloat(mixed[1]) : 0;
    if (mixed[2]) v += parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
    return v;
  };

  let feet = 0;
  let inches = 0;
  const hasFt = s.includes("'");
  const hasIn = s.includes('"');
  if (hasFt) {
    const [ftPart, rest] = s.split("'");
    feet = num(ftPart);
    const inPart = rest.replace(/^[\s-]+/, '').replace(/"$/, '');
    inches = inPart ? num(inPart) : 0;
  } else if (hasIn) {
    inches = num(s.replace(/"$/, ''));
  } else {
    // Bare number = base unit
    const v = num(s);
    return v;
  }
  if (isNaN(feet) || isNaN(inches)) return NaN;
  const ft = feet + inches / 12;
  return unit === 'm' ? ft * 0.3048 : ft;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/** 12.541 ft -> 12'-6 1/2" (rounded to 1/16"). */
export function formatFeetInches(ft) {
  if (!isFinite(ft)) return '—';
  const neg = ft < 0;
  let totalSixteenths = Math.round(Math.abs(ft) * 12 * 16);
  const feet = Math.floor(totalSixteenths / (12 * 16));
  totalSixteenths -= feet * 12 * 16;
  const inches = Math.floor(totalSixteenths / 16);
  let frac = totalSixteenths - inches * 16;
  let fracStr = '';
  if (frac) {
    const g = gcd(frac, 16);
    fracStr = ` ${frac / g}/${16 / g}`;
  }
  return `${neg ? '-' : ''}${feet}'-${inches}${fracStr}"`;
}

export function fmtNum(v, digits = 2) {
  if (!isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(v) {
  if (!isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Display a length in the page's unit. */
export function fmtLength(v, unit, style = 'ftin') {
  if (unit === 'm') return `${fmtNum(v, 2)} m`;
  return style === 'ftin' ? formatFeetInches(v) : `${fmtNum(v, 2)} LF`;
}

/**
 * Roof pitch as rise per 12 of run. Accepts "6", "6/12", "6:12", "6 in 12", "26.57°", "26.57deg".
 * Returns NaN when unreadable.
 */
export function parsePitch(input) {
  if (input == null) return NaN;
  const s = String(input).trim().toLowerCase();
  if (!s) return NaN;
  const deg = s.match(/^(\d*\.?\d+)\s*(°|deg|degrees?)$/);
  if (deg) {
    const a = parseFloat(deg[1]);
    if (a < 0 || a >= 90) return NaN;
    return 12 * Math.tan((a * Math.PI) / 180);
  }
  const ratio = s.match(/^(\d*\.?\d+)\s*(?:\/|:|in)\s*(\d*\.?\d+)$/);
  if (ratio) {
    const run = parseFloat(ratio[2]);
    return run ? (parseFloat(ratio[1]) * 12) / run : NaN;
  }
  const v = Number(s);
  return isFinite(v) && v >= 0 ? v : NaN;
}

export function formatPitch(rise) {
  if (!isFinite(rise)) return '—';
  const r = Math.round(rise * 100) / 100;
  return `${r}/12`;
}

/** Sloped surface / common rafter multiplier for a pitch (rise per 12). */
export const slopeFactor = (rise) => Math.sqrt(1 + (rise / 12) ** 2);
/** Hip / valley multiplier on an equal-pitch roof, applied to the hip's plan length. */
export const hipFactor = (rise) => Math.sqrt(1 + (rise * rise) / 288);

export const UNIT_LABELS = {
  ft: { length: 'LF', area: 'SF', volume: 'CY', count: 'EA' },
  m: { length: 'm', area: 'm²', volume: 'm³', count: 'EA' },
};
