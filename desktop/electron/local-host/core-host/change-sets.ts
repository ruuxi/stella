import type { ZoneManager, ZoneGuardContext } from "./zone-config.js";
import type { InstructionManager } from "./instructions.js";
import type { StateStore } from "./state-store.js";
import type { Snapshot, SnapshotDiffEntry } from "./snapshots.js";
import { createSnapshot, diffSnapshots, restoreSnapshot } from "./snapshots.js";
import { ensureWithinRoot } from "./path-utils.js";
import { getGitDiff, getGitHead, getGitNumStat, resolveGitRoot } from "./git.js";
import {
  defaultValidationSpecs,
  runValidations,
  summarizeValidationResults,
  type ValidationResult,
  type ValidationSpec,
} from "./validations.js";

export type ChangeSetScope =
  | "self_mod"
  | "pack_publish"
  | "pack_install"
  | "pack_uninstall"
  | "update_apply"
  | "manual"
  | "unknown";

export type ChangeSetStatus = "active" | "completed" | "failed" | "rolled_back";

export type ChangeSetChangedFile = {
  virtualPath: string;
  zone: string;
  changeType: "added" | "modified" | "deleted";
  projectRelativePath: string;
  diffStat?: { added: number; removed: number };
  instructionFiles: string[];
  invariants: string[];
  compatibilityNotes: string[];
  blocked: boolean;
  blockReasons: string[];
  guardReason?: string;
};

export type ChangeSetRecord = {
  id: string;
  scope: ChangeSetScope;
  agentType: string;
  status: ChangeSetStatus;
  startedAt: number;
  completedAt?: number;
  title?: string;
  summary?: string;
  baselineId: string;
  baselineSnapshotPath: string;
  gitHeadAtStart?: string | null;
  gitHeadAtEnd?: string | null;
  diffPatch?: string;
  diffPatchTruncated?: boolean;
  changedFiles: ChangeSetChangedFile[];
  instructionInvariants: string[];
  instructionNotes: string[];
  blockReasons: string[];
  guardFailures: string[];
  validations: ValidationResult[];
  validationSummary: {
    ok: boolean;
    requiredFailures: Array<{ name: string; status: string; exitCode: number | null }>;
  };
  rollbackApplied: boolean;
  conversationId?: string;
  deviceId?: string;
};

export type ChangeSetStartContext = {
  scope: ChangeSetScope;
  agentType: string;
  conversationId?: string;
  deviceId?: string;
  reason?: string;
  userConfirmed?: boolean;
  overrideGuard?: boolean;
};

export type ChangeSetFinishInput = {
  title: string;
  summary: string;
  validations?: ValidationSpec[];
  skipDefaultValidations?: boolean;
  userConfirmed?: boolean;
  overrideGuard?: boolean;
};

export type ChangeSetFinishResult = {
  ok: boolean;
  status: ChangeSetStatus;
  changeSet: ChangeSetRecord | null;
  rollbackApplied: boolean;
  reason?: string;
};

export type ConvexBridge = {
  callMutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  callQuery?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  callAction?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

type ChangeSetManagerOptions = {
  zoneManager: ZoneManager;
  instructionManager: InstructionManager;
  stateStore: StateStore;
  convexBridge?: ConvexBridge | null;
};

const MAX_DIFF_PATCH = 300_000;
const truncatePatch = (value: string) => {
  if (value.length <= MAX_DIFF_PATCH) {
    return { patch: value, truncated: false };
  }
  return {
    patch: `${value.slice(0, MAX_DIFF_PATCH)}\n\n... (diff truncated)`,
    truncated: true,
  };
};

const toGuardContext = (
  record: ChangeSetRecord,
  input: { userConfirmed?: boolean; overrideGuard?: boolean },
): ZoneGuardContext => ({
  agentType: record.agentType,
  operation: record.scope,
  userConfirmed: input.userConfirmed ?? false,
  overrideGuard: input.overrideGuard ?? false,
});

const dedupeValidations = (existing: ValidationResult[], next: ValidationResult[]) => {
  const map = new Map<string, ValidationResult>();
  for (const item of existing) {
    const key = `${item.name}::${item.command}::${item.cwd}`;
    map.set(key, item);
  }
  for (const item of next) {
    const key = `${item.name}::${item.command}::${item.cwd}`;
    map.set(key, item);
  }
  return Array.from(map.values()).sort((a, b) => a.startedAt - b.startedAt);
};

const getSnapshotForDiffEntry = (entry: SnapshotDiffEntry) => entry.after ?? entry.before;

export const createChangeSetManager = (options: ChangeSetManagerOptions) => {
  const { zoneManager, instructionManager, stateStore } = options;
  let convexBridge: ConvexBridge | null = options.convexBridge ?? null;

  const setConvexBridge = (bridge: ConvexBridge | null) => {
    convexBridge = bridge;
  };

  const callMutation = async (name: string, args: Record<string, unknown>) => {
    if (!convexBridge) return null;
    try {
      return await convexBridge.callMutation(name, args);
    } catch {
      return null;
    }
  };

  const ensureBaseline = async () => {
    await stateStore.ensureStructure();
    const existing = await stateStore.loadBaselineMetadata();
    if (existing) {
      const snapshot = await stateStore.loadBaselineSnapshot<Snapshot>(existing.baselineId);
      if (snapshot) {
        return { metadata: existing, snapshot };
      }
    }

    const snapshot = await createSnapshot(zoneManager, { zoneKinds: ["platform"] });
    const gitHead = await getGitHead(zoneManager.projectRoot);
    const baselineId = snapshot.id;
    await stateStore.saveBaselineSnapshot(baselineId, snapshot);
    const metadata = {
      baselineId,
      createdAt: snapshot.createdAt,
      snapshotPath: stateStore.getBaselineSnapshotPath(baselineId),
      gitHead,
      sourceScope: "manual",
    };
    await stateStore.saveBaselineMetadata(metadata);
    return { metadata, snapshot };
  };

  const loadActiveChangeSetRecord = async () => {
    const active = await stateStore.getActiveChangeSet();
    if (!active) return null;
    const record = await stateStore.loadChangeSetRecord<ChangeSetRecord>(active.id);
    return record;
  };

  const saveRecord = async (record: ChangeSetRecord) => {
    await stateStore.saveChangeSetRecord(record.id, record);
  };

  const snapshotPlatformZones = async () =>
    await createSnapshot(zoneManager, { zoneKinds: ["platform"] });

  const startChangeSet = async (context: ChangeSetStartContext) => {
    await ensureBaseline();

    const active = await loadActiveChangeSetRecord();
    if (active && active.status === "active") {
      return active;
    }

    const gitRoot = await resolveGitRoot(zoneManager.projectRoot);
    const gitHeadAtStart = gitRoot ? await getGitHead(gitRoot) : null;

    const baselineSnapshot = await snapshotPlatformZones();
    const id = crypto.randomUUID();
    await stateStore.saveChangeSetBaseline(id, baselineSnapshot);

    const record: ChangeSetRecord = {
      id,
      scope: context.scope,
      agentType: context.agentType,
      status: "active",
      startedAt: Date.now(),
      baselineId: baselineSnapshot.id,
      baselineSnapshotPath: stateStore.getChangeSetBaselinePath(id),
      gitHeadAtStart,
      changedFiles: [],
      instructionInvariants: [],
      instructionNotes: [],
      blockReasons: [],
      guardFailures: [],
      validations: [],
      validationSummary: {
        ok: true,
        requiredFailures: [],
      },
      rollbackApplied: false,
      conversationId: context.conversationId,
      deviceId: context.deviceId,
    };

    await saveRecord(record);
    await stateStore.setActiveChangeSet({
      id,
      scope: context.scope,
      startedAt: record.startedAt,
      agentType: context.agentType,
    });

    await callMutation("changesets.start", {
      changeSetId: id,
      scope: context.scope,
      agentType: context.agentType,
      startedAt: record.startedAt,
      baselineId: record.baselineId,
      gitHeadAtStart: record.gitHeadAtStart,
      reason: context.reason,
      conversationId: context.conversationId,
      deviceId: context.deviceId,
    });

    return record;
  };

  const recordValidationResults = async (results: ValidationResult[]) => {
    const active = await loadActiveChangeSetRecord();
    if (!active || active.status !== "active") {
      return active;
    }
    active.validations = dedupeValidations(active.validations, results);
    await saveRecord(active);
    return active;
  };

  const computeGitMetadata = async (paths: string[]) => {
    const gitRoot = await resolveGitRoot(zoneManager.projectRoot);
    if (!gitRoot) {
      return {
        gitHeadAtEnd: null,
        diffPatch: "",
        diffPatchTruncated: false,
        numstat: new Map<string, { added: number; removed: number }>(),
      };
    }
    const diffPatchRaw = await getGitDiff(gitRoot, paths);
    const diffPatch = truncatePatch(diffPatchRaw);
    const numstat = await getGitNumStat(gitRoot, paths);
    const gitHeadAtEnd = await getGitHead(gitRoot);
    return {
      gitHeadAtEnd,
      diffPatch: diffPatch.patch,
      diffPatchTruncated: diffPatch.truncated,
      numstat,
    };
  };

  const evaluateDiffs = async (
    diffs: SnapshotDiffEntry[],
    record: ChangeSetRecord,
    guardInput: { userConfirmed?: boolean; overrideGuard?: boolean },
    gitNumstat: Map<string, { added: number; removed: number }>,
  ) => {
    const changedFiles: ChangeSetChangedFile[] = [];
    const guardFailures: string[] = [];
    const blockReasons: string[] = [];
    const invariants = new Set<string>();
    const compatibilityNotes = new Set<string>();

    for (const diff of diffs) {
      const snapshotFile = getSnapshotForDiffEntry(diff);
      if (!snapshotFile) continue;

      const absolutePath = snapshotFile.absolutePath;
      const guard = zoneManager.enforceGuard(absolutePath, toGuardContext(record, guardInput));
      const instructions = await instructionManager.getInstructionsForPath(absolutePath);

      const projectRelative = snapshotFile.projectRelativePath;
      const diffStat = gitNumstat.get(projectRelative);

      instructions.invariants.forEach((item) => invariants.add(item));
      instructions.compatibilityNotes.forEach((item) => compatibilityNotes.add(item));

      if (!guard.ok && guard.reason) {
        guardFailures.push(guard.reason);
      }
      if (instructions.blocked) {
        blockReasons.push(...instructions.blockReasons);
      }

      const recordFile: ChangeSetChangedFile = {
        virtualPath: snapshotFile.virtualPath,
        zone: snapshotFile.zone,
        changeType: diff.changeType,
        projectRelativePath: projectRelative,
        diffStat: diffStat ? { added: diffStat.added, removed: diffStat.removed } : undefined,
        instructionFiles: instructions.instructionFiles.map((file) => file.filePath),
        invariants: instructions.invariants,
        compatibilityNotes: instructions.compatibilityNotes,
        blocked: instructions.blocked,
        blockReasons: instructions.blockReasons,
        guardReason: guard.ok ? undefined : guard.reason,
      };
      changedFiles.push(recordFile);
    }

    return {
      changedFiles: changedFiles.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath)),
      guardFailures,
      blockReasons,
      invariants: Array.from(invariants),
      compatibilityNotes: Array.from(compatibilityNotes),
    };
  };

  const rollbackToSnapshot = async (snapshot: Snapshot) => {
    const result = await restoreSnapshot(snapshot, zoneManager, {
      zoneNames: zoneManager.getPlatformZones().map((zone) => zone.name),
    });
    return result;
  };

  const updateBaselineFromSnapshot = async (
    snapshot: Snapshot,
    metadata: { sourceChangeSetId?: string; sourceScope?: string },
  ) => {
    const gitHead = await getGitHead(zoneManager.projectRoot);
    const baselineId = snapshot.id;
    await stateStore.saveBaselineSnapshot(baselineId, snapshot);
    const baselineMetadata = {
      baselineId,
      createdAt: snapshot.createdAt,
      snapshotPath: stateStore.getBaselineSnapshotPath(baselineId),
      gitHead,
      sourceChangeSetId: metadata.sourceChangeSetId,
      sourceScope: metadata.sourceScope,
    };
    await stateStore.saveBaselineMetadata(baselineMetadata);
    return baselineMetadata;
  };

  const finishChangeSet = async (input: ChangeSetFinishInput): Promise<ChangeSetFinishResult> => {
    const active = await loadActiveChangeSetRecord();
    if (!active || active.status !== "active") {
      return {
        ok: false,
        status: "failed",
        changeSet: null,
        rollbackApplied: false,
        reason: "No active ChangeSet to finish.",
      };
    }

    const baselineSnapshot = await stateStore.loadChangeSetBaseline<Snapshot>(active.id);
    if (!baselineSnapshot) {
      return {
        ok: false,
        status: "failed",
        changeSet: active,
        rollbackApplied: false,
        reason: "Baseline snapshot missing for active ChangeSet.",
      };
    }

    const currentSnapshot = await snapshotPlatformZones();
    const diffs = diffSnapshots(baselineSnapshot, currentSnapshot);

    const projectPaths = diffs
      .map((diff) => getSnapshotForDiffEntry(diff))
      .filter((file): file is NonNullable<typeof file> => Boolean(file))
      .filter((file) => ensureWithinRoot(zoneManager.projectRoot, file.absolutePath))
      .map((file) => file.projectRelativePath);

    const gitMeta = await computeGitMetadata(projectPaths);
    const evaluated = await evaluateDiffs(diffs, active, input, gitMeta.numstat);

    active.title = input.title.trim();
    active.summary = input.summary.trim();
    active.changedFiles = evaluated.changedFiles;
    active.instructionInvariants = evaluated.invariants;
    active.instructionNotes = evaluated.compatibilityNotes;
    active.blockReasons = evaluated.blockReasons;
    active.guardFailures = evaluated.guardFailures;
    active.diffPatch = gitMeta.diffPatch;
    active.diffPatchTruncated = gitMeta.diffPatchTruncated;
    active.gitHeadAtEnd = gitMeta.gitHeadAtEnd;

    const hasGuardFailures = evaluated.guardFailures.length > 0;
    const hasInstructionBlocks = evaluated.blockReasons.length > 0;

    if (hasGuardFailures || hasInstructionBlocks) {
      await rollbackToSnapshot(baselineSnapshot);
      active.status = "failed";
      active.rollbackApplied = true;
      active.completedAt = Date.now();
      await saveRecord(active);
      await stateStore.setActiveChangeSet(null);
      await stateStore.setSafeModeTrigger({
        reason: hasGuardFailures
          ? `Zone guard blocked platform edits: ${evaluated.guardFailures.join(" | ")}`
          : `Instructions blocked edits: ${evaluated.blockReasons.join(" | ")}`,
        createdAt: Date.now(),
      });
      await callMutation("changesets.complete", {
        changeSetId: active.id,
        status: active.status,
        title: active.title,
        summary: active.summary,
        changedFiles: active.changedFiles,
        diffPatch: active.diffPatch,
        diffPatchTruncated: active.diffPatchTruncated,
        validations: active.validations,
        validationSummary: active.validationSummary,
        blockReasons: active.blockReasons,
        guardFailures: active.guardFailures,
        rollbackApplied: active.rollbackApplied,
        completedAt: active.completedAt,
        conversationId: active.conversationId,
        deviceId: active.deviceId,
      });
      return {
        ok: false,
        status: active.status,
        changeSet: active,
        rollbackApplied: true,
        reason: hasGuardFailures
          ? evaluated.guardFailures[0]
          : evaluated.blockReasons[0] ?? "Instruction block.",
      };
    }

    const defaultSpecs = input.skipDefaultValidations
      ? []
      : defaultValidationSpecs(zoneManager.projectRoot);
    const validationSpecs = [...defaultSpecs, ...(input.validations ?? [])];
    const newValidations = validationSpecs.length > 0 ? await runValidations(validationSpecs) : [];

    active.validations = dedupeValidations(active.validations, newValidations);
    const validationSummary = summarizeValidationResults(active.validations);
    active.validationSummary = {
      ok: validationSummary.ok,
      requiredFailures: validationSummary.requiredFailures.map((failure) => ({
        name: failure.name,
        status: failure.status,
        exitCode: failure.exitCode,
      })),
    };

    if (!validationSummary.ok) {
      await rollbackToSnapshot(baselineSnapshot);
      active.status = "failed";
      active.rollbackApplied = true;
      active.completedAt = Date.now();
      await saveRecord(active);
      await stateStore.setActiveChangeSet(null);
      await stateStore.setSafeModeTrigger({
        reason: `Validation failed: ${validationSummary.requiredFailures
          .map((item) => `${item.name} (${item.status})`)
          .join(", ")}`,
        createdAt: Date.now(),
      });
      await callMutation("changesets.complete", {
        changeSetId: active.id,
        status: active.status,
        title: active.title,
        summary: active.summary,
        changedFiles: active.changedFiles,
        diffPatch: active.diffPatch,
        diffPatchTruncated: active.diffPatchTruncated,
        validations: active.validations,
        validationSummary: active.validationSummary,
        blockReasons: active.blockReasons,
        guardFailures: active.guardFailures,
        rollbackApplied: active.rollbackApplied,
        completedAt: active.completedAt,
        conversationId: active.conversationId,
        deviceId: active.deviceId,
      });
      return {
        ok: false,
        status: active.status,
        changeSet: active,
        rollbackApplied: true,
        reason: "Validation failed and changes were rolled back.",
      };
    }

    active.status = "completed";
    active.rollbackApplied = false;
    active.completedAt = Date.now();
    await saveRecord(active);
    await updateBaselineFromSnapshot(currentSnapshot, {
      sourceChangeSetId: active.id,
      sourceScope: active.scope,
    });
    await stateStore.setActiveChangeSet(null);
    await stateStore.setSafeModeTrigger(null);

    await callMutation("changesets.complete", {
      changeSetId: active.id,
      status: active.status,
      title: active.title,
      summary: active.summary,
      changedFiles: active.changedFiles,
      diffPatch: active.diffPatch,
      diffPatchTruncated: active.diffPatchTruncated,
      validations: active.validations,
      validationSummary: active.validationSummary,
      blockReasons: active.blockReasons,
      guardFailures: active.guardFailures,
      rollbackApplied: active.rollbackApplied,
      completedAt: active.completedAt,
      conversationId: active.conversationId,
      deviceId: active.deviceId,
    });

    return {
      ok: true,
      status: active.status,
      changeSet: active,
      rollbackApplied: false,
    };
  };

  const rollbackToLastKnownGood = async (reason: string) => {
    const baselineMetadata = await stateStore.loadBaselineMetadata();
    if (!baselineMetadata) {
      return { ok: false, reason: "No baseline metadata found." };
    }
    const snapshot = await stateStore.loadBaselineSnapshot<Snapshot>(baselineMetadata.baselineId);
    if (!snapshot) {
      return { ok: false, reason: "Baseline snapshot missing." };
    }

    await rollbackToSnapshot(snapshot);
    await stateStore.setSafeModeTrigger({
      reason,
      createdAt: Date.now(),
    });
    await callMutation("changesets.rollback_to_baseline", {
      baselineId: baselineMetadata.baselineId,
      reason,
      createdAt: Date.now(),
    });
    return { ok: true, baselineId: baselineMetadata.baselineId };
  };

  const rollbackChangeSet = async (changeSetId: string, reason: string) => {
    const record = await stateStore.loadChangeSetRecord<ChangeSetRecord>(changeSetId);
    if (!record) {
      return { ok: false, reason: `ChangeSet not found: ${changeSetId}` };
    }
    const baselineSnapshot = await stateStore.loadChangeSetBaseline<Snapshot>(changeSetId);
    if (!baselineSnapshot) {
      return { ok: false, reason: "ChangeSet baseline snapshot missing." };
    }

    await rollbackToSnapshot(baselineSnapshot);

    record.status = "rolled_back";
    record.rollbackApplied = true;
    record.completedAt = Date.now();
    await saveRecord(record);
    await stateStore.setActiveChangeSet(null);
    await updateBaselineFromSnapshot(baselineSnapshot, {
      sourceChangeSetId: changeSetId,
      sourceScope: "manual",
    });
    await callMutation("changesets.mark_rolled_back", {
      changeSetId,
      reason,
      rolledBackAt: record.completedAt,
    });
    return { ok: true, changeSetId };
  };

  return {
    setConvexBridge,
    ensureBaseline,
    startChangeSet,
    recordValidationResults,
    finishChangeSet,
    rollbackToLastKnownGood,
    rollbackChangeSet,
  };
};

export type ChangeSetManager = ReturnType<typeof createChangeSetManager>;
