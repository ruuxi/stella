import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
const uiState = {
    mode: 'ask',
    window: 'full',
    conversationId: null,
};
let fullWindow = null;
let miniWindow = null;
const miniSize = {
    width: 520,
    height: 280,
};
const broadcastUiState = () => {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('ui:state', uiState);
    }
};
const updateUiState = (partial) => {
    if (partial.mode) {
        uiState.mode = partial.mode;
    }
    if (partial.window) {
        uiState.window = partial.window;
    }
    if (partial.conversationId !== undefined) {
        uiState.conversationId = partial.conversationId;
    }
    broadcastUiState();
};
const getDevUrl = (windowMode) => {
    const url = new URL('http://localhost:5173');
    url.searchParams.set('window', windowMode);
    return url.toString();
};
const getFileTarget = (windowMode) => ({
    filePath: path.join(__dirname, '../dist/index.html'),
    query: { window: windowMode },
});
const loadWindow = (window, windowMode) => {
    if (isDev) {
        window.loadURL(getDevUrl(windowMode));
        return;
    }
    const target = getFileTarget(windowMode);
    window.loadFile(target.filePath, { query: target.query });
};
const createFullWindow = () => {
    fullWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    loadWindow(fullWindow, 'full');
    if (isDev) {
        fullWindow.webContents.openDevTools();
    }
    fullWindow.on('closed', () => {
        fullWindow = null;
    });
};
const positionMiniWindow = () => {
    if (!miniWindow) {
        return;
    }
    const anchor = fullWindow ?? miniWindow;
    const display = anchor ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const targetX = Math.round(x + width - miniSize.width - 24);
    const targetY = Math.round(y + 48);
    miniWindow.setBounds({
        x: targetX,
        y: targetY,
        width: miniSize.width,
        height: miniSize.height,
    });
};
const createMiniWindow = () => {
    miniWindow = new BrowserWindow({
        width: miniSize.width,
        height: miniSize.height,
        resizable: false,
        maximizable: false,
        minimizable: false,
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    loadWindow(miniWindow, 'mini');
    miniWindow.on('closed', () => {
        miniWindow = null;
    });
    positionMiniWindow();
    miniWindow.hide();
};
const showWindow = (target) => {
    if (target === 'mini') {
        if (!miniWindow) {
            createMiniWindow();
        }
        positionMiniWindow();
        miniWindow?.show();
        miniWindow?.focus();
        fullWindow?.hide();
    }
    else {
        if (!fullWindow) {
            createFullWindow();
        }
        fullWindow?.show();
        fullWindow?.focus();
        miniWindow?.hide();
    }
    updateUiState({ window: target });
};
app.whenReady().then(() => {
    createFullWindow();
    createMiniWindow();
    showWindow('full');
    ipcMain.handle('ui:getState', () => uiState);
    ipcMain.handle('ui:setState', (_event, partial) => {
        if (partial.window) {
            showWindow(partial.window);
        }
        const { window: _window, ...rest } = partial;
        if (Object.keys(rest).length > 0) {
            updateUiState(rest);
        }
        return uiState;
    });
    ipcMain.on('window:show', (_event, target) => {
        if (target !== 'mini' && target !== 'full') {
            return;
        }
        showWindow(target);
    });
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createFullWindow();
            createMiniWindow();
        }
        showWindow('full');
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
