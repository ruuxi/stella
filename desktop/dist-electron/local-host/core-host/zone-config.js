import path from "path";
import { ensureWithinRoot, joinRoot, normalizeAbsolutePath, relativeToRoot, toPosix, } from "./path-utils.js";
const getZoneRoots = (projectRoot, StellaHome) => {
    const uiRoot = path.join(projectRoot, "src");
    const screensRoot = path.join(uiRoot, "screens");
    const coreHostRoot = path.join(projectRoot, "electron", "local-host");
    const instructionsRoot = path.join(projectRoot, "instructions");
    const packsRoot = path.join(StellaHome, "packs");
    const workspaceRoot = path.join(StellaHome, "workspace");
    const userRoot = path.join(StellaHome, "user");
    return {
        uiRoot,
        screensRoot,
        coreHostRoot,
        instructionsRoot,
        packsRoot,
        workspaceRoot,
        userRoot,
    };
};
const buildZones = (projectRoot, StellaHome) => {
    const roots = getZoneRoots(projectRoot, StellaHome);
    return [
        {
            name: "ui",
            kind: "platform",
            description: "Renderer UI and shared frontend logic.",
            virtualRoot: "/ui",
            roots: [roots.uiRoot],
        },
        {
            name: "screens",
            kind: "platform",
            description: "Right-panel screens and screen host wiring.",
            virtualRoot: "/screens",
            roots: [roots.screensRoot],
        },
        {
            name: "packs",
            kind: "platform",
            description: "Pack bundles, manifests, and pack state.",
            virtualRoot: "/packs",
            roots: [roots.packsRoot],
        },
        {
            name: "core-host",
            kind: "platform",
            description: "Electron local host, tool runner, and safety rails.",
            virtualRoot: "/core-host",
            roots: [roots.coreHostRoot],
        },
        {
            name: "instructions",
            kind: "platform",
            description: "Folder-local instruction files and platform rules.",
            virtualRoot: "/instructions",
            roots: [roots.instructionsRoot],
        },
        {
            name: "workspace",
            kind: "user",
            description: "User workspace outputs and artifacts.",
            virtualRoot: "/workspace",
            roots: [roots.workspaceRoot],
        },
        {
            name: "user",
            kind: "user",
            description: "User-owned data and artifacts.",
            virtualRoot: "/user",
            roots: [roots.userRoot],
        },
    ];
};
const pickBestZone = (zones, absolutePath) => {
    const matches = [];
    for (const zone of zones) {
        for (const root of zone.roots) {
            if (ensureWithinRoot(root, absolutePath)) {
                matches.push({ zone, root });
            }
        }
    }
    if (matches.length === 0) {
        return null;
    }
    matches.sort((a, b) => b.root.length - a.root.length);
    return matches[0];
};
const virtualToAbsolute = (zones, virtualPath) => {
    const normalized = toPosix(virtualPath);
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) {
        return null;
    }
    const zoneName = segments[0];
    const zone = zones.find((item) => item.virtualRoot === `/${zoneName}`);
    if (!zone) {
        return null;
    }
    const relative = segments.slice(1).join("/");
    const root = zone.roots[0];
    return {
        zone,
        absolutePath: joinRoot(root, relative),
    };
};
const classifyPathInternal = (zones, projectRoot, absolutePath) => {
    const normalizedAbsolute = normalizeAbsolutePath(absolutePath);
    const best = pickBestZone(zones, normalizedAbsolute);
    const zone = best?.zone ?? null;
    const zoneRoot = best?.root;
    const zoneRelativePath = zone && zoneRoot ? relativeToRoot(zoneRoot, normalizedAbsolute) : toPosix(normalizedAbsolute);
    const virtualPath = zone ? `${zone.virtualRoot}/${zoneRelativePath}` : normalizedAbsolute;
    const projectRelativePath = ensureWithinRoot(projectRoot, normalizedAbsolute)
        ? relativeToRoot(projectRoot, normalizedAbsolute)
        : zoneRelativePath;
    return {
        zone,
        absolutePath: normalizedAbsolute,
        zoneRelativePath,
        virtualPath,
        projectRelativePath,
    };
};
const guardPlatformZone = (zone, context) => {
    if (context.agentType === "self_mod") {
        return { ok: true };
    }
    if (context.overrideGuard && context.userConfirmed) {
        return { ok: true };
    }
    const needsSelfMod = "Platform zones may only be modified by the Self-Modification agent (or user-confirmed system operations).";
    return {
        ok: false,
        reason: `${needsSelfMod} Blocked zone: ${zone.virtualRoot}.`,
    };
};
const guardUserZone = (_zone, context) => {
    if (context.agentType === "explore") {
        return {
            ok: false,
            reason: "Explore agent is read-only and may not write to user zones.",
        };
    }
    return { ok: true };
};
const guardUnknownZone = (context) => {
    if (context.agentType === "self_mod" && context.overrideGuard && context.userConfirmed) {
        return { ok: true };
    }
    return {
        ok: false,
        reason: "Path is outside all known zones. Refuse to modify it unless explicitly routed through a user-confirmed system operation.",
    };
};
export const createZoneManager = (options) => {
    const projectRoot = normalizeAbsolutePath(options.projectRoot);
    const StellaHome = normalizeAbsolutePath(options.stellaHome);
    const zones = buildZones(projectRoot, StellaHome);
    const resolvePath = (inputPath) => {
        const trimmed = String(inputPath ?? "").trim();
        if (!trimmed) {
            return {
                ok: false,
                error: "Path is required.",
            };
        }
        if (trimmed.startsWith("/")) {
            const virtual = virtualToAbsolute(zones, trimmed);
            if (virtual) {
                return {
                    ok: true,
                    path: virtual.absolutePath,
                    zone: virtual.zone,
                    virtualPath: trimmed,
                };
            }
        }
        const absolute = path.isAbsolute(trimmed)
            ? normalizeAbsolutePath(trimmed)
            : normalizeAbsolutePath(path.join(projectRoot, trimmed));
        const classification = classifyPathInternal(zones, projectRoot, absolute);
        return {
            ok: true,
            path: classification.absolutePath,
            zone: classification.zone,
            virtualPath: classification.virtualPath,
        };
    };
    const classifyPath = (inputPath) => {
        const resolved = resolvePath(inputPath);
        if (!resolved.ok) {
            return classifyPathInternal(zones, projectRoot, inputPath);
        }
        return classifyPathInternal(zones, projectRoot, resolved.path);
    };
    const enforceGuard = (inputPath, context) => {
        const classification = classifyPath(inputPath);
        const zone = classification.zone;
        if (!zone) {
            const result = guardUnknownZone(context);
            return { ...result, classification };
        }
        const result = zone.kind === "platform" ? guardPlatformZone(zone, context) : guardUserZone(zone, context);
        return { ...result, classification };
    };
    const getZones = () => zones.slice();
    const getPlatformZones = () => zones.filter((zone) => zone.kind === "platform");
    const getUserZones = () => zones.filter((zone) => zone.kind === "user");
    const getZoneRoots = () => {
        const roots = {};
        for (const zone of zones) {
            roots[zone.name] = zone.roots.slice();
        }
        return roots;
    };
    return {
        projectRoot,
        StellaHome,
        resolvePath,
        classifyPath,
        enforceGuard,
        getZones,
        getPlatformZones,
        getUserZones,
        getZoneRoots,
    };
};
