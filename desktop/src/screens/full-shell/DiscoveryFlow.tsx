/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/api";
import { getOrCreateDeviceId } from "../../services/device";
import { synthesizeCoreMemory } from "../../services/synthesis";
import { selectDefaultSkills } from "../../services/skill-selection";
import { useIsLocalMode } from "@/providers/DataProvider";
import { localPost } from "@/services/local-client";
import { toCloudConversationId } from "@/lib/conversation-id";

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
  const isLocalMode = useIsLocalMode();
  const activeConversationId = isLocalMode
    ? conversationId
    : toCloudConversationId(conversationId);
  const appendEvent = useMutation(api.events.appendEvent);

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
    if (!discoveryCategories || !isAuthenticated || !activeConversationId) return;
    if (synthesizedRef.current) return;
    synthesizedRef.current = true;

    const run = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) return;

        const result = await window.electronAPI?.collectAllSignals?.({
          categories: discoveryCategories,
        });

        if (!result || result.error || !result.formatted) return;

        const synthesisResult = await synthesizeCoreMemory(result.formatted);
        if (!synthesisResult.coreMemory) return;

        await window.electronAPI?.writeCoreMemory?.(synthesisResult.coreMemory);

        // Select default skills based on user profile (fire-and-forget)
        void selectDefaultSkills(synthesisResult.coreMemory).catch(() => {
          // Silent fail - skill selection is non-critical
        });

        if (synthesisResult.welcomeMessage) {
          const deviceId = await getOrCreateDeviceId();
          const eventPayload = {
            conversationId: activeConversationId,
            type: "assistant_message",
            deviceId,
            payload: { text: synthesisResult.welcomeMessage },
          };
          if (isLocalMode) {
            await localPost("/api/events", eventPayload);
          } else {
            await appendEvent(eventPayload);
          }

          if (synthesisResult.suggestions?.length) {
            const suggestionPayload = {
              conversationId: activeConversationId,
              type: "welcome_suggestions",
              deviceId,
              payload: { suggestions: synthesisResult.suggestions },
            };
            if (isLocalMode) {
              await localPost("/api/events", suggestionPayload);
            } else {
              await appendEvent(suggestionPayload);
            }
          }
        }
      } catch {
        // Silent fail - discovery is non-critical
      }
    };

    void run();
  }, [discoveryCategories, isAuthenticated, activeConversationId, appendEvent, isLocalMode]);

  return {
    handleDiscoveryConfirm,
  };
}
