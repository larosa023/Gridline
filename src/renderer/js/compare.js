// Revision compare: overlay two sheets. Ink only on the old sheet = red (removed),
// only on the new sheet = blue (added), on both = gray (unchanged).

/** Pure pixel diff (exported for tests). a, b: Uint8Array gray (same size). Returns RGBA + counts. */
export const COMPARE_LIGHT = { bg: [255, 255, 255], same: [120, 120, 120], removed: [225, 45, 45], added: [30, 110, 245] };
export const COMPARE_DARK = { bg: [27, 31, 37], same: [150, 156, 164], removed: [255, 95, 95], added: [90, 165, 255] };

export function diffImages(a, b, W, H, threshold = 170, pal = COMPARE_LIGHT) {
  const out = new Uint8ClampedArray(W * H * 4);
  let added = 0,
    removed = 0,
    same = 0;
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    const da = a[i] < threshold,
      db = b[i] < threshold;
    const c = da && db ? pal.same : da ? pal.removed : db ? pal.added : pal.bg;
    if (da && db) same++;
    else if (da) removed++;
    else if (db) added++;
    out[j] = c[0];
    out[j + 1] = c[1];
    out[j + 2] = c[2];
    out[j + 3] = 255;
  }
  return { rgba: out, added, removed, same };
}

/** Thicken ink by one pixel so tiny render offsets don't show as changes. */
export function dilate(img, W, H, threshold = 170) {
  const out = new Uint8Array(img);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (img[i] < threshold) continue;
      if (img[i - 1] < threshold || img[i + 1] < threshold || img[i - W] < threshold || img[i + W] < threshold) out[i] = threshold - 1;
    }
  return out;
}

/**
 * Changes are only "real" where the other sheet has no ink nearby: compare each sheet's ink
 * against the other sheet thickened by a pixel.
 */
export function compareSheets(oldImg, newImg, W, H, pal = COMPARE_LIGHT) {
  const oldD = dilate(oldImg, W, H),
    newD = dilate(newImg, W, H);
  const a = new Uint8Array(W * H),
    b = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = oldImg[i] < 170,
      n = newImg[i] < 170;
    // ink in old that has new ink nearby counts as unchanged (and vice versa)
    a[i] = o ? 0 : 255;
    b[i] = n ? 0 : 255;
    if (o && !n && newD[i] < 170) b[i] = 0;
    if (n && !o && oldD[i] < 170) a[i] = 0;
  }
  return diffImages(a, b, W, H, 170, pal);
}
