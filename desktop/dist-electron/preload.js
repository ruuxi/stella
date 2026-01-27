"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    getUiState: () => electron_1.ipcRenderer.invoke('ui:getState'),
    setUiState: (partial) => electron_1.ipcRenderer.invoke('ui:setState', partial),
    onUiState: (callback) => {
        const handler = (_event, state) => {
            callback(state);
        };
        electron_1.ipcRenderer.on('ui:state', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('ui:state', handler);
        };
    },
    showWindow: (target) => electron_1.ipcRenderer.send('window:show', target),
    captureScreenshot: () => electron_1.ipcRenderer.invoke('screenshot:capture'),
});
