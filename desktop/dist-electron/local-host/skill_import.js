/**
 * Skill Import System
 *
 * Imports skills from ~/.claude/skills/ and ~/.agents/skills/ into ~/.stella/skills/,
 * generating stella.yaml metadata files via LLM.
 */
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { loadJson, saveJson } from "./tools-utils.js";
import { stringify as stringifyYaml } from "yaml";
const log = (...args) => console.log("[skill-import]", ...args);
// ---------------------------------------------------------------------------
// Index Management
// ---------------------------------------------------------------------------
const INDEX_FILE = "skill_imports.json";
const emptyIndex = () => ({
    version: 1,
    imports: {},
});
export const loadImportIndex = async (statePath) => {
    const indexPath = path.join(statePath, INDEX_FILE);
    return loadJson(indexPath, emptyIndex());
};
export const saveImportIndex = async (statePath, index) => {
    const indexPath = path.join(statePath, INDEX_FILE);
    await saveJson(indexPath, index);
};
// ---------------------------------------------------------------------------
// Hash Computation
// ---------------------------------------------------------------------------
const computeFileHash = async (filePath) => {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    }
    catch {
        return "";
    }
};
// ---------------------------------------------------------------------------
// Skill Discovery
// ---------------------------------------------------------------------------
export const discoverSkillsFromSource = async (sourceDir, priority) => {
    const results = [];
    let entries = [];
    try {
        entries = await fs.readdir(sourceDir, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        // Skip hidden directories
        if (entry.name.startsWith("."))
            continue;
        const skillDir = path.join(sourceDir, entry.name);
        const skillMdPath = path.join(skillDir, "SKILL.md");
        try {
            const stat = await fs.stat(skillMdPath);
            if (stat.isFile()) {
                results.push({
                    id: entry.name,
                    dirName: entry.name,
                    sourceDir: skillDir,
                    skillMdPath,
                    priority,
                });
            }
        }
        catch {
            // Skip directories without SKILL.md
        }
    }
    return results;
};
// ---------------------------------------------------------------------------
// Deduplication and Import Planning
// ---------------------------------------------------------------------------
const getExistingSkillIds = async (stellaSkillsPath) => {
    const ids = new Set();
    let entries = [];
    try {
        entries = await fs.readdir(stellaSkillsPath, { withFileTypes: true });
    }
    catch {
        return ids;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
            ids.add(entry.name);
        }
    }
    return ids;
};
export const getSkillsToImport = async (claudeSkills, agentsSkills, importIndex, existingStellaIds) => {
    const byId = new Map();
    // Add claude skills first (lower priority)
    for (const skill of claudeSkills) {
        if (existingStellaIds.has(skill.id))
            continue;
        if (importIndex.imports[skill.id])
            continue;
        const sourceHash = await computeFileHash(skill.skillMdPath);
        byId.set(skill.id, { ...skill, sourceHash });
    }
    // Agents skills override (higher priority)
    for (const skill of agentsSkills) {
        if (existingStellaIds.has(skill.id))
            continue;
        if (importIndex.imports[skill.id])
            continue;
        const sourceHash = await computeFileHash(skill.skillMdPath);
        byId.set(skill.id, { ...skill, sourceHash });
    }
    return Array.from(byId.values());
};
// ---------------------------------------------------------------------------
// Directory Copy
// ---------------------------------------------------------------------------
const copyDirectory = async (src, dest) => {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
        }
        else if (entry.isFile()) {
            await fs.copyFile(srcPath, destPath);
        }
    }
};
// ---------------------------------------------------------------------------
// Skill Import
// ---------------------------------------------------------------------------
const importSkill = async (plan, stellaSkillsPath, generateMetadata) => {
    const destDir = path.join(stellaSkillsPath, plan.dirName);
    log(`Importing skill: ${plan.id} from ${plan.priority}`);
    // 1. Copy entire skill directory
    await copyDirectory(plan.sourceDir, destDir);
    // 2. Read SKILL.md content
    const skillMdPath = path.join(destDir, "SKILL.md");
    const markdown = await fs.readFile(skillMdPath, "utf-8");
    // 3. Generate metadata via LLM
    let metadata;
    try {
        const result = await generateMetadata(markdown, plan.dirName);
        metadata = {
            id: result.metadata.id || plan.dirName,
            name: result.metadata.name || plan.dirName,
            description: result.metadata.description || "Skill instructions.",
            agentTypes: result.metadata.agentTypes || ["general-purpose"],
            version: 1,
            source: plan.priority,
            importedAt: Date.now(),
        };
    }
    catch (error) {
        log(`Failed to generate metadata for ${plan.id}, using defaults:`, error);
        metadata = {
            id: plan.dirName,
            name: plan.dirName,
            description: "Skill instructions.",
            agentTypes: ["general-purpose"],
            version: 1,
            source: plan.priority,
            importedAt: Date.now(),
        };
    }
    // 4. Write stella.yaml
    const stellaYamlPath = path.join(destDir, "stella.yaml");
    const yamlContent = `# Generated by Stella - do not edit manually\n${stringifyYaml(metadata)}`;
    await fs.writeFile(stellaYamlPath, yamlContent, "utf-8");
    log(`Created stella.yaml for ${plan.id}`);
    return {
        sourceDir: plan.sourceDir,
        sourceHash: plan.sourceHash,
        importedAt: Date.now(),
        priority: plan.priority,
    };
};
// ---------------------------------------------------------------------------
// Main Sync Function
// ---------------------------------------------------------------------------
export const syncExternalSkills = async (claudeSkillsPath, agentsSkillsPath, stellaSkillsPath, statePath, generateMetadata) => {
    const importIndex = await loadImportIndex(statePath);
    // 1. Discover skills from both sources
    const claudeSkills = await discoverSkillsFromSource(claudeSkillsPath, "claude");
    const agentsSkills = await discoverSkillsFromSource(agentsSkillsPath, "agents");
    // 2. Get existing skills in ~/.stella/skills/
    const existingStellaSkills = await getExistingSkillIds(stellaSkillsPath);
    // 3. Determine import plan (with deduplication, .agents wins)
    const importPlan = await getSkillsToImport(claudeSkills, agentsSkills, importIndex, existingStellaSkills);
    if (importPlan.length === 0) {
        return;
    }
    log(`Found ${importPlan.length} new skill(s) to import`);
    // 4. Import each skill
    for (const plan of importPlan) {
        try {
            const record = await importSkill(plan, stellaSkillsPath, generateMetadata);
            importIndex.imports[plan.id] = record;
        }
        catch (error) {
            log(`Failed to import ${plan.id}:`, error);
        }
    }
    // 5. Save updated index
    await saveImportIndex(statePath, importIndex);
};
