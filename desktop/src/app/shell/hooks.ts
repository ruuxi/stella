/**
 * Extracted hooks for FullShell: workspace panels, chat context sync,
 * demo animation, and dialog management.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getElectronApi } from "@/services/electron";
import type { ChatContext, ChatContextUpdate } from "@/types/electron";
import type { OnboardingDemo } from "@/app/onboarding/OnboardingCanvas";

// ── Types ───────────────────────────────────────────────────────────────

export type PersonalPage = {
  pageId: string;
  panelName: string;
  title: string;
  order: number;
};

type LocalWorkspacePanel = {
  name: string;
  title: string;
};

export type DialogType = "auth" | "connect" | "settings" | "test" | "trace" | null;

// ── Constants ───────────────────────────────────────────────────────────

const LOCAL_PANEL_PAGE_PREFIX = "local_panel:";
const LOCAL_PANELS_POLL_INTERVAL_MS = 3_000;

// ── Helpers ─────────────────────────────────────────────────────────────

const arePanelListsEqual = (
  left: LocalWorkspacePanel[],
  right: LocalWorkspacePanel[],
) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.name !== right[index]?.name ||
      left[index]?.title !== right[index]?.title
    ) {
      return false;
    }
  }
  return true;
};

// ── useLocalWorkspacePanels ─────────────────────────────────────────────

export function useLocalWorkspacePanels() {
  const [localWorkspacePanels, setLocalWorkspacePanels] = useState<
    LocalWorkspacePanel[]
  >([]);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.browser.listWorkspacePanels) {
      return;
    }

    let cancelled = false;
    const normalizePanels = (result: unknown) => {
      return (Array.isArray(result) ? result : [])
        .filter(
          (panel): panel is LocalWorkspacePanel =>
            Boolean(
              panel &&
                typeof panel.name === "string" &&
                typeof panel.title === "string",
            ),
        )
        .map((panel) => ({
          name: panel.name.trim(),
          title: panel.title.trim() || panel.name.trim(),
        }))
        .filter((panel) => panel.name.length > 0);
    };

    const applyPanels = (normalized: LocalWorkspacePanel[]) => {
      if (!cancelled) {
        setLocalWorkspacePanels((previous) =>
          arePanelListsEqual(previous, normalized) ? previous : normalized,
        );
      }
    };

    const loadPanels = async () => {
      try {
        const result = await electronApi.browser.listWorkspacePanels();
        if (cancelled) return;
        applyPanels(normalizePanels(result));
      } catch (error) {
        console.debug('[FullShell] Failed to load workspace panels:', (error as Error).message);
      }
    };

    void loadPanels();

    // Prefer file watcher over polling when available
    const unsubscribe = electronApi.browser.onWorkspacePanelsChanged?.((panels) => {
      applyPanels(normalizePanels(panels));
    });

    // Fallback to polling only if watcher is unavailable
    let intervalId: number | undefined;
    if (!unsubscribe) {
      intervalId = window.setInterval(() => {
        void loadPanels();
      }, LOCAL_PANELS_POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, []);

  const personalPages = useMemo<PersonalPage[]>(() => {
    return localWorkspacePanels.map((panel, index) => ({
      pageId: `${LOCAL_PANEL_PAGE_PREFIX}${panel.name}`,
      panelName: panel.name,
      title: panel.title,
      order: index,
    }));
  }, [localWorkspacePanels]);

  return { personalPages };
}

// ── useChatContextSync ──────────────────────────────────────────────────

export function useChatContextSync() {
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi) return;

    electronApi
      .capture.getContext?.()
      .then((context) => {
        if (!context) return;
        setChatContext(context);
        setSelectedText(context.selectedText ?? null);
      })
      .catch((error) => {
        console.warn("Failed to load chat context", error);
      });

    if (!electronApi.capture.onContext) return;

    const unsubscribe = electronApi.capture.onContext((payload) => {
      let context: ChatContext | null = null;
      if (payload && typeof payload === "object" && "context" in payload) {
        context = (payload as ChatContextUpdate).context ?? null;
      } else {
        context = (payload as ChatContext | null) ?? null;
      }
      setChatContext(context);
      setSelectedText(context?.selectedText ?? null);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return { chatContext, setChatContext, selectedText, setSelectedText };
}

// ── useDemoAnimation ────────────────────────────────────────────────────

export function useDemoAnimation() {
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDemoChange = useCallback((demo: OnboardingDemo) => {
    if (demo) {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
        demoCloseTimerRef.current = null;
      }
      setDemoClosing(false);
      setActiveDemo(demo);
    } else {
      setActiveDemo(null);
      setDemoClosing(true);
      demoCloseTimerRef.current = setTimeout(() => {
        setDemoClosing(false);
        demoCloseTimerRef.current = null;
      }, 400);
    }
  }, []);

  return { activeDemo, demoClosing, handleDemoChange };
}

// ── useDialogManager ────────────────────────────────────────────────────

export function useDialogManager() {
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  return { activeDialog, setActiveDialog };
}



