import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { MouseHookManager } from './mouse-hook.js';
import { createRadialWindow, showRadialWindow, hideRadialWindow, updateRadialCursor, getRadialWindow, calculateSelectedWedge, } from './radial-window.js';
import { getOrCreateDeviceId } from './local-host/device.js';
import { createLocalHostRunner } from './local-host/runner.js';
import { resolveStellarHome } from './local-host/stellar-home.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
const uiState = {
    mode: 'chat',
    window: 'full',
    conversationId: null,
};
let fullWindow = null;
let miniWindow = null;
let mouseHook = null;
let localHostRunner = null;
let deviceId = null;
let pendingConvexUrl = null;
const pendingCredentialRequests = new Map();
const miniSize = {
    width: 680,
    height: 420,
};
const RADIAL_SIZE = 280;
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
    const isMac = process.platform === 'darwin';
    const isWindows = process.platform === 'win32';
    fullWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 400,
        minHeight: 300,
        // Custom title bar: frameless on Windows/Linux, hidden inset on macOS
        frame: isMac,
        titleBarStyle: isMac ? 'hiddenInset' : undefined,
        trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
        ...(isWindows || process.platform === 'linux' ? { frame: false } : {}),
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
    const { x, y, width } = display.workArea;
    // Center horizontally, position in upper third of screen (like Spotlight)
    const targetX = Math.round(x + (width - miniSize.width) / 2);
    const targetY = Math.round(y + 120);
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
        frame: false,
        transparent: true,
        hasShadow: false,
        vibrancy: 'under-window',
        visualEffectState: 'active',
        skipTaskbar: true,
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
    // Blur event hides mini window (like Spotlight)
    miniWindow.on('blur', () => {
        if (miniWindow && miniWindow.isVisible()) {
            miniWindow.hide();
        }
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
        updateUiState({ window: target });
    }
    else {
        if (!fullWindow) {
            createFullWindow();
        }
        fullWindow?.show();
        fullWindow?.focus();
        miniWindow?.hide();
        // Full view is always chat mode
        updateUiState({ window: target, mode: 'chat' });
    }
};
// Handle radial wedge selection
const handleRadialSelection = (wedge) => {
    switch (wedge) {
        case 'ask':
            // Ask mode: mini window with screenshot capability
            updateUiState({ mode: 'ask' });
            showWindow('mini');
            break;
        case 'chat':
            // Chat mode: mini window for general chat
            updateUiState({ mode: 'chat' });
            showWindow('mini');
            break;
        case 'voice':
            // Voice mode: mini window with voice input (stubbed)
            updateUiState({ mode: 'voice' });
            showWindow('mini');
            break;
        case 'full':
            // Full always uses chat mode
            showWindow('full'); // This already sets mode to 'chat'
            break;
        case 'menu':
            // Menu just closes the radial - native menu passthrough is handled separately
            break;
    }
};
// Trigger native context menu (platform-specific)
const triggerNativeContextMenu = async (_x, _y) => {
    // On most platforms, we simply don't block the right-click
    // The uiohook captures the event but doesn't prevent it from reaching the system
    // However, if needed, we could use platform-specific approaches:
    // - Windows: Could use PowerShell or nircmd
    // - macOS: Could use AppleScript
    // - Linux: xdotool
    // For now, we just do nothing and let the system handle it normally
    // since uiohook doesn't actually block events, just observes them
};
// Initialize mouse hook
const initMouseHook = () => {
    mouseHook = new MouseHookManager({
        onRadialShow: (x, y) => {
            showRadialWindow(x, y);
        },
        onRadialHide: () => {
            hideRadialWindow();
        },
        onMouseMove: (x, y) => {
            updateRadialCursor(x, y);
        },
        onMouseUp: (x, y) => {
            const display = screen.getDisplayNearestPoint({ x, y });
            const scaleFactor = display.scaleFactor ?? 1;
            const cursorX = x / scaleFactor;
            const cursorY = y / scaleFactor;
            // Get radial window bounds to calculate relative position
            const radialWin = getRadialWindow();
            if (radialWin) {
                const bounds = radialWin.getBounds();
                const relativeX = cursorX - bounds.x;
                const relativeY = cursorY - bounds.y;
                const wedge = calculateSelectedWedge(relativeX, relativeY, RADIAL_SIZE / 2, RADIAL_SIZE / 2);
                if (wedge) {
                    handleRadialSelection(wedge);
                }
                else {
                    // No wedge selected - focus radial briefly to try to suppress native menu
                    // This is a workaround since uiohook is passive and can't block events
                    radialWin.focus();
                    setTimeout(() => {
                        hideRadialWindow();
                    }, 10);
                }
                // Send mouse up event to radial window
                radialWin.webContents.send('radial:mouseup', { wedge });
            }
        },
        onNativeMenuRequest: (x, y) => {
            triggerNativeContextMenu(x, y);
        },
    });
    mouseHook.start();
};
const configureLocalHost = (convexUrl) => {
    pendingConvexUrl = convexUrl;
    if (localHostRunner) {
        localHostRunner.setConvexUrl(convexUrl);
    }
};
const requestCredential = async (payload) => {
    const requestId = crypto.randomUUID();
    const request = { requestId, ...payload };
    const focused = BrowserWindow.getFocusedWindow();
    const targetWindows = focused ? [focused] : fullWindow ? [fullWindow] : BrowserWindow.getAllWindows();
    if (targetWindows.length === 0) {
        throw new Error('No window available to collect credentials.');
    }
    for (const window of targetWindows) {
        window.webContents.send('credential:request', request);
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCredentialRequests.delete(requestId);
            reject(new Error('Credential request timed out.'));
        }, 5 * 60 * 1000);
        pendingCredentialRequests.set(requestId, { resolve, reject, timeout });
    });
};
app.whenReady().then(async () => {
    const userDataPath = app.getPath('userData');
    const stellarHome = await resolveStellarHome(app, userDataPath);
    deviceId = await getOrCreateDeviceId(stellarHome.statePath);
    localHostRunner = createLocalHostRunner({
        deviceId,
        stellarHome: stellarHome.homePath,
        requestCredential,
    });
    if (pendingConvexUrl) {
        localHostRunner.setConvexUrl(pendingConvexUrl);
    }
    localHostRunner.start();
    createFullWindow();
    createMiniWindow();
    createRadialWindow(); // Pre-create radial window for faster display
    showWindow('full');
    // Initialize mouse hook for global right-click detection
    initMouseHook();
    ipcMain.handle('device:getId', () => deviceId);
    ipcMain.handle('host:configure', (_event, config) => {
        if (config?.convexUrl) {
            configureLocalHost(config.convexUrl);
        }
        return { deviceId };
    });
    // Window control handlers for custom title bar
    ipcMain.on('window:minimize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.minimize();
    });
    ipcMain.on('window:maximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win?.isMaximized()) {
            win.unmaximize();
        }
        else {
            win?.maximize();
        }
    });
    ipcMain.on('window:close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.close();
    });
    ipcMain.handle('window:isMaximized', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() ?? false;
    });
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
    // Handle radial wedge selection from renderer
    ipcMain.on('radial:select', (_event, wedge) => {
        handleRadialSelection(wedge);
        hideRadialWindow();
    });
    // Theme sync across windows
    ipcMain.on('theme:broadcast', (_event, data) => {
        // Broadcast theme changes to all windows except the sender
        const sender = BrowserWindow.fromWebContents(_event.sender);
        for (const window of BrowserWindow.getAllWindows()) {
            if (window !== sender) {
                window.webContents.send('theme:change', data);
            }
        }
    });
    ipcMain.handle('credential:submit', (_event, payload) => {
        const pending = pendingCredentialRequests.get(payload.requestId);
        if (!pending) {
            return { ok: false, error: 'Credential request not found.' };
        }
        clearTimeout(pending.timeout);
        pendingCredentialRequests.delete(payload.requestId);
        pending.resolve(payload);
        return { ok: true };
    });
    ipcMain.handle('credential:cancel', (_event, payload) => {
        const pending = pendingCredentialRequests.get(payload.requestId);
        if (!pending) {
            return { ok: false, error: 'Credential request not found.' };
        }
        clearTimeout(pending.timeout);
        pendingCredentialRequests.delete(payload.requestId);
        pending.reject(new Error('Credential request cancelled.'));
        return { ok: true };
    });
    ipcMain.handle('screenshot:capture', async () => {
        const display = screen.getPrimaryDisplay();
        const scaleFactor = display.scaleFactor ?? 1;
        const thumbnailSize = {
            width: Math.floor(display.size.width * scaleFactor),
            height: Math.floor(display.size.height * scaleFactor),
        };
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize,
        });
        const preferred = sources.find((source) => source.display_id === String(display.id));
        const source = preferred ?? sources[0];
        if (!source) {
            return null;
        }
        const image = source.thumbnail;
        const png = image.toPNG();
        const size = image.getSize();
        return {
            dataUrl: `data:image/png;base64,${png.toString('base64')}`,
            width: size.width,
            height: size.height,
        };
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
app.on('will-quit', () => {
    // Stop mouse hook before quitting
    if (mouseHook) {
        mouseHook.stop();
        mouseHook = null;
    }
    if (localHostRunner) {
        localHostRunner.stop();
        localHostRunner = null;
    }
});
