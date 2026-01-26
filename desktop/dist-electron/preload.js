import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    getUiState: () => ipcRenderer.invoke('ui:getState'),
    setUiState: (partial) => ipcRenderer.invoke('ui:setState', partial),
    onUiState: (callback) => {
        const handler = (_event, state) => {
            callback(state);
        };
        ipcRenderer.on('ui:state', handler);
        return () => {
            ipcRenderer.removeListener('ui:state', handler);
        };
    },
    showWindow: (target) => ipcRenderer.send('window:show', target),
});
