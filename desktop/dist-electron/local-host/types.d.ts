/**
 * Shared types for user signal collection
 */
import type { BrowserData } from "./browser-data.js";
export type DevProject = {
    name: string;
    path: string;
    lastActivity: number;
};
export type CommandFrequency = {
    command: string;
    count: number;
};
export type ShellAnalysis = {
    topCommands: CommandFrequency[];
    projectPaths: string[];
    toolsUsed: string[];
};
export type DiscoveredApp = {
    name: string;
    executablePath: string;
    source: "running" | "recent";
    lastUsed?: number;
};
export type AppDiscoveryResult = {
    apps: DiscoveredApp[];
};
export type AllUserSignals = {
    browser: BrowserData;
    devProjects: DevProject[];
    shell: ShellAnalysis;
    apps: DiscoveredApp[];
};
export type AllUserSignalsResult = {
    data: AllUserSignals | null;
    formatted: string | null;
    error?: string;
};
