import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { StellaAppMock } from "./panels/StellaAppMock";
import {
  EMPTY_SECTION_TOGGLES,
  type SectionKey,
  type SectionToggles,
} from "./panels/stella-app-mock-types";

/**
 * OnboardingCanvas — renders the live demo shown during the "creation"
 * onboarding phase.
 *
 * The creation phase is manually driven: floating pills inside the mock let the
 * user pick which part of Stella changes. No timer or morph loop runs here,
 * because the phase copy explicitly asks the user to click a pill.
 */
export type OnboardingDemo = "default" | null;

const MORPH_STATE_SETTLE_MS = 520;

const waitForPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs);
  });

const getElementRect = (element: HTMLElement | null) => {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
};

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
  onMorphingChange?: (isMorphing: boolean) => void;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({
  activeDemo,
  onMorphingChange,
}) => {
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);
  const [pillsDisabled, setPillsDisabled] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const morphingRef = useRef(false);

  useEffect(() => {
    onMorphingChange?.(false);
  }, [activeDemo, onMorphingChange]);

  const handleToggleSection = useCallback(
    (section: SectionKey) => {
      if (morphingRef.current) return;

      const nextSection = activeSection === section ? null : section;
      const morphApi = window.electronAPI?.ui;

      if (!morphApi) {
        setActiveSection(nextSection);
        return;
      }

      morphingRef.current = true;
      setPillsDisabled(true);
      onMorphingChange?.(true);

      void (async () => {
        try {
          const rect = getElementRect(rootRef.current);
          const morphPayload = rect ? { rect } : undefined;
          const started = await morphApi
            .morphStart(morphPayload)
            .catch(() => ({ ok: false }));

          if (!started.ok) {
            setActiveSection(nextSection);
            return;
          }

          flushSync(() => {
            setActiveSection(nextSection);
          });
          await waitForPaint();
          await wait(MORPH_STATE_SETTLE_MS);

          await morphApi
            .morphComplete(morphPayload)
            .catch(() => ({ ok: false }));
        } finally {
          morphingRef.current = false;
          setPillsDisabled(false);
          onMorphingChange?.(false);
        }
      })();
    },
    [activeSection, onMorphingChange],
  );

  const toggles: SectionToggles = useMemo(
    () => ({
      ...EMPTY_SECTION_TOGGLES,
      ...(activeSection ? { [activeSection]: true } : {}),
    }),
    [activeSection],
  );

  if (!activeDemo) return null;

  return (
    <div ref={rootRef} className="onboarding-canvas">
      <div className="selfmod-layout">
        <StellaAppMock
          interactive
          toggles={toggles}
          onToggleSection={handleToggleSection}
          pillsDisabled={pillsDisabled}
        />
      </div>
    </div>
  );
};
