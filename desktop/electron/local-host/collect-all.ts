/**
 * Collect All User Signals
 *
 * Orchestrates parallel collection of all user signal sources:
 * - Browser history (existing)
 * - Dev projects (git repos)
 * - Shell history (command patterns)
 * - Apps (running + recently used with paths)
 */

import { collectBrowserData, formatBrowserDataForSynthesis } from "./browser-data.js";
import { collectDevProjects, formatDevProjectsForSynthesis } from "./dev-projects.js";
import { analyzeShellHistory, formatShellAnalysisForSynthesis } from "./shell-history.js";
import { discoverApps, formatAppDiscoveryForSynthesis } from "./app-discovery.js";

import type { AllUserSignals, AllUserSignalsResult } from "./types.js";

const log = (...args: unknown[]) => console.log("[collect-all]", ...args);

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

/**
 * Collect all user signals in parallel
 */
export const collectAllUserSignals = async (
  stellarHome: string
): Promise<AllUserSignals> => {
  log("Starting parallel collection of all user signals...");
  const start = Date.now();

  // All collections run in parallel for speed
  const [browser, devProjects, shell, appResult] = await Promise.all([
    collectBrowserData(stellarHome),
    collectDevProjects(),
    analyzeShellHistory(),
    discoverApps(),
  ]);

  const elapsed = Date.now() - start;
  log(`Collection complete in ${elapsed}ms`);

  return {
    browser,
    devProjects,
    shell,
    apps: appResult.apps,
  };
};

// ---------------------------------------------------------------------------
// Formatting for LLM Synthesis
// ---------------------------------------------------------------------------

/**
 * Format all collected data for LLM synthesis into CORE_MEMORY
 */
export const formatAllSignalsForSynthesis = (data: AllUserSignals): string => {
  const sections: string[] = [];

  // Browser data
  const browserSection = formatBrowserDataForSynthesis(data.browser);
  if (browserSection && browserSection !== "No browser data available.") {
    sections.push(browserSection);
  }

  // Dev projects
  const projectsSection = formatDevProjectsForSynthesis(data.devProjects);
  if (projectsSection) {
    sections.push(projectsSection);
  }

  // Shell history
  const shellSection = formatShellAnalysisForSynthesis(data.shell);
  if (shellSection) {
    sections.push(shellSection);
  }

  // Apps
  const appsSection = formatAppDiscoveryForSynthesis({ apps: data.apps });
  if (appsSection) {
    sections.push(appsSection);
  }

  return sections.join("\n\n");
};

// ---------------------------------------------------------------------------
// IPC Handler Helper
// ---------------------------------------------------------------------------

/**
 * Collect and format all signals - for use in IPC handler
 */
export const collectAllSignals = async (
  stellarHome: string
): Promise<AllUserSignalsResult> => {
  try {
    const data = await collectAllUserSignals(stellarHome);
    const formatted = formatAllSignalsForSynthesis(data);

    return {
      data,
      formatted,
    };
  } catch (error) {
    log("Error collecting signals:", error);
    return {
      data: null,
      formatted: null,
      error: (error as Error).message,
    };
  }
};
