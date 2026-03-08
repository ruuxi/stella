/**
 * Shared types for user signal collection
 */

import type {
  DevProject,
  CommandFrequency,
  ShellAnalysis,
  DiscoveredApp,
  AllUserSignals,
  AllUserSignalsResult,
} from '../../src/shared/contracts/electron-data.js'

export type {
  DevProject,
  CommandFrequency,
  ShellAnalysis,
  DiscoveredApp,
  AllUserSignals,
  AllUserSignalsResult,
}

// ---------------------------------------------------------------------------
// Dev Projects
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shell History Analysis
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App Discovery
// ---------------------------------------------------------------------------

export type AppDiscoveryResult = {
  apps: DiscoveredApp[];
};

// ---------------------------------------------------------------------------
// Combined Output
// ---------------------------------------------------------------------------
