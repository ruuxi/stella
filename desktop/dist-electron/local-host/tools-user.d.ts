/**
 * User interaction tools: AskUser, RequestCredential handlers.
 */
import type { ToolResult } from "./tools-types.js";
export type UserToolsConfig = {
    requestCredential?: (payload: {
        provider: string;
        label?: string;
        description?: string;
        placeholder?: string;
    }) => Promise<{
        secretId: string;
        provider: string;
        label: string;
    }>;
};
export declare const handleAskUser: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleRequestCredential: (config: UserToolsConfig, args: Record<string, unknown>) => Promise<ToolResult>;
