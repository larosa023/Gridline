// Runs symbol matching off the UI thread.
import { matchTemplate } from './match.js';

self.onmessage = (e) => {
  const { id, img, W, H, tpl, opts } = e.data;
  try {
    let last = 0;
    const res = matchTemplate(img, W, H, tpl, {
      ...opts,
      onProgress: (p) => {
        if (p - last > 0.05) {
          last = p;
          self.postMessage({ id, progress: p });
        }
      },
    });
    self.postMessage({ id, result: res });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
