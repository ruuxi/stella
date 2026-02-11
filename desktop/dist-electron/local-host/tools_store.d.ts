/**
 * Store install/uninstall handlers for local package management.
 *
 * Skills: ~/.stella/skills/{skillId}/
 * Themes: ~/.stella/themes/{themeId}.json
 * Mini-apps: ~/.stella/apps/{appName}/
 */
import type { ToolResult } from "./tools-types.js";
/**
 * Install a skill package locally.
 * Writes SKILL.md and stella.yaml to ~/.stella/skills/{skillId}/
 */
export declare const handleInstallSkill: (args: Record<string, unknown>) => Promise<ToolResult>;
/**
 * Install a theme package locally.
 * Writes to ~/.stella/themes/{themeId}.json
 */
export declare const handleInstallTheme: (args: Record<string, unknown>) => Promise<ToolResult>;
/**
 * Install a mini-app/canvas package as a workspace app.
 * Uses create-app.js to scaffold from the committed template.
 */
export declare const handleInstallCanvas: (args: Record<string, unknown>) => Promise<ToolResult>;
/**
 * Uninstall a package locally by removing its files.
 */
export declare const handleUninstallPackage: (args: Record<string, unknown>) => Promise<ToolResult>;
/**
 * Unified package management entrypoint.
 * - install: skill/theme/canvas
 * - uninstall: skill/theme/canvas/mod
 */
export declare const handleManagePackage: (args: Record<string, unknown>) => Promise<ToolResult>;
