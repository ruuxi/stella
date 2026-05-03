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

type DiscoveryWelcomeStatus = "idle" | "preparing" | "ready";

const DISCOVERY_CONVERSATION_FALLBACK_MS = 8000;

export function useDiscoveryFlow({ conversationId }: UseDiscoveryFlowOptions) {
  const activeConversationId = conversationId;
  const { hasConnectedAccount } = useAuthSessionState();

  const [discoveryCategories, setDiscoveryCategories] = useState<
    DiscoveryCategory[] | null
  >(null);
  const [welcomeStatus, setWelcomeStatus] =
    useState<DiscoveryWelcomeStatus>("idle");
  const synthesizedRef = useRef(false);
  const synthesizingRef = useRef(false);

  const handleDiscoveryConfirm = useCallback(
    (categories: DiscoveryCategory[]) => {
      const nextCategories = withBrowserDiscoveryCategory(categories);
      setDiscoveryCategories(nextCategories);
      setWelcomeStatus(nextCategories.length > 0 ? "preparing" : "ready");
    },
    [],
  );

  useEffect(() => {
    if (!discoveryCategories || activeConversationId) return;
    if (welcomeStatus !== "preparing") return;

    const timeoutId = window.setTimeout(() => {
      if (synthesizingRef.current || synthesizedRef.current) return;
      console.warn(
        "[onboarding-discovery] Conversation was unavailable; continuing without a personalized welcome.",
      );
      synthesizedRef.current = true;
      setWelcomeStatus("ready");
    }, DISCOVERY_CONVERSATION_FALLBACK_MS);

    return () => window.clearTimeout(timeoutId);
  }, [activeConversationId, discoveryCategories, welcomeStatus]);

  // Collect signals -> synthesize -> post welcome as soon as collection finishes
  useEffect(() => {
    if (!discoveryCategories || !activeConversationId) return;
    if (synthesizedRef.current) return;
    if (synthesizingRef.current) return;
    if (discoveryCategories.length === 0) {
      synthesizedRef.current = true;
      setWelcomeStatus("ready");
      return;
    }
    synthesizingRef.current = true;
    setWelcomeStatus("preparing");

    const run = async () => {
      let completed = false;
      try {
        const [coreMemoryExists, discoveryKnowledgeExists] = await Promise.all([
          window.electronAPI?.discovery.checkCoreMemoryExists?.() ??
            Promise.resolve(false),
          window.electronAPI?.discovery.checkKnowledgeExists?.() ??
            Promise.resolve(false),
        ]);
        if (coreMemoryExists && discoveryKnowledgeExists) {
          completed = true;
          synthesizedRef.current = true;
          setWelcomeStatus("ready");
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

        // Location is only resolved (and stored in core-memory.md) when the
        // user opted into a discovery category that already implies their
        // physical location — browsing history (URLs are geo-correlated) or
        // apps/system signals (system identity, dock, locale). Dev-only or
        // messages-only profiles never trigger the IP lookup.
        const includeLocation =
          discoveryCategories.includes("browsing_bookmarks") ||
          discoveryCategories.includes("apps_system");
        const [coreMemoryWrite, knowledgeWrite] = await Promise.all([
          window.electronAPI?.discovery.writeCoreMemory
            ? window.electronAPI.discovery.writeCoreMemory(
                synthesisResult.coreMemory,
                { includeLocation },
              )
            : Promise.resolve({
                ok: false,
                error: "Core memory write IPC is unavailable.",
              }),
          window.electronAPI?.discovery.writeKnowledge
            ? window.electronAPI.discovery.writeKnowledge({
                coreMemory: synthesisResult.coreMemory,
                formattedSections: result.formattedSections,
                ...(synthesisResult.categoryAnalyses
                  ? {
                      categoryAnalyses:
                        synthesisResult.categoryAnalyses as Partial<
                          Record<DiscoveryCategory, string>
                        >,
                    }
                  : {}),
              })
            : Promise.resolve({
                ok: false,
                error: "Knowledge write IPC is unavailable.",
              }),
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
              ...(synthesisResult.appRecommendations?.length
                ? { appRecommendations: synthesisResult.appRecommendations }
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
        setWelcomeStatus("ready");
      } catch (error) {
        reportDiscoveryFailure("Discovery failed unexpectedly.", error);
      } finally {
        if (!completed) {
          synthesizedRef.current = true;
          setWelcomeStatus("ready");
        }
        synthesizingRef.current = false;
      }
    };

    void run();
  }, [discoveryCategories, hasConnectedAccount, activeConversationId]);

  return {
    handleDiscoveryConfirm,
    discoveryWelcomeExpected: welcomeStatus !== "idle",
    discoveryWelcomeReady: welcomeStatus === "ready",
  };
}
