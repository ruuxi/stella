/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateDeviceId } from "@/platform/electron/device";
import { synthesizeCoreMemory } from "@/app/onboarding/services/synthesis";
import { useChatStore } from "@/context/chat-store";
import type { DiscoveryCategory } from "@/app/onboarding/use-onboarding-state";

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
  const { storageMode, isAuthenticated, appendEvent: chatStoreAppendEvent } = useChatStore();

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

        // Resolve independent work in parallel to avoid an async waterfall.
        const [deviceId] = await Promise.all([
          getOrCreateDeviceId(),
          writeCoreMemoryPromise,
        ]);

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
    chatStoreAppendEvent,
  ]);

  return {
    handleDiscoveryConfirm,
  };
}


