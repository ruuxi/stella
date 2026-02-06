import type { ParsedAgent, ParsedSkill } from "./manifests.js";
type ToolResult = {
    result?: unknown;
    error?: string;
};
type ToolContext = {
    conversationId: string;
    deviceId: string;
    requestId: string;
};
type PluginToolSchema = {
    type?: string;
    description?: string;
    properties?: Record<string, PluginToolSchema>;
    required?: string[];
    items?: PluginToolSchema;
    enum?: string[];
};
export type PluginRecord = {
    id: string;
    name: string;
    version: string;
    description?: string;
    source: string;
};
export type PluginToolDescriptor = {
    pluginId: string;
    name: string;
    description: string;
    inputSchema: PluginToolSchema;
    source: string;
};
type PluginLoadResult = {
    plugins: PluginRecord[];
    tools: PluginToolDescriptor[];
    skills: ParsedSkill[];
    agents: ParsedAgent[];
    handlers: Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>>;
};
export declare const loadPluginsFromHome: (pluginsPath: string) => Promise<PluginLoadResult>;
export {};
