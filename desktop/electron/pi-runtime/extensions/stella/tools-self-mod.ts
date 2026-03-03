/**
 * Self-modification device tool handlers.
 *
 * SelfModRevert  — undo a batch
 * SelfModPackage — export as blueprint
 */

import type { ToolContext, ToolResult } from "./tools-types.js";
import {
  getActiveFeature,
  updateFeature,
  getHistory,
  removeLastHistoryEntries,
  restoreSnapshot,
  packageFeature,
} from "../../../self-mod/index.js";

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

  const remainingHistory = await removeLastHistoryEntries(
    featureId,
    batchesToRevert,
  );
  await updateFeature(featureId, {
    status: remainingHistory.length > 0 ? "applied" : "reverted",
  });

  return {
    result: JSON.stringify({
      revertedBatches: batchesToRevert,
      revertedFiles: revertedFiles.length,
      files: [...new Set(revertedFiles)],
      remainingBatches: remainingHistory.length,
      message: `Reverted ${batchesToRevert} batch(es), restoring ${revertedFiles.length} file(s). HMR will update the UI.`,
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
