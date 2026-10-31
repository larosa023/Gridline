// PDF loading, page rendering, pan/zoom transform and thumbnails.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { buildSnapIndex } from './snap.js';
import { clearFillCache } from './fill.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';

const docs = new Map(); // docId -> PDFDocumentProxy
const tasks = new Map(); // docId -> loading task (owns the worker-side document)
const pageCache = new Map(); // pageKey -> PDFPageProxy

export const view = {
  zoom: 1,
  x: 0,
  y: 0,
  pageW: 0, // page size in PDF points (viewport at scale 1)
  pageH: 0,
  pageKey: null,
};

let canvas, stage, viewportEl, onChange;
let renderTask = null;
let renderTimer = null;
let renderSeq = 0;

export function initViewer({ canvasEl, stageEl, viewport, onViewChange }) {
  canvas = canvasEl;
  stage = stageEl;
  viewportEl = viewport;
  onChange = onViewChange;
  // When a side panel slides in or out, shift the view so the drawing stays put on screen.
  let lastLeft = viewportEl.getBoundingClientRect().left;
  new ResizeObserver(() => {
    const left = viewportEl.getBoundingClientRect().left;
    if (view.pageKey && left !== lastLeft) {
      view.x += lastLeft - left;
      apply(false, true);
    }
    lastLeft = left;
    onChange && onChange('resize');
  }).observe(viewportEl);
}

export async function loadDocument(docId, bytes) {
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/',
    iccUrl: BASE + 'iccs/',
    isEvalSupported: false,
    enableXfa: false,
  });
  const pdf = await task.promise;
  docs.set(docId, pdf);
  tasks.set(docId, task);
  let labels = null;
  try {
    labels = await pdf.getPageLabels();
  } catch {
    labels = null;
  }
  return { numPages: pdf.numPages, labels };
}

/** The PDF's bytes, straight from PDF.js (so Gridline doesn't keep a second copy in memory). */
export async function documentBytes(docId) {
  const pdf = docs.get(docId);
  return pdf ? await pdf.getData() : null;
}

export function unloadDocument(docId) {
  const task = tasks.get(docId);
  const pdf = docs.get(docId);
  try {
    if (task && typeof task.destroy === 'function') task.destroy();
    else if (pdf && typeof pdf.destroy === 'function') pdf.destroy();
  } catch (e) {
    console.warn('pdf cleanup', e);
  }
  docs.delete(docId);
  tasks.delete(docId);
  for (const k of [...pageCache.keys()]) if (k.startsWith(docId + ':')) pageCache.delete(k);
  for (const k of [...thumbCache.keys()]) if (k.startsWith(docId + ':')) thumbCache.delete(k);
  for (const k of [...snapCache.keys()]) if (k.startsWith(docId + ':')) snapCache.delete(k);
  for (const k of [...textCache.keys()]) if (k.startsWith(docId + ':')) textCache.delete(k);
}

export function unloadAll() {
  for (const id of [...docs.keys()]) unloadDocument(id);
}

async function getPage(pageKey) {
  if (pageCache.has(pageKey)) return pageCache.get(pageKey);
  const [docId, num] = pageKey.split(':');
  const pdf = docs.get(docId);
  if (!pdf) throw new Error('Document not loaded');
  const page = await pdf.getPage(+num);
  pageCache.set(pageKey, page);
  return page;
}

const textCache = new Map(); // pageKey -> Promise<{ items, text }>

/**
 * Page text with positions in viewer space (top-left origin, points).
 * items: [{ str, x, y, w, h }] where (x, y) is the baseline start.
 */
export function getPageText(pageKey) {
  if (!textCache.has(pageKey)) {
    textCache.set(
      pageKey,
      (async () => {
        const page = await getPage(pageKey);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const items = [];
        for (const it of tc.items) {
          const str = (it.str || '').trim();
          if (!str) continue;
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          const size = Math.hypot(it.transform[2], it.transform[3]) || Math.hypot(it.transform[0], it.transform[1]);
          items.push({ str, x, y, w: it.width || str.length * size * 0.5, h: size });
        }
        return { items, text: items.map((i) => i.str).join(' ') };
      })().catch(() => ({ items: [], text: '' }))
    );
  }
  return textCache.get(pageKey);
}

/** Try to read a sheet number/title from the page's text (e.g. "A-101"). */
export async function guessSheetName(pageKey) {
  try {
    const { items } = await getPageText(pageKey);
    const page = await getPage(pageKey);
    const vp = page.getViewport({ scale: 1 });
    const re = /^[A-Z]{1,3}[-.\s]?\d{1,3}(?:\.\d{1,2})?[A-Z]?$/;
    let best = null;
    for (const it of items) {
      if (!re.test(it.str)) continue;
      // Prefer large text near the bottom-right title block.
      const score = it.h * 2 + (it.x / vp.width) * 10 + (it.y / vp.height) * 10;
      if (!best || score > best.score) best = { s: it.str, score };
    }
    return best ? best.s.replace(/\s/, '-') : null;
  } catch {
    return null;
  }
}

/** Render a sheet to grayscale at `r` pixels per point (for symbol matching / AI vision). */
export async function renderGray(pageKey, r) {
  const page = await getPage(pageKey);
  const vp = page.getViewport({ scale: r });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const img = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < img.length; i++, j += 4) img[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return { img, W: c.width, H: c.height, r };
}

/** Render a sheet (or a region of it, in page points) to a JPEG data URL, longest side `max` px. */
export async function renderJpeg(pageKey, max = 1600, region = null, draw = null) {
  const page = await getPage(pageKey);
  const base = page.getViewport({ scale: 1 });
  const rw = region ? region[2] : base.width;
  const rh = region ? region[3] : base.height;
  const s = Math.min(4, max / Math.max(rw, rh));
  const vp = page.getViewport({ scale: s });
  const c = document.createElement('canvas');
  c.width = Math.ceil(rw * s);
  c.height = Math.ceil(rh * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const tf = region ? [1, 0, 0, 1, -region[0] * s, -region[1] * s] : null;
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp, transform: tf }).promise;
  if (draw) {
    // Callers draw in page points; map them into this image.
    ctx.save();
    ctx.setTransform(s, 0, 0, s, region ? -region[0] * s : 0, region ? -region[1] * s : 0);
    draw(ctx, s);
    ctx.restore();
  }
  return { dataUrl: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height, scale: s };
}

export async function pageSize(pageKey) {
  const page = await getPage(pageKey);
  const vp = page.getViewport({ scale: 1 });
  return { w: vp.width, h: vp.height };
}

export async function showPage(pageKey) {
  const page = await getPage(pageKey);
  const vp = page.getViewport({ scale: 1 });
  const prev = view.pageKey;
  view.pageKey = pageKey;
  view.pageW = vp.width;
  view.pageH = vp.height;
  rendered = null;
  fit();
  // Let PDF.js drop the drawing data of the sheet we left (it reloads on demand).
  if (prev && prev !== pageKey && pageCache.has(prev)) {
    try {
      pageCache.get(prev).cleanup();
    } catch {}
  }
}

export function fit() {
  if (!view.pageW) return;
  const r = viewportEl.getBoundingClientRect();
  const pad = 36;
  const z = Math.min((r.width - pad * 2) / view.pageW, (r.height - pad * 2) / view.pageH);
  view.zoom = clampZoom(z);
  view.x = (r.width - view.pageW * view.zoom) / 2;
  view.y = (r.height - view.pageH * view.zoom) / 2;
  apply(true);
}

const clampZoom = (z) => Math.max(0.05, Math.min(16, z));

export function zoomAt(factor, cx, cy) {
  const nz = clampZoom(view.zoom * factor);
  const f = nz / view.zoom;
  view.x = cx - (cx - view.x) * f;
  view.y = cy - (cy - view.y) * f;
  view.zoom = nz;
  apply();
}

/** Zoom and centre on a box [x, y, w, h] in page points. */
export function fitRect(box, pad = 0.25) {
  if (!view.pageW || !box) return;
  const r = viewportEl.getBoundingClientRect();
  const [x, y, w, h] = box;
  const bw = Math.max(w, 20) * (1 + pad * 2),
    bh = Math.max(h, 20) * (1 + pad * 2);
  view.zoom = clampZoom(Math.min(r.width / bw, r.height / bh));
  view.x = r.width / 2 - (x + w / 2) * view.zoom;
  view.y = r.height / 2 - (y + h / 2) * view.zoom;
  apply(true);
}

export function zoomCenter(factor) {
  const r = viewportEl.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

export function panBy(dx, dy) {
  view.x += dx;
  view.y += dy;
  apply(false, true);
}

/** Screen (client) coords -> page points. */
export function toPage(clientX, clientY) {
  const r = viewportEl.getBoundingClientRect();
  return [(clientX - r.left - view.x) / view.zoom, (clientY - r.top - view.y) / view.zoom];
}

/** Page points -> viewport-relative pixels. */
export function toScreen(p) {
  return [p[0] * view.zoom + view.x, p[1] * view.zoom + view.y];
}

// What the canvas currently shows, in page points (the whole sheet, or just the part around
// the view when zoomed in far enough that a full-sheet bitmap would be huge).
let rendered = null; // { zoom, rx, ry, rw, rh, partial }
const FULL_LIMIT = 12e6; // pixels: above this, render only the visible area
const PART_LIMIT = 20e6;

function placeCanvas() {
  const z = view.zoom;
  const r = rendered || { rx: 0, ry: 0, rw: view.pageW, rh: view.pageH };
  canvas.style.left = r.rx * z + 'px';
  canvas.style.top = r.ry * z + 'px';
  canvas.style.width = r.rw * z + 'px';
  canvas.style.height = r.rh * z + 'px';
}

function visibleRect() {
  const r = viewportEl.getBoundingClientRect();
  const x0 = -view.x / view.zoom,
    y0 = -view.y / view.zoom;
  return [x0, y0, r.width / view.zoom, r.height / view.zoom];
}

function needsRender() {
  if (!rendered || Math.abs(rendered.zoom - view.zoom) > 1e-6) return true;
  if (!rendered.partial) return false;
  const [x, y, w, h] = visibleRect();
  const cx0 = Math.max(0, x),
    cy0 = Math.max(0, y),
    cx1 = Math.min(view.pageW, x + w),
    cy1 = Math.min(view.pageH, y + h);
  return cx0 < rendered.rx - 0.5 || cy0 < rendered.ry - 0.5 || cx1 > rendered.rx + rendered.rw + 0.5 || cy1 > rendered.ry + rendered.rh + 0.5;
}

function apply(immediateRender = false, panOnly = false) {
  const w = view.pageW * view.zoom;
  const h = view.pageH * view.zoom;
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  stage.style.transform = `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px)`;
  placeCanvas();
  if (!panOnly || needsRender()) {
    clearTimeout(renderTimer);
    if (immediateRender) render();
    else renderTimer = setTimeout(render, panOnly ? 60 : 140);
  }
  onChange && onChange(panOnly ? 'pan' : 'zoom');
}

async function render() {
  if (!view.pageKey) return;
  const key = view.pageKey;
  const zoom = view.zoom;
  if (!needsRender() && canvas.width) return;
  const seq = ++renderSeq;
  const page = await getPage(key);
  if (seq !== renderSeq) return;

  const dpr = window.devicePixelRatio || 1;
  let s = zoom * dpr;
  const MAX_SIDE = 16384;
  let rx = 0,
    ry = 0,
    rw = view.pageW,
    rh = view.pageH,
    partial = false;
  if (view.pageW * view.pageH * s * s > FULL_LIMIT) {
    // Zoomed in: render the visible area plus half a screen of margin each way.
    const [x, y, w, h] = visibleRect();
    rx = Math.max(0, x - w * 0.5);
    ry = Math.max(0, y - h * 0.5);
    rw = Math.min(view.pageW, x + w * 1.5) - rx;
    rh = Math.min(view.pageH, y + h * 1.5) - ry;
    partial = rw < view.pageW - 0.5 || rh < view.pageH - 0.5;
    const pix = rw * rh * s * s;
    if (pix > PART_LIMIT) s *= Math.sqrt(PART_LIMIT / pix);
  }
  s = Math.min(s, MAX_SIDE / rw, MAX_SIDE / rh);
  if (rw <= 0 || rh <= 0) return;

  const vp = page.getViewport({ scale: s });
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {}
  }
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.floor(rw * s));
  off.height = Math.max(1, Math.floor(rh * s));
  const ctx = off.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, off.width, off.height);
  renderTask = page.render({
    canvasContext: ctx,
    canvas: off,
    viewport: vp,
    transform: partial || rx || ry ? [1, 0, 0, 1, -rx * s, -ry * s] : null,
    annotationMode: pdfjs.AnnotationMode.ENABLE,
  });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    console.error(e);
    return;
  }
  if (seq !== renderSeq || key !== view.pageKey) {
    off.width = off.height = 0;
    return;
  }
  // Swap the finished frame in (no copy, no flash); the old bitmap is released right away.
  off.id = canvas.id;
  canvas.replaceWith(off);
  canvas.width = canvas.height = 0;
  canvas = off;
  rendered = { zoom, rx, ry, rw, rh, partial };
  placeCanvas();
  if (needsRender()) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 60);
  }
}

export function clearCanvas() {
  view.pageKey = null;
  view.pageW = view.pageH = 0;
  canvas.width = canvas.height = 0;
  rendered = null;
  renderSeq++;
}

// ---- Snap geometry (built once per sheet, in the background) ----
const snapCache = new Map(); // pageKey -> Promise<SnapIndex|null>  (most recent last)
const SNAP_KEEP = 4;

export function getSnapIndex(pageKey) {
  if (snapCache.has(pageKey)) {
    const v = snapCache.get(pageKey);
    snapCache.delete(pageKey);
    snapCache.set(pageKey, v);
    return v;
  }
  while (snapCache.size >= SNAP_KEEP) {
    const oldest = snapCache.keys().next().value;
    snapCache.delete(oldest);
    clearFillCache(oldest + '|');
  }
  {
    snapCache.set(
      pageKey,
      (async () => {
        try {
          const page = await getPage(pageKey);
          const vp = page.getViewport({ scale: 1 });
          const idx = await buildSnapIndex(page, pdfjs.OPS, vp.transform);
          idx.freeze();
          return idx;
        } catch (e) {
          console.warn('snap geometry unavailable', e);
          return null;
        }
      })()
    );
  }
  return snapCache.get(pageKey);
}

// ---- Thumbnails (queued, one at a time) ----
const thumbQueue = [];
let thumbBusy = false;

const thumbCache = new Map(); // pageKey -> canvas

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function requestThumb(pageKey, el) {
  const cached = thumbCache.get(pageKey);
  if (cached) return el.replaceChildren(cloneCanvas(cached));
  thumbQueue.push({ pageKey, el });
  pumpThumbs();
}

async function pumpThumbs() {
  if (thumbBusy) return;
  const job = thumbQueue.shift();
  if (!job) return;
  thumbBusy = true;
  try {
    const cached = thumbCache.get(job.pageKey);
    if (cached) {
      job.el.replaceChildren(cloneCanvas(cached));
    } else {
      const page = await getPage(job.pageKey);
      const base = page.getViewport({ scale: 1 });
      const s = Math.min(128 / base.width, 92 / base.height);
      const vp = page.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
      thumbCache.set(job.pageKey, c);
      // The row may have been re-rendered meanwhile; fill whichever thumb is live now.
      const live = job.el.isConnected ? job.el : document.querySelector(`.sheet[data-key="${job.pageKey}"] .thumb`);
      if (live) live.replaceChildren(cloneCanvas(c));
    }
  } catch (e) {
    console.warn('thumb failed', e);
  }
  thumbBusy = false;
  pumpThumbs();
}
