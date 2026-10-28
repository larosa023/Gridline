import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodRegion, traceOuter, simplifyRing } from '../src/renderer/js/fill.js';
import { polygonArea } from '../src/renderer/js/geometry.js';

function room(w, h, walls) {
  const m = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of walls) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
  return m;
}

test('fills a closed room and traces its exact outline', () => {
  const w = 60, h = 40;
  // Outer box walls 1px thick at x=5..54, y=5..34
  const m = room(w, h, [[5, 5, 54, 5], [5, 34, 54, 34], [5, 5, 5, 34], [54, 5, 54, 34]]);
  const r = floodRegion(m, w, h, 20, 20);
  assert.ok(!r.error);
  assert.equal(r.count, 48 * 28);
  const ring = simplifyRing(traceOuter(r.fill, w, h), 0.5);
  assert.equal(ring.length, 4);
  assert.equal(polygonArea(ring), 48 * 28);
});

test('L-shaped room keeps 6 corners; furniture inside does not reduce the outline', () => {
  const w = 60, h = 60;
  const walls = [[5, 5, 30, 5], [30, 5, 30, 30], [30, 30, 55, 30], [55, 30, 55, 55], [5, 55, 55, 55], [5, 5, 5, 55], [12, 40, 18, 46]];
  const m = room(w, h, walls);
  const r = floodRegion(m, w, h, 10, 10);
  assert.ok(!r.error);
  const ring = simplifyRing(traceOuter(r.fill, w, h), 0.5);
  assert.equal(ring.length, 6);
  // Interior of the L: upper arm 24x25 px + lower band 49x24 px (inside the 1px walls)
  assert.equal(polygonArea(ring), 24 * 25 + 49 * 24);
});

test('a gap in the walls is reported as a leak', () => {
  const w = 60, h = 40;
  const m = room(w, h, [[5, 5, 54, 5], [5, 34, 54, 34], [5, 5, 5, 34], [54, 5, 54, 20]]); // right wall open below y=20
  assert.equal(floodRegion(m, w, h, 20, 20).error, 'leak');
});

test('clicking on a wall line steps into the room', () => {
  const w = 60, h = 60; // room is a small part of the sheet, like a real plan
  const m = room(w, h, [[2, 2, 27, 2], [2, 27, 27, 27], [2, 2, 2, 27], [27, 2, 27, 27]]);
  const r = floodRegion(m, w, h, 2, 15);
  assert.ok(!r.error);
  assert.equal(r.count, 24 * 24);
});
