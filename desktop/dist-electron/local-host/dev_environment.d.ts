import type { DevEnvironmentSignals } from "./discovery_types.js";
export declare function collectDevEnvironment(): Promise<DevEnvironmentSignals>;
export declare function formatDevEnvironmentForSynthesis(data: DevEnvironmentSignals): string;
