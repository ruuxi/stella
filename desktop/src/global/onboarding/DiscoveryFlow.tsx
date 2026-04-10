/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeCoreMemory } from "@/global/onboarding/services/synthesis";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
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
        const result = await window.electronAPI?.discovery.collectAllSignals?.({
          categories: discoveryCategories,
          selectedBrowser,
          selectedProfile,
        });

        if (!result || result.error || !result.formattedSections) return;
        if (Object.keys(result.formattedSections).length === 0) return;

        const synthesisResult = await synthesizeCoreMemory(
          result.formattedSections,
          {
            includeAuth: hasConnectedAccount,
          },
        );
        if (!synthesisResult.coreMemory) return;

        await Promise.all([
          window.electronAPI?.discovery.writeCoreMemory?.(
            synthesisResult.coreMemory,
          ) ?? Promise.resolve(),
          window.electronAPI?.discovery.writeKnowledge?.({
            coreMemory: synthesisResult.coreMemory,
            formattedSections: result.formattedSections,
            ...(synthesisResult.categoryAnalyses
              ? { categoryAnalyses: synthesisResult.categoryAnalyses as Partial<Record<DiscoveryCategory, string>> }
              : {}),
          }) ?? Promise.resolve(),
        ]);

        if (synthesisResult.welcomeMessage) {
          await window.electronAPI?.localChat.persistDiscoveryWelcome?.({
            conversationId: activeConversationId,
            message: synthesisResult.welcomeMessage,
            ...(synthesisResult.suggestions?.length
              ? { suggestions: synthesisResult.suggestions }
              : {}),
          });
        }

        completed = true;
        synthesizedRef.current = true;
      } catch {
        // Silent fail - discovery is non-critical
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
