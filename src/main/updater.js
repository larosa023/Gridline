// Built-in updater. Checks GitHub Releases on launch and every few hours,
// downloads new versions in the background, and lets the user restart to install.
const { app, ipcMain } = require('electron');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let win = null;
let state = { status: 'idle' };
let manualCheck = false;
let autoEnabled = true;

function send(next) {
  state = { ...state, manual: manualCheck, ...next };
  if (win && !win.isDestroyed()) win.webContents.send('updater:state', state);
}

function check(manual = false) {
  manualCheck = manual;
  if (!app.isPackaged) {
    send({ status: 'dev', message: 'Updates are only available in the installed app.' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('update check failed', err);
    send({ status: 'error', message: friendly(err) });
  });
}

function friendly(err) {
  const m = String((err && err.message) || err || '');
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|getaddrinfo/i.test(m)) return 'Offline — could not reach the update server.';
  if (/404|latest\.yml/i.test(m)) return 'No published release found yet.';
  return 'Update check failed. Try again later.';
}

function init(window) {
  win = window;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => send({ status: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    send({ status: 'downloading', version: info.version, percent: 0, notes: notesText(info.releaseNotes) })
  );
  autoUpdater.on('update-not-available', () =>
    send({ status: manualCheck ? 'current' : 'idle', version: app.getVersion() })
  );
  autoUpdater.on('download-progress', (p) =>
    send({ status: 'downloading', percent: Math.round(p.percent), speed: p.bytesPerSecond })
  );
  autoUpdater.on('update-downloaded', (info) =>
    send({ status: 'ready', version: info.version, notes: notesText(info.releaseNotes) })
  );
  autoUpdater.on('error', (err) => {
    log.warn('updater error', err);
    send({ status: 'error', message: friendly(err) });
  });

  ipcMain.handle('updater:check', () => check(true));
  ipcMain.handle('updater:state', () => state);
  ipcMain.on('updater:set-auto', (_e, on) => {
    autoEnabled = !!on;
    autoUpdater.autoDownload = true;
  });
  ipcMain.on('updater:install', () => {
    // Silent install, then relaunch Gridline on the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  const autoCheck = () => autoEnabled && check(false);
  win.webContents.once('did-finish-load', () => setTimeout(autoCheck, 4000));
  setInterval(autoCheck, CHECK_EVERY_MS);
}

function notesText(notes) {
  if (!notes) return '';
  const raw = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return raw.replace(/<[^>]+>/g, '').trim().slice(0, 1200);
}

module.exports = { init, check };
