/**
 * Self-modification staging system — public API.
 */
export { stageFile, readStaged, listStagedFiles, clearStaging, } from "./staging.js";
export { createFeature, getFeature, updateFeature, getActiveFeature, setActiveFeature, listFeatures, } from "./features.js";
export { takeSnapshot, restoreSnapshot, listSnapshots, } from "./snapshots.js";
export { applyBatch, getHistory, removeLastHistoryEntries, } from "./apply.js";
export { packageFeature, } from "./packaging.js";
