// Small persistent stores in the user's app-data folder:
//  - autosave/ : crash/close recovery copies of unsaved projects
//  - recent.json : recently opened/saved projects
//  - library.json : reusable conditions (saved across projects)
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const log = require('electron-log/main');

const dir = () => app.getPath('userData');
const autosaveDir = () => path.join(dir(), 'autosave');
const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function addRecent(entry) {
  const file = path.join(dir(), 'recent.json');
  let list = await readJson(file, []);
  list = list.filter((r) => r.path !== entry.path);
  list.unshift({ ...entry, at: new Date().toISOString() });
  await writeAtomic(file, JSON.stringify(list.slice(0, 12), null, 1));
}

function init() {
  // ---- Autosave ----
  ipcMain.handle('autosave:write', async (_e, { id, name, path: filePath, text }) => {
    const sid = safeId(id);
    if (!sid) return false;
    try {
      await writeAtomic(path.join(autosaveDir(), sid + '.gridline'), text);
      await writeAtomic(path.join(autosaveDir(), sid + '.json'), JSON.stringify({ id: sid, name, path: filePath || null, at: new Date().toISOString(), bytes: text.length }));
      return true;
    } catch (e) {
      log.warn('autosave failed', e);
      return false;
    }
  });

  ipcMain.handle('autosave:list', async () => {
    try {
      const files = await fs.readdir(autosaveDir());
      const out = [];
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        const meta = await readJson(path.join(autosaveDir(), f), null);
        if (meta) out.push(meta);
      }
      return out.sort((a, b) => (a.at < b.at ? 1 : -1));
    } catch {
      return [];
    }
  });

  ipcMain.handle('autosave:read', async (_e, id) => {
    const sid = safeId(id);
    try {
      return await fs.readFile(path.join(autosaveDir(), sid + '.gridline'), 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('autosave:clear', async (_e, id) => {
    const sid = safeId(id);
    for (const ext of ['.gridline', '.json']) {
      try {
        await fs.unlink(path.join(autosaveDir(), sid + ext));
      } catch {}
    }
    return true;
  });

  // ---- Recent projects ----
  ipcMain.handle('recent:add', async (_e, entry) => {
    if (entry && entry.path) await addRecent(entry);
    return true;
  });
  ipcMain.handle('recent:list', async () => {
    const list = await readJson(path.join(dir(), 'recent.json'), []);
    const out = [];
    for (const r of list) {
      try {
        await fs.access(r.path);
        out.push(r);
      } catch {}
    }
    return out;
  });
  ipcMain.handle('recent:remove', async (_e, p) => {
    const file = path.join(dir(), 'recent.json');
    const list = (await readJson(file, [])).filter((r) => r.path !== p);
    await writeAtomic(file, JSON.stringify(list, null, 1));
    return true;
  });

  // ---- Condition library ----
  ipcMain.handle('library:get', async () => readJson(path.join(dir(), 'library.json'), []));
  ipcMain.handle('library:set', async (_e, list) => {
    if (!Array.isArray(list)) return false;
    await writeAtomic(path.join(dir(), 'library.json'), JSON.stringify(list.slice(0, 2000), null, 1));
    return true;
  });
}

module.exports = { init, addRecent };
