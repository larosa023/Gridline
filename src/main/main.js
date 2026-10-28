const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const log = require('electron-log/main');
const { buildMenu } = require('./menu');
const updater = require('./updater');

log.initialize();
log.transports.file.level = 'info';

let win = null;
let forceQuit = false;
let fileToOpen = process.argv.find((a) => a.toLowerCase().endsWith('.gridline'));

// Single instance: opening a .gridline file while the app runs focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = argv.find((a) => a.toLowerCase().endsWith('.gridline'));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) win.webContents.send('menu', 'open-project-path', f);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101215' : '#f4f5f7',
    title: 'Gridline',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  buildMenu(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (fileToOpen) {
      win.webContents.send('menu', 'open-project-path', fileToOpen);
      fileToOpen = null;
    }
  });

  // Ask the renderer before closing so unsaved work isn't lost.
  win.on('close', (e) => {
    if (forceQuit) return;
    e.preventDefault();
    win.webContents.send('app:close-requested');
  });

  // External links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  updater.init(win);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.on('app:confirm-close', () => {
  forceQuit = true;
  if (win) win.close();
});

ipcMain.handle('dialog:open-pdfs', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add drawings',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF drawings', extensions: ['pdf'] }],
  });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths) {
    const buf = await fs.readFile(p);
    out.push({ name: path.basename(p), data: new Uint8Array(buf) });
  }
  return out;
});

ipcMain.handle('dialog:open-project', async (_e, givenPath) => {
  let p = givenPath;
  if (!p) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'Gridline project', extensions: ['gridline'] }],
    });
    if (r.canceled) return null;
    p = r.filePaths[0];
  }
  const text = await fs.readFile(p, 'utf8');
  return { path: p, text };
});

ipcMain.handle('dialog:save-project', async (_e, { text, path: currentPath, name, saveAs }) => {
  let p = currentPath;
  if (!p || saveAs) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save project',
      defaultPath: (name || 'Untitled') + '.gridline',
      filters: [{ name: 'Gridline project', extensions: ['gridline'] }],
    });
    if (r.canceled) return null;
    p = r.filePath;
  }
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, p);
  return p;
});

ipcMain.handle('dialog:export', async (_e, { text, defaultName, ext, label }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: defaultName,
    filters: [{ name: label, extensions: [ext] }],
  });
  if (r.canceled) return null;
  await fs.writeFile(r.filePath, text, 'utf8');
  return r.filePath;
});

ipcMain.handle('dialog:message', async (_e, opts) => {
  const r = await dialog.showMessageBox(win, opts);
  return r.response;
});

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});
