/**
 * Shared utilities for the tools system.
 */
export declare const MAX_OUTPUT = 30000;
export declare const MAX_FILE_BYTES = 1000000;
export declare const log: (...args: unknown[]) => void;
export declare const logError: (...args: unknown[]) => void;
export declare const sanitizeForLogs: (value: unknown) => unknown;
export declare const ensureAbsolutePath: (filePath: string) => {
    ok: false;
    error: string;
} | {
    ok: true;
    error?: undefined;
};
export declare const toPosix: (value: string) => string;
export declare const expandHomePath: (value: string) => string;
export declare const truncate: (value: string, max?: number) => string;
export declare const isIgnoredDir: (name: string) => name is "node_modules" | ".git" | "dist" | "dist-electron" | "release";
export declare const globToRegExp: (pattern: string) => RegExp;
export declare const walkFiles: (basePath: string) => Promise<string[]>;
export declare const readFileSafe: (filePath: string) => Promise<{
    ok: false;
    error: string;
    content?: undefined;
} | {
    ok: true;
    content: string;
    error?: undefined;
}>;
export declare const formatWithLineNumbers: (content: string, offset?: number, limit?: number) => {
    header: string;
    body: string;
};
export declare const stripHtml: (html: string) => string;
export declare const getStatePath: (stateRoot: string, kind: string, id: string) => string;
export declare const loadJson: <T>(filePath: string, fallback: T) => Promise<T>;
export declare const saveJson: (filePath: string, value: unknown) => Promise<void>;
export declare const writeSecretFile: (filePath: string, value: string, cwd: string) => Promise<string>;
