import { promises as fs } from "fs";
import path from "path";
import { createSnapshot, restoreSnapshot } from "./snapshots.js";
import { ensureWithinRoot } from "./path-utils.js";
import { smokeValidationSpecs } from "./validations.js";
const contentToBuffer = (encoding, content) => {
    if (!encoding || content === undefined) {
        return null;
    }
    return encoding === "utf8" ? Buffer.from(content, "utf-8") : Buffer.from(content, "base64");
};
const snapshotFileToBuffer = (file) => {
    if (!file)
        return null;
    return file.encoding === "utf8"
        ? Buffer.from(file.content, "utf-8")
        : Buffer.from(file.content, "base64");
};
const buffersEqual = (a, b) => {
    if (!a && !b)
        return true;
    if (!a || !b)
        return false;
    return a.equals(b);
};
const buildLocalFile = (file) => {
    if (!file) {
        return undefined;
    }
    return {
        hash: file.hash,
        encoding: file.encoding,
        content: file.content,
    };
};
const buildUpstreamFile = (entry) => {
    if (entry.action === "delete") {
        return {
            action: entry.action,
            hash: entry.hash,
        };
    }
    return {
        action: entry.action,
        hash: entry.hash,
        encoding: entry.encoding,
        content: entry.content,
    };
};
const selectBaseSnapshot = async (stateStore, baseGitHead) => {
    const currentBaseline = await stateStore.loadBaselineMetadata();
    if (!baseGitHead) {
        if (!currentBaseline) {
            return null;
        }
        const snapshot = await stateStore.loadBaselineSnapshot(currentBaseline.baselineId);
        if (!snapshot) {
            return null;
        }
        return { metadata: currentBaseline, snapshot };
    }
    const history = await stateStore.loadBaselineHistory();
    const match = history.find((entry) => entry.gitHead === baseGitHead);
    if (match) {
        const snapshot = await stateStore.loadBaselineSnapshot(match.baselineId);
        if (snapshot) {
            return { metadata: match, snapshot };
        }
    }
    if (!currentBaseline) {
        return null;
    }
    const snapshot = await stateStore.loadBaselineSnapshot(currentBaseline.baselineId);
    if (!snapshot) {
        return null;
    }
    return { metadata: currentBaseline, snapshot };
};
const computeConflicts = async (bundle, baseSnapshot, currentSnapshot, instructionManager) => {
    const conflicts = [];
    const nonConflicts = [];
    for (const entry of bundle.entries) {
        const baseFile = baseSnapshot.files[entry.virtualPath];
        const localFile = currentSnapshot.files[entry.virtualPath];
        const baseBuffer = snapshotFileToBuffer(baseFile);
        const localBuffer = snapshotFileToBuffer(localFile);
        const upstreamBuffer = entry.action === "delete" ? null : contentToBuffer(entry.encoding, entry.content);
        const localChanged = !buffersEqual(baseBuffer, localBuffer);
        const upstreamChanged = entry.action === "delete" ? Boolean(baseFile) : !buffersEqual(baseBuffer, upstreamBuffer);
        const localVsUpstreamSame = buffersEqual(localBuffer, upstreamBuffer);
        const isConflict = localChanged && upstreamChanged && !localVsUpstreamSame;
        if (!isConflict) {
            nonConflicts.push(entry);
            continue;
        }
        const instructions = await instructionManager.getInstructionsForPath(entry.virtualPath);
        conflicts.push({
            virtualPath: entry.virtualPath,
            zone: instructions.classification.zone?.name ?? "unknown",
            base: buildLocalFile(baseFile),
            local: buildLocalFile(localFile),
            upstream: buildUpstreamFile(entry),
            instructions: {
                instructionFiles: instructions.instructionFiles.map((file) => file.filePath),
                invariants: instructions.invariants,
                compatibilityNotes: instructions.compatibilityNotes,
            },
        });
    }
    return { conflicts, nonConflicts };
};
const applyEntry = async (zoneManager, entry) => {
    const resolved = zoneManager.resolvePath(entry.virtualPath);
    if (!resolved.ok) {
        throw new Error(resolved.error);
    }
    const classification = zoneManager.classifyPath(resolved.path);
    if (!ensureWithinRoot(zoneManager.projectRoot, classification.absolutePath)) {
        // Upstream updates only apply inside the project root.
        throw new Error(`Refusing to update outside the project root: ${entry.virtualPath}`);
    }
    if (entry.action === "delete") {
        await fs.rm(classification.absolutePath, { force: true });
        return;
    }
    if (!entry.content || !entry.encoding) {
        throw new Error(`Entry missing content: ${entry.virtualPath}`);
    }
    await fs.mkdir(path.dirname(classification.absolutePath), { recursive: true });
    if (entry.encoding === "utf8") {
        await fs.writeFile(classification.absolutePath, entry.content, "utf-8");
    }
    else {
        await fs.writeFile(classification.absolutePath, Buffer.from(entry.content, "base64"));
    }
};
const mergeConflicts = async (convexBridge, conflicts, bundle) => {
    if (conflicts.length === 0) {
        return { ok: true, resolutions: [] };
    }
    if (!convexBridge?.callAction) {
        return {
            ok: false,
            reason: "Semantic merge requires backend agent.invoke support.",
        };
    }
    const payload = {
        mode: "semantic_merge",
        agentType: "self_mod",
        prompt: "Resolve semantic merge conflicts between upstream and local changes. Follow the provided rules and return JSON only.",
        input: {
            rules: [
                "Preserve user-local changes where possible.",
                "Do not move screens outside the right panel host.",
                "Honor INSTRUCTIONS.md invariants and compatibility notes.",
                "Return bounded JSON only.",
            ],
            conflicts,
            bundleMetadata: {
                packId: bundle.manifest.packId,
                version: bundle.manifest.version,
                changedPaths: bundle.manifest.changedPaths,
            },
        },
        resultSchema: {
            type: "object",
            required: ["resolutions"],
            properties: {
                resolutions: {
                    type: "array",
                    maxItems: Math.min(conflicts.length, 50),
                    items: {
                        type: "object",
                        required: ["virtualPath", "strategy"],
                        properties: {
                            virtualPath: { type: "string" },
                            strategy: {
                                type: "string",
                                enum: ["keep_local", "use_upstream", "merged"],
                            },
                            encoding: {
                                type: "string",
                                enum: ["utf8", "base64"],
                            },
                            content: { type: "string" },
                        },
                    },
                },
            },
        },
    };
    const result = (await convexBridge.callAction("agent.invoke", payload));
    if (!result?.ok || !result.resolutions) {
        return {
            ok: false,
            reason: result?.reason ?? "Semantic merge failed.",
        };
    }
    return {
        ok: true,
        resolutions: result.resolutions,
    };
};
export const createUpdateManager = (options) => {
    const { zoneManager, instructionManager, stateStore, changeSetManager } = options;
    let convexBridge = options.convexBridge ?? null;
    const setConvexBridge = (bridge) => {
        convexBridge = bridge;
    };
    const callAction = async (name, args) => {
        if (!convexBridge?.callAction)
            return null;
        try {
            return await convexBridge.callAction(name, args);
        }
        catch {
            return null;
        }
    };
    const callMutation = async (name, args) => {
        if (!convexBridge)
            return null;
        try {
            return await convexBridge.callMutation(name, args);
        }
        catch {
            return null;
        }
    };
    const checkForUpdates = async (channelId) => {
        const response = (await callAction("updates.getLatestRelease", {
            channelId,
        }));
        if (!response?.ok || !response.release) {
            return {
                ok: false,
                channelId,
                reason: response?.reason ?? "No update information available.",
            };
        }
        return {
            ok: true,
            channelId: response.channelId ?? channelId,
            release: response.release,
        };
    };
    const applyUpdate = async (input) => {
        await stateStore.ensureStructure();
        await changeSetManager.ensureBaseline();
        if (!input.userConfirmed) {
            return {
                ok: false,
                reason: "Applying an upstream update requires explicit user confirmation.",
            };
        }
        const releaseResponse = (await callAction("updates.getReleaseForApply", {
            channelId: input.channelId,
            releaseId: input.releaseId,
        }));
        if (!releaseResponse?.ok || !releaseResponse.release) {
            return {
                ok: false,
                reason: releaseResponse?.reason ?? "Update release not available.",
            };
        }
        const release = releaseResponse.release;
        const externalEntry = release.bundle.entries.find((entry) => {
            const classification = zoneManager.classifyPath(entry.virtualPath);
            return !ensureWithinRoot(zoneManager.projectRoot, classification.absolutePath);
        });
        if (externalEntry) {
            return {
                ok: false,
                releaseId: release.releaseId,
                reason: `Upstream update attempted to modify a path outside the project root: ${externalEntry.virtualPath}`,
            };
        }
        const baseGitHead = release.baseGitHead ?? release.bundle.manifest.baselineGitHead ?? null;
        const base = await selectBaseSnapshot(stateStore, baseGitHead);
        if (!base) {
            return {
                ok: false,
                releaseId: release.releaseId,
                reason: "Unable to resolve a baseline snapshot for conflict detection.",
            };
        }
        const currentSnapshot = await createSnapshot(zoneManager, { zoneKinds: ["platform"] });
        const conflictResult = await computeConflicts(release.bundle, base.snapshot, currentSnapshot, instructionManager);
        const mergeResult = await mergeConflicts(convexBridge, conflictResult.conflicts, release.bundle);
        if (!mergeResult.ok) {
            return {
                ok: false,
                releaseId: release.releaseId,
                reason: mergeResult.reason,
                conflicts: conflictResult.conflicts.length,
            };
        }
        const resolutionMap = new Map();
        for (const resolution of mergeResult.resolutions) {
            resolutionMap.set(resolution.virtualPath, resolution);
        }
        const changedPaths = release.bundle.manifest.changedPaths;
        const zones = release.bundle.manifest.zones;
        const rollbackSnapshot = await createSnapshot(zoneManager, {
            subsetPaths: changedPaths,
            zoneNames: zones,
        });
        const changeSet = await changeSetManager.startChangeSet({
            scope: "update_apply",
            agentType: "system_update",
            conversationId: input.conversationId,
            deviceId: input.deviceId,
            reason: `Applying upstream update ${release.releaseId} (${release.version})`,
            userConfirmed: true,
            overrideGuard: true,
        });
        try {
            for (const entry of conflictResult.nonConflicts) {
                await applyEntry(zoneManager, entry);
            }
            for (const conflict of conflictResult.conflicts) {
                const resolution = resolutionMap.get(conflict.virtualPath);
                if (!resolution) {
                    throw new Error(`No merge resolution provided for ${conflict.virtualPath}`);
                }
                if (resolution.strategy === "keep_local") {
                    continue;
                }
                if (resolution.strategy === "use_upstream") {
                    const upstreamEntry = release.bundle.entries.find((entry) => entry.virtualPath === conflict.virtualPath);
                    if (!upstreamEntry) {
                        throw new Error(`Upstream entry missing for ${conflict.virtualPath}`);
                    }
                    await applyEntry(zoneManager, upstreamEntry);
                    continue;
                }
                if (resolution.strategy === "merged") {
                    if (!resolution.content || !resolution.encoding) {
                        throw new Error(`Merged resolution missing content for ${conflict.virtualPath}`);
                    }
                    await applyEntry(zoneManager, {
                        virtualPath: conflict.virtualPath,
                        zone: conflict.zone,
                        projectRelativePath: conflict.virtualPath,
                        action: "update",
                        encoding: resolution.encoding,
                        content: resolution.content,
                    });
                }
            }
        }
        catch (error) {
            await restoreSnapshot(rollbackSnapshot, zoneManager, {
                subsetPaths: changedPaths,
                zoneNames: zones,
            });
            return {
                ok: false,
                releaseId: release.releaseId,
                changeSetId: changeSet.id,
                reason: `Failed to apply update: ${error.message}`,
                conflicts: conflictResult.conflicts.length,
            };
        }
        const finish = await changeSetManager.finishChangeSet({
            title: `Upstream update: ${release.version}`,
            summary: `Applied upstream update ${release.releaseId} on channel ${release.channelId}.`,
            skipDefaultValidations: true,
            validations: smokeValidationSpecs(zoneManager.projectRoot),
            userConfirmed: true,
            overrideGuard: true,
        });
        if (!finish.ok || !finish.changeSet) {
            await restoreSnapshot(rollbackSnapshot, zoneManager, {
                subsetPaths: changedPaths,
                zoneNames: zones,
            });
            return {
                ok: false,
                releaseId: release.releaseId,
                changeSetId: changeSet.id,
                reason: finish.reason ?? "Update failed validation and was rolled back.",
                conflicts: conflictResult.conflicts.length,
            };
        }
        const appliedRecord = {
            releaseId: release.releaseId,
            channelId: release.channelId,
            version: release.version,
            appliedAt: Date.now(),
            changeSetId: finish.changeSet.id,
            conflicts: conflictResult.conflicts.length,
        };
        const appliedPath = path.join(stateStore.updatesDir, "applied.json");
        const appliedHistory = await (async () => {
            try {
                const raw = await fs.readFile(appliedPath, "utf-8");
                return JSON.parse(raw);
            }
            catch {
                return [];
            }
        })();
        await fs.mkdir(path.dirname(appliedPath), { recursive: true });
        await fs.writeFile(appliedPath, JSON.stringify([appliedRecord, ...appliedHistory].slice(0, 50), null, 2), "utf-8");
        await callAction("updates.recordAppliedRelease", {
            releaseId: release.releaseId,
            channelId: release.channelId,
            version: release.version,
            deviceId: input.deviceId,
            conversationId: input.conversationId,
            changeSetId: finish.changeSet.id,
            conflicts: conflictResult.conflicts.length,
        });
        if (input.conversationId) {
            await callMutation("events.appendEvent", {
                conversationId: input.conversationId,
                type: "update_applied",
                deviceId: input.deviceId,
                payload: {
                    releaseId: release.releaseId,
                    channelId: release.channelId,
                    version: release.version,
                    changeSetId: finish.changeSet.id,
                    conflicts: conflictResult.conflicts.length,
                },
            });
        }
        return {
            ok: true,
            releaseId: release.releaseId,
            changeSetId: finish.changeSet.id,
            conflicts: conflictResult.conflicts.length,
        };
    };
    return {
        setConvexBridge,
        checkForUpdates,
        applyUpdate,
    };
};
