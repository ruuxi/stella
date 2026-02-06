import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { toPosix } from "./path-utils.js";
const isIgnoredDir = (name) => name === "node_modules" ||
    name === ".git" ||
    name === "dist" ||
    name === "dist-electron" ||
    name === "release" ||
    name === "coverage" ||
    name === "bundles" ||
    name === "cache";
const walkFiles = async (basePath) => {
    const results = [];
    const stack = [basePath];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        let entries = [];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!isIgnoredDir(entry.name)) {
                    stack.push(fullPath);
                }
                continue;
            }
            if (entry.isFile()) {
                results.push(fullPath);
            }
        }
    }
    return results;
};
const hashBuffer = (buffer) => {
    const hash = createHash("sha256");
    hash.update(buffer);
    return hash.digest("hex");
};
const readFileForSnapshot = async (filePath) => {
    const buffer = await fs.readFile(filePath);
    const hash = hashBuffer(buffer);
    try {
        return {
            size: buffer.byteLength,
            hash,
            encoding: "utf8",
            content: buffer.toString("utf-8"),
        };
    }
    catch {
        return {
            size: buffer.byteLength,
            hash,
            encoding: "base64",
            content: buffer.toString("base64"),
        };
    }
};
const shouldIncludeZone = (zone, options) => {
    if (options.zoneNames && options.zoneNames.length > 0) {
        return options.zoneNames.includes(zone.name);
    }
    if (options.zoneKinds && options.zoneKinds.length > 0) {
        return options.zoneKinds.includes(zone.kind);
    }
    return true;
};
const pickSubsetZones = (zoneManager, subsetPaths) => {
    const seen = new Set();
    for (const item of subsetPaths) {
        const classification = zoneManager.classifyPath(item);
        if (classification.zone) {
            seen.add(classification.zone.name);
        }
    }
    return Array.from(seen);
};
const includeSubsetPath = (subsetPaths, fileVirtualPath, zoneManager) => {
    if (!subsetPaths || subsetPaths.length === 0) {
        return true;
    }
    const normalizedVirtual = toPosix(fileVirtualPath);
    return subsetPaths.some((subsetPath) => {
        const classification = zoneManager.classifyPath(subsetPath);
        const subsetVirtual = toPosix(classification.virtualPath);
        return normalizedVirtual === subsetVirtual;
    });
};
export const createSnapshot = async (zoneManager, options = {}) => {
    const zones = zoneManager.getZones().filter((zone) => shouldIncludeZone(zone, options));
    const subsetZoneNames = options.subsetPaths && options.subsetPaths.length > 0
        ? pickSubsetZones(zoneManager, options.subsetPaths)
        : null;
    const files = {};
    for (const zone of zones) {
        if (subsetZoneNames && subsetZoneNames.length > 0 && !subsetZoneNames.includes(zone.name)) {
            continue;
        }
        for (const root of zone.roots) {
            let statOk = false;
            try {
                const stat = await fs.stat(root);
                statOk = stat.isDirectory();
            }
            catch {
                statOk = false;
            }
            if (!statOk)
                continue;
            const entries = await walkFiles(root);
            for (const entry of entries) {
                const classification = zoneManager.classifyPath(entry);
                if (!classification.zone)
                    continue;
                if (!includeSubsetPath(options.subsetPaths, classification.virtualPath, zoneManager)) {
                    continue;
                }
                try {
                    const snapshotData = await readFileForSnapshot(entry);
                    const record = {
                        virtualPath: classification.virtualPath,
                        absolutePath: classification.absolutePath,
                        zone: classification.zone.name,
                        zoneRelativePath: classification.zoneRelativePath,
                        projectRelativePath: classification.projectRelativePath,
                        size: snapshotData.size,
                        hash: snapshotData.hash,
                        encoding: snapshotData.encoding,
                        content: snapshotData.content,
                    };
                    files[record.virtualPath] = record;
                }
                catch {
                    // Skip unreadable files.
                }
            }
        }
    }
    return {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        zoneRoots: zoneManager.getZoneRoots(),
        files,
    };
};
export const diffSnapshots = (before, after) => {
    const diffs = [];
    const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
    for (const key of keys) {
        const prev = before.files[key];
        const next = after.files[key];
        if (!prev && next) {
            diffs.push({
                virtualPath: key,
                zone: next.zone,
                changeType: "added",
                after: next,
            });
            continue;
        }
        if (prev && !next) {
            diffs.push({
                virtualPath: key,
                zone: prev.zone,
                changeType: "deleted",
                before: prev,
            });
            continue;
        }
        if (prev && next && prev.hash !== next.hash) {
            diffs.push({
                virtualPath: key,
                zone: next.zone,
                changeType: "modified",
                before: prev,
                after: next,
            });
        }
    }
    diffs.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));
    return diffs;
};
const writeSnapshotFile = async (file) => {
    await fs.mkdir(path.dirname(file.absolutePath), { recursive: true });
    if (file.encoding === "utf8") {
        await fs.writeFile(file.absolutePath, file.content, "utf-8");
        return;
    }
    const buffer = Buffer.from(file.content, "base64");
    await fs.writeFile(file.absolutePath, buffer);
};
const deleteIfExists = async (filePath) => {
    try {
        await fs.rm(filePath, { force: true });
    }
    catch {
        // Ignore deletes.
    }
};
const filterDiffsForRestore = (diffs, options, zoneManager) => {
    const subsetVirtuals = new Set();
    if (options.subsetPaths && options.subsetPaths.length > 0) {
        for (const item of options.subsetPaths) {
            const classification = zoneManager.classifyPath(item);
            subsetVirtuals.add(classification.virtualPath);
        }
    }
    return diffs.filter((diff) => {
        if (options.zoneNames && options.zoneNames.length > 0) {
            if (!options.zoneNames.includes(diff.zone)) {
                return false;
            }
        }
        if (subsetVirtuals.size > 0 && !subsetVirtuals.has(diff.virtualPath)) {
            return false;
        }
        return true;
    });
};
export const restoreSnapshot = async (snapshot, zoneManager, options = {}) => {
    const zoneNames = options.zoneNames && options.zoneNames.length > 0 ? options.zoneNames : undefined;
    const subsetPaths = options.subsetPaths && options.subsetPaths.length > 0 ? options.subsetPaths : undefined;
    const current = await createSnapshot(zoneManager, {
        zoneNames,
        subsetPaths,
    });
    const diffs = diffSnapshots(snapshot, current);
    const toApply = filterDiffsForRestore(diffs, options, zoneManager);
    for (const diff of toApply) {
        if (diff.changeType === "added") {
            await deleteIfExists(diff.after?.absolutePath ?? "");
            continue;
        }
        if (diff.before) {
            await writeSnapshotFile(diff.before);
        }
        else if (diff.after) {
            await deleteIfExists(diff.after.absolutePath);
        }
    }
    return {
        restoredCount: toApply.length,
        diffs: toApply,
    };
};
