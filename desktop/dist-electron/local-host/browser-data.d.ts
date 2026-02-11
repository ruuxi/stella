/**
 * Browser Data Collection Script
 *
 * Extracts browsing patterns from local browser databases.
 * Runs once on first launch to populate core memory data.
 *
 * Detection strategy:
 * 1. Detect the user's DEFAULT browser from OS settings
 * 2. Find the LAST USED profile from the browser's Local State file
 * 3. Fall back to checking all browsers/profiles if detection fails
 */
export type BrowserType = "chrome" | "edge" | "brave" | "arc" | "opera" | "vivaldi";
export type DomainVisit = {
    domain: string;
    visits: number;
};
export type DomainDetail = {
    title: string;
    url: string;
    visitCount: number;
};
export type BrowserData = {
    browser: BrowserType | null;
    clusterDomains: string[];
    recentDomains: DomainVisit[];
    allTimeDomains: DomainVisit[];
    domainDetails: Record<string, DomainDetail[]>;
};
/**
 * Collect browser data from the user's default browser
 */
export declare const collectBrowserData: (StellaHome: string) => Promise<BrowserData>;
/**
 * Check if core memory already exists
 */
export declare const coreMemoryExists: (StellaHome: string) => Promise<boolean>;
/**
 * Write core memory profile to disk
 */
export declare const writeCoreMemory: (StellaHome: string, content: string) => Promise<void>;
/**
 * Read core memory profile from disk
 */
export declare const readCoreMemory: (StellaHome: string) => Promise<string | null>;
/**
 * Format browser data for LLM synthesis input
 */
export declare const formatBrowserDataForSynthesis: (data: BrowserData) => string;
