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
        if (done) buf += '\n'; // flush a last line without a trailing newline
        else buf += dec.decode(value, { stream: true });
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
        if (done) break;
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

  // Must stay identical on every call: changing it makes Ollama reload the model.
  const OPTIONS = { num_ctx: 20480, temperature: 0.1, top_p: 0.9, repeat_penalty: 1.05 };

  // Load the model into GPU memory ahead of the first request.
  ipcMain.handle('ai:warm', async (_e, model) => {
    try {
      await getJson('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: '30m', options: OPTIONS }),
        signal: AbortSignal.timeout(120000),
      });
      return { ok: true };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });

  // One chat turn, streamed: text/thinking deltas go to the window as they arrive; the full
  // message (with any tool calls) is returned at the end. The renderer runs the tool loop.
  ipcMain.handle('ai:chat', async (_e, { id, model, messages, tools, options, think }) => {
    const ac = new AbortController();
    aborts.set(id, ac);
    const send = (d) => win && !win.isDestroyed() && win.webContents.send('ai:chat-delta', { id, ...d });
    try {
      const r = await fetch(url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, stream: true, keep_alive: '30m', ...(think != null ? { think } : {}), options: { ...OPTIONS, ...(options || {}) } }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) {
        let msg = `${r.status} ${r.statusText}`;
        try {
          const j = await r.json();
          if (j.error) msg = j.error;
        } catch {}
        throw new Error(msg);
      }
      const message = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
      let final = {};
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) buf += '\n'; // flush a last line without a trailing newline
        else buf += dec.decode(value, { stream: true });
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
          const m = j.message || {};
          if (m.content) {
            message.content += m.content;
            send({ content: m.content });
          }
          if (m.thinking) {
            message.thinking += m.thinking;
            send({ thinking: m.thinking });
          }
          if (m.tool_calls && m.tool_calls.length) message.tool_calls.push(...m.tool_calls);
          if (j.done) final = j;
        }
        if (done) break;
      }
      if (!message.tool_calls.length) delete message.tool_calls;
      const sec = (ns) => (ns ? ns / 1e9 : 0);
      return {
        message,
        stats: {
          evalCount: final.eval_count || 0,
          tokPerSec: final.eval_count && final.eval_duration ? +(final.eval_count / sec(final.eval_duration)).toFixed(1) : null,
          promptTokens: final.prompt_eval_count || 0,
          promptMs: final.prompt_eval_duration ? Math.round(final.prompt_eval_duration / 1e6) : null,
          ms: final.total_duration ? Math.round(final.total_duration / 1e6) : null,
          loadMs: final.load_duration ? Math.round(final.load_duration / 1e6) : null,
        },
      };
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
