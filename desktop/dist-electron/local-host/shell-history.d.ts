/**
 * Shell History Analysis
 *
 * Extracts actual tool usage patterns and project paths from shell history.
 * High signal: what they actually run, not what's installed.
 */
import type { ShellAnalysis } from "./types.js";
export declare const analyzeShellHistory: () => Promise<ShellAnalysis>;
/**
 * Format shell analysis for LLM synthesis
 */
export declare const formatShellAnalysisForSynthesis: (data: ShellAnalysis) => string;
