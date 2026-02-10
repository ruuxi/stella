/**
 * Signal Processing — filtering and tiering for synthesis input.
 *
 * Applied as post-processing on formatted signals before sending to the LLM.
 * - filterLowSignalDomains: removes low-visit-count domains using an adaptive threshold
 * - tierFormattedSignals: reorganizes flat sections into priority tiers
 */
/**
 * Remove low-visit-count domains from browser signals.
 *
 * Formula: threshold = max(ABSOLUTE_MIN, top5_avg * RELATIVE_FACTOR)
 * - ABSOLUTE_MIN = 5 — always drops domains with < 5 visits
 * - RELATIVE_FACTOR = 0.05 — 5% of the top-5 domain average; scales with activity
 * - AI chat sites always bypass the threshold
 * - Individual page titles with count < TITLE_MIN_COUNT are pruned for non-chat sites
 */
export declare function filterLowSignalDomains(formatted: string): string;
/**
 * Reorganize flat formatted signals into priority tiers.
 *
 * - Tier 1 (Core): Active Projects, Browser Data, Shell History
 * - Tier 2 (Supporting): Everything not in Tier 1 or 3
 * - Tier 3 (Supplementary): Apps, System Signals
 */
export declare function tierFormattedSignals(formatted: string): string;
