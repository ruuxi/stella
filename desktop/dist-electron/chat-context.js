import { getSelectedText } from './selected-text.js';
export const captureChatContext = async (_point) => {
    // Get selected text via platform-native API (UI Automation on Windows, Accessibility on macOS)
    const selectedText = await getSelectedText();
    return {
        window: null,
        browserUrl: null,
        selectedText,
        regionScreenshots: [],
    };
};
