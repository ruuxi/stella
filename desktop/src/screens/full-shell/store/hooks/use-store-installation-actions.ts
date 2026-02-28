import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useUiState } from "@/app/state/ui-state";
import { showToast } from "@/components/toast";
import { registerTheme, unregisterTheme } from "@/theme/themes";
import type { ThemeColors } from "@/theme/themes/types";
import type { StorePackage } from "../constants";

const STORE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const STORE_TOKEN_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const NPM_PACKAGE_VERSION_PATTERN = /^[a-z0-9*^~<>=|.+-]+$/i;
const STORE_PACKAGE_TYPES = new Set(["skill", "theme", "canvas", "mod"]);
const MAX_SKILL_MARKDOWN_CHARS = 250_000;
const MAX_CANVAS_SOURCE_CHARS = 250_000;
const MAX_CANVAS_DEPENDENCIES = 64;
const MAX_THEME_TOKENS = 256;
const THEME_COLOR_KEYS: Array<keyof ThemeColors> = [
  "background",
  "backgroundWeak",
  "backgroundStrong",
  "foreground",
  "foregroundWeak",
  "foregroundStrong",
  "primary",
  "primaryForeground",
  "success",
  "warning",
  "error",
  "info",
  "interactive",
  "border",
  "borderWeak",
  "borderStrong",
  "card",
  "cardForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeStoreId = (value: unknown, fieldName: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!STORE_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return normalized;
};

const sanitizeStoreName = (value: unknown, fieldName: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 120) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return normalized;
};

const sanitizeTokenList = (
  value: unknown,
  fieldName: string,
  maxItems: number,
): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > maxItems) {
    throw new Error(`Too many values for ${fieldName}.`);
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = typeof item === "string" ? item.trim() : "";
    if (!STORE_TOKEN_PATTERN.test(normalized)) {
      throw new Error(`Invalid ${fieldName}.`);
    }
    result.push(normalized);
  }
  return result;
};

const sanitizeThemePalette = (
  value: unknown,
  fieldName: string,
): Record<string, string> => {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldName} palette.`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_THEME_TOKENS) {
    throw new Error(`Invalid ${fieldName} palette.`);
  }
  const palette: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const normalizedKey = key.trim();
    const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
    if (
      !STORE_TOKEN_PATTERN.test(normalizedKey) ||
      !normalizedValue ||
      normalizedValue.length > 200
    ) {
      throw new Error(`Invalid ${fieldName} palette.`);
    }
    palette[normalizedKey] = normalizedValue;
  }
  return palette;
};

const toThemeColors = (
  palette: Record<string, string>,
  fieldName: string,
): ThemeColors => {
  const normalized: Partial<ThemeColors> = {};
  for (const key of THEME_COLOR_KEYS) {
    const value = palette[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid ${fieldName} palette.`);
    }
    normalized[key] = value;
  }
  return normalized as ThemeColors;
};

const sanitizeCanvasDependencies = (
  value: unknown,
): Record<string, string> | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid canvas dependencies.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CANVAS_DEPENDENCIES) {
    throw new Error("Too many canvas dependencies.");
  }
  const dependencies: Record<string, string> = {};
  for (const [pkgName, rawVersion] of entries) {
    const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
    if (!NPM_PACKAGE_NAME_PATTERN.test(pkgName) || !NPM_PACKAGE_VERSION_PATTERN.test(version)) {
      throw new Error("Invalid canvas dependencies.");
    }
    dependencies[pkgName] = version;
  }
  return dependencies;
};

const sanitizeCanvasSource = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid canvas source.");
  }
  if (value.length > MAX_CANVAS_SOURCE_CHARS) {
    throw new Error("Canvas source is too large.");
  }
  return value;
};

const sanitizePackageType = (value: unknown): "skill" | "theme" | "canvas" | "mod" => {
  if (typeof value !== "string" || !STORE_PACKAGE_TYPES.has(value)) {
    throw new Error("Invalid package type.");
  }
  return value as "skill" | "theme" | "canvas" | "mod";
};

interface UseStoreInstallationActionsOptions {
  onComposePrompt: (text: string) => void;
}

export function useStoreInstallationActions({
  onComposePrompt,
}: UseStoreInstallationActionsOptions) {
  const { setView } = useUiState();
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());

  const installMutation = useMutation(api.data.store_packages.install);
  const uninstallMutation = useMutation(api.data.store_packages.uninstall);

  const handleInstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;
      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        if (pkg.type === "mod") {
          setView("home");
          onComposePrompt(
            `Install the "${pkg.name}" mod from package "${pkg.packageId}". Use SelfModInstallBlueprint with this package ID, adapt it to the current codebase, then apply the feature.`,
          );
        } else if (pkg.type === "skill" && window.electronAPI) {
          const payload = isRecord(pkg.modPayload) ? pkg.modPayload : undefined;
          const markdown =
            typeof payload?.markdown === "string" ? payload.markdown.trim() : "";
          if (!markdown) {
            throw new Error(
              `Skill package "${pkg.packageId}" is missing modPayload.markdown and cannot be installed.`,
            );
          }
          if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
            throw new Error(
              `Skill package "${pkg.packageId}" markdown is too large to install safely.`,
            );
          }
          const safePackageId = sanitizeStoreId(pkg.packageId, "packageId");
          const safeName = sanitizeStoreName(pkg.name, "name");
          const safeAgentTypes = sanitizeTokenList(
            payload?.agentTypes,
            "agentTypes",
            16,
          );
          await window.electronAPI.storeInstallSkill({
            packageId: safePackageId,
            skillId: safePackageId,
            name: safeName,
            markdown,
            agentTypes: safeAgentTypes.length > 0 ? safeAgentTypes : ["general"],
            tags: sanitizeTokenList(payload?.tags ?? pkg.tags, "tags", 32),
          });
        } else if (pkg.type === "theme" && window.electronAPI) {
          const payload = isRecord(pkg.modPayload) ? pkg.modPayload : undefined;
          if (payload?.light !== undefined && payload?.dark !== undefined) {
            const safePackageId = sanitizeStoreId(pkg.packageId, "packageId");
            const safeName = sanitizeStoreName(pkg.name, "name");
            const lightRecord = sanitizeThemePalette(payload.light, "light");
            const darkRecord = sanitizeThemePalette(payload.dark, "dark");
            const light = toThemeColors(lightRecord, "light");
            const dark = toThemeColors(darkRecord, "dark");
            await window.electronAPI.storeInstallTheme({
              packageId: safePackageId,
              themeId: safePackageId,
              name: safeName,
              light: lightRecord,
              dark: darkRecord,
            });
            registerTheme({
              id: safePackageId,
              name: safeName,
              light,
              dark,
            });
          }
        } else if (pkg.type === "canvas" && window.electronAPI) {
          const payload = isRecord(pkg.modPayload) ? pkg.modPayload : undefined;
          const safePackageId = sanitizeStoreId(pkg.packageId, "packageId");
          const safeWorkspaceId = sanitizeStoreId(
            typeof payload?.workspaceId === "string" ? payload.workspaceId : pkg.packageId,
            "workspaceId",
          );
          const safeName = sanitizeStoreName(
            typeof payload?.workspaceName === "string" ? payload.workspaceName : pkg.name,
            "workspaceName",
          );
          await window.electronAPI.storeInstallCanvas({
            packageId: safePackageId,
            workspaceId: safeWorkspaceId,
            name: safeName,
            dependencies: sanitizeCanvasDependencies(payload?.dependencies),
            source: sanitizeCanvasSource(payload?.source),
          });
        }

        await installMutation({ packageId: pkg.packageId, version: pkg.version });
      } catch (err) {
        console.error("Install failed:", err);
        showToast({ title: "Failed to install", variant: "error" });
      } finally {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(pkg.packageId);
          return next;
        });
      }
    },
    [installingIds, installMutation, onComposePrompt, setView],
  );

  const handleUninstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;
      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        if (pkg.type === "mod") {
          setView("home");
          onComposePrompt(
            `Uninstall the "${pkg.name}" mod (package "${pkg.packageId}") by reverting its applied self-mod feature batches, then confirm cleanup.`,
          );
        } else if (window.electronAPI) {
          const safePackageId = sanitizeStoreId(pkg.packageId, "packageId");
          await window.electronAPI.storeUninstall({
            packageId: safePackageId,
            type: sanitizePackageType(pkg.type),
            localId: safePackageId,
          });
        }

        if (pkg.type === "theme") {
          unregisterTheme(pkg.packageId);
        }

        await uninstallMutation({ packageId: pkg.packageId });
      } catch (err) {
        console.error("Uninstall failed:", err);
        showToast({ title: "Failed to uninstall", variant: "error" });
      } finally {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(pkg.packageId);
          return next;
        });
      }
    },
    [installingIds, onComposePrompt, setView, uninstallMutation],
  );

  return {
    installingIds,
    handleInstall,
    handleUninstall,
  };
}
