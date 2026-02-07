/**
 * Self-modification staging system — public API.
 */

export {
  stageFile,
  readStaged,
  listStagedFiles,
  clearStaging,
} from "./staging.js";

export {
  createFeature,
  getFeature,
  updateFeature,
  getActiveFeature,
  setActiveFeature,
  listFeatures,
  type FeatureMeta,
} from "./features.js";

export {
  takeSnapshot,
  restoreSnapshot,
  listSnapshots,
  type SnapshotEntry,
} from "./snapshots.js";

export {
  applyBatch,
  getHistory,
  type BatchResult,
  type HistoryEntry,
} from "./apply.js";

export {
  packageFeature,
  installMod,
  detectConflicts,
  installModWithConflictCheck,
  type ModPackage,
  type ModFileEntry,
  type ConflictInfo,
  type ConflictReport,
} from "./packaging.js";
