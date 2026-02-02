import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV === 'development';
const RADIAL_SIZE = 280; // Diameter of the radial dial
let radialWindow = null;
let isRadialShowing = false;
const getDevUrl = () => {
    const url = new URL('http://localhost:5173');
    url.searchParams.set('window', 'radial');
    return url.toString();
};
const getFileTarget = () => ({
    filePath: path.join(__dirname, '../dist/index.html'),
    query: { window: 'radial' },
});
export const createRadialWindow = () => {
    if (radialWindow)
        return radialWindow;
    radialWindow = new BrowserWindow({
        width: RADIAL_SIZE,
        height: RADIAL_SIZE,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        skipTaskbar: true,
        hasShadow: false,
        focusable: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'persist:stellar',
        },
    });
    // Set higher alwaysOnTop level than overlay
    radialWindow.setAlwaysOnTop(true, 'screen-saver');
    // Make window click-through when not interacting
    radialWindow.setIgnoreMouseEvents(false);
    if (isDev) {
        radialWindow.loadURL(getDevUrl());
    }
    else {
        const target = getFileTarget();
        radialWindow.loadFile(target.filePath, { query: target.query });
    }
    radialWindow.on('closed', () => {
        radialWindow = null;
    });
    return radialWindow;
};
export const showRadialWindow = (x, y) => {
    // Prevent double-show
    if (isRadialShowing)
        return;
    isRadialShowing = true;
    if (!radialWindow) {
        createRadialWindow();
    }
    if (!radialWindow) {
        isRadialShowing = false;
        return;
    }
    // Get the display where the cursor is
    const cursorPoint = { x, y };
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const scaleFactor = display.scaleFactor ?? 1;
    // Position window centered on cursor
    // Account for display scaling
    const adjustedX = Math.round(x / scaleFactor - RADIAL_SIZE / 2);
    const adjustedY = Math.round(y / scaleFactor - RADIAL_SIZE / 2);
    radialWindow.setBounds({
        x: adjustedX,
        y: adjustedY,
        width: RADIAL_SIZE,
        height: RADIAL_SIZE,
    });
    // Send cursor position to renderer (relative to window center)
    radialWindow.webContents.send('radial:show', {
        centerX: RADIAL_SIZE / 2,
        centerY: RADIAL_SIZE / 2,
    });
    radialWindow.show();
};
export const hideRadialWindow = () => {
    isRadialShowing = false;
    if (radialWindow) {
        radialWindow.webContents.send('radial:hide');
        radialWindow.hide();
    }
};
export const updateRadialCursor = (x, y) => {
    if (!radialWindow || !radialWindow.isVisible())
        return;
    // Get window bounds to calculate relative cursor position
    const bounds = radialWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x, y });
    const scaleFactor = display.scaleFactor ?? 1;
    const relativeX = x / scaleFactor - bounds.x;
    const relativeY = y / scaleFactor - bounds.y;
    radialWindow.webContents.send('radial:cursor', {
        x: relativeX,
        y: relativeY,
        centerX: RADIAL_SIZE / 2,
        centerY: RADIAL_SIZE / 2,
    });
};
export const getRadialWindow = () => radialWindow;
export const RADIAL_WEDGES = ['capture', 'chat', 'full', 'voice', 'auto'];
const DEAD_ZONE_RADIUS = 30; // Larger center zone for "dismiss"
export const calculateSelectedWedge = (cursorX, cursorY, centerX, centerY) => {
    const dx = cursorX - centerX;
    const dy = cursorY - centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // Center zone = dismiss (cancel action)
    if (distance < DEAD_ZONE_RADIUS) {
        return 'dismiss';
    }
    // Calculate angle (0 = right, going clockwise)
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    // Normalize to 0-360
    if (angle < 0)
        angle += 360;
    // 5 wedges, each 72 degrees
    // Starting from top (-90 degrees / 270 degrees)
    // Adjust angle to start from top
    angle = (angle + 90) % 360;
    // Determine wedge index
    const wedgeIndex = Math.floor(angle / 72);
    // Map: 0=Capture (top), 1=Chat (top-right), 2=Full (bottom-right), 3=Voice (bottom-left), 4=Auto (top-left)
    return RADIAL_WEDGES[wedgeIndex] ?? 'dismiss';
};
