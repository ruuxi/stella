/**
 * Store install/uninstall handlers for local package management.
 *
 * Skills: ~/.stella/skills/{skillId}/
 * Themes: ~/.stella/themes/{themeId}.json
 * Mini-apps: ~/.stella/apps/{appName}/
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import type { ToolResult } from "./tools-types.js";
import { trashPathForDeferredDelete } from "./deferred_delete.js";

const getStellaRoot = () => path.join(os.homedir(), ".stella");

const normalizeAppName = (value: string): string | null => {
  const normalized = value
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 64);
};

const runCommand = async (
  command: string,
  args: string[],
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
};

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
    return { error: "Skill install requires skillId, name, and markdown." };
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
export const handleInstallTheme = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const themeId = args.themeId as string;
  const name = args.name as string;
  const light = args.light;
  const dark = args.dark;

  if (!themeId || !name || !light || !dark) {
    return { error: "Theme install requires themeId, name, light, and dark." };
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
 * Install a mini-app/canvas package as a workspace app.
 * Uses create-app.js to scaffold from the committed template.
 */
export const handleInstallCanvas = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const packageId = String(args.packageId ?? "").trim();
  const appNameInput = String(args.workspaceId ?? args.name ?? packageId).trim();
  const appName = normalizeAppName(appNameInput);

  if (!packageId) {
    return { error: "Canvas install requires packageId." };
  }
  if (!appName) {
    return { error: "Canvas install requires a name." };
  }

  // Locate create-app.js relative to this file (local-host/ → ../../workspace/)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const createAppScript = path.resolve(__dirname, "..", "..", "workspace", "create-app.js");
  const appsDir = path.join(os.homedir(), ".stella", "apps");
  const appPath = path.join(appsDir, appName);

  try {
    await runCommand(process.execPath, [createAppScript, appName]);

    // Write custom App.tsx if provided
    const source = typeof args.source === "string" ? args.source : undefined;
    if (source) {
      await fs.writeFile(path.join(appPath, "src", "App.tsx"), source, "utf-8");
    }

    // Add extra dependencies if provided
    const dependencies =
      args.dependencies && typeof args.dependencies === "object"
        ? (args.dependencies as Record<string, string>)
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
  } catch (err) {
    return { error: `Failed to install canvas package: ${(err as Error).message}` };
  }
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
    return { error: "Package uninstall requires type and localId." };
  }

  const stellaRoot = getStellaRoot();
  const trashOptions = {
    source: "tool:UninstallPackage",
    force: true,
    stellaHome: stellaRoot,
  };

  try {
    switch (type) {
      case "skill": {
        const skillDir = path.join(stellaRoot, "skills", localId);
        await trashPathForDeferredDelete(skillDir, trashOptions);
        break;
      }
      case "theme": {
        const themePath = path.join(stellaRoot, "themes", `${localId}.json`);
        await trashPathForDeferredDelete(themePath, trashOptions);
        break;
      }
      case "canvas": {
        const appsRoot = path.join(os.homedir(), ".stella", "apps");
        await trashPathForDeferredDelete(path.join(appsRoot, localId), trashOptions);
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
  } catch (err) {
    return { error: `Failed to uninstall: ${(err as Error).message}` };
  }

  return { result: { uninstalled: true } };
};

/**
 * Unified package management entrypoint.
 * - install: skill/theme/canvas
 * - uninstall: skill/theme/canvas/mod
 */
export const handleManagePackage = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const action = String(args.action ?? "").trim().toLowerCase();
  const pkg =
    args.package && typeof args.package === "object"
      ? (args.package as Record<string, unknown>)
      : null;

  if (!action || !pkg) {
    return { error: "ManagePackage requires action and package." };
  }

  if (action === "install") {
    const type = String(pkg.type ?? "").trim().toLowerCase();
    switch (type) {
      case "skill":
        return await handleInstallSkill(pkg);
      case "theme":
        return await handleInstallTheme(pkg);
      case "canvas":
        return await handleInstallCanvas(pkg);
      case "mod":
        return {
          error:
            "Mod install is not supported via ManagePackage. Delegate to Self-Mod and use SelfModInstallBlueprint.",
        };
      default:
        return { error: `Unsupported install package type: ${type}` };
    }
  }

  if (action === "uninstall") {
    return await handleUninstallPackage(pkg);
  }

  return { error: `Unsupported action: ${action}` };
};
