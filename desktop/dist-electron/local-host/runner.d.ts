type HostRunnerOptions = {
    deviceId: string;
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
};
export declare const createLocalHostRunner: ({ deviceId, StellaHome, frontendRoot, requestCredential }: HostRunnerOptions) => {
    deviceId: string;
    setConvexUrl: (url: string) => void;
    setAuthToken: (token: string | null) => void;
    start: () => void;
    stop: () => void;
    executeTool: (toolName: string, toolArgs: Record<string, unknown>, context: {
        conversationId: string;
        deviceId: string;
        requestId: string;
        agentType?: string;
    }) => Promise<import("./tools-types.js").ToolResult>;
    runQuery: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T | null>;
    subscribeQuery: (name: string, args: Record<string, unknown>, onUpdate: (value: unknown) => void) => (() => void) | null;
    getConvexUrl: () => string | null;
    getAuthToken: () => string | null;
};
export {};
