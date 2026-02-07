/**
 * Self-modification device tool handlers.
 *
 * SelfModStart  — create/switch feature
 * SelfModApply  — apply staged changes atomically
 * SelfModRevert — undo a batch
 * SelfModStatus — show staging/history info
 * SelfModPackage — export as blueprint
 */

import type { ToolContext, ToolResult } from "./tools-types.js";
import {
  createFeature,
  getActiveFeature,
  setActiveFeature,
  getFeature,
  listStagedFiles,
  applyBatch,
  getHistory,
  restoreSnapshot,
  listSnapshots,
  packageFeature,
} from "../self-mod/index.js";

export const handleSelfModStart = async (
  args: Record<string, unknown>,
  context: ToolContext,
  frontendRoot?: string,
): Promise<ToolResult> => {
  const name = String(args.name ?? "Unnamed modification");
  const description = String(args.description ?? "");

  const featureId = `mod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const meta = await createFeature(
    featureId,
    name,
    description,
    context.conversationId,
  );
  await setActiveFeature(context.conversationId, featureId);

  return {
    result: JSON.stringify({
      featureId: meta.id,
      name: meta.name,
      description: meta.description,
      status: meta.status,
      message: `Feature "${name}" created and set as active. Your Write/Edit operations will now be staged under this feature.`,
    }),
  };
};

export const handleSelfModApply = async (
  args: Record<string, unknown>,
  context: ToolContext,
  frontendRoot?: string,
): Promise<ToolResult> => {
  if (!frontendRoot) {
    return { error: "Frontend root not configured. Cannot apply changes." };
  }

  const featureId = await getActiveFeature(context.conversationId);
  if (!featureId) {
    return { error: "No active feature for this conversation. Call SelfModStart first." };
  }

  const message = args.message ? String(args.message) : undefined;

  try {
    const result = await applyBatch(featureId, frontendRoot, message);
    if (result.batchIndex === -1) {
      return { result: "No staged files to apply. Make changes with Write/Edit first." };
    }

    return {
      result: JSON.stringify({
        batchIndex: result.batchIndex,
        filesApplied: result.files.length,
        files: result.files,
        message: `Applied ${result.files.length} file(s) atomically. HMR will update the UI. Use SelfModRevert to undo.`,
      }),
    };
  } catch (error) {
    return { error: `Failed to apply: ${(error as Error).message}` };
  }
};

export const handleSelfModRevert = async (
  args: Record<string, unknown>,
  context: ToolContext,
  frontendRoot?: string,
): Promise<ToolResult> => {
  if (!frontendRoot) {
    return { error: "Frontend root not configured. Cannot revert changes." };
  }

  const featureId = args.feature_id
    ? String(args.feature_id)
    : await getActiveFeature(context.conversationId);

  if (!featureId) {
    return { error: "No active feature to revert." };
  }

  const steps = Number(args.steps ?? 1);
  const history = await getHistory(featureId);

  if (history.length === 0) {
    return { error: "No applied batches to revert." };
  }

  const revertedFiles: string[] = [];
  const batchesToRevert = Math.min(steps, history.length);

  for (let i = 0; i < batchesToRevert; i++) {
    const batchIndex = history.length - 1 - i;
    const files = await restoreSnapshot(featureId, batchIndex, frontendRoot);
    revertedFiles.push(...files);
  }

  return {
    result: JSON.stringify({
      revertedBatches: batchesToRevert,
      revertedFiles: revertedFiles.length,
      files: [...new Set(revertedFiles)],
      message: `Reverted ${batchesToRevert} batch(es), restoring ${revertedFiles.length} file(s). HMR will update the UI.`,
    }),
  };
};

export const handleSelfModStatus = async (
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const featureId = args.feature_id
    ? String(args.feature_id)
    : await getActiveFeature(context.conversationId);

  if (!featureId) {
    return {
      result: JSON.stringify({
        activeFeature: null,
        message: "No active feature. Call SelfModStart to begin.",
      }),
    };
  }

  const meta = await getFeature(featureId);
  const staged = await listStagedFiles(featureId);
  const history = await getHistory(featureId);
  const snapshots = await listSnapshots(featureId);

  return {
    result: JSON.stringify({
      feature: meta
        ? { id: meta.id, name: meta.name, status: meta.status }
        : null,
      stagedFiles: staged,
      appliedBatches: history.length,
      history: history.map((h) => ({
        batchIndex: h.batchIndex,
        files: h.files.length,
        message: h.message,
        appliedAt: new Date(h.appliedAt).toISOString(),
      })),
      revertPoints: snapshots.length,
    }),
  };
};

export const handleSelfModPackage = async (
  args: Record<string, unknown>,
  context: ToolContext,
  frontendRoot?: string,
): Promise<ToolResult> => {
  if (!frontendRoot) {
    return { error: "Frontend root not configured. Cannot package." };
  }

  const featureId = args.feature_id
    ? String(args.feature_id)
    : await getActiveFeature(context.conversationId);

  if (!featureId) {
    return { error: "No feature to package. Provide feature_id or have an active feature." };
  }

  const description = args.description ? String(args.description) : "";
  const implementation = args.implementation ? String(args.implementation) : "";

  try {
    const blueprint = await packageFeature(featureId, frontendRoot);
    if (!blueprint) {
      return { error: `Feature ${featureId} not found.` };
    }

    // Inject agent-provided description and implementation
    blueprint.description = description;
    blueprint.implementation = implementation;

    return {
      result: JSON.stringify({
        format: blueprint.format,
        name: blueprint.name,
        description: blueprint.description,
        implementation: blueprint.implementation,
        fileCount: blueprint.referenceFiles.length,
        files: blueprint.referenceFiles.map((f) => ({
          path: f.path,
          action: f.action,
        })),
        blueprint,
        message: `Packaged "${blueprint.name}" as blueprint with ${blueprint.referenceFiles.length} reference file(s).`,
      }),
    };
  } catch (error) {
    return { error: `Failed to package: ${(error as Error).message}` };
  }
};
