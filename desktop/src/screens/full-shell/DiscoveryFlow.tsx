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

type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

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
  isAuthenticated: boolean;
  conversationId: string | null;
};

export function useDiscoveryFlow({
  isAuthenticated,
  conversationId,
}: UseDiscoveryFlowOptions) {
  const activeConversationId = conversationId;
  const chatStore = useChatStore();
  const { storageMode, isLocalStorage } = chatStore;
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

  // Collect signals → synthesize → post welcome as soon as collection finishes
  useEffect(() => {
    if (!discoveryCategories || !activeConversationId) return;
    if (storageMode === "cloud" && !isAuthenticated) return;
    if (synthesizedRef.current) return;
    synthesizedRef.current = true;

    const run = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) {
          return;
        }

        const result = await window.electronAPI?.collectAllSignals?.({
          categories: discoveryCategories,
        });

        if (!result || result.error || !result.formatted) return;

        const synthesisResult = await synthesizeCoreMemory(result.formatted, {
          includeAuth: isAuthenticated,
        });
        if (!synthesisResult.coreMemory) return;

        await window.electronAPI?.writeCoreMemory?.(synthesisResult.coreMemory);

        // Sync core memory to Convex when authenticated.
        if (isAuthenticated) {
          try {
            await setCoreMemory({ content: synthesisResult.coreMemory });
          } catch {
            // Non-critical — local file is the source of truth
          }
        }
        const deviceId = await getOrCreateDeviceId();

        // Select default skills based on user profile (fire-and-forget).
        // Requires auth because endpoint is owner-scoped.
        if (isAuthenticated) {
          void selectDefaultSkills(synthesisResult.coreMemory).catch(() => {
            // Silent fail - skill selection is non-critical
          });
        }

        if (synthesisResult.welcomeMessage) {
          await chatStore.appendEvent({
            conversationId: activeConversationId,
            type: "assistant_message",
            deviceId,
            payload: { text: synthesisResult.welcomeMessage },
          });

          if (synthesisResult.suggestions?.length) {
            await chatStore.appendEvent({
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
            }).catch((error) => {
              console.warn("[DiscoveryFlow] Dashboard generation trigger failed:", error);
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
    chatStore,
    setCoreMemory,
    getOrCreateDefaultConversation,
    startGeneration,
  ]);

  return {
    handleDiscoveryConfirm,
  };
}
