/**
 * Shared types for user signal collection
 */

import type { BrowserData } from "./browser-data.js";
import type { DiscoveryCategory } from "./discovery_types.js";

// ---------------------------------------------------------------------------
// Dev Projects
// ---------------------------------------------------------------------------

export type DevProject = {
  name: string;
  path: string;
  lastActivity: number; // timestamp in ms
};

// ---------------------------------------------------------------------------
// Shell History Analysis
// ---------------------------------------------------------------------------

export type CommandFrequency = {
  command: string;
  count: number;
};

export type ShellAnalysis = {
  topCommands: CommandFrequency[];
  projectPaths: string[]; // Paths extracted from cd commands
  toolsUsed: string[]; // Dev tools inferred from command usage
};

// ---------------------------------------------------------------------------
// App Discovery
// ---------------------------------------------------------------------------

export type DiscoveredApp = {
  name: string;
  executablePath: string;
  source: "running" | "recent";
  lastUsed?: number; // timestamp for recent apps
};

export type AppDiscoveryResult = {
  apps: DiscoveredApp[];
};

// ---------------------------------------------------------------------------
// Combined Output
// ---------------------------------------------------------------------------

export type AllUserSignals = {
  browser: BrowserData;
  devProjects: DevProject[];
  shell: ShellAnalysis;
  apps: DiscoveredApp[];
};

export type AllUserSignalsResult = {
  data: AllUserSignals | null;
  formatted: string | null;
  formattedSections?: Partial<Record<DiscoveryCategory, string>> | null;
  error?: string;
};
