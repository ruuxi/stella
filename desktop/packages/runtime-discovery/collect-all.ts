/**
 * Collect All User Signals
 *
 * Orchestrates parallel collection of all user signal sources,
 * organized into 4 onboarding-selectable categories:
 *
 * Category 1 (browsing_bookmarks): Browser history + bookmarks + Safari + Firefox
 * Category 2 (dev_environment): Dev projects + shell + git config + dotfiles
 * Category 3 (apps_system): Apps + Screen Time + Dock + filesystem + Steam + Music
 * Category 4 (messages_notes): iMessage + Notes + Reminders + Calendar (opt-in)
 */

import path from "path";
import {
  collectBrowserData,
  detectPreferredBrowserProfile,
  formatBrowserDataForSynthesis,
} from "./browser-data.js";
import { collectDevProjects, formatDevProjectsForSynthesis } from "./dev-projects.js";
import { analyzeShellHistory, formatShellAnalysisForSynthesis } from "./shell-history.js";
import { discoverApps, formatAppDiscoveryForSynthesis } from "./app-discovery.js";
import { collectBrowserBookmarks, formatBrowserBookmarksForSynthesis } from "./browser-bookmarks.js";
import { collectSafariData, formatSafariDataForSynthesis } from "./safari-data.js";
import { filterLowSignalDomains, tierFormattedSignals } from "./signal-processing.js";
import { collectDevEnvironment, formatDevEnvironmentForSynthesis } from "./dev-environment.js";
import { collectSystemSignals, formatSystemSignalsForSynthesis } from "./system-signals.js";
import { collectMessagesNotes, formatMessagesNotesForSynthesis } from "./messages-notes.js";
import { collectEditorState, formatEditorStateForSynthesis } from "./editor-state.js";
import { collectFirefoxData, formatFirefoxDataForSynthesis } from "./firefox-data.js";
import { collectSteamLibrary, formatSteamLibraryForSynthesis } from "./steam-library.js";
import { collectMusicLibrary, formatMusicLibraryForSynthesis } from "./music-library.js";
import {
  addContacts,
  pseudonymize,
  loadIdentityMap,
} from "../runtime-kernel/home/identity-map.js";
import {
  ensurePrivateDir,
  writePrivateFile,
} from "../runtime-kernel/home/private-fs.js";

import type { AllUserSignals, AllUserSignalsResult } from "./types.js";
import type { DiscoveryCategory } from "../../src/shared/contracts/discovery.js";
import type { BrowserBookmarks, SafariData, DevEnvironmentSignals, SystemSignals, MessagesNotesSignals } from "./discovery-types.js";
import type { EditorStateSignals } from "./editor-state.js";
import type { FirefoxSignals } from "./firefox-data.js";
import type { SteamLibrarySignals } from "./steam-library.js";
import type { MusicLibrarySignals } from "./music-library.js";
import type { BrowserType } from "../boundary-contracts/index.js";

const log = (...args: unknown[]) => console.error("[collect-all]", ...args);

// Default categories (Category 4 is opt-in)
const DEFAULT_CATEGORIES: DiscoveryCategory[] = [
  "browsing_bookmarks",
  "dev_environment",
  "apps_system",
];

const DISCOVERY_CATEGORIES_STATE_FILE = "discovery_categories.json";
const CHROMIUM_BROWSERS = new Set([
  "chrome",
  "edge",
  "brave",
  "arc",
  "opera",
  "vivaldi",
]);

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
    await ensurePrivateDir(stateDir);
    await writePrivateFile(
      statePath,
      JSON.stringify({ categories, updatedAt: Date.now() }, null, 2),
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
  firefox?: FirefoxSignals | null;
  devEnvironment?: DevEnvironmentSignals;
  systemSignals?: SystemSignals;
  messagesNotes?: MessagesNotesSignals;
  editorState?: EditorStateSignals | null;
  steamLibrary?: SteamLibrarySignals | null;
  musicLibrary?: MusicLibrarySignals | null;
};

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

/**
 * Collect all user signals in parallel, filtered by selected categories.
 * When `selectedBrowser` is provided, only that browser's collectors run
 * (skips Firefox, Safari, and generic bookmarks scan for other browsers).
 */
export const collectAllUserSignals = async (
  StellaHome: string,
  categories: DiscoveryCategory[] = DEFAULT_CATEGORIES,
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
): Promise<ExtendedUserSignals> => {
  log("Starting parallel collection for categories:", categories);
  if (selectedBrowser) log("Selected browser:", selectedBrowser);
  if (selectedProfile) log("Selected browser profile:", selectedProfile);
  const start = Date.now();

  // Build list of promises based on selected categories
  const tasks: Record<string, Promise<unknown>> = {};

  if (categories.includes("browsing_bookmarks")) {
    const shouldCollectChromium =
      !selectedBrowser || CHROMIUM_BROWSERS.has(selectedBrowser);
    const preferredChromiumSelection =
      !selectedBrowser && shouldCollectChromium
        ? await detectPreferredBrowserProfile()
        : null;
    const selectedChromiumBrowser = selectedBrowser
      ? ((selectedBrowser as BrowserType | undefined))
      : preferredChromiumSelection?.browser ?? undefined;
    const selectedChromiumProfile = selectedBrowser
      ? selectedProfile
      : preferredChromiumSelection?.profile ?? undefined;

    if (shouldCollectChromium && selectedChromiumBrowser) {
      tasks.browser = collectBrowserData(StellaHome, {
        selectedBrowser: selectedChromiumBrowser,
        selectedProfile: selectedChromiumProfile,
      });
      tasks.bookmarks = collectBrowserBookmarks({
        selectedBrowser: selectedChromiumBrowser,
        selectedProfile: selectedChromiumProfile,
      }).catch((e) => {
        log("Bookmark collection failed:", e);
        return null;
      });
    }

    // Only run Firefox/Safari if no specific browser selected, or if that browser is selected
    if (!selectedBrowser || selectedBrowser === "firefox") {
      tasks.firefox = collectFirefoxData(StellaHome).catch((e) => {
        log("Firefox collection failed:", e);
        return null;
      });
    }
    if (!selectedBrowser || selectedBrowser === "safari") {
      tasks.safari = collectSafariData(StellaHome).catch((e) => {
        log("Safari collection failed:", e);
        return null;
      });
    }
  }

  if (categories.includes("dev_environment")) {
    tasks.devProjects = collectDevProjects();
    tasks.shell = analyzeShellHistory();
    tasks.devEnv = collectDevEnvironment().catch((e) => {
      log("Dev environment collection failed:", e);
      return { gitConfig: null, dotfiles: [], runtimes: [], packageManagers: [], wslDetected: false };
    });
    tasks.editorState = collectEditorState().catch((e) => {
      log("Editor state collection failed:", e);
      return null;
    });
  }

  if (categories.includes("apps_system")) {
    tasks.apps = discoverApps();
    tasks.system = collectSystemSignals(StellaHome).catch((e) => {
      log("System signals collection failed:", e);
      return { dockPins: [], appUsage: [], filesystem: { downloadsExtensions: {}, documentsFolders: [], desktopFileTypes: {} } };
    });
    tasks.steam = collectSteamLibrary().catch((e) => {
      log("Steam library collection failed:", e);
      return null;
    });
    tasks.music = collectMusicLibrary().catch((e) => {
      log("Music library collection failed:", e);
      return null;
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
    firefox: results.firefox as FirefoxSignals | null | undefined,
    devEnvironment: results.devEnv as DevEnvironmentSignals | undefined,
    editorState: results.editorState as EditorStateSignals | null | undefined,
    systemSignals: results.system as SystemSignals | undefined,
    messagesNotes: results.messagesNotes as MessagesNotesSignals | undefined,
    steamLibrary: results.steam as SteamLibrarySignals | null | undefined,
    musicLibrary: results.music as MusicLibrarySignals | null | undefined,
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

    if (data.firefox) {
      const firefoxSection = formatFirefoxDataForSynthesis(data.firefox);
      if (firefoxSection) categorySections.push(firefoxSection);
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

    if (data.editorState) {
      const editorSection = formatEditorStateForSynthesis(data.editorState);
      if (editorSection) categorySections.push(editorSection);
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

    if (data.steamLibrary) {
      const steamSection = formatSteamLibraryForSynthesis(data.steamLibrary);
      if (steamSection) categorySections.push(steamSection);
    }

    if (data.musicLibrary) {
      const musicSection = formatMusicLibraryForSynthesis(data.musicLibrary);
      if (musicSection) categorySections.push(musicSection);
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

  // Post-process: filter low-signal domains, then tier for synthesis priority
  let formatted = orderedSections.join("\n\n");
  formatted = filterLowSignalDomains(formatted);
  formatted = tierFormattedSignals(formatted);

  return {
    formatted,
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
  selectedBrowser?: string | null,
  selectedProfile?: string | null,
): Promise<AllUserSignalsResult> => {
  try {
    const cats = categories ?? DEFAULT_CATEGORIES;
    await persistSelectedCategories(StellaHome, cats);
    const data = await collectAllUserSignals(
      StellaHome,
      cats,
      selectedBrowser,
      selectedProfile,
    );
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
