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
    getDeviceId: () => electron_1.ipcRenderer.invoke('device:getId'),
    configureHost: (config) => electron_1.ipcRenderer.invoke('host:configure', config),
    // Radial dial events
    onRadialShow: (callback) => {
        const handler = (event, data) => {
            callback(event, data);
        };
        electron_1.ipcRenderer.on('radial:show', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('radial:show', handler);
        };
    },
    onRadialHide: (callback) => {
        const handler = () => {
            callback();
        };
        electron_1.ipcRenderer.on('radial:hide', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('radial:hide', handler);
        };
    },
    onRadialCursor: (callback) => {
        const handler = (event, data) => {
            callback(event, data);
        };
        electron_1.ipcRenderer.on('radial:cursor', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('radial:cursor', handler);
        };
    },
    onRadialMouseUp: (callback) => {
        const handler = (event, data) => {
            callback(event, data);
        };
        electron_1.ipcRenderer.on('radial:mouseup', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('radial:mouseup', handler);
        };
    },
    radialSelect: (wedge) => electron_1.ipcRenderer.send('radial:select', wedge),
});
