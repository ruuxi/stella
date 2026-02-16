type BridgeBundle = {
    provider: string;
    code: string;
    env: Record<string, string>;
    dependencies: string;
};
export declare function deploy(bundle: BridgeBundle): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function start(provider: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function stop(provider: string): {
    ok: boolean;
};
export declare function stopAll(): void;
export declare function isRunning(provider: string): boolean;
export {};
