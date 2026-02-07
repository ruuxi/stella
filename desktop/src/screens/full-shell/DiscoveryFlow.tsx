/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/api";
import { getOrCreateDeviceId } from "../../services/device";
import {
  synthesizeCoreMemory,
  seedDiscoveryMemories,
} from "../../services/synthesis";
import type { AllUserSignalsResult } from "../../types/electron";

type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

const DEFAULT_DISCOVERY_CATEGORIES = [
  "browsing_bookmarks",
  "dev_environment",
  "apps_system",
] as const;

const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

const parseStoredDiscoveryCategories = (
  raw: string | null,
): DiscoveryCategory[] => {
  if (!raw) {
    return [...DEFAULT_DISCOVERY_CATEGORIES];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_DISCOVERY_CATEGORIES];
    }
    const valid = parsed.filter(
      (value): value is DiscoveryCategory =>
        value === "browsing_bookmarks" ||
        value === "dev_environment" ||
        value === "apps_system" ||
        value === "messages_notes",
    );
    if (parsed.length === 0) {
      return [];
    }
    return valid.length > 0 ? valid : [...DEFAULT_DISCOVERY_CATEGORIES];
  } catch {
    return [...DEFAULT_DISCOVERY_CATEGORIES];
  }
};

type UseDiscoveryFlowOptions = {
  isAuthenticated: boolean;
  onboardingDone: boolean;
  conversationId: string | null;
};

export function useDiscoveryFlow({
  isAuthenticated,
  onboardingDone,
  conversationId,
}: UseDiscoveryFlowOptions) {
  const appendEvent = useMutation(api.events.appendEvent);

  const discoveryRef = useRef<{
    started: boolean;
    synthesized: boolean;
    result: AllUserSignalsResult | null;
    error: string | null;
  }>({ started: false, synthesized: false, result: null, error: null });

  const [discoveryCategories, setDiscoveryCategories] = useState<
    DiscoveryCategory[] | null
  >(() => {
    if (!onboardingDone) {
      return null;
    }
    return parseStoredDiscoveryCategories(
      localStorage.getItem(DISCOVERY_CATEGORIES_KEY),
    );
  });

  const waitForSignalCollection = async (
    maxWaitSeconds: number,
  ): Promise<boolean> => {
    let attempts = 0;
    const maxAttempts = maxWaitSeconds;
    while (
      !discoveryRef.current.result &&
      !discoveryRef.current.error &&
      attempts < maxAttempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }
    return !!discoveryRef.current.result && !discoveryRef.current.error;
  };

  const handleDiscoveryConfirm = useCallback(
    (categories: DiscoveryCategory[]) => {
      setDiscoveryCategories(categories);
    },
    [],
  );

  // Returning users: hydrate categories from localStorage
  useEffect(() => {
    if (!onboardingDone || discoveryCategories) return;
    setDiscoveryCategories(
      parseStoredDiscoveryCategories(
        localStorage.getItem(DISCOVERY_CATEGORIES_KEY),
      ),
    );
  }, [onboardingDone, discoveryCategories]);

  // Step 1: Start signal collection when categories are selected
  useEffect(() => {
    if (!discoveryCategories || discoveryRef.current.started) return;
    discoveryRef.current.started = true;

    const collectSignals = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) return;

        const result = await window.electronAPI?.collectAllSignals?.({
          categories: discoveryCategories,
        });

        if (!result) {
          discoveryRef.current.error = "No result from signal collection";
          return;
        }

        if (result.error) {
          discoveryRef.current.error = result.error;
          return;
        }

        discoveryRef.current.result = result;
      } catch (error) {
        discoveryRef.current.error = (error as Error).message;
      }
    };

    void collectSignals();
  }, [discoveryCategories]);

  // Step 2: After auth + onboarding + conversationId, synthesize
  useEffect(() => {
    if (!isAuthenticated || !onboardingDone || !conversationId) return;
    if (discoveryRef.current.synthesized) return;

    const synthesize = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) return;

        discoveryRef.current.synthesized = true;

        const collectionReady = await waitForSignalCollection(30);
        if (!collectionReady) return;

        const result = discoveryRef.current.result;
        if (!result?.formatted) return;

        const synthesisResult = await synthesizeCoreMemory(result.formatted);
        if (!synthesisResult.coreMemory) return;

        await window.electronAPI?.writeCoreMemory?.(synthesisResult.coreMemory);

        void seedDiscoveryMemories(result.formatted);

        if (synthesisResult.welcomeMessage && conversationId) {
          const deviceId = await getOrCreateDeviceId();
          await appendEvent({
            conversationId,
            type: "assistant_message",
            deviceId,
            payload: { text: synthesisResult.welcomeMessage },
          });
        }
      } catch {
        // Silent fail - discovery is non-critical
      }
    };

    void synthesize();
  }, [isAuthenticated, onboardingDone, conversationId, appendEvent]);

  return {
    handleDiscoveryConfirm,
  };
}
