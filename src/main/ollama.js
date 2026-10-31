// Bridge to a local Ollama server (default http://127.0.0.1:11434).
// Everything runs on this PC; nothing is sent anywhere else.
const { ipcMain } = require('electron');
const log = require('electron-log/main');

let base = 'http://127.0.0.1:11434';
let win = null;
const aborts = new Map(); // request id -> AbortController

function url(p) {
  return base.replace(/\/+$/, '') + p;
}

async function getJson(p, opts = {}) {
  const r = await fetch(url(p), opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function isLocal(u) {
  try {
    const h = new URL(u).hostname;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h) || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return false;
  }
}

function init(window) {
  win = window;

  ipcMain.handle('ai:set-base', (_e, u) => {
    if (u && isLocal(u)) base = u;
    return base;
  });

  // Is Ollama running, and which models are installed?
  ipcMain.handle('ai:status', async () => {
    try {
      const v = await getJson('/api/version', { signal: AbortSignal.timeout(2500) });
      const t = await getJson('/api/tags', { signal: AbortSignal.timeout(5000) });
      return {
        running: true,
        version: v.version,
        models: (t.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details && m.details.family, params: m.details && m.details.parameter_size })),
      };
    } catch (e) {
      return { running: false, error: String(e.message || e) };
    }
  });

  // What can a model do (vision, tools)?
  ipcMain.handle('ai:show', async (_e, model) => {
    try {
      const j = await getJson('/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      return { capabilities: j.capabilities || [], details: j.details || {} };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });

  // Download a model, streaming progress to the window.
  ipcMain.handle('ai:pull', async (_e, { id, model }) => {
    const ac = new AbortController();
    aborts.set(id, ac);
    try {
      const r = await fetch(url('/api/pull'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) throw new Error(`${r.status} ${r.statusText}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.error) throw new Error(j.error);
          if (win && !win.isDestroyed()) win.webContents.send('ai:pull-progress', { id, status: j.status, total: j.total, completed: j.completed });
        }
      }
      return { ok: true };
    } catch (e) {
      if (ac.signal.aborted) return { cancelled: true };
      log.warn('ollama pull failed', e);
      return { error: String(e.message || e) };
    } finally {
      aborts.delete(id);
    }
  });

  // One chat turn (non-streaming). The renderer runs the tool loop.
  ipcMain.handle('ai:chat', async (_e, { id, model, messages, tools, options, think }) => {
    const ac = new AbortController();
    aborts.set(id, ac);
    try {
      const j = await getJson('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools,
          stream: false,
          keep_alive: '15m',
          ...(think != null ? { think } : {}),
          // Low temperature = consistent, literal tool use. Context sized for a 24 GB GPU with a 27B model.
          options: { num_ctx: 20480, temperature: 0.1, top_p: 0.9, repeat_penalty: 1.05, ...(options || {}) },
        }),
        signal: ac.signal,
      });
      return { message: j.message, stats: { evalCount: j.eval_count, ms: j.total_duration ? Math.round(j.total_duration / 1e6) : null } };
    } catch (e) {
      if (ac.signal.aborted) return { cancelled: true };
      log.warn('ollama chat failed', e);
      return { error: String(e.message || e) };
    } finally {
      aborts.delete(id);
    }
  });

  ipcMain.on('ai:cancel', (_e, id) => {
    const ac = aborts.get(id);
    if (ac) ac.abort();
  });
}

module.exports = { init };
