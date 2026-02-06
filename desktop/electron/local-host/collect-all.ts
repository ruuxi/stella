/**
 * Collect All User Signals
 *
 * Orchestrates parallel collection of all user signal sources,
 * organized into 4 onboarding-selectable categories:
 *
 * Category 1 (browsing_bookmarks): Browser history + bookmarks + Safari
 * Category 2 (dev_environment): Dev projects + shell + IDE config + dotfiles
 * Category 3 (apps_system): Apps + Screen Time + Dock + filesystem
 * Category 4 (messages_notes): iMessage + Notes + Reminders + Calendar (opt-in)
 */

import { collectBrowserData, formatBrowserDataForSynthesis } from "./browser-data.js";
import { collectDevProjects, formatDevProjectsForSynthesis } from "./dev-projects.js";
import { analyzeShellHistory, formatShellAnalysisForSynthesis } from "./shell-history.js";
import { discoverApps, formatAppDiscoveryForSynthesis } from "./app-discovery.js";
import { collectBrowserBookmarks, formatBrowserBookmarksForSynthesis } from "./browser_bookmarks.js";
import { collectSafariData, formatSafariDataForSynthesis } from "./safari_data.js";
import { collectDevEnvironment, formatDevEnvironmentForSynthesis } from "./dev_environment.js";
import { collectSystemSignals, formatSystemSignalsForSynthesis } from "./system_signals.js";
import { collectMessagesNotes, formatMessagesNotesForSynthesis } from "./messages_notes.js";
import { addContacts, pseudonymize, loadIdentityMap } from "./identity_map.js";

import type { AllUserSignals, AllUserSignalsResult } from "./types.js";
import type { DiscoveryCategory, BrowserBookmarks, SafariData, DevEnvironmentSignals, SystemSignals, MessagesNotesSignals } from "./discovery_types.js";

const log = (...args: unknown[]) => console.log("[collect-all]", ...args);

// Default categories (Category 4 is opt-in)
const DEFAULT_CATEGORIES: DiscoveryCategory[] = [
  "browsing_bookmarks",
  "dev_environment",
  "apps_system",
];

// ---------------------------------------------------------------------------
// Extended Signals Type
// ---------------------------------------------------------------------------

type ExtendedUserSignals = AllUserSignals & {
  bookmarks?: BrowserBookmarks | null;
  safari?: SafariData | null;
  devEnvironment?: DevEnvironmentSignals;
  systemSignals?: SystemSignals;
  messagesNotes?: MessagesNotesSignals;
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

/**
 * Collect all user signals in parallel, filtered by selected categories
 */
export const collectAllUserSignals = async (
  StellaHome: string,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
): Promise<ExtendedUserSignals> => {
  log("Starting parallel collection for categories:", categories);
  const start = Date.now();

  // Build list of promises based on selected categories
  const tasks: Record<string, Promise<unknown>> = {};

  if (categories.includes("browsing_bookmarks")) {
    tasks.browser = collectBrowserData(StellaHome);
    tasks.bookmarks = collectBrowserBookmarks().catch((e) => {
      log("Bookmark collection failed:", e);
      return null;
    });
    tasks.safari = collectSafariData(StellaHome).catch((e) => {
      log("Safari collection failed:", e);
      return null;
    });
  }

  if (categories.includes("dev_environment")) {
    tasks.devProjects = collectDevProjects();
    tasks.shell = analyzeShellHistory();
    tasks.devEnv = collectDevEnvironment().catch((e) => {
      log("Dev environment collection failed:", e);
      return { ideExtensions: [], ideSettings: [], gitConfig: null, dotfiles: [], runtimes: [], packageManagers: [], wslDetected: false };
    });
  }

  if (categories.includes("apps_system")) {
    tasks.apps = discoverApps();
    tasks.system = collectSystemSignals(StellaHome).catch((e) => {
      log("System signals collection failed:", e);
      return { dockPins: [], appUsage: [], filesystem: { downloadsExtensions: {}, documentsFolders: [], desktopFileTypes: {} } };
    });
  }

  if (categories.includes("messages_notes")) {
    tasks.messagesNotes = collectMessagesNotes(StellaHome).catch((e) => {
      log("Messages/notes collection failed:", e);
      return { contacts: [], groupChats: [], noteFolders: [], calendars: [] };
    });
  }

  // Run all tasks in parallel
  const keys = Object.keys(tasks);
  const values = await Promise.all(Object.values(tasks));
  const results: Record<string, unknown> = {};
  keys.forEach((key, i) => { results[key] = values[i]; });

  const elapsed = Date.now() - start;
  log(`Collection complete in ${elapsed}ms`);

  // Assemble the output
  const appResult = results.apps as { apps: { name: string; executablePath: string; source: "running" | "recent"; lastUsed?: number }[] } | undefined;

  return {
    // Existing signals (may be undefined if category not selected)
    browser: (results.browser as AllUserSignals["browser"]) ?? { browser: null, clusterDomains: [], recentDomains: [], allTimeDomains: [], domainDetails: {} },
    devProjects: (results.devProjects as AllUserSignals["devProjects"]) ?? [],
    shell: (results.shell as AllUserSignals["shell"]) ?? { topCommands: [], projectPaths: [], toolsUsed: [] },
    apps: appResult?.apps ?? [],
    // New signals
    bookmarks: results.bookmarks as BrowserBookmarks | null | undefined,
    safari: results.safari as SafariData | null | undefined,
    devEnvironment: results.devEnv as DevEnvironmentSignals | undefined,
    systemSignals: results.system as SystemSignals | undefined,
    messagesNotes: results.messagesNotes as MessagesNotesSignals | undefined,
  };
};

// ---------------------------------------------------------------------------
// Formatting for LLM Synthesis
// ---------------------------------------------------------------------------

/**
 * Format all collected data for LLM synthesis into CORE_MEMORY.
 * Category 4 output is pseudonymized before inclusion.
 */
export const formatAllSignalsForSynthesis = async (
  data: ExtendedUserSignals,
  StellaHome: string,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
): Promise<string> => {
  const sections: string[] = [];

  // --- Category 1: Browsing & Bookmarks ---
  if (categories.includes("browsing_bookmarks")) {
    const browserSection = formatBrowserDataForSynthesis(data.browser);
    if (browserSection && browserSection !== "No browser data available.") {
      sections.push(browserSection);
    }

    if (data.bookmarks) {
      const bookmarksSection = formatBrowserBookmarksForSynthesis(data.bookmarks);
      if (bookmarksSection) sections.push(bookmarksSection);
    }

    if (data.safari) {
      const safariSection = formatSafariDataForSynthesis(data.safari);
      if (safariSection) sections.push(safariSection);
    }
  }

  // --- Category 2: Development Environment ---
  if (categories.includes("dev_environment")) {
    const projectsSection = formatDevProjectsForSynthesis(data.devProjects);
    if (projectsSection) sections.push(projectsSection);

    const shellSection = formatShellAnalysisForSynthesis(data.shell);
    if (shellSection) sections.push(shellSection);

    if (data.devEnvironment) {
      const devEnvSection = formatDevEnvironmentForSynthesis(data.devEnvironment);
      if (devEnvSection) sections.push(devEnvSection);
    }
  }

  // --- Category 3: Apps & System ---
  if (categories.includes("apps_system")) {
    const appsSection = formatAppDiscoveryForSynthesis({ apps: data.apps });
    if (appsSection) sections.push(appsSection);

    if (data.systemSignals) {
      const systemSection = formatSystemSignalsForSynthesis(data.systemSignals);
      if (systemSection) sections.push(systemSection);
    }
  }

  // --- Category 4: Messages & Notes (pseudonymized) ---
  if (categories.includes("messages_notes") && data.messagesNotes) {
    // Build identity map from contacts + git config
    const contactsToMap: { name: string; identifier: string; source: "imessage" | "calendar" | "notes" | "reminders" | "git_config" }[] = [];

    // Add iMessage contacts
    for (const c of data.messagesNotes.contacts) {
      if (c.displayName && c.identifier) {
        contactsToMap.push({ name: c.displayName, identifier: c.identifier, source: "imessage" });
      }
    }

    // Add git config identity if available
    if (data.devEnvironment?.gitConfig?.name && data.devEnvironment?.gitConfig?.email) {
      contactsToMap.push({
        name: data.devEnvironment.gitConfig.name,
        identifier: data.devEnvironment.gitConfig.email,
        source: "git_config",
      });
    }

    // Add calendar recurring event people (extract names from titles like "1:1 with Sarah")
    for (const cal of data.messagesNotes.calendars) {
      for (const title of cal.recurringTitles) {
        // Simple heuristic: "with {Name}" pattern
        const withMatch = title.match(/\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
        if (withMatch) {
          contactsToMap.push({ name: withMatch[1], identifier: withMatch[1], source: "calendar" });
        }
      }
    }

    // Register contacts in identity map
    if (contactsToMap.length > 0) {
      await addContacts(StellaHome, contactsToMap);
    }

    // Format then pseudonymize
    let messagesSection = formatMessagesNotesForSynthesis(data.messagesNotes);
    if (messagesSection) {
      const identityMap = await loadIdentityMap(StellaHome);
      if (identityMap.mappings.length > 0) {
        messagesSection = pseudonymize(messagesSection, identityMap);
      }
      sections.push(messagesSection);
    }

    // Also pseudonymize git config in dev environment section if present
    if (data.devEnvironment?.gitConfig?.name) {
      const identityMap = await loadIdentityMap(StellaHome);
      if (identityMap.mappings.length > 0) {
        // Re-pseudonymize the dev environment section that was already added
        const devEnvIdx = sections.findIndex((s) => s.startsWith("## Development Environment"));
        if (devEnvIdx >= 0) {
          sections[devEnvIdx] = pseudonymize(sections[devEnvIdx], identityMap);
        }
      }
    }
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
  StellaHome: string,
  categories?: DiscoveryCategory[],
): Promise<AllUserSignalsResult> => {
  try {
    const cats = categories ?? DEFAULT_CATEGORIES;
    const data = await collectAllUserSignals(StellaHome, cats);
    const formatted = await formatAllSignalsForSynthesis(data, StellaHome, cats);

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
