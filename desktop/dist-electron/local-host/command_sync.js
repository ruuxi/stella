/**
 * Command Sync
 *
 * Reads bundled command markdown files from resources/bundled-commands/
 * and syncs them to the backend commands table.
 */
import { promises as fs } from "fs";
import path from "path";
const log = (...args) => console.log("[command-sync]", ...args);
/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { name, description, argumentHint } or null if parsing fails.
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match)
        return null;
    const yaml = match[1];
    const fields = {};
    for (const line of yaml.split(/\r?\n/)) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        fields[key] = value;
    }
    if (!fields["description"])
        return null;
    return {
        name: fields["name"] || "",
        description: fields["description"],
        argumentHint: fields["argument-hint"],
    };
}
/**
 * Derive a human-readable name from the command filename.
 * e.g. "call-summary" → "Call Summary"
 */
function deriveDisplayName(filename) {
    const base = filename.replace(/\.md$/, "");
    return base
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}
export async function syncBundledCommands(bundledCommandsPath, callMutation) {
    log("Syncing bundled commands from", bundledCommandsPath);
    const commands = [];
    let pluginDirs;
    try {
        const entries = await fs.readdir(bundledCommandsPath, {
            withFileTypes: true,
        });
        pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        log("No bundled commands directory found");
        return;
    }
    for (const pluginDir of pluginDirs) {
        const pluginPath = path.join(bundledCommandsPath, pluginDir);
        let files;
        try {
            files = (await fs.readdir(pluginPath)).filter((f) => f.endsWith(".md"));
        }
        catch {
            continue;
        }
        for (const file of files) {
            const filePath = path.join(pluginPath, file);
            const content = await fs.readFile(filePath, "utf-8");
            const frontmatter = parseFrontmatter(content);
            const baseName = file.replace(/\.md$/, "");
            const commandId = `${pluginDir}--${baseName}`;
            const displayName = frontmatter?.name || deriveDisplayName(file);
            const description = frontmatter?.description || `${displayName} command`;
            commands.push({
                commandId,
                name: displayName,
                description,
                pluginName: pluginDir,
                content,
            });
        }
    }
    if (commands.length === 0) {
        log("No commands found");
        return;
    }
    try {
        await callMutation("data/commands.upsertMany", { commands });
        log(`Synced ${commands.length} commands`);
    }
    catch (error) {
        log("Command sync mutation failed:", error);
    }
}
