/**
 * App Discovery
 *
 * Discovers apps with executable paths for Stella to launch.
 * Sources:
 * 1. Currently running apps (highest signal)
 * 2. Recently used apps (check data folder mtime)
 */
import type { AppDiscoveryResult } from "./types.js";
export declare const discoverApps: () => Promise<AppDiscoveryResult>;
/**
 * Format app discovery for LLM synthesis
 * Includes executable paths so Stella can launch apps
 */
export declare const formatAppDiscoveryForSynthesis: (result: AppDiscoveryResult) => string;
