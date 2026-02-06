/**
 * System Signals Collector
 *
 * Gathers behavioral data:
 * - Screen Time / app usage (knowledgeC.db on macOS, ActivitiesCache.db on Windows)
 * - Dock pins (macOS)
 * - Filesystem signals (Downloads, Documents, Desktop)
 *
 * NO theme/accessibility/appearance signals — only behavioral data.
 */
import type { SystemSignals } from "./discovery_types.js";
export declare function collectSystemSignals(stellaHome: string): Promise<SystemSignals>;
export declare function formatSystemSignalsForSynthesis(data: SystemSignals): string;
