/**
 * Command Sync
 *
 * Reads bundled command markdown files from resources/bundled-commands/
 * and syncs them to the backend commands table.
 */
export declare function syncBundledCommands(bundledCommandsPath: string, callMutation: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<void>;
