import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { MouseHookManager } from './mouse-hook.js';
import { createRadialWindow, showRadialWindow, hideRadialWindow, updateRadialCursor, getRadialWindow, calculateSelectedWedge, } from './radial-window.js';
import { getOrCreateDeviceId } from './local-host/device.js';
import { createLocalHostRunner } from './local-host/runner.js';
import { resolveStellarHome } from './local-host/stellar-home.js';
import { createScreenBridge } from './local-host/screen-bridge.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
const uiState = {
    mode: 'chat',
    window: 'full',
    conversationId: null,
    panel: {
        isOpen: true,
        width: 420,
        focused: false,
        activeScreenId: 'media_viewer',
        chatDrawerOpen: false,
    },
};
let fullWindow = null;
let miniWindow = null;
let mouseHook = null;
let localHostRunner = null;
let deviceId = null;
let pendingConvexUrl = null;
let screenBridge = null;
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
    if (partial.panel) {
        uiState.panel = {
            ...uiState.panel,
            ...partial.panel,
        };
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
const triggerNativeContextMenu = async (x, y) => {
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
app.whenReady().then(async () => {
    const userDataPath = app.getPath('userData');
    const stellarHome = await resolveStellarHome(app, userDataPath);
    const projectRoot = path.resolve(__dirname, '..');
    deviceId = await getOrCreateDeviceId(stellarHome.statePath);
    screenBridge = createScreenBridge({
        getTargetWindow: () => fullWindow,
    });
    localHostRunner = createLocalHostRunner({
        deviceId,
        stellarHome: stellarHome.homePath,
        projectRoot,
        screenBridge,
        onRevertPrompt: async ({ triggers, reason }) => {
            const triggerDescriptions = triggers.map((t) => {
                switch (t.type) {
                    case 'safe_mode_trigger':
                        return `• Safe Mode Trigger: ${t.message}`;
                    case 'unhealthy_boot':
                        return `• Previous Boot Issue: ${t.message}`;
                    case 'smoke_check_failed':
                        return `• Build Check Failed: ${t.message}`;
                    default:
                        return `• ${t.message}`;
                }
            });
            const result = await dialog.showMessageBox({
                type: 'warning',
                title: 'Revert to Last Known Good?',
                message: 'Stellar detected issues that may require reverting to a previous state.',
                detail: `The following issues were detected:\n\n${triggerDescriptions.join('\n')}\n\nWould you like to revert platform files (src/, electron/) to the last known good state?\n\nChoose "Don't Revert" to keep your current changes.`,
                buttons: ['Revert', "Don't Revert"],
                defaultId: 1,
                cancelId: 1,
            });
            return result.response === 0; // 0 = Revert, 1 = Don't Revert
        },
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
    ipcMain.handle('ui:getState', () => uiState);
    ipcMain.handle('ui:setState', (_event, partial) => {
        if (partial.window) {
            showWindow(partial.window);
        }
        const { window, ...rest } = partial;
        void window;
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
    if (localHostRunner) {
        localHostRunner.stop();
        localHostRunner = null;
    }
});
