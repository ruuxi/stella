/**
 * Shell tools: Bash, SkillBash handlers. KillShell is handled via Bash's kill_shell_id param.
 */
import type { ToolContext, ToolResult, ShellRecord, SecretMountSpec, PluginSyncPayload } from "./tools-types.js";
export type ShellState = {
    shells: Map<string, ShellRecord>;
    skillCache: PluginSyncPayload["skills"];
    resolveSecretValue: (spec: SecretMountSpec, cache: Map<string, string>) => Promise<string | null>;
};
export declare const createShellState: (resolveSecretValue: ShellState["resolveSecretValue"]) => ShellState;
export declare const startShell: (state: ShellState, command: string, cwd: string, envOverrides?: Record<string, string>) => ShellRecord;
export declare const runShell: (command: string, cwd: string, timeoutMs: number, envOverrides?: Record<string, string>) => Promise<string>;
export declare const handleBash: (state: ShellState, args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
export declare const handleSkillBash: (state: ShellState, args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleKillShell: (state: ShellState, args: Record<string, unknown>) => Promise<ToolResult>;
