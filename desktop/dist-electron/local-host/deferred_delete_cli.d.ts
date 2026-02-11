export declare const extractPowerShellDeleteTargets: (command: string) => string[];
export declare const extractPythonDeleteTargets: (code: string) => string[];
export declare const runDeferredDeleteCli: (argv: string[]) => Promise<number>;
