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
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

const log = (...args: unknown[]) => console.log("[skill-import]", ...args);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillImportRecord = {
  sourceDir: string;
  sourceHash: string;
  importedAt: number;
  priority: "claude" | "agents" | "anthropic";
};

export type SkillImportIndex = {
  version: 1;
  imports: Record<string, SkillImportRecord>;
};

export type StellaYaml = {
  id: string;
  name: string;
  description: string;
  agentTypes: string[];
  version: number;
  source: "claude" | "agents" | "anthropic";
  enabled?: boolean;
  importedAt: number;
};

export type DiscoveredSkill = {
  id: string;
  dirName: string;
  sourceDir: string;
  skillMdPath: string;
  priority: "claude" | "agents" | "anthropic";
};

export type SkillImportPlan = DiscoveredSkill & {
  sourceHash: string;
};

export type GenerateMetadataFn = (
  markdown: string,
  dirName: string,
) => Promise<{ metadata: { id: string; name: string; description: string; agentTypes: string[] } }>;

// ---------------------------------------------------------------------------
// Index Management
// ---------------------------------------------------------------------------

const INDEX_FILE = "skill_imports.json";

const emptyIndex = (): SkillImportIndex => ({
  version: 1,
  imports: {},
});

export const loadImportIndex = async (statePath: string): Promise<SkillImportIndex> => {
  const indexPath = path.join(statePath, INDEX_FILE);
  return loadJson(indexPath, emptyIndex());
};

export const saveImportIndex = async (
  statePath: string,
  index: SkillImportIndex,
): Promise<void> => {
  const indexPath = path.join(statePath, INDEX_FILE);
  await saveJson(indexPath, index);
};

// ---------------------------------------------------------------------------
// Hash Computation
// ---------------------------------------------------------------------------

const computeFileHash = async (filePath: string): Promise<string> => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// Skill Discovery
// ---------------------------------------------------------------------------

export const discoverSkillsFromSource = async (
  sourceDir: string,
  priority: "claude" | "agents" | "anthropic",
): Promise<DiscoveredSkill[]> => {
  const results: DiscoveredSkill[] = [];

  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

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
    } catch {
      // Skip directories without SKILL.md
    }
  }

  return results;
};

// ---------------------------------------------------------------------------
// Deduplication and Import Planning
// ---------------------------------------------------------------------------

const getExistingSkillIds = async (stellaSkillsPath: string): Promise<Set<string>> => {
  const ids = new Set<string>();

  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(stellaSkillsPath, { withFileTypes: true });
  } catch {
    return ids;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      ids.add(entry.name);
    }
  }

  return ids;
};

export const getSkillsToImport = async (
  claudeSkills: DiscoveredSkill[],
  agentsSkills: DiscoveredSkill[],
  importIndex: SkillImportIndex,
  existingStellaIds: Set<string>,
): Promise<SkillImportPlan[]> => {
  const byId = new Map<string, SkillImportPlan>();

  // Add claude skills first (lower priority)
  for (const skill of claudeSkills) {
    if (existingStellaIds.has(skill.id)) continue;
    if (importIndex.imports[skill.id]) continue;

    const sourceHash = await computeFileHash(skill.skillMdPath);
    byId.set(skill.id, { ...skill, sourceHash });
  }

  // Agents skills override (higher priority)
  for (const skill of agentsSkills) {
    if (existingStellaIds.has(skill.id)) continue;
    if (importIndex.imports[skill.id]) continue;

    const sourceHash = await computeFileHash(skill.skillMdPath);
    byId.set(skill.id, { ...skill, sourceHash });
  }

  return Array.from(byId.values());
};

// ---------------------------------------------------------------------------
// Directory Copy
// ---------------------------------------------------------------------------

const copyDirectory = async (src: string, dest: string): Promise<void> => {
  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
};

// ---------------------------------------------------------------------------
// SKILL.md Post-Processing (Anthropic → Stella adaptation)
// ---------------------------------------------------------------------------

const postProcessSkillMarkdown = (markdown: string, skillId: string, destDir: string): string => {
  let processed = markdown;

  // 1. Replace relative script paths with absolute paths
  //    e.g., `python scripts/office/unpack.py` → `python /path/to/skill/scripts/office/unpack.py`
  const scriptPathRegex = /(?<=\s|`|^)(python[3]?\s+)(scripts\/)/gm;
  const absoluteScriptDir = destDir.replace(/\\/g, "/") + "/scripts/";
  processed = processed.replace(scriptPathRegex, (_match, prefix) => `${prefix}${absoluteScriptDir}`);

  // 2. Strip Anthropic artifact model references
  processed = processed.replace(/\bcreate_artifact\b/g, "create a file");
  processed = processed.replace(/\bwindow\.artifact\b/g, "the canvas panel");
  processed = processed.replace(
    /\bartifact\s+viewer\b/gi,
    "canvas panel",
  );

  // 3. Add Stella canvas integration hint if the skill produces visual output
  //    but only if it doesn't already mention OpenCanvas
  if (!processed.includes("OpenCanvas")) {
    const producesVisual =
      /\.(html|svg|png|jpg|jpeg|gif|pdf)\b/i.test(processed) ||
      /p5\.js|canvas|chart|diagram|visualization/i.test(processed);

    if (producesVisual) {
      processed += `\n\n## Stella Canvas Integration\nAfter generating output files, you can display them using \`OpenCanvas(name="${skillId}", title="Output")\` to show results in the side panel.\n`;
    }
  }

  return processed;
};

// ---------------------------------------------------------------------------
// Skill Import
// ---------------------------------------------------------------------------

const importSkill = async (
  plan: SkillImportPlan,
  stellaSkillsPath: string,
  generateMetadata: GenerateMetadataFn,
  options?: { enabled?: boolean },
): Promise<SkillImportRecord> => {
  const destDir = path.join(stellaSkillsPath, plan.dirName);

  log(`Importing skill: ${plan.id} from ${plan.priority}`);

  // 1. Copy entire skill directory
  await copyDirectory(plan.sourceDir, destDir);

  // 2. Read SKILL.md content and apply post-processing for bundled skills
  const skillMdPath = path.join(destDir, "SKILL.md");
  let markdown = await fs.readFile(skillMdPath, "utf-8");

  if (plan.priority === "anthropic") {
    markdown = postProcessSkillMarkdown(markdown, plan.id, destDir);
    await fs.writeFile(skillMdPath, markdown, "utf-8");
  }

  // 3. Generate metadata via LLM
  let metadata: StellaYaml;
  try {
    const result = await generateMetadata(markdown, plan.dirName);
    metadata = {
      id: result.metadata.id || plan.dirName,
      name: result.metadata.name || plan.dirName,
      description: result.metadata.description || "Skill instructions.",
      agentTypes: result.metadata.agentTypes || ["general-purpose"],
      version: 1,
      source: plan.priority,
      ...(options?.enabled === false ? { enabled: false } : {}),
      importedAt: Date.now(),
    };
  } catch (error) {
    log(`Failed to generate metadata for ${plan.id}, using defaults:`, error);
    metadata = {
      id: plan.dirName,
      name: plan.dirName,
      description: "Skill instructions.",
      agentTypes: ["general-purpose"],
      version: 1,
      source: plan.priority,
      ...(options?.enabled === false ? { enabled: false } : {}),
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

export const syncExternalSkills = async (
  claudeSkillsPath: string,
  agentsSkillsPath: string,
  stellaSkillsPath: string,
  statePath: string,
  generateMetadata: GenerateMetadataFn,
): Promise<void> => {
  const importIndex = await loadImportIndex(statePath);

  // 1. Discover skills from both sources
  const claudeSkills = await discoverSkillsFromSource(claudeSkillsPath, "claude");
  const agentsSkills = await discoverSkillsFromSource(agentsSkillsPath, "agents");

  // 2. Get existing skills in ~/.stella/skills/
  const existingStellaSkills = await getExistingSkillIds(stellaSkillsPath);

  // 3. Determine import plan (with deduplication, .agents wins)
  const importPlan = await getSkillsToImport(
    claudeSkills,
    agentsSkills,
    importIndex,
    existingStellaSkills,
  );

  if (importPlan.length === 0) {
    return;
  }

  log(`Found ${importPlan.length} new skill(s) to import`);

  // 4. Import each skill
  for (const plan of importPlan) {
    try {
      const record = await importSkill(plan, stellaSkillsPath, generateMetadata);
      importIndex.imports[plan.id] = record;
    } catch (error) {
      log(`Failed to import ${plan.id}:`, error);
    }
  }

  // 5. Save updated index
  await saveImportIndex(statePath, importIndex);
};

// ---------------------------------------------------------------------------
// Bundled Skills Sync (Anthropic skills shipped with the app)
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIM = "---";

/**
 * Extract metadata from SKILL.md frontmatter or an existing stella.yaml.
 * Frontmatter takes priority over stella.yaml.
 */
const extractBundledMetadata = async (
  skillDir: string,
  dirName: string,
): Promise<{ id: string; name: string; description: string; agentTypes: string[] }> => {
  const defaults = { id: dirName, name: dirName, description: "Skill instructions.", agentTypes: [] as string[] };

  // Try frontmatter first (priority)
  try {
    const markdown = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    if (markdown.startsWith(FRONTMATTER_DELIM)) {
      const lines = markdown.split("\n");
      let endIndex = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === FRONTMATTER_DELIM) { endIndex = i; break; }
      }
      if (endIndex > 0) {
        const frontmatter = parseYaml(lines.slice(1, endIndex).join("\n")) as Record<string, unknown> | null;
        if (frontmatter) {
          return {
            id: (typeof frontmatter.id === "string" && frontmatter.id.trim()) || dirName,
            name: (typeof frontmatter.name === "string" && frontmatter.name.trim()) || dirName,
            description: (typeof frontmatter.description === "string" && frontmatter.description.trim()) || defaults.description,
            agentTypes: Array.isArray(frontmatter.agentTypes) ? frontmatter.agentTypes.filter((a): a is string => typeof a === "string") : [],
          };
        }
      }
    }
  } catch { /* fall through */ }

  // Fall back to stella.yaml if present in source
  try {
    const yamlContent = await fs.readFile(path.join(skillDir, "stella.yaml"), "utf-8");
    const parsed = parseYaml(yamlContent) as Record<string, unknown> | null;
    if (parsed) {
      return {
        id: (typeof parsed.id === "string" && parsed.id.trim()) || dirName,
        name: (typeof parsed.name === "string" && parsed.name.trim()) || dirName,
        description: (typeof parsed.description === "string" && parsed.description.trim()) || defaults.description,
        agentTypes: Array.isArray(parsed.agentTypes) ? parsed.agentTypes.filter((a): a is string => typeof a === "string") : [],
      };
    }
  } catch { /* fall through */ }

  return defaults;
};

export const syncBundledSkills = async (
  bundledSourcePath: string,
  stellaSkillsPath: string,
  statePath: string,
): Promise<void> => {
  // Check if bundled source exists
  try {
    await fs.stat(bundledSourcePath);
  } catch {
    return;
  }

  const importIndex = await loadImportIndex(statePath);
  const bundledSkills = await discoverSkillsFromSource(bundledSourcePath, "anthropic");

  if (bundledSkills.length === 0) return;

  const existingStellaSkills = await getExistingSkillIds(stellaSkillsPath);

  const toImport: SkillImportPlan[] = [];
  for (const skill of bundledSkills) {
    if (existingStellaSkills.has(skill.id)) continue;
    if (importIndex.imports[skill.id]) continue;

    const sourceHash = await computeFileHash(skill.skillMdPath);
    toImport.push({ ...skill, sourceHash });
  }

  if (toImport.length === 0) return;

  log(`Found ${toImport.length} bundled skill(s) to import`);

  for (const plan of toImport) {
    try {
      const destDir = path.join(stellaSkillsPath, plan.dirName);

      // 1. Copy skill directory
      await copyDirectory(plan.sourceDir, destDir);

      // 2. Post-process SKILL.md (script paths, artifact refs, canvas hints)
      const skillMdPath = path.join(destDir, "SKILL.md");
      const markdown = await fs.readFile(skillMdPath, "utf-8");
      const processed = postProcessSkillMarkdown(markdown, plan.id, destDir);
      if (processed !== markdown) {
        await fs.writeFile(skillMdPath, processed, "utf-8");
      }

      // 3. Extract metadata from frontmatter or existing stella.yaml (no LLM call)
      const extracted = await extractBundledMetadata(plan.sourceDir, plan.dirName);

      // 4. Write stella.yaml with enabled: false
      const metadata: StellaYaml = {
        id: extracted.id,
        name: extracted.name,
        description: extracted.description,
        agentTypes: extracted.agentTypes,
        version: 1,
        source: "anthropic",
        enabled: false,
        importedAt: Date.now(),
      };
      const yamlContent = `# Generated by Stella - do not edit manually\n${stringifyYaml(metadata)}`;
      await fs.writeFile(path.join(destDir, "stella.yaml"), yamlContent, "utf-8");

      log(`Imported bundled skill: ${plan.id}`);

      importIndex.imports[plan.id] = {
        sourceDir: plan.sourceDir,
        sourceHash: plan.sourceHash,
        importedAt: Date.now(),
        priority: "anthropic",
      };
    } catch (error) {
      log(`Failed to import bundled skill ${plan.id}:`, error);
    }
  }

  await saveImportIndex(statePath, importIndex);
};
