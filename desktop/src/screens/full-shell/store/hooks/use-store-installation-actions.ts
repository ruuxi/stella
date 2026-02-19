/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useUiState } from "@/app/state/ui-state";
import { registerTheme, unregisterTheme } from "@/theme/themes";
import type {
  CanvasPackagePayload,
  SkillPackagePayload,
  StorePackage,
  ThemePackagePayload,
} from "../constants";

interface UseStoreInstallationActionsOptions {
  onComposePrompt: (text: string) => void;
}

export function useStoreInstallationActions({
  onComposePrompt,
}: UseStoreInstallationActionsOptions) {
  const { setView } = useUiState();
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());

  const installMutation = useMutation(api.data.store_packages.install as any);
  const uninstallMutation = useMutation(api.data.store_packages.uninstall as any);

  const handleInstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;
      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        if (pkg.type === "mod") {
          setView("chat");
          onComposePrompt(
            `Install the "${pkg.name}" mod from package "${pkg.packageId}". Use SelfModInstallBlueprint with this package ID, adapt it to the current codebase, then apply the feature.`,
          );
        } else if (pkg.type === "skill" && window.electronAPI) {
          const payload = pkg.modPayload as SkillPackagePayload | undefined;
          const markdown =
            typeof payload?.markdown === "string" ? payload.markdown.trim() : "";
          if (!markdown) {
            throw new Error(
              `Skill package "${pkg.packageId}" is missing modPayload.markdown and cannot be installed.`,
            );
          }
          await (window.electronAPI as any).storeInstallSkill({
            packageId: pkg.packageId,
            skillId: pkg.packageId,
            name: pkg.name,
            markdown,
            agentTypes: payload?.agentTypes ?? ["general"],
            tags: payload?.tags ?? pkg.tags,
          });
        } else if (pkg.type === "theme" && window.electronAPI) {
          const payload = pkg.modPayload as ThemePackagePayload | undefined;
          if (payload?.light && payload?.dark) {
            await (window.electronAPI as any).storeInstallTheme({
              packageId: pkg.packageId,
              themeId: pkg.packageId,
              name: pkg.name,
              light: payload.light,
              dark: payload.dark,
            });
            registerTheme({
              id: pkg.packageId,
              name: pkg.name,
              light: payload.light,
              dark: payload.dark,
            });
          }
        } else if (pkg.type === "canvas" && window.electronAPI) {
          const payload = pkg.modPayload as CanvasPackagePayload | undefined;
          await (window.electronAPI as any).storeInstallCanvas({
            packageId: pkg.packageId,
            workspaceId: payload?.workspaceId ?? pkg.packageId,
            name: payload?.workspaceName ?? pkg.name,
            dependencies: payload?.dependencies,
            source: payload?.source,
          });
        }

        await installMutation({ packageId: pkg.packageId, version: pkg.version });
      } catch (err) {
        console.error("Install failed:", err);
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
          setView("chat");
          onComposePrompt(
            `Uninstall the "${pkg.name}" mod (package "${pkg.packageId}") by reverting its applied self-mod feature batches, then confirm cleanup.`,
          );
        } else if (window.electronAPI) {
          await (window.electronAPI as any).storeUninstall({
            packageId: pkg.packageId,
            type: pkg.type,
            localId: pkg.packageId,
          });
        }

        if (pkg.type === "theme") {
          unregisterTheme(pkg.packageId);
        }

        await uninstallMutation({ packageId: pkg.packageId });
      } catch (err) {
        console.error("Uninstall failed:", err);
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
