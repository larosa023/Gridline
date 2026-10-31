import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSheets } from '../src/renderer/js/compare.js';

test('added, removed and unchanged ink; 1px shifts are not changes', () => {
  const W = 40, H = 20;
  const A = new Uint8Array(W * H).fill(255), B = new Uint8Array(W * H).fill(255);
  for (let x = 2; x < 38; x++) { A[5 * W + x] = 0; B[6 * W + x] = 0; } // same wall, 1px shifted
  for (let x = 2; x < 12; x++) A[12 * W + x] = 0; // removed
  for (let x = 20; x < 30; x++) B[15 * W + x] = 0; // added
  const r = compareSheets(A, B, W, H);
  assert.equal(r.removed, 10);
  assert.equal(r.added, 10);
  assert.ok(r.same >= 36);
});
