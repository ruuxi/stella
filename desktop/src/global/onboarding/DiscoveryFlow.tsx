/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeCoreMemory } from "@/global/onboarding/services/synthesis";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { showToast } from "@/ui/toast";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
} from "@/shared/contracts/discovery";

const withBrowserDiscoveryCategory = (
  categories: DiscoveryCategory[],
): DiscoveryCategory[] => {
  const selectedBrowser = localStorage.getItem(BROWSER_SELECTION_KEY);
  if (!selectedBrowser || categories.includes("browsing_bookmarks")) {
    return categories;
  }
  return ["browsing_bookmarks", ...categories];
};

const reportDiscoveryFailure = (
  description: string,
  details?: unknown,
): void => {
  console.error("[onboarding-discovery]", description, details ?? "");
  showToast({
    title: "Discovery did not finish",
    description,
    variant: "error",
    duration: 8000,
  });
};

type UseDiscoveryFlowOptions = {
  conversationId: string | null;
};

export function useDiscoveryFlow({ conversationId }: UseDiscoveryFlowOptions) {
  const activeConversationId = conversationId;
  const { hasConnectedAccount } = useAuthSessionState();

  const [discoveryCategories, setDiscoveryCategories] = useState<
    DiscoveryCategory[] | null
  >(null);
  const synthesizedRef = useRef(false);
  const synthesizingRef = useRef(false);

  const handleDiscoveryConfirm = useCallback(
    (categories: DiscoveryCategory[]) => {
      setDiscoveryCategories(withBrowserDiscoveryCategory(categories));
    },
    [],
  );

  // Collect signals -> synthesize -> post welcome as soon as collection finishes
  useEffect(() => {
    if (!discoveryCategories || !activeConversationId) return;
    if (synthesizedRef.current) return;
    if (synthesizingRef.current) return;
    if (discoveryCategories.length === 0) {
      synthesizedRef.current = true;
      return;
    }
    synthesizingRef.current = true;

    const run = async () => {
      let completed = false;
      try {
        const [coreMemoryExists, discoveryKnowledgeExists] = await Promise.all([
          window.electronAPI?.discovery.checkCoreMemoryExists?.() ?? Promise.resolve(false),
          window.electronAPI?.discovery.checkKnowledgeExists?.() ??
            Promise.resolve(false),
        ]);
        if (coreMemoryExists && discoveryKnowledgeExists) {
          completed = true;
          synthesizedRef.current = true;
          return;
        }

        const selectedBrowser =
          localStorage.getItem(BROWSER_SELECTION_KEY) ?? undefined;
        const selectedProfile =
          localStorage.getItem(BROWSER_PROFILE_KEY) ?? undefined;
        const collectAllSignals =
          window.electronAPI?.discovery.collectAllSignals;
        if (!collectAllSignals) {
          reportDiscoveryFailure("Discovery IPC is unavailable.");
          return;
        }

        const result = await collectAllSignals({
          categories: discoveryCategories,
          selectedBrowser,
          selectedProfile,
        });

        if (!result) {
          reportDiscoveryFailure("Signal collection returned no result.");
          return;
        }
        if (result.error) {
          reportDiscoveryFailure("Signal collection failed.", result.error);
          return;
        }
        if (!result.formattedSections) {
          reportDiscoveryFailure(
            "Signal collection did not return formatted sections.",
            result,
          );
          return;
        }
        if (Object.keys(result.formattedSections).length === 0) {
          reportDiscoveryFailure(
            "Signal collection returned no usable discovery data.",
            result,
          );
          return;
        }

        const synthesisResult = await synthesizeCoreMemory(
          result.formattedSections,
          {
            includeAuth: hasConnectedAccount,
          },
        );
        if (!synthesisResult.coreMemory) {
          reportDiscoveryFailure(
            "Core memory synthesis returned an empty result.",
            synthesisResult,
          );
          return;
        }

        const [coreMemoryWrite, knowledgeWrite] = await Promise.all([
          window.electronAPI?.discovery.writeCoreMemory
            ? window.electronAPI.discovery.writeCoreMemory(
                synthesisResult.coreMemory,
              )
            : Promise.resolve({ ok: false, error: "Core memory write IPC is unavailable." }),
          window.electronAPI?.discovery.writeKnowledge
            ? window.electronAPI.discovery.writeKnowledge({
                coreMemory: synthesisResult.coreMemory,
                formattedSections: result.formattedSections,
                ...(synthesisResult.categoryAnalyses
                  ? { categoryAnalyses: synthesisResult.categoryAnalyses as Partial<Record<DiscoveryCategory, string>> }
                  : {}),
              })
            : Promise.resolve({ ok: false, error: "Knowledge write IPC is unavailable." }),
        ]);

        if (!coreMemoryWrite?.ok || !knowledgeWrite?.ok) {
          reportDiscoveryFailure("Failed to save discovery memory.", {
            coreMemoryWrite,
            knowledgeWrite,
          });
          return;
        }

        if (synthesisResult.welcomeMessage) {
          try {
            await window.electronAPI?.localChat.persistDiscoveryWelcome?.({
              conversationId: activeConversationId,
              message: synthesisResult.welcomeMessage,
              ...(synthesisResult.suggestions?.length
                ? { suggestions: synthesisResult.suggestions }
                : {}),
            });
          } catch (error) {
            console.error(
              "[onboarding-discovery] Failed to persist discovery welcome.",
              error,
            );
          }
        }

        completed = true;
        synthesizedRef.current = true;
      } catch (error) {
        reportDiscoveryFailure("Discovery failed unexpectedly.", error);
      } finally {
        if (!completed) {
          synthesizedRef.current = false;
        }
        synthesizingRef.current = false;
      }
    };

    void run();
  }, [
    discoveryCategories,
    hasConnectedAccount,
    activeConversationId,
  ]);

  return {
    handleDiscoveryConfirm,
  };
}
