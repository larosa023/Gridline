import { hydrateIcons, icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild;
  hydrateIcons(node);
  return node;
}

export function toast(msg, { kind = '', action, actionLabel, timeout = 4200 } = {}) {
  const t = h(`<div class="toast ${kind}"><div class="msg">${esc(msg)}</div></div>`);
  if (action) {
    const b = h(`<button class="btn small primary">${esc(actionLabel)}</button>`);
    b.onclick = () => {
      action();
      t.remove();
    };
    t.append(b);
  }
  const x = h(`<button class="icon-btn" title="Dismiss">${icon('x', 15)}</button>`);
  x.onclick = () => t.remove();
  t.append(x);
  $('#toasts').append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}

/**
 * Open a modal. `build(body, close)` fills the body; returns a promise resolving to the close value.
 * buttons: [{ label, kind, value, primary }]
 */
export function modal({ title, wide = false, build, buttons = [], onSubmit }) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    const back = h(`<div class="modal-backdrop">
      <form class="modal ${wide ? 'wide' : ''}" autocomplete="off">
        <header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-x>${icon('x', 16)}</button></header>
        <div class="body"></div>
        <footer></footer>
      </form></div>`);
    const form = $('form', back);
    const body = $('.body', back);
    const foot = $('footer', back);
    const close = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    $('[data-x]', back).onclick = () => close(null);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) close(null);
    });
    for (const b of buttons) {
      const btn = h(`<button type="${b.primary ? 'submit' : 'button'}" class="btn ${b.primary ? 'primary' : ''} ${b.kind || ''}">${esc(b.label)}</button>`);
      if (!b.primary) btn.onclick = () => close(b.value);
      foot.append(btn);
    }
    if (!buttons.length) foot.remove();
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = onSubmit ? onSubmit(form) : true;
      if (v !== false && v !== undefined) close(v);
    };
    build && build(body, close);
    hydrateIcons(back);
    root.append(back);
    const first = $('input:not([type=color]), select, textarea', body);
    if (first) setTimeout(() => (first.focus(), first.select && first.select()), 20);
  });
}

export function contextMenu(x, y, items) {
  closeContextMenu();
  const m = h(`<div class="ctx-menu" id="ctxMenu"></div>`);
  for (const it of items) {
    if (it === '-') {
      m.append(h('<hr>'));
      continue;
    }
    if (it.head) {
      m.append(h(`<div class="menu-head">${esc(it.head)}</div>`));
      continue;
    }
    const lead = it.dot ? `<span class="dot" style="background:${esc(it.dot)}"></span>` : it.icon ? icon(it.icon, 15) : '';
    const b = h(`<button class="${it.danger ? 'danger' : ''} ${it.current ? 'current' : ''}">${lead}<span>${esc(it.label)}</span></button>`);
    b.onclick = () => {
      closeContextMenu();
      it.run();
    };
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

function outside(e) {
  if (!e.target.closest('#ctxMenu')) closeContextMenu();
}

export function closeContextMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.remove();
  document.removeEventListener('mousedown', outside, true);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
