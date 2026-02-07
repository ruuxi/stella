import { desktopCapturer } from 'electron';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_THUMB_SIZE = { width: 1280, height: 960 };
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
 * Pre-fetch desktop capturer sources before showing any overlay windows.
 * Call this while the screen is still clean, then pass the result to captureWindowAtPoint.
 * Pass excludeSourceIds to filter out known windows (e.g. the mini shell).
 */
export const prefetchWindowSources = (excludeSourceIds) => {
    return desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: DEFAULT_THUMB_SIZE,
    }).then((sources) => {
        if (!excludeSourceIds?.length)
            return sources;
        const excluded = new Set(excludeSourceIds);
        return sources.filter((s) => !excluded.has(s.id));
    });
};
export const captureWindowAtPoint = async (x, y, prefetchedSources, options) => {
    const info = await queryWindowInfo(x, y, options);
    if (!info || !info.title)
        return null;
    const sources = prefetchedSources ?? await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: info.bounds.width, height: info.bounds.height },
    });
    // Match by title (best effort — desktopCapturer source names are window titles)
    const titleLower = info.title.toLowerCase();
    const match = sources.find((s) => s.name.toLowerCase() === titleLower)
        ?? sources.find((s) => titleLower.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(titleLower));
    if (!match)
        return null;
    const image = match.thumbnail;
    if (image.isEmpty())
        return null;
    const png = image.toPNG();
    const size = image.getSize();
    return {
        windowInfo: info,
        screenshot: {
            dataUrl: `data:image/png;base64,${png.toString('base64')}`,
            width: size.width,
            height: size.height,
        },
    };
};
