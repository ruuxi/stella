/**
 * Collect All User Signals
 *
 * Orchestrates parallel collection of all user signal sources,
 * organized into 4 onboarding-selectable categories:
 *
 * Category 1 (browsing_bookmarks): Browser history + bookmarks + Safari
 * Category 2 (dev_environment): Dev projects + shell + git config + dotfiles
 * Category 3 (apps_system): Apps + Screen Time + Dock + filesystem
 * Category 4 (messages_notes): iMessage + Notes + Reminders + Calendar (opt-in)
 */

import { promises as fs } from "fs";
import path from "path";
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

const DISCOVERY_CATEGORIES_STATE_FILE = "discovery_categories.json";

type FormattedCategorySections = Partial<Record<DiscoveryCategory, string>>;

const joinSections = (sections: string[]): string =>
  sections.filter((s) => s && s.trim().length > 0).join("\n\n");

const persistSelectedCategories = async (
  stellaHome: string,
  categories: DiscoveryCategory[],
): Promise<void> => {
  try {
    const stateDir = path.join(stellaHome, "state");
    const statePath = path.join(stateDir, DISCOVERY_CATEGORIES_STATE_FILE);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ categories, updatedAt: Date.now() }, null, 2),
      "utf-8",
    );
  } catch (error) {
    log("Failed to persist selected discovery categories:", error);
  }
};

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
      return { gitConfig: null, dotfiles: [], runtimes: [], packageManagers: [], wslDetected: false };
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
  const { formatted } = await formatSignalsForSynthesisWithSections(
    data,
    StellaHome,
    categories,
  );
  return formatted;
};

const formatSignalsForSynthesisWithSections = async (
  data: ExtendedUserSignals,
  StellaHome: string,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
): Promise<{ formatted: string; formattedSections: FormattedCategorySections }> => {
  const formattedSections: FormattedCategorySections = {};

  // --- Category 1: Browsing & Bookmarks ---
  if (categories.includes("browsing_bookmarks")) {
    const categorySections: string[] = [];

    const browserSection = formatBrowserDataForSynthesis(data.browser);
    if (browserSection && browserSection !== "No browser data available.") {
      categorySections.push(browserSection);
    }

    if (data.bookmarks) {
      const bookmarksSection = formatBrowserBookmarksForSynthesis(data.bookmarks);
      if (bookmarksSection) categorySections.push(bookmarksSection);
    }

    if (data.safari) {
      const safariSection = formatSafariDataForSynthesis(data.safari);
      if (safariSection) categorySections.push(safariSection);
    }

    const categoryFormatted = joinSections(categorySections);
    if (categoryFormatted) {
      formattedSections.browsing_bookmarks = categoryFormatted;
    }
  }

  // --- Category 2: Development Environment ---
  if (categories.includes("dev_environment")) {
    const categorySections: string[] = [];

    const projectsSection = formatDevProjectsForSynthesis(data.devProjects);
    if (projectsSection) categorySections.push(projectsSection);

    const shellSection = formatShellAnalysisForSynthesis(data.shell);
    if (shellSection) categorySections.push(shellSection);

    if (data.devEnvironment) {
      const devEnvSection = formatDevEnvironmentForSynthesis(data.devEnvironment);
      if (devEnvSection) categorySections.push(devEnvSection);
    }

    const categoryFormatted = joinSections(categorySections);
    if (categoryFormatted) {
      formattedSections.dev_environment = categoryFormatted;
    }
  }

  // --- Category 3: Apps & System ---
  if (categories.includes("apps_system")) {
    const categorySections: string[] = [];

    const appsSection = formatAppDiscoveryForSynthesis({ apps: data.apps });
    if (appsSection) categorySections.push(appsSection);

    if (data.systemSignals) {
      const systemSection = formatSystemSignalsForSynthesis(data.systemSignals);
      if (systemSection) categorySections.push(systemSection);
    }

    const categoryFormatted = joinSections(categorySections);
    if (categoryFormatted) {
      formattedSections.apps_system = categoryFormatted;
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
    let identityMap: Awaited<ReturnType<typeof loadIdentityMap>> | null = null;
    const getIdentityMap = async () => {
      if (!identityMap) {
        identityMap = await loadIdentityMap(StellaHome);
      }
      return identityMap;
    };

    let messagesSection = formatMessagesNotesForSynthesis(data.messagesNotes);
    if (messagesSection) {
      const map = await getIdentityMap();
      if (map.mappings.length > 0) {
        messagesSection = pseudonymize(messagesSection, map);
      }
      formattedSections.messages_notes = messagesSection;
    }

    // Also pseudonymize git config in dev environment section if present
    if (data.devEnvironment?.gitConfig?.name && formattedSections.dev_environment) {
      const map = await getIdentityMap();
      if (map.mappings.length > 0) {
        formattedSections.dev_environment = pseudonymize(
          formattedSections.dev_environment,
          map,
        );
      }
    }
  }

  const orderedSections = categories
    .map((category) => formattedSections[category])
    .filter((section): section is string => Boolean(section && section.trim().length > 0));

  return {
    formatted: orderedSections.join("\n\n"),
    formattedSections,
  };
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
    await persistSelectedCategories(StellaHome, cats);
    const data = await collectAllUserSignals(StellaHome, cats);
    const { formatted, formattedSections } = await formatSignalsForSynthesisWithSections(
      data,
      StellaHome,
      cats,
    );

    return {
      data,
      formatted,
      formattedSections,
    };
  } catch (error) {
    log("Error collecting signals:", error);
    return {
      data: null,
      formatted: null,
      formattedSections: null,
      error: (error as Error).message,
    };
  }
};
