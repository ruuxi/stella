/**
 * Discovery category selection, signal collection, synthesis trigger.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/api";
import { getOrCreateDeviceId } from "../../services/device";
import {
  generateWelcomeMessageFromCoreMemory,
  seedDiscoveryMemories,
  synthesizeCoreMemory,
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
const DEFAULT_WELCOME_MESSAGE = "Hey! I'm Stella, your AI assistant. What can I help you with today?";

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

  const previousOnboardingDoneRef = useRef(onboardingDone);
  const [onboardingCompletionCount, setOnboardingCompletionCount] =
    useState(0);

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

  useEffect(() => {
    if (!previousOnboardingDoneRef.current && onboardingDone) {
      setOnboardingCompletionCount((count) => count + 1);
    }

    if (!onboardingDone) {
      discoveryRef.current = {
        started: false,
        synthesized: false,
        result: null,
        error: null,
      };
      setDiscoveryCategories(null);
    }

    previousOnboardingDoneRef.current = onboardingDone;
  }, [onboardingDone]);

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

  const appendWelcomeMessage = useCallback(
    async (text: string) => {
      if (!conversationId || !text.trim()) return;
      const deviceId = await getOrCreateDeviceId();
      await appendEvent({
        conversationId,
        type: "assistant_message",
        deviceId,
        payload: { text },
      });
    },
    [appendEvent, conversationId],
  );

  const effectiveDiscoveryCategories = useMemo(() => {
    if (discoveryCategories) {
      return discoveryCategories;
    }
    if (!onboardingDone) {
      return null;
    }
    return parseStoredDiscoveryCategories(
      localStorage.getItem(DISCOVERY_CATEGORIES_KEY),
    );
  }, [discoveryCategories, onboardingDone]);

  // Step 1: Start signal collection when categories are selected
  useEffect(() => {
    if (!effectiveDiscoveryCategories || discoveryRef.current.started) return;
    discoveryRef.current.started = true;

    const collectSignals = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) return;

        const result = await window.electronAPI?.collectAllSignals?.({
          categories: effectiveDiscoveryCategories,
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
  }, [effectiveDiscoveryCategories]);

  // Step 2: After auth + onboarding completion + conversationId, generate welcome.
  useEffect(() => {
    if (!isAuthenticated || !onboardingDone || !conversationId) return;
    if (onboardingCompletionCount < 1) return;
    if (discoveryRef.current.synthesized) return;

    const synthesize = async () => {
      discoveryRef.current.synthesized = true;

      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) {
          const existingCoreMemory = await window.electronAPI?.readCoreMemory?.();
          let welcomeMessage = "";

          if (existingCoreMemory?.trim()) {
            welcomeMessage = await generateWelcomeMessageFromCoreMemory(
              existingCoreMemory,
            );
          }

          await appendWelcomeMessage(welcomeMessage || DEFAULT_WELCOME_MESSAGE);
          return;
        }

        const collectionReady = await waitForSignalCollection(30);
        if (!collectionReady) return;

        const result = discoveryRef.current.result;
        if (!result?.formatted) return;

        const synthesisResult = await synthesizeCoreMemory(result.formatted);
        if (!synthesisResult.coreMemory) return;

        await window.electronAPI?.writeCoreMemory?.(synthesisResult.coreMemory);

        void seedDiscoveryMemories(result.formatted);

        await appendWelcomeMessage(
          synthesisResult.welcomeMessage || DEFAULT_WELCOME_MESSAGE,
        );
      } catch {
        // Silent fail - discovery is non-critical
      }
    };

    void synthesize();
  }, [
    appendWelcomeMessage,
    conversationId,
    isAuthenticated,
    onboardingCompletionCount,
    onboardingDone,
  ]);

  return {
    handleDiscoveryConfirm,
  };
}
