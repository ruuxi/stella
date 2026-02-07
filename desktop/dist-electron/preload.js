"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    // Window controls for custom title bar
    minimizeWindow: () => electron_1.ipcRenderer.send('window:minimize'),
    maximizeWindow: () => electron_1.ipcRenderer.send('window:maximize'),
    closeWindow: () => electron_1.ipcRenderer.send('window:close'),
    isMaximized: () => electron_1.ipcRenderer.invoke('window:isMaximized'),
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
    captureScreenshot: (point) => electron_1.ipcRenderer.invoke('screenshot:capture', point),
    getChatContext: () => electron_1.ipcRenderer.invoke('chatContext:get'),
    // Renderer acks that it has applied a particular chat context version. Used to avoid flashing stale frames on show.
    ackChatContext: (payload) => electron_1.ipcRenderer.send('chatContext:ack', payload),
    onMiniVisibility: (callback) => {
        const handler = (_event, data) => {
            callback(Boolean(data?.visible));
        };
        electron_1.ipcRenderer.on('mini:visibility', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('mini:visibility', handler);
        };
    },
    onDismissPreview: (callback) => {
        electron_1.ipcRenderer.on('mini:dismissPreview', callback);
        return () => {
            electron_1.ipcRenderer.removeListener('mini:dismissPreview', callback);
        };
    },
    onChatContext: (callback) => {
        const handler = (_event, context) => {
            callback(context);
        };
        electron_1.ipcRenderer.on('chatContext:updated', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('chatContext:updated', handler);
        };
    },
    getDeviceId: () => electron_1.ipcRenderer.invoke('device:getId'),
    configureHost: (config) => electron_1.ipcRenderer.invoke('host:configure', config),
    setAuthToken: (payload) => electron_1.ipcRenderer.invoke('auth:setToken', payload),
    onAuthCallback: (callback) => {
        const handler = (_event, data) => {
            callback(data);
        };
        electron_1.ipcRenderer.on('auth:callback', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('auth:callback', handler);
        };
    },
    // App readiness gate (controls radial menu + mini shell)
    setAppReady: (ready) => electron_1.ipcRenderer.send('app:setReady', ready),
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
    submitRegionSelection: (payload) => electron_1.ipcRenderer.send('region:select', payload),
    submitRegionClick: (point) => electron_1.ipcRenderer.send('region:click', point),
    cancelRegionCapture: () => electron_1.ipcRenderer.send('region:cancel'),
    removeScreenshot: (index) => electron_1.ipcRenderer.send('chatContext:removeScreenshot', index),
    // Theme sync across windows
    onThemeChange: (callback) => {
        const handler = (event, data) => {
            callback(event, data);
        };
        electron_1.ipcRenderer.on('theme:change', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('theme:change', handler);
        };
    },
    broadcastThemeChange: (key, value) => electron_1.ipcRenderer.send('theme:broadcast', { key, value }),
    onCredentialRequest: (callback) => {
        const handler = (event, data) => {
            callback(event, data);
        };
        electron_1.ipcRenderer.on('credential:request', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('credential:request', handler);
        };
    },
    submitCredential: (payload) => electron_1.ipcRenderer.invoke('credential:submit', payload),
    cancelCredential: (payload) => electron_1.ipcRenderer.invoke('credential:cancel', payload),
    // Browser data collection for core memory
    checkCoreMemoryExists: () => electron_1.ipcRenderer.invoke('browserData:exists'),
    collectBrowserData: () => electron_1.ipcRenderer.invoke('browserData:collect'),
    writeCoreMemory: (content) => electron_1.ipcRenderer.invoke('browserData:writeCoreMemory', content),
    // Comprehensive user signal collection (browser + dev projects + shell + apps)
    collectAllSignals: (options) => electron_1.ipcRenderer.invoke('signals:collectAll', options),
    // Identity map for pseudonymization
    getIdentityMap: () => electron_1.ipcRenderer.invoke('identity:getMap'),
    depseudonymize: (text) => electron_1.ipcRenderer.invoke('identity:depseudonymize', text),
    // System preferences (macOS FDA)
    openFullDiskAccess: () => electron_1.ipcRenderer.send('system:openFullDiskAccess'),
});
