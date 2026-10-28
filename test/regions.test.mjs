import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelRegions, findHoles } from '../src/renderer/js/regions.js';
import { traceFrom, simplifyRing } from '../src/renderer/js/fill.js';
import { polygonArea } from '../src/renderer/js/geometry.js';

function draw(w, h, rects, lines = []) {
  const m = new Uint8Array(w * h);
  const set = (x, y) => (m[y * w + x] = 1);
  for (const [x0, y0, x1, y1] of rects) {
    for (let x = x0; x <= x1; x++) set(x, y0), set(x, y1);
    for (let y = y0; y <= y1; y++) set(x0, y), set(x1, y);
  }
  for (const [x0, y0, x1, y1] of lines) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y);
  return m;
}

test('labels every closed zone and flags the open outside', () => {
  const w = 100, h = 60;
  // facade 10..89 x 10..49 split into two zones at x=50, with a window 20..30 x 20..35 in the left zone
  const m = draw(w, h, [[10, 10, 89, 49], [20, 20, 30, 35]], [[50, 10, 50, 49]]);
  const { regions } = labelRegions(m, w, h, [0, 0, w, h]);
  const closed = regions.filter((r) => !r.open);
  assert.equal(regions.filter((r) => r.open).length, 1);
  assert.equal(closed.length, 3); // left zone, right zone, window glass
  const right = closed.find((r) => r.minx === 51);
  assert.equal(right.count, 38 * 38);
});

test('openings inside a zone are found; stray lines are not openings', () => {
  const w = 100, h = 60;
  const m = draw(w, h, [[10, 10, 89, 49], [20, 20, 30, 35]], [[60, 25, 75, 25]]); // window + a stray leader line
  const { labels, regions } = labelRegions(m, w, h, [0, 0, w, h]);
  const zone = regions.find((r) => !r.open && r.minx === 11);
  const H = findHoles(labels, w, zone.id, [zone.minx, zone.miny, zone.maxx, zone.maxy], m);
  const real = H.holes.filter((x) => x.solid >= x.count * 0.5);
  assert.equal(H.holes.length, 2);
  assert.equal(real.length, 1);
  // Window hole includes its frame: 11 x 16 px
  assert.equal(real[0].count, 11 * 16);
  // Outer outline of the zone is the full facade interior
  const at = (x, y) => labels[y * w + x] === zone.id;
  const ring = simplifyRing(traceFrom(at, w, h, zone.start), 0.5);
  assert.equal(polygonArea(ring), 78 * 38);
});

import { SnapIndex } from '../src/renderer/js/snap.js';
import { hatchFlags } from '../src/renderer/js/fill.js';

test('hatch detection: coursing lines are hatch, the zone outline is not', () => {
  const idx = new SnapIndex();
  // zone outline 0..200 x 0..100
  idx.add(0, 0, 200, 0); idx.add(200, 0, 200, 100); idx.add(200, 100, 0, 100); idx.add(0, 100, 0, 0);
  // brick coursing every 2pt inside
  for (let y = 4; y < 100; y += 2) idx.add(2, y, 198, y);
  // a single mullion line far from anything parallel
  idx.add(100, 0, 100, 100);
  // light gray detail line
  idx.add(20, 20, 60, 60, 0.2, 200);
  const f = hatchFlags(idx);
  assert.equal(f[0], 0); // top outline: coursing only on one side
  assert.equal(f[1], 0); // right edge
  assert.equal(f[2], 0); // bottom outline
  assert.equal(f[3], 0); // left edge
  const coursing = [...f.slice(4, 4 + 48)];
  assert.ok(coursing.every((v) => v === 1));
  assert.equal(f[4 + 48], 0); // mullion
  assert.equal(f[4 + 49], 1); // light gray
});

test('a boundary between two different hatch patterns is kept', () => {
  const idx = new SnapIndex();
  idx.add(0, 50, 200, 50); // boundary between zones
  for (let y = 2; y < 50; y += 2) idx.add(0, y, 200, y); // fine coursing above (2pt)
  for (let y = 56; y < 100; y += 6) idx.add(0, y, 200, y); // wider laps below (6pt)
  const f = hatchFlags(idx);
  assert.equal(f[0], 0);
  assert.equal(f[5], 1); // a coursing line
  assert.equal(f[idx.n - 2], 1); // a lap line
});
