/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/api";
import { getOrCreateDeviceId } from "../../services/device";
import { synthesizeCoreMemory } from "../../services/synthesis";
import { selectDefaultSkills } from "../../services/skill-selection";
import { useChatStore } from "../../app/state/chat-store";
import type { DiscoveryCategory } from "../../components/onboarding/use-onboarding-state";

const BROWSER_SELECTION_KEY = "stella-selected-browser";

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

export function useDiscoveryFlow({
  conversationId,
}: UseDiscoveryFlowOptions) {
  const activeConversationId = conversationId;
  const { storageMode, isLocalStorage, isAuthenticated, appendEvent: chatStoreAppendEvent } = useChatStore();
  const setCoreMemory = useMutation(api.data.preferences.setCoreMemory);
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );
  const startGeneration = useAction(api.personalized_dashboard.startGeneration);

  const [discoveryCategories, setDiscoveryCategories] = useState<
    DiscoveryCategory[] | null
  >(null);

  const synthesizedRef = useRef(false);

  const handleDiscoveryConfirm = useCallback(
    (categories: DiscoveryCategory[]) => {
      setDiscoveryCategories(withBrowserDiscoveryCategory(categories));
    },
    [],
  );

  // Collect signals -> synthesize -> post welcome as soon as collection finishes
  useEffect(() => {
    if (!discoveryCategories || !activeConversationId) return;
    if (storageMode === "cloud" && !isAuthenticated) return;
    if (synthesizedRef.current) return;
    synthesizedRef.current = true;

    const run = async () => {
      try {
        const exists = await window.electronAPI?.browser.checkCoreMemoryExists?.();
        if (exists) {
          return;
        }

        const result = await window.electronAPI?.browser.collectAllSignals?.({
          categories: discoveryCategories,
        });

        if (!result || result.error || !result.formatted) return;

        const synthesisResult = await synthesizeCoreMemory(result.formatted, {
          includeAuth: isAuthenticated,
        });
        if (!synthesisResult.coreMemory) return;

        const writeCoreMemoryPromise =
          window.electronAPI?.browser.writeCoreMemory?.(synthesisResult.coreMemory) ??
          Promise.resolve();

        const syncCoreMemoryPromise = isAuthenticated
          ? setCoreMemory({ content: synthesisResult.coreMemory }).catch(() => {
              // Non-critical - local file is the source of truth
            })
          : Promise.resolve();

        // Resolve independent work in parallel to avoid an async waterfall.
        const [deviceId] = await Promise.all([
          getOrCreateDeviceId(),
          writeCoreMemoryPromise,
          syncCoreMemoryPromise,
        ]);

        // Select default skills based on user profile (fire-and-forget).
        // Requires auth because endpoint is owner-scoped.
        if (isAuthenticated) {
          void selectDefaultSkills(synthesisResult.coreMemory).catch(() => {
            // Silent fail - skill selection is non-critical
          });
        }

        if (synthesisResult.welcomeMessage) {
          await chatStoreAppendEvent({
            conversationId: activeConversationId,
            type: "assistant_message",
            deviceId,
            payload: { text: synthesisResult.welcomeMessage },
          });

          if (synthesisResult.suggestions?.length) {
            await chatStoreAppendEvent({
              conversationId: activeConversationId,
              type: "welcome_suggestions",
              deviceId,
              payload: { suggestions: synthesisResult.suggestions },
            });
          }
        }

        // Fire-and-forget page generation in both local and cloud modes.
        if (isAuthenticated && synthesisResult.coreMemory) {
          let generationConversationId = activeConversationId;

          // In local storage mode we still generate dashboard pages in the cloud.
          // Resolve the canonical default conversation ID for reliable ownership checks.
          if (isLocalStorage) {
            try {
              const defaultConversation = await getOrCreateDefaultConversation({});
              if (defaultConversation?._id) {
                generationConversationId = defaultConversation._id;
              }
            } catch {
              // Fallback to active conversation ID.
            }
          }

          if (generationConversationId) {
            void startGeneration({
              conversationId: generationConversationId,
              coreMemory: synthesisResult.coreMemory,
              targetDeviceId: deviceId,
              force: isLocalStorage,
            }).catch(() => {
              // Silent fail - dashboard generation is non-critical
            });
          }
        }
      } catch {
        // Silent fail - discovery is non-critical
      }
    };

    void run();
  }, [
    discoveryCategories,
    isAuthenticated,
    activeConversationId,
    storageMode,
    isLocalStorage,
    chatStoreAppendEvent,
    setCoreMemory,
    getOrCreateDefaultConversation,
    startGeneration,
  ]);

  return {
    handleDiscoveryConfirm,
  };
}
