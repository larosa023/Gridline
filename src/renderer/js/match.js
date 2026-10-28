// Symbol matching: normalized cross-correlation of a template against a grayscale sheet image.
// Most of a drawing is blank paper, so cheap filters (ink amount, contrast, a sparse sample of
// the template) skip almost every position before the full correlation runs.

function integral(img, W, H) {
  const S = new Float64Array((W + 1) * (H + 1));
  const S2 = new Float64Array((W + 1) * (H + 1));
  const INK = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0,
      rs2 = 0,
      ri = 0;
    for (let x = 0; x < W; x++) {
      const v = img[y * W + x];
      rs += v;
      rs2 += v * v;
      ri += v < 140 ? 1 : 0;
      const k = (y + 1) * (W + 1) + (x + 1);
      S[k] = S[k - (W + 1)] + rs;
      S2[k] = S2[k - (W + 1)] + rs2;
      INK[k] = INK[k - (W + 1)] + ri;
    }
  }
  return { S, S2, INK };
}

const boxSum = (A, W1, x, y, w, h) => A[(y + h) * W1 + (x + w)] - A[y * W1 + (x + w)] - A[(y + h) * W1 + x] + A[y * W1 + x];

export function rotate90(t, w, h) {
  const out = new Uint8Array(w * h);
  // (x, y) -> (h-1-y, x); new width = h, height = w
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = t[y * w + x];
  return { t: out, w: h, h: w };
}

/**
 * Find template matches. img: Uint8Array gray (0 black .. 255 white), W × H.
 * tpl: { t, w, h }. Returns [{ x, y, score, rot }] with (x, y) the match centre in pixels.
 */
export function matchTemplate(img, W, H, tpl, { minScore = 0.55, rotations = true, onProgress } = {}) {
  const ii = integral(img, W, H);
  const W1 = W + 1;
  const variants = [{ ...tpl, rot: 0 }];
  if (rotations) {
    let cur = tpl;
    for (const rot of [90, 180, 270]) {
      cur = rotate90(cur.t, cur.w, cur.h);
      variants.push({ ...cur, rot });
    }
  }
  const all = [];
  variants.forEach((v, vi) => {
    const n = v.w * v.h;
    let st = 0,
      st2 = 0,
      ink = 0;
    for (let i = 0; i < n; i++) {
      st += v.t[i];
      st2 += v.t[i] * v.t[i];
      if (v.t[i] < 140) ink++;
    }
    const mt = st / n;
    const sdt = Math.sqrt(Math.max(0, st2 / n - mt * mt));
    if (sdt < 8 || ink < 3) return; // blank template
    // Sparse sample: the darkest and the lightest template pixels in equal measure, so the
    // quick test can tell ink from paper (a sample of only ink pixels has no contrast).
    const asc = [...Array(n).keys()].sort((a, b) => v.t[a] - v.t[b]);
    const half = Math.min(32, Math.floor(n / 2));
    const order = asc.slice(0, half).concat(asc.slice(n - half));
    const K = order.length;
    const sx = new Int32Array(K),
      sy = new Int32Array(K),
      sv = new Float64Array(K);
    let svm = 0;
    for (let k = 0; k < K; k++) {
      sx[k] = order[k] % v.w;
      sy[k] = (order[k] / v.w) | 0;
      sv[k] = v.t[order[k]];
      svm += sv[k];
    }
    svm /= K;
    let svd = 0;
    for (let k = 0; k < K; k++) svd += (sv[k] - svm) ** 2;
    svd = Math.sqrt(svd);

    const inkLo = ink * 0.55,
      inkHi = ink * 1.7;
    for (let y = 0; y + v.h <= H; y++) {
      if (onProgress && y % 64 === 0) onProgress((vi + y / (H - v.h + 1)) / variants.length);
      for (let x = 0; x + v.w <= W; x++) {
        const wi = boxSum(ii.INK, W1, x, y, v.w, v.h);
        if (wi < inkLo || wi > inkHi) continue;
        const s = boxSum(ii.S, W1, x, y, v.w, v.h);
        const s2 = boxSum(ii.S2, W1, x, y, v.w, v.h);
        const mw = s / n;
        const varw = s2 / n - mw * mw;
        if (varw < (sdt * 0.4) ** 2) continue;
        // Quick correlation over the sample
        let a = 0,
          a2 = 0,
          at = 0;
        for (let k = 0; k < K; k++) {
          const iv = img[(y + sy[k]) * W + (x + sx[k])];
          a += iv;
          a2 += iv * iv;
          at += iv * (sv[k] - svm);
        }
        const am = a / K;
        const ad = Math.sqrt(Math.max(1e-9, a2 - K * am * am));
        if (at / (ad * svd + 1e-9) < minScore * 0.85) continue;
        // Full NCC
        let sum = 0;
        for (let ty = 0; ty < v.h; ty++) {
          const row = (y + ty) * W + x;
          const trow = ty * v.w;
          for (let tx = 0; tx < v.w; tx++) sum += img[row + tx] * v.t[trow + tx];
        }
        const ncc = (sum - n * mw * mt) / (n * Math.sqrt(varw) * sdt + 1e-9);
        if (ncc >= minScore) all.push({ x: x + v.w / 2, y: y + v.h / 2, score: ncc, rot: v.rot });
      }
    }
  });
  // Non-maximum suppression
  all.sort((a, b) => b.score - a.score);
  const r = Math.max(tpl.w, tpl.h) * 0.6;
  const kept = [];
  for (const c of all) if (!kept.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < r)) kept.push(c);
  return kept;
}
