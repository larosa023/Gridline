const { Menu, shell, app } = require('electron');
const updater = require('./updater');

function buildMenu(win) {
  const cmd = (name) => () => win.webContents.send('menu', name);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: cmd('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
        { label: 'Add Drawings (PDF)…', accelerator: 'CmdOrCtrl+Shift+O', click: cmd('add-pdf') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-as') },
        { type: 'separator' },
        { label: 'Export Estimate (CSV)…', accelerator: 'CmdOrCtrl+E', click: cmd('export-csv') },
        { type: 'separator' },
        { label: 'Close Current PDF', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('close-drawing') },
        { label: 'Close Project', accelerator: 'CmdOrCtrl+W', click: cmd('close-project') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: cmd('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Takeoff', accelerator: 'CmdOrCtrl+1', click: cmd('view-takeoff') },
        { label: 'Estimate', accelerator: 'CmdOrCtrl+2', click: cmd('view-estimate') },
        { type: 'separator' },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+0', click: cmd('fit') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('toggle-theme') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }, { role: 'reload' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: cmd('shortcuts') },
        { label: 'Check for Updates…', click: () => updater.check(true) },
        { type: 'separator' },
        { label: 'Release Notes', click: () => shell.openExternal('https://github.com/larosa023/Gridline/releases') },
        { label: `About Gridline ${app.getVersion()}`, click: cmd('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
