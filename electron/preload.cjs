const { contextBridge, ipcRenderer } = require('electron');

const validKinds = new Set(['char', 'back', 'enter', 'space']);

contextBridge.exposeInMainWorld('cadenceDesktop', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke('cadence:get-state'),
  setEnabled: (enabled) => ipcRenderer.invoke('cadence:set-enabled', Boolean(enabled)),
  getMusicResource: () => ipcRenderer.invoke('cadence:get-music-resource'),
  openMusicResource: () => ipcRenderer.invoke('cadence:open-music-resource'),
  onKey: (callback) => {
    const listener = (_event, payload) => {
      if (payload && validKinds.has(payload.kind)) callback({ kind: payload.kind });
    };
    ipcRenderer.on('cadence:key', listener);
    return () => ipcRenderer.removeListener('cadence:key', listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('cadence:monitoring-state', listener);
    return () => ipcRenderer.removeListener('cadence:monitoring-state', listener);
  },
  onMusicResourceChange: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cadence:music-resource-change', listener);
    return () => ipcRenderer.removeListener('cadence:music-resource-change', listener);
  },
});
