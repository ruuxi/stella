/**
 * Store install/uninstall handlers for local package management.
 *
 * Skills are written to ~/.stella/skills/{skillId}/
 * Themes are written to ~/.stella/themes/{themeId}.json
 */

import path from "path";
import fs from "fs/promises";
import os from "os";
import type { ToolResult } from "./tools-types.js";

const getStellaRoot = () => path.join(os.homedir(), ".stella");

/**
 * Install a skill package locally.
 * Writes SKILL.md and stella.yaml to ~/.stella/skills/{skillId}/
 */
export const handleInstallSkill = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const skillId = args.skillId as string;
  const name = args.name as string;
  const markdown = args.markdown as string;
  const agentTypes = (args.agentTypes as string[]) ?? ["general"];
  const tags = (args.tags as string[]) ?? [];

  if (!skillId || !name || !markdown) {
    return { error: "InstallSkillPackage requires skillId, name, and markdown." };
  }

  const skillDir = path.join(getStellaRoot(), "skills", skillId);
  await fs.mkdir(skillDir, { recursive: true });

  // Write SKILL.md
  await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown, "utf-8");

  // Write stella.yaml metadata
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
export const handleInstallTheme = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const themeId = args.themeId as string;
  const name = args.name as string;
  const light = args.light;
  const dark = args.dark;

  if (!themeId || !name || !light || !dark) {
    return { error: "InstallThemePackage requires themeId, name, light, and dark." };
  }

  const themesDir = path.join(getStellaRoot(), "themes");
  await fs.mkdir(themesDir, { recursive: true });

  const themeData = { id: themeId, name, light, dark };
  await fs.writeFile(
    path.join(themesDir, `${themeId}.json`),
    JSON.stringify(themeData, null, 2),
    "utf-8",
  );

  return { result: { installed: true, themeId } };
};

/**
 * Uninstall a package locally by removing its files.
 */
export const handleUninstallPackage = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const type = args.type as string;
  const localId = args.localId as string;

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
        const workspaceDir = path.join(stellaRoot, "workspaces", localId);
        await fs.rm(workspaceDir, { recursive: true, force: true });
        break;
      }
      default:
        return { result: { uninstalled: true, note: `Type "${type}" does not require local file removal.` } };
    }
  } catch (err) {
    return { error: `Failed to uninstall: ${(err as Error).message}` };
  }

  return { result: { uninstalled: true } };
};
