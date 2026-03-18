import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCollectBrowserData,
  mockDetectPreferredBrowserProfile,
  mockCollectBrowserBookmarks,
} = vi.hoisted(() => ({
  mockCollectBrowserData: vi.fn(),
  mockDetectPreferredBrowserProfile: vi.fn(),
  mockCollectBrowserBookmarks: vi.fn(),
}));

vi.mock("../../../electron/system/browser-data.js", () => ({
  collectBrowserData: mockCollectBrowserData,
  detectPreferredBrowserProfile: mockDetectPreferredBrowserProfile,
  formatBrowserDataForSynthesis: vi.fn(() => "browser"),
}));

vi.mock("../../../electron/system/browser-bookmarks.js", () => ({
  collectBrowserBookmarks: mockCollectBrowserBookmarks,
  formatBrowserBookmarksForSynthesis: vi.fn(() => "bookmarks"),
}));

vi.mock("../../../electron/system/firefox-data.js", () => ({
  collectFirefoxData: vi.fn(async () => null),
  formatFirefoxDataForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/safari-data.js", () => ({
  collectSafariData: vi.fn(async () => null),
  formatSafariDataForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/dev-projects.js", () => ({
  collectDevProjects: vi.fn(async () => []),
  formatDevProjectsForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/shell-history.js", () => ({
  analyzeShellHistory: vi.fn(async () => ({
    topCommands: [],
    projectPaths: [],
    toolsUsed: [],
  })),
  formatShellAnalysisForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/app-discovery.js", () => ({
  discoverApps: vi.fn(async () => ({ apps: [] })),
  formatAppDiscoveryForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/signal-processing.js", () => ({
  filterLowSignalDomains: vi.fn((value: string) => value),
  tierFormattedSignals: vi.fn((value: string) => value),
}));

vi.mock("../../../electron/system/dev-environment.js", () => ({
  collectDevEnvironment: vi.fn(async () => null),
  formatDevEnvironmentForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/system-signals.js", () => ({
  collectSystemSignals: vi.fn(async () => null),
  formatSystemSignalsForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/messages-notes.js", () => ({
  collectMessagesNotes: vi.fn(async () => null),
  formatMessagesNotesForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/editor-state.js", () => ({
  collectEditorState: vi.fn(async () => null),
  formatEditorStateForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/steam-library.js", () => ({
  collectSteamLibrary: vi.fn(async () => null),
  formatSteamLibraryForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/music-library.js", () => ({
  collectMusicLibrary: vi.fn(async () => null),
  formatMusicLibraryForSynthesis: vi.fn(() => ""),
}));

vi.mock("../../../electron/system/identity-map.js", () => ({
  addContacts: vi.fn(async () => {}),
  pseudonymize: vi.fn((value: string) => value),
  loadIdentityMap: vi.fn(async () => ({ mappings: [] })),
}));

vi.mock("../../../electron/system/private-fs.js", () => ({
  ensurePrivateDir: vi.fn(async () => {}),
  writePrivateFile: vi.fn(async () => {}),
}));

import { collectAllSignals } from "../../../electron/system/collect-all.js";

describe("collectAllSignals browser selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectPreferredBrowserProfile.mockResolvedValue({
      browser: "brave",
      profile: "Profile 2",
    });
    mockCollectBrowserData.mockResolvedValue({
      browser: "brave",
      clusterDomains: [],
      recentDomains: [],
      allTimeDomains: [],
      domainDetails: {},
      clusterKeywords: [],
    });
    mockCollectBrowserBookmarks.mockResolvedValue({
      browser: "Brave",
      bookmarks: [],
      folders: [],
    });
  });

  it("uses one resolved browser/profile for both history and bookmarks when none is selected", async () => {
    await collectAllSignals("C:\\temp\\stella-home", ["browsing_bookmarks"]);

    expect(mockDetectPreferredBrowserProfile).toHaveBeenCalledTimes(1);
    expect(mockCollectBrowserData).toHaveBeenCalledWith(
      "C:\\temp\\stella-home",
      {
        selectedBrowser: "brave",
        selectedProfile: "Profile 2",
      },
    );
    expect(mockCollectBrowserBookmarks).toHaveBeenCalledWith({
      selectedBrowser: "brave",
      selectedProfile: "Profile 2",
    });
  });
});
