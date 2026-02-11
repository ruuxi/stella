/**
 * Shared type definitions for the tools system.
 */
export type ToolContext = {
    conversationId: string;
    deviceId: string;
    requestId: string;
    agentType?: string;
};
export type ToolResult = {
    result?: unknown;
    error?: string;
};
export type SecretMountSpec = {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
};
export type SecretMounts = {
    env?: Record<string, SecretMountSpec>;
    files?: Record<string, SecretMountSpec>;
};
export type ResolvedSecret = {
    secretId: string;
    provider: string;
    label: string;
    plaintext: string;
};
export type ShellRecord = {
    id: string;
    command: string;
    cwd: string;
    output: string;
    running: boolean;
    exitCode: number | null;
    startedAt: number;
    completedAt: number | null;
    kill: () => void;
};
export type TaskRecord = {
    id: string;
    description: string;
    status: "running" | "completed" | "error";
    result?: string;
    error?: string;
    startedAt: number;
    completedAt: number | null;
};
export type ToolHostOptions = {
    StellaHome: string;
    frontendRoot?: string;
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
    resolveSecret?: (payload: {
        provider: string;
        secretId?: string;
        requestId?: string;
        toolName?: string;
        deviceId?: string;
    }) => Promise<ResolvedSecret | null>;
};
export type SkillRecord = {
    id: string;
    name: string;
    description: string;
    markdown: string;
    agentTypes: string[];
    toolsAllowlist?: string[];
    tags?: string[];
    execution?: "backend" | "device";
    requiresSecrets?: string[];
    publicIntegration?: boolean;
    secretMounts?: SecretMounts;
    version: number;
    source: string;
    filePath: string;
};
export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
