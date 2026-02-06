/**
 * Collect All User Signals
 *
 * Orchestrates parallel collection of all user signal sources:
 * - Browser history (existing)
 * - Dev projects (git repos)
 * - Shell history (command patterns)
 * - Apps (running + recently used with paths)
 */
import type { AllUserSignals, AllUserSignalsResult } from "./types.js";
/**
 * Collect all user signals in parallel
 */
export declare const collectAllUserSignals: (StellaHome: string) => Promise<AllUserSignals>;
/**
 * Format all collected data for LLM synthesis into CORE_MEMORY
 */
export declare const formatAllSignalsForSynthesis: (data: AllUserSignals) => string;
/**
 * Collect and format all signals - for use in IPC handler
 */
export declare const collectAllSignals: (StellaHome: string) => Promise<AllUserSignalsResult>;
