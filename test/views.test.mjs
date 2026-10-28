import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectViews } from '../src/renderer/js/views.js';

const T = (str, x, y, h = 10, w = str.length * 6) => ({ str, x, y, w, h });

test('finds stacked elevation views with numbers, titles, scales and boxes', () => {
  const items = [
    T('1', 40, 300), T('PROPOSED PARTIAL FRONT ELEVATION', 60, 300), T('SCALE: 1/8" = 1\'-0"', 60, 312, 5),
    T('2', 40, 600), T('PROPOSED PARTIAL FRONT ELEVATION', 60, 600), T('SCALE: 1/8" = 1\'-0"', 60, 612, 5),
    T('3', 40, 900), T('REAR ELEVATION', 60, 900), T('SCALE: 3/16" = 1\'-0"', 60, 912, 5),
    T('BR-1', 300, 150, 6), T('NOTE: REFER TO A-701 FOR FINISHES', 900, 950, 5),
    T('FINISHES ENLARGED ELEVATIONS', 1500, 1050, 10), // title block, right of frame
  ];
  const v = detectViews(items, 1800, 1100, 1400);
  assert.equal(v.length, 3);
  assert.deepEqual(v.map((x) => x.number), ['1', '2', '3']);
  assert.equal(v[0].scale, '1/8" = 1\'-0"');
  assert.equal(v[2].scale, '3/16" = 1\'-0"');
  assert.equal(v[0].box[1], 0);
  assert.ok(v[1].box[1] > 300 && v[1].box[1] < 340); // starts under view 1's title
  assert.ok(v[0].box[0] + v[0].box[2] <= 1400);
});

test('side-by-side views split the row', () => {
  const items = [T('1', 40, 500), T('NORTH ELEVATION', 60, 500), T('2', 700, 500), T('SOUTH ELEVATION', 720, 500)];
  const v = detectViews(items, 1800, 1100, 1400);
  assert.equal(v.length, 2);
  assert.ok(v[0].box[0] + v[0].box[2] <= 720);
  assert.ok(v[1].box[0] >= 600);
});
