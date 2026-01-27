import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { MouseHookManager } from './mouse-hook.js';
import { createRadialWindow, showRadialWindow, hideRadialWindow, updateRadialCursor, getRadialWindow, calculateSelectedWedge, } from './radial-window.js';
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
let mouseHook = null;
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
        hasShadow: true,
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
// Handle radial wedge selection
const handleRadialSelection = (wedge) => {
    switch (wedge) {
        case 'ask':
            updateUiState({ mode: 'ask' });
            showWindow('mini');
            break;
        case 'chat':
            updateUiState({ mode: 'chat' });
            showWindow('mini');
            break;
        case 'voice':
            updateUiState({ mode: 'voice' });
            showWindow('mini');
            break;
        case 'full':
            showWindow('full');
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
app.whenReady().then(() => {
    createFullWindow();
    createMiniWindow();
    createRadialWindow(); // Pre-create radial window for faster display
    showWindow('full');
    // Initialize mouse hook for global right-click detection
    initMouseHook();
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
});
