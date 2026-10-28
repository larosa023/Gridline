const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gridline', {
  version: () => ipcRenderer.invoke('app:version'),
  openPdfs: () => ipcRenderer.invoke('dialog:open-pdfs'),
  openProject: (path) => ipcRenderer.invoke('dialog:open-project', path),
  saveProject: (opts) => ipcRenderer.invoke('dialog:save-project', opts),
  exportFile: (opts) => ipcRenderer.invoke('dialog:export', opts),
  message: (opts) => ipcRenderer.invoke('dialog:message', opts),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onCloseRequested: (fn) => ipcRenderer.on('app:close-requested', () => fn()),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, name, arg) => fn(name, arg)),
  ai: {
    setBase: (u) => ipcRenderer.invoke('ai:set-base', u),
    status: () => ipcRenderer.invoke('ai:status'),
    show: (model) => ipcRenderer.invoke('ai:show', model),
    pull: (id, model) => ipcRenderer.invoke('ai:pull', { id, model }),
    onPullProgress: (fn) => ipcRenderer.on('ai:pull-progress', (_e, p) => fn(p)),
    chat: (req) => ipcRenderer.invoke('ai:chat', req),
    cancel: (id) => ipcRenderer.send('ai:cancel', id),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    state: () => ipcRenderer.invoke('updater:state'),
    install: () => ipcRenderer.send('updater:install'),
    setAuto: (on) => ipcRenderer.send('updater:set-auto', !!on),
    onState: (fn) => ipcRenderer.on('updater:state', (_e, s) => fn(s)),
  },
});
