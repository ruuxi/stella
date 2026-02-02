import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
let regionWindow = null;
let contentReady = false;
const getDevUrl = () => {
    const url = new URL('http://localhost:5173');
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
            partition: 'persist:stellar',
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
export const showRegionCaptureWindow = async (display = screen.getPrimaryDisplay()) => {
    if (!regionWindow) {
        createRegionCaptureWindow();
    }
    if (!regionWindow)
        return;
    const bounds = display.bounds;
    regionWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
    });
    if (!contentReady) {
        await new Promise((resolve) => {
            regionWindow.webContents.once('did-finish-load', () => resolve());
        });
    }
    regionWindow.setAlwaysOnTop(true, 'screen-saver');
    regionWindow.show();
    regionWindow.focus();
};
export const hideRegionCaptureWindow = () => {
    if (regionWindow) {
        regionWindow.hide();
    }
};
