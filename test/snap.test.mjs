import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapIndex, findSnap } from '../src/renderer/js/snap.js';

test('snaps to endpoints, intersections, then nearest point on a line', () => {
  const idx = new SnapIndex();
  idx.add(0, 0, 100, 0); // horizontal
  idx.add(50, -50, 50, 50); // vertical crossing at (50,0)
  idx.add(200, 200, 300, 260); // diagonal

  let s = findSnap(idx, [98, 3], 8);
  assert.equal(s.kind, 'endpoint');
  assert.deepEqual(s.point.map(Math.round), [100, 0]);

  s = findSnap(idx, [52, 2], 8);
  assert.equal(s.kind, 'intersection');
  assert.deepEqual(s.point.map((v) => Math.round(v * 1000) / 1000), [50, 0]);

  s = findSnap(idx, [75, 4], 8);
  assert.equal(s.kind, 'line');
  assert.ok(Math.abs(s.point[1]) < 1e-6 && Math.abs(s.point[0] - 75) < 1e-6);

  assert.equal(findSnap(idx, [150, 120], 8), null);
  s = findSnap(idx, [251, 228], 8);
  assert.equal(s.kind, 'line');
});

test('existing markup vertices count as endpoints', () => {
  const s = findSnap(new SnapIndex(), [10, 11], 5, [[10, 10]]);
  assert.equal(s.kind, 'endpoint');
});

test('long diagonal lines are findable anywhere along them', () => {
  const idx = new SnapIndex();
  idx.add(0, 0, 5000, 3000);
  const s = findSnap(idx, [2500, 1503], 8);
  assert.equal(s.kind, 'line');
});

test('packed (frozen) index finds the same segments', () => {
  const a = new SnapIndex();
  const b = new SnapIndex();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2000;
  for (let i = 0; i < 3000; i++) {
    const s = [rnd(), rnd(), rnd() / 10 + 5, rnd() / 10 + 5];
    a.add(s[0], s[1], s[0] + s[2], s[1] + s[3]);
    b.add(s[0], s[1], s[0] + s[2], s[1] + s[3]);
  }
  b.freeze();
  for (let i = 0; i < 200; i++) {
    const p = [rnd(), rnd()];
    assert.deepEqual([...b.near(p, 30)].sort((x, y) => x - y), [...a.near(p, 30)].sort((x, y) => x - y));
    const sa = findSnap(a, p, 12);
    const sb = findSnap(b, p, 12);
    assert.deepEqual(sb && sb.point, sa && sa.point);
  }
});
