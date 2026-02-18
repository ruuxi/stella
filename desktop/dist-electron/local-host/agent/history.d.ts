/**
 * History message builder — converts event rows from SQLite to LLM-friendly messages.
 * Ported from backend/convex/agent/history_messages.ts + context_window.ts
 */
type EventRow = {
    id: string;
    conversation_id: string;
    timestamp: number;
    type: string;
    payload: Record<string, unknown> | string;
    request_id?: string;
    device_id?: string;
};
export type HistoryMessage = {
    role: "user" | "assistant";
    content: string;
};
export declare const ORCHESTRATOR_HISTORY_MAX_TOKENS = 24000;
export declare const SUBAGENT_HISTORY_MAX_TOKENS = 20000;
export declare function loadRecentEvents(conversationId: string, maxTokens: number, beforeTimestamp?: number, excludeEventId?: string): EventRow[];
export declare function eventsToHistoryMessages(events: EventRow[]): HistoryMessage[];
export {};
