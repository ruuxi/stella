import { getSelectedText } from './selected-text.js';
import { getWindowInfoAtPoint } from './window-capture.js';
export const captureChatContext = async (point, options) => {
    const excludePids = options?.excludeCurrentProcessWindows ? [process.pid] : undefined;
    // Capture selected text and window metadata in parallel.
    const [selectedText, windowInfo] = await Promise.all([
        getSelectedText(),
        getWindowInfoAtPoint(point.x, point.y, { excludePids }),
    ]);
    const window = windowInfo && (windowInfo.title || windowInfo.process)
        ? {
            title: windowInfo.title,
            app: windowInfo.process,
            bounds: windowInfo.bounds,
        }
        : null;
    return {
        window,
        browserUrl: null,
        selectedText,
        regionScreenshots: [],
    };
};
