import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLength, formatFeetInches, presetToScale, SCALE_PRESETS } from '../src/renderer/js/units.js';
import { polygonArea, polylineLength, conditionTotals, priceLine, estimateSummary, orthoSnap } from '../src/renderer/js/geometry.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('parses feet-inch strings', () => {
  close(parseLength(`12'-6"`), 12.5);
  close(parseLength(`12' 6 1/2"`), 12 + 6.5 / 12);
  close(parseLength('24.5'), 24.5);
  close(parseLength(`150"`), 12.5);
  close(parseLength(`3/4"`), 0.75 / 12);
  close(parseLength(`10'`), 10);
  close(parseLength('3m', 'm'), 3);
  close(parseLength('450mm', 'm'), 0.45);
  assert.ok(isNaN(parseLength('abc')));
});

test('formats feet-inches to 1/16"', () => {
  assert.equal(formatFeetInches(12.5), `12'-6"`);
  assert.equal(formatFeetInches(12 + 6.5 / 12), `12'-6 1/2"`);
  assert.equal(formatFeetInches(0.0625 / 12), `0'-0 1/16"`);
  assert.equal(formatFeetInches(11.99999), `12'-0"`);
});

test('architectural scale math', () => {
  const quarter = SCALE_PRESETS.find((p) => p.label.startsWith('1/4"'));
  const s = presetToScale(quarter);
  close(s.ptPerUnit, 18); // 1/4" = 18pt per foot
  const eng = presetToScale(SCALE_PRESETS.find((p) => p.label === '1" = 20\''));
  close(eng.ptPerUnit, 3.6);
});

test('area / length in real units', () => {
  // 10ft x 20ft room at 1/4" scale (18 pt/ft)
  const k = 18;
  const pts = [
    [0, 0],
    [10 * k, 0],
    [10 * k, 20 * k],
    [0, 20 * k],
  ];
  close(polygonArea(pts) / (k * k), 200);
  close(polylineLength(pts) / k, 40);
});

test('condition roll-up with waste, depth, height and pricing', () => {
  const k = 18;
  const scaleFor = () => ({ ptPerUnit: k, unit: 'ft' });
  const slab = { id: 'c1', type: 'area', depth: 4, waste: 5, matCost: 150, laborCost: 50, costBasis: 'volume', unit: 'ft' };
  const room = [
    [0, 0],
    [27 * k, 0],
    [27 * k, 10 * k],
    [0, 10 * k],
  ];
  const hole = [
    [0, 0],
    [3 * k, 0],
    [3 * k, 3 * k],
    [0, 3 * k],
  ];
  const markups = [
    { conditionId: 'c1', type: 'area', points: room, pageKey: 'p' },
    { conditionId: 'c1', type: 'area', points: hole, pageKey: 'p', deduct: true },
  ];
  const t = conditionTotals(slab, markups, scaleFor);
  close(t.area, 270 - 9);
  close(t.volume, (261 * (4 / 12)) / 27);
  const line = priceLine(slab, t);
  assert.equal(line.basis, 'volume');
  close(line.qtyW, t.volume * 1.05);
  close(line.total, line.qtyW * 200);

  const wall = { id: 'w', type: 'linear', height: 10, unit: 'ft', costBasis: 'area', matCost: 2 };
  const wt = conditionTotals(wall, [{ conditionId: 'w', type: 'linear', points: [[0, 0], [30 * k, 0]], pageKey: 'p' }], scaleFor);
  close(wt.length, 30);
  close(wt.area, 300);
  close(priceLine(wall, wt).mat, 600);
});

test('unscaled sheets are excluded, counts still work', () => {
  const t = conditionTotals(
    { id: 'c', type: 'count' },
    [
      { conditionId: 'c', type: 'count', points: [[1, 1]], pageKey: 'a' },
      { conditionId: 'c', type: 'count', points: [[2, 2]], pageKey: 'a' },
    ],
    () => null
  );
  assert.equal(t.count, 2);
  const lt = conditionTotals({ id: 'l', type: 'linear' }, [{ conditionId: 'l', type: 'linear', points: [[0, 0], [10, 0]], pageKey: 'a' }], () => null);
  assert.equal(lt.unscaled, 1);
  assert.equal(lt.length, 0);
});

test('estimate summary markups', () => {
  const s = estimateSummary([{ mat: 1000, lab: 500 }], { taxPct: 10, overheadPct: 10, profitPct: 10 });
  close(s.tax, 100);
  close(s.sub, 1600);
  close(s.overhead, 160);
  close(s.profit, 176);
  close(s.total, 1936);
});

test('ortho snap', () => {
  const p = orthoSnap([0, 0], [10, 1]);
  close(p[1], 0);
});

import { parsePitch, slopeFactor, hipFactor, formatPitch } from '../src/renderer/js/units.js';

test('parses roof pitch', () => {
  close(parsePitch('6'), 6);
  close(parsePitch('6/12'), 6);
  close(parsePitch('6:12'), 6);
  close(parsePitch('3 in 4'), 9);
  close(parsePitch('45°'), 12);
  assert.ok(isNaN(parsePitch('steep')));
  assert.equal(formatPitch(6), '6/12');
  close(slopeFactor(12), Math.SQRT2);
  close(slopeFactor(6), 1.118033988749895);
  close(hipFactor(12), Math.sqrt(1.5));
});

test('roof squares from plan area and pitch, with per-plane override and deduction', () => {
  const k = 18;
  const scaleFor = () => ({ ptPerUnit: k, unit: 'ft' });
  const roof = { id: 'r', type: 'roof', pitch: 6, unit: 'ft', waste: 10, matCost: 120 };
  const sq = (w, h) => [[0, 0], [w * k, 0], [w * k, h * k], [0, h * k]];
  const t = conditionTotals(
    roof,
    [
      { conditionId: 'r', type: 'roof', points: sq(40, 30), pageKey: 'p' }, // 1200 SF plan @ 6/12
      { conditionId: 'r', type: 'roof', points: sq(10, 10), pageKey: 'p', pitch: 12 }, // 100 SF plan @ 12/12
      { conditionId: 'r', type: 'roof', points: sq(4, 4), pageKey: 'p', deduct: true }, // skylight
    ],
    scaleFor
  );
  close(t.planArea, 1200 + 100 - 16);
  close(t.area, 1200 * slopeFactor(6) + 100 * Math.SQRT2 - 16 * slopeFactor(6));
  close(t.squares, t.area / 100);
  const line = priceLine(roof, t);
  assert.equal(line.basis, 'squares');
  close(line.mat, t.squares * 1.1 * 120);
});

test('rake and hip lines use true sloped length', () => {
  const k = 18;
  const scaleFor = () => ({ ptPerUnit: k, unit: 'ft' });
  const run = [{ conditionId: 'l', type: 'linear', points: [[0, 0], [20 * k, 0]], pageKey: 'p' }];
  close(conditionTotals({ id: 'l', type: 'linear', roofLine: 'rake', pitch: 12 }, run, scaleFor).length, 20 * Math.SQRT2);
  close(conditionTotals({ id: 'l', type: 'linear', roofLine: 'hip', pitch: 12 }, run, scaleFor).length, 20 * Math.sqrt(1.5));
  close(conditionTotals({ id: 'l', type: 'linear' }, run, scaleFor).length, 20);
});
