import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTemplate, rotate90 } from '../src/renderer/js/match.js';

// Draw an asymmetric "symbol" (circle with a tick) into a white image at given spots/rotations.
function sheet(W, H, stamps) {
  const img = new Uint8Array(W * H).fill(255);
  const sym = (cx, cy, rot) => {
    for (let a = 0; a < 360; a += 2) {
      const x = Math.round(cx + 6 * Math.cos((a * Math.PI) / 180));
      const y = Math.round(cy + 6 * Math.sin((a * Math.PI) / 180));
      img[y * W + x] = 0;
    }
    for (let i = 0; i < 9; i++)
      for (let k = -1; k <= 1; k++) {
        // heavy tick from the centre outwards, so orientation matters
        const [dx, dy] = [[i, k], [k, i], [-i, k], [k, -i]][rot / 90];
        img[(cy + dy) * W + (cx + dx)] = 0;
      }
  };
  for (const s of stamps) sym(...s);
  return img;
}

test('finds every copy of a symbol, including rotated ones, and ignores other marks', () => {
  const W = 200, H = 120;
  const stamps = [[30, 30, 0], [90, 30, 0], [150, 30, 90], [30, 90, 180], [90, 90, 270]];
  const img = sheet(W, H, stamps);
  // unrelated mark: a square
  for (let i = 140; i < 160; i++) { img[80 * W + i] = 0; img[100 * W + i] = 0; img[i - 60 + 20 * W] = 255; }
  for (let j = 80; j < 100; j++) { img[j * W + 140] = 0; img[j * W + 159] = 0; }
  const tw = 19, th = 19, t = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) t[y * tw + x] = img[(30 - 9 + y) * W + (30 - 9 + x)];
  const found = matchTemplate(img, W, H, { t, w: tw, h: th }, { minScore: 0.7 });
  assert.equal(found.length, 5);
  for (const [cx, cy] of stamps) assert.ok(found.some((f) => Math.hypot(f.x - cx - 0.5, f.y - cy - 0.5) <= 1.5), `missing ${cx},${cy}`);
  const noRot = matchTemplate(img, W, H, { t, w: tw, h: th }, { minScore: 0.7, rotations: false });
  assert.equal(noRot.length, 2);
});

test('rotate90 swaps dimensions', () => {
  const r = rotate90(new Uint8Array([1, 2, 3, 4, 5, 6]), 3, 2);
  assert.equal(r.w, 2);
  assert.equal(r.h, 3);
  assert.deepEqual([...r.t], [4, 1, 5, 2, 6, 3]);
});
