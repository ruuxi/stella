import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { MouseHookManager } from './mouse-hook.js';
import { createRadialWindow, showRadialWindow, hideRadialWindow, updateRadialCursor, getRadialWindow, calculateSelectedWedge, } from './radial-window.js';
import { createRegionCaptureWindow, showRegionCaptureWindow, hideRegionCaptureWindow } from './region-capture-window.js';
import { captureChatContext } from './chat-context.js';
import { captureWindowAtPoint, prefetchWindowSources } from './window-capture.js';
import { initSelectedTextProcess, cleanupSelectedTextProcess, getSelectedText } from './selected-text.js';
import { createModifierOverlay, showModifierOverlay, showModifierOverlayPreemptive, hideModifierOverlay, destroyModifierOverlay, } from './modifier-overlay.js';
import { getOrCreateDeviceId } from './local-host/device.js';
import { createLocalHostRunner } from './local-host/runner.js';
import { resolveStellaHome } from './local-host/stella-home.js';
import { collectBrowserData, coreMemoryExists, writeCoreMemory, formatBrowserDataForSynthesis, } from './local-host/browser-data.js';
import { collectAllSignals } from './local-host/collect-all.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
const AUTH_PROTOCOL = 'Stella';
const getDeepLinkUrl = (argv) => 
// Case-insensitive check for the protocol (Windows may lowercase it)
argv.find((arg) => arg.toLowerCase().startsWith(`${AUTH_PROTOCOL.toLowerCase()}://`)) || null;
let pendingAuthCallback = null;
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
let StellaHomePath = null;
let appReady = false; // true when authenticated + onboarding complete
let isQuitting = false;
let pendingConvexUrl = null;
let pendingChatContext = null;
// Bump when pendingChatContext changes so we can avoid broadcasting the same payload
// right before showing the mini window (which can cause a visible "flash" of old state).
let chatContextVersion = 0;
let lastBroadcastChatContextVersion = -1;
let lastMiniChatContextAckVersion = -1;
let pendingMiniChatContextAck = null;
let lastRadialPoint = null;
let pendingMiniShowTimer = null;
let miniShowRequestId = 0;
let pendingMiniBlurHideTimer = null;
let suppressMiniBlurUntil = 0;
let pendingMiniOpacityHideTimer = null;
let radialShowActive = false;
let radialSelectionCommitted = false;
let radialCaptureRequestId = 0;
let pendingRadialCapturePromise = null;
let regionCaptureDisplay = null;
let pendingRegionCaptureResolve = null;
let pendingRegionCapturePromise = null;
const pendingCredentialRequests = new Map();
const emptyContext = () => ({
    window: null,
    browserUrl: null,
    selectedText: null,
    regionScreenshots: [],
});
const miniSize = {
    width: 680,
    height: 420,
};
const RADIAL_SIZE = 280;
const MINI_SHELL_ANIM_MS = 140;
const isMiniShowing = () => {
    if (!miniWindow) {
        return false;
    }
    return miniWindow.getOpacity() > 0.01;
};
const sendMiniVisibility = (visible) => {
    if (!miniWindow)
        return;
    miniWindow.webContents.send('mini:visibility', { visible });
};
const hideMiniWindow = (animate = true) => {
    if (!miniWindow)
        return;
    if (pendingMiniOpacityHideTimer) {
        clearTimeout(pendingMiniOpacityHideTimer);
        pendingMiniOpacityHideTimer = null;
    }
    // Keep the window "shown" but invisible so Windows doesn't flash a cached old frame
    // next time we call show(). Also keep it click-through and non-focusable.
    sendMiniVisibility(false);
    miniWindow.setIgnoreMouseEvents(true, { forward: true });
    miniWindow.setFocusable(false);
    // Explicitly blur so isFocused() returns false in the timer callback
    miniWindow.blur();
    if (!animate) {
        miniWindow.setOpacity(0);
        return;
    }
    // Let the renderer animate the panel out; then make the window fully transparent.
    if (miniWindow.getOpacity() <= 0.01) {
        return;
    }
    pendingMiniOpacityHideTimer = setTimeout(() => {
        pendingMiniOpacityHideTimer = null;
        if (!miniWindow)
            return;
        // Only fully hide if it didn't get re-opened in the meantime.
        if (!miniWindow.isFocused()) {
            miniWindow.setOpacity(0);
        }
    }, MINI_SHELL_ANIM_MS);
};
const broadcastUiState = () => {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('ui:state', uiState);
    }
};
const setPendingChatContext = (next) => {
    pendingChatContext = next;
    chatContextVersion += 1;
};
const broadcastAuthCallback = (url) => {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('auth:callback', { url });
    }
};
const handleAuthCallback = (url) => {
    if (!url) {
        return;
    }
    pendingAuthCallback = url;
    if (app.isReady()) {
        showWindow('full');
        broadcastAuthCallback(url);
        pendingAuthCallback = null;
    }
};
const registerAuthProtocol = () => {
    if (isDev) {
        // In dev mode, we need to pass the project directory so Electron can find package.json
        const projectDir = path.resolve(__dirname, '..');
        app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [projectDir]);
        return;
    }
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
};
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}
else {
    app.on('second-instance', (_event, argv) => {
        const url = getDeepLinkUrl(argv);
        if (url) {
            handleAuthCallback(url);
        }
        if (fullWindow) {
            fullWindow.focus();
        }
    });
}
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthCallback(url);
});
const updateUiState = (partial) => {
    Object.assign(uiState, partial);
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
            partition: 'persist:Stella',
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
    // Center horizontally, position near bottom of screen
    const targetX = Math.round(x + (width - miniSize.width) / 2);
    const targetY = Math.round(y + height - miniSize.height - 20);
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
        skipTaskbar: true,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'persist:Stella',
        },
    });
    // Set higher alwaysOnTop level to appear above other floating windows
    miniWindow.setAlwaysOnTop(true, 'pop-up-menu');
    loadWindow(miniWindow, 'mini');
    miniWindow.on('closed', () => {
        miniWindow = null;
    });
    // Prevent destroying the mini window (re-creating transparent windows can cause visible flashes).
    // We still allow it to close during app shutdown.
    miniWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        event.preventDefault();
        miniWindow?.hide();
    });
    // Blur event hides mini window (like Spotlight)
    miniWindow.on('blur', () => {
        if (isMiniShowing()) {
            // Focus can bounce between the radial/overlay and mini during fast selections.
            // Don't dismiss on transient blur during the open handshake.
            if (Date.now() < suppressMiniBlurUntil) {
                return;
            }
            if (pendingMiniBlurHideTimer) {
                clearTimeout(pendingMiniBlurHideTimer);
            }
            pendingMiniBlurHideTimer = setTimeout(() => {
                pendingMiniBlurHideTimer = null;
                if (!miniWindow) {
                    return;
                }
                if (Date.now() < suppressMiniBlurUntil) {
                    return;
                }
                if (!miniWindow.isFocused() && isMiniShowing()) {
                    hideMiniWindow(true);
                }
            }, 50);
        }
    });
    positionMiniWindow();
    // Keep the window alive/paintable but invisible to avoid cached-frame flashes on fast open.
    hideMiniWindow(false);
    miniWindow.showInactive();
};
const showWindow = (target) => {
    if (target === 'mini') {
        if (!appReady)
            return; // Block mini shell when not signed in or onboarding incomplete
        if (!miniWindow) {
            createMiniWindow();
        }
        if (pendingMiniOpacityHideTimer) {
            clearTimeout(pendingMiniOpacityHideTimer);
            pendingMiniOpacityHideTimer = null;
        }
        if (pendingMiniBlurHideTimer) {
            clearTimeout(pendingMiniBlurHideTimer);
            pendingMiniBlurHideTimer = null;
        }
        const requestId = ++miniShowRequestId;
        // Give the mini window a short blur-grace period while we transition away from the radial/overlay.
        suppressMiniBlurUntil = Date.now() + 250;
        // Push the latest context before the window becomes visible to avoid flashing stale selection text.
        // If the context was already broadcast during the current radial interaction, skip the duplicate send.
        if (lastBroadcastChatContextVersion !== chatContextVersion) {
            broadcastChatContext();
        }
        positionMiniWindow();
        // Defer showing by a tick so the renderer can process the chatContext update while hidden.
        if (pendingMiniShowTimer) {
            clearTimeout(pendingMiniShowTimer);
        }
        pendingMiniShowTimer = setTimeout(() => {
            pendingMiniShowTimer = null;
            const versionToWait = chatContextVersion;
            void (async () => {
                // Show the window fully transparent first so Windows doesn't display a cached old frame.
                // We'll restore opacity after the renderer acks that it applied the latest chatContext.
                fullWindow?.hide();
                miniWindow?.setIgnoreMouseEvents(false);
                miniWindow?.setFocusable(true);
                miniWindow?.setOpacity(0);
                miniWindow?.show();
                miniWindow?.focus();
                await waitForMiniChatContext(versionToWait);
                // If a newer show request arrived, don't "commit" this one.
                if (requestId !== miniShowRequestId) {
                    // Make sure we don't leave the window invisible if it was shown.
                    if (miniWindow?.isVisible()) {
                        miniWindow.setOpacity(1);
                    }
                    return;
                }
                // Ensure the window is interactive in case a transient blur hid it during the handshake.
                miniWindow?.setIgnoreMouseEvents(false);
                miniWindow?.setFocusable(true);
                // Trigger renderer "panel in" animation, then reveal the window.
                sendMiniVisibility(true);
                setTimeout(() => {
                    // If a newer show request arrived, don't reveal for the old one.
                    if (requestId !== miniShowRequestId)
                        return;
                    miniWindow?.setOpacity(1);
                }, 16);
                updateUiState({ window: target });
            })();
        }, 0);
    }
    else {
        if (pendingMiniShowTimer) {
            clearTimeout(pendingMiniShowTimer);
            pendingMiniShowTimer = null;
        }
        if (!fullWindow) {
            createFullWindow();
        }
        fullWindow?.show();
        fullWindow?.focus();
        hideMiniWindow(false);
        // Full view is always chat mode
        updateUiState({ window: target, mode: 'chat' });
    }
};
const cancelRadialContextCapture = () => {
    radialCaptureRequestId += 1;
    pendingRadialCapturePromise = null;
};
const captureRadialContext = (x, y) => {
    const requestId = ++radialCaptureRequestId;
    lastRadialPoint = { x, y };
    // Reset selected text immediately so the mini shell never shows stale content
    // while the latest context capture is still in flight.
    const existingScreenshots = pendingChatContext?.regionScreenshots ?? [];
    setPendingChatContext({
        window: null,
        browserUrl: null,
        selectedText: null,
        regionScreenshots: existingScreenshots,
        capturePending: true,
    });
    // If mini is already visible, surface the pending state right away.
    if (isMiniShowing()) {
        broadcastChatContext();
    }
    pendingRadialCapturePromise = (async () => {
        try {
            const fresh = await captureChatContext({ x, y });
            if (requestId !== radialCaptureRequestId) {
                return;
            }
            // Preserve screenshots captured while text capture was running.
            const screenshots = pendingChatContext?.regionScreenshots ?? existingScreenshots;
            setPendingChatContext({
                ...fresh,
                regionScreenshots: screenshots,
                capturePending: false,
            });
        }
        catch (error) {
            if (requestId !== radialCaptureRequestId) {
                return;
            }
            console.warn('Failed to capture chat context', error);
            const screenshots = pendingChatContext?.regionScreenshots ?? existingScreenshots;
            setPendingChatContext({
                window: null,
                browserUrl: null,
                selectedText: null,
                regionScreenshots: screenshots,
                capturePending: false,
            });
        }
        finally {
            if (requestId === radialCaptureRequestId) {
                pendingRadialCapturePromise = null;
                // Keep the mini shell synced when context lands after the shell is open.
                if (isMiniShowing()) {
                    broadcastChatContext();
                }
            }
        }
    })();
};
const consumeChatContext = () => {
    const context = pendingChatContext;
    setPendingChatContext(null);
    return context;
};
const broadcastChatContext = () => {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('chatContext:updated', {
            context: pendingChatContext,
            version: chatContextVersion,
        });
    }
    lastBroadcastChatContextVersion = chatContextVersion;
};
const waitForMiniChatContext = async (version, timeoutMs = 250) => {
    if (!miniWindow) {
        return;
    }
    if (lastMiniChatContextAckVersion >= version) {
        return;
    }
    // Replace any existing waiter (we only care about the latest version).
    if (pendingMiniChatContextAck) {
        clearTimeout(pendingMiniChatContextAck.timeout);
        pendingMiniChatContextAck.resolve();
        pendingMiniChatContextAck = null;
    }
    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            if (pendingMiniChatContextAck?.version === version) {
                pendingMiniChatContextAck = null;
            }
            resolve();
        }, timeoutMs);
        pendingMiniChatContextAck = {
            version,
            timeout,
            resolve: () => {
                clearTimeout(timeout);
                pendingMiniChatContextAck = null;
                resolve();
            },
        };
    });
};
const getDisplayForPoint = (point) => {
    const targetPoint = point ?? lastRadialPoint ?? screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(targetPoint);
};
const getDisplaySource = async (display) => {
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
    return { source, scaleFactor };
};
const captureDisplayScreenshot = async (display) => {
    const result = await getDisplaySource(display);
    if (!result)
        return null;
    const image = result.source.thumbnail;
    const png = image.toPNG();
    const size = image.getSize();
    return {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        width: size.width,
        height: size.height,
    };
};
const captureRegionScreenshot = async (display, selection) => {
    const result = await getDisplaySource(display);
    if (!result)
        return null;
    const image = result.source.thumbnail;
    const size = image.getSize();
    const cropX = Math.max(0, Math.round(selection.x * result.scaleFactor));
    const cropY = Math.max(0, Math.round(selection.y * result.scaleFactor));
    const cropWidth = Math.min(size.width - cropX, Math.round(selection.width * result.scaleFactor));
    const cropHeight = Math.min(size.height - cropY, Math.round(selection.height * result.scaleFactor));
    if (cropWidth <= 0 || cropHeight <= 0) {
        return null;
    }
    const cropped = image.crop({
        x: cropX,
        y: cropY,
        width: cropWidth,
        height: cropHeight,
    });
    const png = cropped.toPNG();
    const cropSize = cropped.getSize();
    return {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        width: cropSize.width,
        height: cropSize.height,
    };
};
const resetRegionCapture = () => {
    pendingRegionCaptureResolve = null;
    pendingRegionCapturePromise = null;
    regionCaptureDisplay = null;
    hideRegionCaptureWindow();
};
const startRegionCapture = async () => {
    if (pendingRegionCapturePromise) {
        return pendingRegionCapturePromise;
    }
    regionCaptureDisplay = getDisplayForPoint(screen.getCursorScreenPoint());
    await showRegionCaptureWindow(regionCaptureDisplay, cancelRegionCapture);
    pendingRegionCapturePromise = new Promise((resolve) => {
        pendingRegionCaptureResolve = resolve;
    });
    return pendingRegionCapturePromise;
};
const finalizeRegionCapture = async (selection) => {
    if (!pendingRegionCaptureResolve) {
        resetRegionCapture();
        return;
    }
    const display = regionCaptureDisplay ?? getDisplayForPoint();
    const screenshot = await captureRegionScreenshot(display, selection);
    pendingRegionCaptureResolve(screenshot);
    resetRegionCapture();
};
const cancelRegionCapture = () => {
    if (pendingRegionCaptureResolve) {
        pendingRegionCaptureResolve(null);
    }
    resetRegionCapture();
};
// Handle radial wedge selection
const handleRadialSelection = async (wedge) => {
    switch (wedge) {
        case 'dismiss':
            // Center/dismiss: clear context and do nothing else
            cancelRadialContextCapture();
            setPendingChatContext(null);
            break;
        case 'capture': {
            updateUiState({ mode: 'chat' });
            const regionScreenshot = await startRegionCapture();
            if (regionScreenshot) {
                const ctx = pendingChatContext ?? emptyContext();
                const existing = ctx.regionScreenshots ?? [];
                setPendingChatContext({ ...ctx, regionScreenshots: [...existing, regionScreenshot] });
            }
            if (!isMiniShowing())
                showWindow('mini');
            else
                broadcastChatContext();
            break;
        }
        case 'chat':
        case 'auto': {
            updateUiState({ mode: 'chat' });
            if (!isMiniShowing())
                showWindow('mini');
            break;
        }
        case 'voice':
            updateUiState({ mode: 'voice' });
            if (!isMiniShowing())
                showWindow('mini');
            break;
        case 'full':
            cancelRadialContextCapture();
            setPendingChatContext(null);
            showWindow('full');
            break;
    }
};
// Initialize mouse hook
const initMouseHook = () => {
    mouseHook = new MouseHookManager({
        onModifierDown: () => {
            if (process.platform === 'darwin') {
                // On macOS, show the overlay preemptively when Cmd is pressed.
                // macOS fires the context menu at the OS level on right-click before
                // any window can intercept it. By placing the overlay before the
                // right-click happens, the overlay receives (and suppresses) the
                // context menu event instead of the app underneath.
                showModifierOverlayPreemptive();
            }
        },
        onModifierUp: () => {
            // Clear any unused context, but not if the mini shell is already showing
            // (the user selected a wedge and the context is in use)
            if (!isMiniShowing() && !pendingMiniShowTimer && !pendingRadialCapturePromise) {
                setPendingChatContext(null);
            }
            if (process.platform === 'darwin') {
                // Hide preemptive overlay when modifier is released (unless radial is
                // active — onRadialHide will handle cleanup in that case).
                if (!mouseHook?.isRadialActive()) {
                    hideModifierOverlay();
                }
            }
        },
        onLeftClick: (x, y) => {
            // Hide mini window if clicking outside its bounds
            const win = miniWindow;
            if (win && win.getOpacity() > 0.01) {
                const bounds = win.getBounds();
                const display = screen.getDisplayNearestPoint({ x, y });
                // On macOS uiohook coords are already logical; on Windows/Linux divide to convert.
                const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1);
                const clickX = x / scaleFactor;
                const clickY = y / scaleFactor;
                const isOutside = clickX < bounds.x ||
                    clickX > bounds.x + bounds.width ||
                    clickY < bounds.y ||
                    clickY > bounds.y + bounds.height;
                if (isOutside) {
                    hideMiniWindow(true);
                }
            }
        },
        onRadialShow: (x, y) => {
            if (!appReady)
                return;
            // Suppress mini blur so the radial overlay doesn't dismiss an already-open mini shell.
            suppressMiniBlurUntil = Date.now() + 2000;
            // Dismiss any open image preview in the mini shell.
            if (isMiniShowing() && miniWindow) {
                miniWindow.webContents.send('mini:dismissPreview');
            }
            radialShowActive = true;
            radialSelectionCommitted = false;
            // 1. Show radial immediately so first-open latency is not gated by
            // selected-text capture.
            showRadialWindow(x, y);
            // 2. Show overlay to block context menu on mouseup.
            showModifierOverlay();
            // 3. Capture context in the background.
            captureRadialContext(x, y);
        },
        onRadialHide: () => {
            radialShowActive = false;
            // Modifier-up can end the gesture without a mouse-up selection.
            // In that path, ignore any in-flight capture from this gesture.
            if (!radialSelectionCommitted) {
                cancelRadialContextCapture();
                if (!isMiniShowing() && !pendingMiniShowTimer) {
                    setPendingChatContext(null);
                }
            }
            radialSelectionCommitted = false;
            hideRadialWindow();
            hideModifierOverlay();
        },
        onMouseMove: (x, y) => {
            updateRadialCursor(x, y);
        },
        onMouseUp: (x, y) => {
            const display = screen.getDisplayNearestPoint({ x, y });
            // On macOS uiohook coords are already logical; on Windows/Linux divide to convert.
            const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1);
            const cursorX = x / scaleFactor;
            const cursorY = y / scaleFactor;
            // Get radial window bounds to calculate relative position
            const radialWin = getRadialWindow();
            if (radialWin) {
                const bounds = radialWin.getBounds();
                const relativeX = cursorX - bounds.x;
                const relativeY = cursorY - bounds.y;
                const wedge = calculateSelectedWedge(relativeX, relativeY, RADIAL_SIZE / 2, RADIAL_SIZE / 2);
                // Always a valid wedge (center = 'dismiss')
                radialSelectionCommitted = true;
                void handleRadialSelection(wedge);
            }
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
    registerAuthProtocol();
    // Start persistent PowerShell process for fast selected text capture
    initSelectedTextProcess();
    if (process.platform === 'win32') {
        // Warm up the first UI Automation query so the first radial open doesn't pay
        // the cold-call latency spike.
        setTimeout(() => {
            void getSelectedText();
        }, 250);
    }
    const initialAuthUrl = getDeepLinkUrl(process.argv);
    if (initialAuthUrl) {
        pendingAuthCallback = initialAuthUrl;
    }
    const StellaHome = await resolveStellaHome(app);
    StellaHomePath = StellaHome.homePath;
    deviceId = await getOrCreateDeviceId(StellaHome.statePath);
    localHostRunner = createLocalHostRunner({
        deviceId,
        StellaHome: StellaHome.homePath,
        requestCredential,
    });
    if (pendingConvexUrl) {
        localHostRunner.setConvexUrl(pendingConvexUrl);
    }
    localHostRunner.start();
    createFullWindow();
    createMiniWindow();
    createRadialWindow(); // Pre-create radial window for faster display
    createRegionCaptureWindow(); // Pre-create region capture window for faster display
    createModifierOverlay(); // Overlay to capture right-clicks when Ctrl is held
    showWindow('full');
    // Wait for the full window to finish loading before broadcasting auth callback
    // Otherwise the renderer won't be ready to receive the IPC message
    if (pendingAuthCallback && fullWindow) {
        const authUrl = pendingAuthCallback;
        pendingAuthCallback = null;
        fullWindow.webContents.once('did-finish-load', () => {
            broadcastAuthCallback(authUrl);
        });
    }
    // Initialize mouse hook for global right-click detection
    initMouseHook();
    ipcMain.on('app:setReady', (_event, ready) => {
        appReady = !!ready;
    });
    ipcMain.on('chatContext:ack', (event, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!miniWindow || win !== miniWindow) {
            return;
        }
        const version = payload?.version;
        if (typeof version !== 'number') {
            return;
        }
        lastMiniChatContextAckVersion = Math.max(lastMiniChatContextAckVersion, version);
        if (pendingMiniChatContextAck && pendingMiniChatContextAck.version === version) {
            pendingMiniChatContextAck.resolve();
        }
    });
    ipcMain.handle('device:getId', () => deviceId);
    ipcMain.handle('host:configure', (_event, config) => {
        if (config?.convexUrl) {
            configureLocalHost(config.convexUrl);
        }
        return { deviceId };
    });
    ipcMain.handle('auth:setToken', (_event, payload) => {
        localHostRunner?.setAuthToken(payload?.token ?? null);
        return { ok: true };
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
        if (!win)
            return;
        // For spotlight-style overlays, "close" should dismiss without destroying the window.
        // Destroying/recreating transparent windows can cause visible flashes/flicker.
        if (win === miniWindow) {
            hideMiniWindow(true);
            return;
        }
        win.close();
    });
    ipcMain.handle('window:isMaximized', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() ?? false;
    });
    ipcMain.handle('ui:getState', () => uiState);
    ipcMain.handle('ui:setState', (_event, partial) => {
        const { window: nextWindow, ...rest } = partial;
        if (nextWindow) {
            showWindow(nextWindow);
        }
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
    ipcMain.handle('chatContext:get', () => consumeChatContext());
    ipcMain.on('chatContext:removeScreenshot', (_event, index) => {
        if (!pendingChatContext?.regionScreenshots)
            return;
        const next = [...pendingChatContext.regionScreenshots];
        next.splice(index, 1);
        setPendingChatContext({ ...pendingChatContext, regionScreenshots: next });
    });
    ipcMain.on('region:select', (_event, selection) => {
        void finalizeRegionCapture(selection);
    });
    ipcMain.on('region:cancel', () => {
        cancelRegionCapture();
    });
    ipcMain.on('region:click', async (_event, point) => {
        if (!pendingRegionCaptureResolve) {
            resetRegionCapture();
            return;
        }
        // Grab the resolve function before resetting (resetRegionCapture clears it)
        const resolve = pendingRegionCaptureResolve;
        // Hide the region capture overlay BEFORE capturing so it doesn't appear in the screenshot
        hideRegionCaptureWindow();
        // Also hide the mini shell if visible (so we capture the window underneath)
        const miniWasShowing = isMiniShowing();
        if (miniWasShowing) {
            hideMiniWindow(false);
        }
        // Wait a frame for the windows to actually hide
        await new Promise((r) => setTimeout(r, 50));
        // Pre-fetch sources (overlay and mini shell should now be hidden)
        const sources = await prefetchWindowSources([]);
        // Capture window at clicked point
        const capture = await captureWindowAtPoint(point.x, point.y, sources);
        resolve(capture?.screenshot ?? null);
        pendingRegionCaptureResolve = null;
        pendingRegionCapturePromise = null;
        regionCaptureDisplay = null;
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
    // Browser data collection for core memory
    ipcMain.handle('browserData:exists', async () => {
        if (!StellaHomePath)
            return false;
        return coreMemoryExists(StellaHomePath);
    });
    ipcMain.handle('browserData:collect', async () => {
        if (!StellaHomePath) {
            return { data: null, formatted: null, error: 'Stella home not initialized' };
        }
        try {
            const data = await collectBrowserData(StellaHomePath);
            const formatted = formatBrowserDataForSynthesis(data);
            return { data, formatted };
        }
        catch (error) {
            return {
                data: null,
                formatted: null,
                error: error.message,
            };
        }
    });
    ipcMain.handle('browserData:writeCoreMemory', async (_event, content) => {
        if (!StellaHomePath) {
            return { ok: false, error: 'Stella home not initialized' };
        }
        try {
            await writeCoreMemory(StellaHomePath, content);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    });
    // Comprehensive user signal collection (with category support)
    ipcMain.handle('signals:collectAll', async (_event, options) => {
        if (!StellaHomePath) {
            return { data: null, formatted: null, error: 'Stella home not initialized' };
        }
        const categories = options?.categories;
        return collectAllSignals(StellaHomePath, categories);
    });
    // Identity map for depseudonymization
    ipcMain.handle('identity:getMap', async () => {
        if (!StellaHomePath)
            return { version: 1, mappings: [] };
        const { loadIdentityMap } = await import('./local-host/identity_map.js');
        return loadIdentityMap(StellaHomePath);
    });
    ipcMain.handle('identity:depseudonymize', async (_event, text) => {
        if (!StellaHomePath || !text)
            return text;
        const { loadIdentityMap, depseudonymize } = await import('./local-host/identity_map.js');
        const map = await loadIdentityMap(StellaHomePath);
        if (map.mappings.length === 0)
            return text;
        return depseudonymize(text, map);
    });
    // Open Full Disk Access in System Preferences (macOS)
    ipcMain.on('system:openFullDiskAccess', () => {
        if (process.platform === 'darwin') {
            import('child_process').then(({ exec: execCmd }) => {
                execCmd('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"');
            });
        }
    });
    ipcMain.handle('screenshot:capture', async (_event, point) => {
        const display = getDisplayForPoint(point);
        return captureDisplayScreenshot(display);
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
app.on('before-quit', () => {
    isQuitting = true;
    cleanupSelectedTextProcess();
    destroyModifierOverlay();
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
