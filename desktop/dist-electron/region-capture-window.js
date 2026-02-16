import { BrowserWindow, globalShortcut, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDevServerUrl } from './dev-url.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
let regionWindow = null;
let contentReady = false;
let onEscapeCancel = null;
const getDevUrl = () => {
    const url = new URL(getDevServerUrl());
    url.searchParams.set('window', 'region');
    return url.toString();
};
const getFileTarget = () => ({
    filePath: path.join(__dirname, '../dist/index.html'),
    query: { window: 'region' },
});
export const createRegionCaptureWindow = () => {
    if (regionWindow)
        return regionWindow;
    contentReady = false;
    regionWindow = new BrowserWindow({
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        focusable: true,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'persist:Stella',
        },
    });
    regionWindow.webContents.on('did-finish-load', () => {
        contentReady = true;
    });
    if (isDev) {
        regionWindow.loadURL(getDevUrl());
    }
    else {
        const target = getFileTarget();
        regionWindow.loadFile(target.filePath, { query: target.query });
    }
    regionWindow.on('closed', () => {
        regionWindow = null;
        contentReady = false;
    });
    return regionWindow;
};
/**
 * Compute the bounding rectangle that spans all displays (in DIP coordinates).
 */
const getAllDisplaysBounds = () => {
    const displays = screen.getAllDisplays();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of displays) {
        minX = Math.min(minX, d.bounds.x);
        minY = Math.min(minY, d.bounds.y);
        maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
        maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
export const showRegionCaptureWindow = async (cancelCallback) => {
    if (!regionWindow) {
        createRegionCaptureWindow();
    }
    if (!regionWindow)
        return;
    const bounds = getAllDisplaysBounds();
    regionWindow.setBounds(bounds);
    if (!contentReady) {
        await new Promise((resolve) => {
            regionWindow.webContents.once('did-finish-load', () => resolve());
        });
    }
    // Register a global Escape shortcut as a fallback — the renderer keydown
    // listener can miss events when the transparent overlay doesn't have focus.
    onEscapeCancel = cancelCallback ?? null;
    globalShortcut.register('Escape', () => {
        onEscapeCancel?.();
    });
    regionWindow.setAlwaysOnTop(true, 'screen-saver');
    regionWindow.show();
    regionWindow.focus();
};
export const hideRegionCaptureWindow = () => {
    globalShortcut.unregister('Escape');
    onEscapeCancel = null;
    if (regionWindow) {
        regionWindow.hide();
    }
};
export const getRegionCaptureWindow = () => regionWindow;
