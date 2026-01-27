import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { createSnapshot, restoreSnapshot } from "./snapshots.js";
import { getGitDiff, getGitHead, resolveGitRoot } from "./git.js";
import { defaultValidationSpecs, runValidations, summarizeValidationResults, smokeValidationSpecs, } from "./validations.js";
import { ensureSigningKeys, hashCanonicalJson, signHash, stableStringify, verifySignature } from "./signing.js";
import { ensureWithinRoot } from "./path-utils.js";
const PACK_DIFF_LIMIT = 300000;
const truncateDiff = (value) => {
    if (value.length <= PACK_DIFF_LIMIT) {
        return { diff: value, truncated: false };
    }
    return {
        diff: `${value.slice(0, PACK_DIFF_LIMIT)}\n\n... (diff truncated)`,
        truncated: true,
    };
};
const sanitizePackId = (value) => {
    const base = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return base || `pack-${Date.now()}`;
};
const isSemverLike = (version) => /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version);
const hashBuffer = (buffer) => {
    const hash = createHash("sha256");
    hash.update(buffer);
    return hash.digest("hex");
};
const isLikelyText = (buffer) => {
    if (buffer.includes(0)) {
        return false;
    }
    const decoded = buffer.toString("utf-8");
    const replacementCount = (decoded.match(/\uFFFD/g) ?? []).length;
    return replacementCount < 5;
};
const readFileAsEntry = async (absolutePath, virtualPath, zone, projectRelativePath) => {
    const buffer = await fs.readFile(absolutePath);
    const hash = hashBuffer(buffer);
    const size = buffer.byteLength;
    if (isLikelyText(buffer)) {
        return {
            virtualPath,
            zone,
            projectRelativePath,
            action: "update",
            encoding: "utf8",
            content: buffer.toString("utf-8"),
            hash,
            size,
        };
    }
    return {
        virtualPath,
        zone,
        projectRelativePath,
        action: "update",
        encoding: "base64",
        content: buffer.toString("base64"),
        hash,
        size,
    };
};
const bundleWithoutSignature = (bundle) => {
    const clone = JSON.parse(JSON.stringify(bundle));
    clone.manifest.bundleHash = "";
    clone.manifest.signature = "";
    clone.manifest.authorPublicKey = "";
    return clone;
};
const buildBundlePath = (packsRoot, packId, version) => {
    return path.join(packsRoot, "bundles", packId, `${version}.bundle.json`);
};
const ensureBundleDir = async (packsRoot, packId) => {
    const dir = path.join(packsRoot, "bundles", packId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
};
const collectChangeSets = async (stateStore, changeSetIds) => {
    const records = [];
    for (const id of changeSetIds) {
        const record = await stateStore.loadChangeSetRecord(id);
        if (!record) {
            return { ok: false, reason: `ChangeSet not found: ${id}` };
        }
        if (record.status !== "completed") {
            return { ok: false, reason: `ChangeSet is not completed: ${id}` };
        }
        records.push(record);
    }
    records.sort((a, b) => {
        const aTime = a.completedAt ?? a.startedAt;
        const bTime = b.completedAt ?? b.startedAt;
        return aTime - bTime;
    });
    return { ok: true, records };
};
const collectChangedPaths = (records) => {
    const paths = new Set();
    const zones = new Set();
    const compatibility = new Set();
    const actionMap = new Map();
    for (const record of records) {
        for (const file of record.changedFiles) {
            paths.add(file.virtualPath);
            zones.add(file.zone);
            file.compatibilityNotes.forEach((note) => compatibility.add(note));
            if (file.changeType === "added") {
                actionMap.set(file.virtualPath, "add");
            }
            else if (file.changeType === "deleted") {
                actionMap.set(file.virtualPath, "delete");
            }
            else {
                actionMap.set(file.virtualPath, "update");
            }
        }
    }
    return {
        changedPaths: Array.from(paths).sort((a, b) => a.localeCompare(b)),
        zones: Array.from(zones).sort((a, b) => a.localeCompare(b)),
        compatibilityNotes: Array.from(compatibility),
        actionMap,
    };
};
const buildEntriesFromPaths = async (zoneManager, changedPaths, actionMap) => {
    const entries = [];
    for (const virtualPath of changedPaths) {
        const resolved = zoneManager.resolvePath(virtualPath);
        if (!resolved.ok || !resolved.zone) {
            continue;
        }
        const classification = zoneManager.classifyPath(resolved.path);
        const absolutePath = classification.absolutePath;
        const zone = classification.zone?.name ?? resolved.zone.name;
        const projectRelativePath = classification.projectRelativePath;
        const plannedAction = actionMap.get(classification.virtualPath) ?? "update";
        try {
            const stat = await fs.stat(absolutePath);
            if (stat.isFile()) {
                const entry = await readFileAsEntry(absolutePath, classification.virtualPath, zone, projectRelativePath);
                entry.action = plannedAction === "delete" ? "update" : plannedAction;
                entries.push(entry);
                continue;
            }
        }
        catch {
            // File missing; treat as delete.
        }
        entries.push({
            virtualPath: classification.virtualPath,
            zone,
            projectRelativePath,
            action: "delete",
        });
    }
    entries.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));
    return entries;
};
const verifyBundleSignature = (bundle) => {
    const bundleForHash = bundleWithoutSignature(bundle);
    const hashed = hashCanonicalJson(bundleForHash);
    const signatureValid = verifySignature(bundle.manifest.authorPublicKey, hashed.hashHex, bundle.manifest.signature);
    const hashMatches = hashed.hashHex === bundle.manifest.bundleHash;
    return {
        hashHex: hashed.hashHex,
        signatureValid,
        hashMatches,
    };
};
export const createPackManager = (options) => {
    const { zoneManager, stateStore, changeSetManager, instructionManager, deviceId: hostDeviceId } = options;
    let convexBridge = options.convexBridge ?? null;
    const setConvexBridge = (bridge) => {
        convexBridge = bridge;
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
    const listInstallations = async () => await stateStore.loadPackInstallations();
    const saveInstallations = async (installations) => {
        await stateStore.savePackInstallations(installations);
    };
    const publishPack = async (input) => {
        await stateStore.ensureStructure();
        await changeSetManager.ensureBaseline();
        if (!input.name.trim()) {
            return {
                ok: false,
                packId: input.packId ?? "",
                version: input.version,
                reason: "Pack name is required.",
            };
        }
        if (!isSemverLike(input.version)) {
            return {
                ok: false,
                packId: input.packId ?? "",
                version: input.version,
                reason: "Version must be semver-like (e.g., 1.2.3).",
            };
        }
        if (!Array.isArray(input.changeSetIds) || input.changeSetIds.length === 0) {
            return {
                ok: false,
                packId: input.packId ?? "",
                version: input.version,
                reason: "At least one ChangeSet is required to publish a pack.",
            };
        }
        const changeSets = await collectChangeSets(stateStore, input.changeSetIds);
        if (!changeSets.ok) {
            return {
                ok: false,
                packId: input.packId ?? "",
                version: input.version,
                reason: changeSets.reason,
            };
        }
        const collected = collectChangedPaths(changeSets.records);
        const entries = await buildEntriesFromPaths(zoneManager, collected.changedPaths, collected.actionMap);
        const projectPaths = entries
            .map((entry) => zoneManager.classifyPath(entry.virtualPath))
            .filter((classification) => ensureWithinRoot(zoneManager.projectRoot, classification.absolutePath))
            .map((classification) => classification.projectRelativePath);
        const gitRoot = await resolveGitRoot(zoneManager.projectRoot);
        const diffPatchRaw = gitRoot ? await getGitDiff(gitRoot, projectPaths) : "";
        const diffPatch = truncateDiff(diffPatchRaw);
        const baselineMetadata = await stateStore.loadBaselineMetadata();
        const baselineGitHead = baselineMetadata?.gitHead ?? (await getGitHead(zoneManager.projectRoot));
        const validations = await runValidations(defaultValidationSpecs(zoneManager.projectRoot));
        const validationSummary = summarizeValidationResults(validations);
        const summary = {
            ok: validationSummary.ok,
            requiredFailures: validationSummary.requiredFailures.map((failure) => ({
                name: failure.name,
                status: failure.status,
                exitCode: failure.exitCode,
            })),
        };
        if (!summary.ok) {
            return {
                ok: false,
                packId: input.packId ?? "",
                version: input.version,
                reason: `Validations failed: ${summary.requiredFailures.map((f) => f.name).join(", ")}`,
            };
        }
        const packId = input.packId?.trim() ? sanitizePackId(input.packId) : sanitizePackId(input.name);
        const keys = await ensureSigningKeys(stateStore);
        const securityReviewPayload = {
            packId,
            name: input.name,
            description: input.description,
            version: input.version,
            changedPaths: collected.changedPaths,
            diffPatch: diffPatch.diff,
            entries: entries.map((entry) => ({
                virtualPath: entry.virtualPath,
                zone: entry.zone,
                action: entry.action,
                size: entry.size,
                hash: entry.hash,
                preview: entry.content && entry.encoding === "utf8"
                    ? entry.content.slice(0, 20000)
                    : undefined,
            })),
            validations: validations.map((result) => ({
                name: result.name,
                status: result.status,
                exitCode: result.exitCode,
            })),
        };
        const securityReviewResult = (await callAction("packs.securityReviewBundle", {
            bundle: securityReviewPayload,
        }));
        const securityReview = securityReviewResult ?? {
            status: "needs_changes",
            summary: "Security review could not be completed by the backend. Submission is blocked until review succeeds.",
            findings: ["Security review unavailable."],
            reviewedAt: Date.now(),
        };
        if (securityReview.status !== "approved") {
            return {
                ok: false,
                packId,
                version: input.version,
                securityReview,
                reason: `Security review did not approve the pack (${securityReview.status}).`,
            };
        }
        const manifestBase = {
            schemaVersion: 1,
            packId,
            name: input.name.trim(),
            description: input.description.trim(),
            version: input.version.trim(),
            createdAt: Date.now(),
            authorDeviceId: input.deviceId,
            authorPublicKey: keys.publicKeyPem,
            changeSetIds: input.changeSetIds.slice(),
            baselineId: baselineMetadata?.baselineId,
            baselineGitHead,
            changedPaths: collected.changedPaths,
            zones: collected.zones,
            compatibilityNotes: [
                ...(input.compatibilityNotes ?? []),
                ...collected.compatibilityNotes,
            ].filter((item) => item && item.trim().length > 0),
            validations,
            validationSummary: summary,
            securityReview,
            bundleHash: "",
            signature: "",
        };
        const bundleDraft = {
            schemaVersion: 1,
            manifest: manifestBase,
            entries,
            diffPatch: diffPatch.diff,
            diffPatchTruncated: diffPatch.truncated,
        };
        const hashed = hashCanonicalJson(bundleWithoutSignature(bundleDraft));
        const signature = signHash(keys.privateKeyPem, hashed.hashHex);
        bundleDraft.manifest.bundleHash = hashed.hashHex;
        bundleDraft.manifest.signature = signature;
        await ensureBundleDir(stateStore.packsRoot, packId);
        const bundlePath = buildBundlePath(stateStore.packsRoot, packId, input.version);
        await fs.writeFile(bundlePath, stableStringify(bundleDraft), "utf-8");
        const publishResult = (await callAction("packs.publishVersion", {
            packId,
            name: bundleDraft.manifest.name,
            description: bundleDraft.manifest.description,
            version: bundleDraft.manifest.version,
            manifest: bundleDraft.manifest,
            bundle: bundleDraft,
            bundleHash: bundleDraft.manifest.bundleHash,
            signature: bundleDraft.manifest.signature,
            authorPublicKey: bundleDraft.manifest.authorPublicKey,
            securityReview,
            conversationId: input.conversationId,
            deviceId: input.deviceId,
        }));
        if (!publishResult?.ok) {
            return {
                ok: false,
                packId,
                version: input.version,
                bundlePath,
                securityReview,
                reason: publishResult?.reason ?? "Failed to publish pack to the store registry.",
            };
        }
        if (input.conversationId) {
            await callMutation("events.appendEvent", {
                conversationId: input.conversationId,
                type: "pack_publish_completed",
                deviceId: input.deviceId,
                payload: {
                    packId,
                    version: input.version,
                    changedPaths: collected.changedPaths,
                    bundleHash: bundleDraft.manifest.bundleHash,
                },
            });
        }
        return {
            ok: true,
            packId,
            version: input.version,
            bundlePath,
            securityReview,
        };
    };
    const fetchPackBundle = async (packId, version) => {
        const localPath = buildBundlePath(stateStore.packsRoot, packId, version);
        try {
            const raw = await fs.readFile(localPath, "utf-8");
            const parsed = JSON.parse(raw);
            return { bundle: parsed, source: "local" };
        }
        catch {
            // fall through to store.
        }
        const remote = (await callAction("packs.getBundleForInstall", {
            packId,
            version,
        }));
        if (!remote?.ok || !remote.bundle) {
            return {
                bundle: null,
                source: "remote",
                reason: remote?.reason ?? "Bundle not available.",
            };
        }
        await ensureBundleDir(stateStore.packsRoot, packId);
        await fs.writeFile(localPath, stableStringify(remote.bundle), "utf-8");
        return { bundle: remote.bundle, source: "remote" };
    };
    const applyEntry = async (entry) => {
        const resolved = zoneManager.resolvePath(entry.virtualPath);
        if (!resolved.ok) {
            throw new Error(resolved.error);
        }
        const classification = zoneManager.classifyPath(resolved.path);
        const absolutePath = classification.absolutePath;
        if (entry.action === "delete") {
            await fs.rm(absolutePath, { force: true });
            return classification.virtualPath;
        }
        if (!entry.content || !entry.encoding) {
            throw new Error(`Entry missing content for ${entry.virtualPath}`);
        }
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        if (entry.encoding === "utf8") {
            await fs.writeFile(absolutePath, entry.content, "utf-8");
        }
        else {
            const buffer = Buffer.from(entry.content, "base64");
            await fs.writeFile(absolutePath, buffer);
        }
        return classification.virtualPath;
    };
    const installPack = async (input) => {
        await stateStore.ensureStructure();
        await changeSetManager.ensureBaseline();
        if (!input.userConfirmed) {
            return {
                ok: false,
                reason: "Pack installation requires explicit user confirmation.",
            };
        }
        const fetched = await fetchPackBundle(input.packId, input.version);
        if (!fetched.bundle) {
            return {
                ok: false,
                reason: fetched.reason ?? "Pack bundle not found.",
            };
        }
        const bundle = fetched.bundle;
        const verification = verifyBundleSignature(bundle);
        if (!verification.hashMatches || !verification.signatureValid) {
            return {
                ok: false,
                reason: "Pack signature verification failed.",
            };
        }
        const installId = crypto.randomUUID();
        const changeSet = await changeSetManager.startChangeSet({
            scope: "pack_install",
            agentType: "system_pack_install",
            conversationId: input.conversationId,
            deviceId: input.deviceId,
            reason: `Installing pack ${input.packId}@${input.version} (installId: ${installId})`,
            userConfirmed: true,
            overrideGuard: true,
        });
        const uninstallSnapshot = await createSnapshot(zoneManager, {
            zoneNames: bundle.manifest.zones,
            subsetPaths: bundle.manifest.changedPaths,
        });
        const uninstallSnapshotPath = stateStore.getPackUninstallSnapshotPath(installId);
        await stateStore.savePackUninstallSnapshot(installId, uninstallSnapshot);
        let appliedCount = 0;
        try {
            for (const entry of bundle.entries) {
                await instructionManager.getInstructionsForPath(entry.virtualPath);
                await applyEntry(entry);
                appliedCount += 1;
            }
        }
        catch (error) {
            await restoreSnapshot(uninstallSnapshot, zoneManager, {
                zoneNames: bundle.manifest.zones,
                subsetPaths: bundle.manifest.changedPaths,
            });
            return {
                ok: false,
                reason: `Failed to apply pack entries after ${appliedCount} changes: ${error.message}`,
                changeSetId: changeSet.id,
            };
        }
        const finish = await changeSetManager.finishChangeSet({
            title: `Install pack: ${bundle.manifest.name}@${bundle.manifest.version}`,
            summary: `Installed pack ${bundle.manifest.packId}@${bundle.manifest.version} (${appliedCount} changes).`,
            skipDefaultValidations: true,
            validations: smokeValidationSpecs(zoneManager.projectRoot),
            userConfirmed: true,
            overrideGuard: true,
        });
        if (!finish.ok || !finish.changeSet) {
            await restoreSnapshot(uninstallSnapshot, zoneManager, {
                zoneNames: bundle.manifest.zones,
                subsetPaths: bundle.manifest.changedPaths,
            });
            return {
                ok: false,
                reason: finish.reason ?? "Pack install failed validation and was rolled back.",
                changeSetId: changeSet.id,
            };
        }
        const installations = await listInstallations();
        const record = {
            installId,
            packId: bundle.manifest.packId,
            name: bundle.manifest.name,
            description: bundle.manifest.description,
            version: bundle.manifest.version,
            status: "installed",
            installedAt: Date.now(),
            updatedAt: Date.now(),
            deviceId: input.deviceId,
            bundleHash: bundle.manifest.bundleHash,
            signature: bundle.manifest.signature,
            authorPublicKey: bundle.manifest.authorPublicKey,
            changedPaths: bundle.manifest.changedPaths.slice(),
            zones: bundle.manifest.zones.slice(),
            uninstallSnapshotPath,
        };
        const nextInstallations = [
            record,
            ...installations.filter((item) => !(item.packId === record.packId && item.version === record.version)),
        ];
        await saveInstallations(nextInstallations);
        await callAction("packs.recordInstallation", {
            installId,
            packId: record.packId,
            version: record.version,
            status: record.status,
            deviceId: input.deviceId,
            bundleHash: record.bundleHash,
            signature: record.signature,
            authorPublicKey: record.authorPublicKey,
            changedPaths: record.changedPaths,
            zones: record.zones,
            conversationId: input.conversationId,
            changeSetId: finish.changeSet.id,
        });
        if (input.conversationId) {
            await callMutation("events.appendEvent", {
                conversationId: input.conversationId,
                type: "pack_install_completed",
                deviceId: input.deviceId,
                payload: {
                    packId: record.packId,
                    version: record.version,
                    installId,
                    changeSetId: finish.changeSet.id,
                },
            });
        }
        return {
            ok: true,
            installId,
            changeSetId: finish.changeSet.id,
        };
    };
    const findInstallation = async (packId, version) => {
        const installations = await listInstallations();
        const candidates = installations.filter((item) => item.packId === packId && (!version || item.version === version));
        if (candidates.length === 0) {
            return null;
        }
        candidates.sort((a, b) => b.updatedAt - a.updatedAt);
        return candidates[0];
    };
    const uninstallPack = async (input) => {
        await stateStore.ensureStructure();
        await changeSetManager.ensureBaseline();
        if (!input.userConfirmed) {
            return {
                ok: false,
                reason: "Pack uninstall requires explicit user confirmation.",
            };
        }
        const installation = await findInstallation(input.packId, input.version);
        if (!installation) {
            return {
                ok: false,
                reason: `Pack is not installed: ${input.packId}${input.version ? `@${input.version}` : ""}`,
            };
        }
        if (installation.status === "uninstalled") {
            return {
                ok: true,
                installId: installation.installId,
                changeSetId: undefined,
            };
        }
        const uninstallSnapshot = await stateStore.loadPackUninstallSnapshot(installation.installId);
        if (!uninstallSnapshot) {
            return {
                ok: false,
                reason: "Uninstall snapshot missing; cannot safely uninstall.",
            };
        }
        const changedPaths = installation.changedPaths && installation.changedPaths.length > 0
            ? installation.changedPaths
            : Object.keys(uninstallSnapshot.files);
        const zones = installation.zones && installation.zones.length > 0
            ? installation.zones
            : Array.from(new Set(Object.values(uninstallSnapshot.files).map((file) => file.zone)));
        const rollbackSnapshot = await createSnapshot(zoneManager, {
            subsetPaths: changedPaths,
            zoneNames: zones,
        });
        const changeSet = await changeSetManager.startChangeSet({
            scope: "pack_uninstall",
            agentType: "system_pack_uninstall",
            conversationId: input.conversationId,
            deviceId: input.deviceId,
            reason: `Uninstalling pack ${installation.packId}@${installation.version}`,
            userConfirmed: true,
            overrideGuard: true,
        });
        await restoreSnapshot(uninstallSnapshot, zoneManager, {
            subsetPaths: changedPaths,
            zoneNames: zones,
        });
        const finish = await changeSetManager.finishChangeSet({
            title: `Uninstall pack: ${installation.packId}@${installation.version}`,
            summary: `Restored state prior to pack installation (${installation.packId}@${installation.version}).`,
            skipDefaultValidations: true,
            validations: smokeValidationSpecs(zoneManager.projectRoot),
            userConfirmed: true,
            overrideGuard: true,
        });
        if (!finish.ok || !finish.changeSet) {
            await restoreSnapshot(rollbackSnapshot, zoneManager, {
                subsetPaths: Object.keys(rollbackSnapshot.files),
                zoneNames: Array.from(new Set(Object.values(rollbackSnapshot.files).map((f) => f.zone))),
            });
            return {
                ok: false,
                reason: finish.reason ?? "Uninstall failed validation and was rolled back.",
                changeSetId: changeSet.id,
            };
        }
        const installations = await listInstallations();
        const nextInstallations = installations.map((item) => {
            if (item.installId !== installation.installId) {
                return item;
            }
            return {
                ...item,
                status: "uninstalled",
                updatedAt: Date.now(),
            };
        });
        await saveInstallations(nextInstallations);
        await callAction("packs.recordInstallation", {
            installId: installation.installId,
            packId: installation.packId,
            version: installation.version,
            status: "uninstalled",
            deviceId: input.deviceId,
            changedPaths,
            zones,
            conversationId: input.conversationId,
            changeSetId: finish.changeSet.id,
        });
        if (input.conversationId) {
            await callMutation("events.appendEvent", {
                conversationId: input.conversationId,
                type: "pack_uninstall_completed",
                deviceId: input.deviceId,
                payload: {
                    packId: installation.packId,
                    version: installation.version,
                    installId: installation.installId,
                    changeSetId: finish.changeSet.id,
                },
            });
        }
        return {
            ok: true,
            installId: installation.installId,
            changeSetId: finish.changeSet.id,
        };
    };
    const disableAllForSafeMode = async (reason) => {
        const installations = await listInstallations();
        if (installations.length === 0) {
            return;
        }
        const now = Date.now();
        const next = installations.map((item) => {
            if (item.status !== "installed") {
                return item;
            }
            return {
                ...item,
                status: "disabled_safe_mode",
                updatedAt: now,
                lastError: reason,
            };
        });
        await saveInstallations(next);
        await callAction("packs.safeModeDisabled", {
            reason,
            disabledAt: now,
            packIds: next.filter((item) => item.status === "disabled_safe_mode").map((item) => item.packId),
            deviceId: hostDeviceId,
        });
    };
    return {
        setConvexBridge,
        publishPack,
        installPack,
        uninstallPack,
        disableAllForSafeMode,
        listInstallations,
    };
};
