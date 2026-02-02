/**
 * Mouse blocking helper for Windows
 * Spawns a standalone .exe that uses WH_MOUSE_LL to intercept Ctrl+Right-click
 * Communication via stdout - simpler than N-API addon, no node-gyp needed
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let helperProcess = null;
let currentCallback = null;
let isReady = false;
/**
 * Find the helper executable
 */
const findHelperPath = () => {
    // Check various locations
    const candidates = [
        // Development: next to dist-electron
        path.join(__dirname, '..', 'native', 'mouse_block.exe'),
        // Production: in resources
        path.join(__dirname, '..', '..', 'native', 'mouse_block.exe'),
        // Alternative: same directory
        path.join(__dirname, 'mouse_block.exe'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
};
/**
 * Start the mouse blocking helper
 * Returns true if started successfully
 */
export const startMouseBlock = (callback) => {
    if (process.platform !== 'win32') {
        console.log('[mouse-block] Not on Windows, skipping');
        return false;
    }
    if (helperProcess) {
        console.log('[mouse-block] Already running');
        return isReady;
    }
    const helperPath = findHelperPath();
    if (!helperPath) {
        console.warn('[mouse-block] Helper executable not found');
        console.warn('[mouse-block] Build it with: cl /O2 mouse_block.cpp /link user32.lib');
        return false;
    }
    console.log('[mouse-block] Starting helper:', helperPath);
    currentCallback = callback;
    try {
        helperProcess = spawn(helperPath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        helperProcess.stdout?.setEncoding('utf8');
        helperProcess.stderr?.setEncoding('utf8');
        helperProcess.stdout?.on('data', (data) => {
            const lines = data.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(' ');
                const cmd = parts[0];
                if (cmd === 'READY') {
                    isReady = true;
                    console.log('[mouse-block] Helper ready');
                }
                else if (cmd === 'DOWN' && parts.length >= 3) {
                    const x = parseInt(parts[1], 10);
                    const y = parseInt(parts[2], 10);
                    currentCallback?.('down', x, y);
                }
                else if (cmd === 'UP' && parts.length >= 3) {
                    const x = parseInt(parts[1], 10);
                    const y = parseInt(parts[2], 10);
                    currentCallback?.('up', x, y);
                }
                else if (cmd === 'EXIT') {
                    console.log('[mouse-block] Helper exited cleanly');
                }
            }
        });
        helperProcess.stderr?.on('data', (data) => {
            console.error('[mouse-block] Helper error:', data.trim());
        });
        helperProcess.on('exit', (code) => {
            console.log('[mouse-block] Helper exited with code:', code);
            helperProcess = null;
            isReady = false;
        });
        helperProcess.on('error', (error) => {
            console.error('[mouse-block] Helper spawn error:', error);
            helperProcess = null;
            isReady = false;
        });
        // Wait briefly for READY signal
        return true; // Will be ready shortly
    }
    catch (error) {
        console.error('[mouse-block] Failed to start helper:', error);
        return false;
    }
};
/**
 * Stop the mouse blocking helper
 */
export const stopMouseBlock = () => {
    if (!helperProcess) {
        return true;
    }
    try {
        helperProcess.kill('SIGTERM');
        helperProcess = null;
        isReady = false;
        currentCallback = null;
        return true;
    }
    catch (error) {
        console.error('[mouse-block] Failed to stop helper:', error);
        return false;
    }
};
/**
 * Check if native blocking is available (helper exists)
 */
export const isNativeBlockingAvailable = () => {
    if (process.platform !== 'win32') {
        return false;
    }
    return findHelperPath() !== null;
};
