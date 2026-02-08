/**
 * Store install/uninstall handlers for local package management.
 *
 * Skills: ~/.stella/skills/{skillId}/
 * Themes: ~/.stella/themes/{themeId}.json
 * Mini-apps: workspace root/{workspaceId}/ (default ~/workspaces, with legacy fallback)
 * Plugins: ~/.stella/plugins/{pluginId}/
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
const getStellaRoot = () => path.join(os.homedir(), ".stella");
const sanitizeRelativePath = (relativePath) => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("..")) {
        return null;
    }
    return normalized;
};
const readResultObject = (result) => {
    if (result.error) {
        throw new Error(result.error);
    }
    if (!result.result) {
        return {};
    }
    if (typeof result.result === "string") {
        try {
            return JSON.parse(result.result);
        }
        catch {
            return { value: result.result };
        }
    }
    if (typeof result.result === "object") {
        return result.result;
    }
    return { value: result.result };
};
/**
 * Install a skill package locally.
 * Writes SKILL.md and stella.yaml to ~/.stella/skills/{skillId}/
 */
export const handleInstallSkill = async (args) => {
    const skillId = args.skillId;
    const name = args.name;
    const markdown = args.markdown;
    const agentTypes = args.agentTypes ?? ["general"];
    const tags = args.tags ?? [];
    if (!skillId || !name || !markdown) {
        return { error: "InstallSkillPackage requires skillId, name, and markdown." };
    }
    const skillDir = path.join(getStellaRoot(), "skills", skillId);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown, "utf-8");
    const yaml = [
        `name: ${name}`,
        `description: "Installed from App Store"`,
        `agent_types: [${agentTypes.map((t) => `"${t}"`).join(", ")}]`,
        tags.length > 0 ? `tags: [${tags.map((t) => `"${t}"`).join(", ")}]` : "",
        `enabled: true`,
    ]
        .filter(Boolean)
        .join("\n");
    await fs.writeFile(path.join(skillDir, "stella.yaml"), yaml, "utf-8");
    return { result: { installed: true, path: skillDir } };
};
/**
 * Install a theme package locally.
 * Writes to ~/.stella/themes/{themeId}.json
 */
export const handleInstallTheme = async (args) => {
    const themeId = args.themeId;
    const name = args.name;
    const light = args.light;
    const dark = args.dark;
    if (!themeId || !name || !light || !dark) {
        return { error: "InstallThemePackage requires themeId, name, light, and dark." };
    }
    const themesDir = path.join(getStellaRoot(), "themes");
    await fs.mkdir(themesDir, { recursive: true });
    const themeData = { id: themeId, name, light, dark };
    await fs.writeFile(path.join(themesDir, `${themeId}.json`), JSON.stringify(themeData, null, 2), "utf-8");
    return { result: { installed: true, themeId } };
};
/**
 * Install a mini-app/canvas package as a workspace app.
 * Uses create-app.js to scaffold from the committed template.
 */
export const handleInstallCanvas = async (args) => {
    const packageId = String(args.packageId ?? "").trim();
    const appName = String(args.workspaceId ?? args.name ?? packageId).trim();
    if (!packageId) {
        return { error: "InstallCanvasPackage requires packageId." };
    }
    if (!appName) {
        return { error: "InstallCanvasPackage requires a name." };
    }
    // Locate create-app.js relative to this file (local-host/ → ../../workspace/)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const createAppScript = path.resolve(__dirname, "..", "..", "workspace", "create-app.js");
    const appsDir = path.resolve(__dirname, "..", "..", "workspace", "apps");
    const appPath = path.join(appsDir, appName);
    try {
        execSync(`node "${createAppScript}" "${appName}"`, { stdio: "pipe" });
        // Write custom App.tsx if provided
        const source = typeof args.source === "string" ? args.source : undefined;
        if (source) {
            await fs.writeFile(path.join(appPath, "src", "App.tsx"), source, "utf-8");
        }
        // Add extra dependencies if provided
        const dependencies = args.dependencies && typeof args.dependencies === "object"
            ? args.dependencies
            : undefined;
        if (dependencies && Object.keys(dependencies).length > 0) {
            const pkgPath = path.join(appPath, "package.json");
            const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
            pkg.dependencies = { ...pkg.dependencies, ...dependencies };
            await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
        }
        return {
            result: {
                installed: true,
                packageId,
                workspaceId: appName,
                path: appPath,
            },
        };
    }
    catch (err) {
        return { error: `Failed to install canvas package: ${err.message}` };
    }
};
/**
 * Install a plugin package locally.
 * Supports plugin manifest + arbitrary file map.
 */
export const handleInstallPlugin = async (args) => {
    const pluginId = String(args.pluginId ?? args.packageId ?? "").trim();
    const name = String(args.name ?? pluginId).trim();
    const version = String(args.version ?? "0.0.0").trim();
    const description = String(args.description ?? "Installed from App Store");
    const manifest = args.manifest && typeof args.manifest === "object"
        ? args.manifest
        : null;
    const files = args.files && typeof args.files === "object"
        ? args.files
        : {};
    if (!pluginId) {
        return { error: "InstallPluginPackage requires pluginId or packageId." };
    }
    const pluginDir = path.join(getStellaRoot(), "plugins", pluginId);
    await fs.mkdir(pluginDir, { recursive: true });
    const pluginJson = manifest ?? {
        id: pluginId,
        name,
        version,
        description,
        tools: [],
        skills: [],
        agents: [],
    };
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(pluginJson, null, 2), "utf-8");
    for (const [relativePath, content] of Object.entries(files)) {
        if (typeof content !== "string")
            continue;
        const safePath = sanitizeRelativePath(relativePath);
        if (!safePath)
            continue;
        const filePath = path.join(pluginDir, safePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
    }
    return { result: { installed: true, pluginId, path: pluginDir } };
};
/**
 * Uninstall a package locally by removing its files.
 */
export const handleUninstallPackage = async (args) => {
    const type = args.type;
    const localId = args.localId;
    if (!type || !localId) {
        return { error: "UninstallPackage requires type and localId." };
    }
    const stellaRoot = getStellaRoot();
    try {
        switch (type) {
            case "skill": {
                const skillDir = path.join(stellaRoot, "skills", localId);
                await fs.rm(skillDir, { recursive: true, force: true });
                break;
            }
            case "theme": {
                const themePath = path.join(stellaRoot, "themes", `${localId}.json`);
                await fs.rm(themePath, { force: true });
                break;
            }
            case "canvas": {
                const __dir = path.dirname(fileURLToPath(import.meta.url));
                const appsRoot = path.resolve(__dir, "..", "..", "workspace", "apps");
                await fs.rm(path.join(appsRoot, localId), {
                    recursive: true,
                    force: true,
                });
                break;
            }
            case "plugin": {
                const pluginDir = path.join(stellaRoot, "plugins", localId);
                await fs.rm(pluginDir, { recursive: true, force: true });
                break;
            }
            case "mod": {
                return {
                    result: {
                        uninstalled: false,
                        requiresRevert: true,
                        note: "Mod uninstall must be handled via SelfModRevert of the applied feature.",
                    },
                };
            }
            default:
                return { error: `Unsupported package type: ${type}` };
        }
    }
    catch (err) {
        return { error: `Failed to uninstall: ${err.message}` };
    }
    return { result: { uninstalled: true } };
};
