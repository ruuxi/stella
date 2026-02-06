/**
 * Dev Projects Discovery
 *
 * Finds active development projects by scanning for git repos
 * and checking recency via .git folder modification times.
 */
import type { DevProject } from "./types.js";
export declare const collectDevProjects: () => Promise<DevProject[]>;
/**
 * Format dev projects for LLM synthesis
 */
export declare const formatDevProjectsForSynthesis: (projects: DevProject[]) => string;
