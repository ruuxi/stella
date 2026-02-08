/**
 * Self-modification staging system — public API.
 */
export { stageFile, readStaged, listStagedFiles, clearStaging, } from "./staging.js";
export { createFeature, getFeature, updateFeature, getActiveFeature, setActiveFeature, listFeatures, type FeatureMeta, } from "./features.js";
export { takeSnapshot, restoreSnapshot, listSnapshots, type SnapshotEntry, } from "./snapshots.js";
export { applyBatch, getHistory, removeLastHistoryEntries, type BatchResult, type HistoryEntry, } from "./apply.js";
export { packageFeature, type Blueprint, type BlueprintFile, } from "./packaging.js";
