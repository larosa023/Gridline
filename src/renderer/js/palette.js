// Command palette (Ctrl+K): type to find any action, sheet, condition or recent project.
import { esc, h } from './dom.js';
import { icon } from './icons.js';

/** Score how well `q` matches `text` (0 = no match). Word starts and runs of letters score higher. */
export function fuzzyScore(q, text) {
  q = q.toLowerCase().trim();
  if (!q) return 1;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct + (direct === 0 || /[\s\-–_/]/.test(t[direct - 1]) ? 200 : 0);
  let score = 0,
    ti = 0,
    run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    run = at === ti ? run + 1 : 0;
    score += 10 + run * 5 + (at === 0 || /[\s\-–_/]/.test(t[at - 1]) ? 15 : 0);
    ti = at + 1;
  }
  return score;
}

/**
 * items: [{ label, hint?, group, icon?, keys?, run }] (or a function returning them).
 */
export function openPalette(items, { placeholder = 'Type a command, sheet or condition…' } = {}) {
  const existing = document.getElementById('palette');
  if (existing) return existing.remove();
  const all = typeof items === 'function' ? items() : items;
  const back = h(`<div class="palette-back" id="palette"><div class="palette">
      <div class="palette-in">${icon('search', 17)}<input placeholder="${esc(placeholder)}" spellcheck="false" /></div>
      <div class="palette-list"></div>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
    </div></div>`);
  const input = back.querySelector('input');
  const list = back.querySelector('.palette-list');
  let shown = [];
  let sel = 0;
  const close = () => back.remove();
  const render = () => {
    const q = input.value;
    shown = all
      .map((it) => ({ it, s: fuzzyScore(q, `${it.label} ${it.hint || ''} ${it.group}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || 0)
      .slice(0, 60)
      .map((x) => x.it);
    if (!q.trim()) shown = all.filter((x) => x.top).concat(all.filter((x) => !x.top)).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let last = null;
    list.innerHTML = shown.length
      ? shown
          .map((it, i) => {
            const head = it.group !== last ? `<div class="palette-group">${esc(it.group)}</div>` : '';
            last = it.group;
            return `${head}<button class="palette-item ${i === sel ? 'sel' : ''}" data-i="${i}">${it.dot ? `<span class="dot" style="background:${esc(it.dot)}"></span>` : icon(it.icon || 'chevronR', 15)}<span class="pl">${esc(it.label)}</span>${it.hint ? `<span class="ph">${esc(it.hint)}</span>` : ''}${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ''}</button>`;
          })
          .join('')
      : `<div class="palette-empty">No matches</div>`;
    list.querySelectorAll('[data-i]').forEach((b) => {
      b.onmousemove = () => {
        if (sel !== +b.dataset.i) {
          sel = +b.dataset.i;
          list.querySelectorAll('.palette-item').forEach((x) => x.classList.toggle('sel', +x.dataset.i === sel));
        }
      };
      b.onclick = () => runAt(+b.dataset.i);
    });
    const cur = list.querySelector('.palette-item.sel');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  };
  const runAt = (i) => {
    const it = shown[i];
    if (!it) return;
    close();
    setTimeout(() => it.run(), 0);
  };
  input.addEventListener('input', () => {
    sel = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = Math.min(shown.length - 1, sel + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(sel);
    }
  });
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  document.body.append(back);
  render();
  input.focus();
}
