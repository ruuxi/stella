import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const getWindowInfoBin = () => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(__dirname, `../native/window_info${ext}`);
};
const queryWindowInfo = (x, y, options) => {
    return new Promise((resolve) => {
        const args = [String(x), String(y)];
        if (options?.excludePids?.length) {
            args.push(`--exclude-pids=${options.excludePids.join(',')}`);
        }
        execFile(getWindowInfoBin(), args, { timeout: 3000 }, (error, stdout) => {
            if (error) {
                console.warn('window_info failed', error);
                resolve(null);
                return;
            }
            try {
                const info = JSON.parse(stdout.trim());
                if (info.error) {
                    resolve(null);
                    return;
                }
                resolve(info);
            }
            catch {
                resolve(null);
            }
        });
    });
};
export const getWindowInfoAtPoint = (x, y, options) => {
    return queryWindowInfo(x, y, options);
};
/**
 * Capture a window screenshot using the native binary's --screenshot flag.
 * Returns window info + base64 PNG data URL, or null on failure.
 * Uses PrintWindow (Windows) / CGWindowListCreateImage (macOS) to capture
 * a single window directly — no desktopCapturer enumeration needed (~15ms vs 100-500ms).
 */
export const captureWindowScreenshot = async (x, y, options) => {
    const tempPath = path.join(tmpdir(), `stella_cap_${randomBytes(8).toString('hex')}.png`);
    const args = [String(x), String(y), `--screenshot=${tempPath}`];
    if (options?.excludePids?.length) {
        args.push(`--exclude-pids=${options.excludePids.join(',')}`);
    }
    try {
        const stdout = await new Promise((resolve, reject) => {
            execFile(getWindowInfoBin(), args, { timeout: 5000 }, (error, out) => {
                if (error)
                    return reject(error);
                resolve(out);
            });
        });
        const info = JSON.parse(stdout.trim());
        if (info.error)
            return null;
        let pngBuffer;
        try {
            pngBuffer = await fs.readFile(tempPath);
        }
        catch {
            // Screenshot file wasn't created (native capture failed), return info without screenshot
            return null;
        }
        const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
        return {
            windowInfo: info,
            screenshot: {
                dataUrl,
                width: info.bounds.width,
                height: info.bounds.height,
            },
        };
    }
    catch {
        return null;
    }
    finally {
        // Clean up temp file
        fs.unlink(tempPath).catch(() => { });
    }
};
