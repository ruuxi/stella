import type { MessagesNotesSignals } from "./discovery_types.js";
/**
 * Main collection function
 */
export declare function collectMessagesNotes(stellaHome: string): Promise<MessagesNotesSignals>;
/**
 * Format messages and notes signals for synthesis
 */
export declare function formatMessagesNotesForSynthesis(data: MessagesNotesSignals): string;
