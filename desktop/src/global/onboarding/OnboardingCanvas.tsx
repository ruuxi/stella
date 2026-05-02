import React, { useCallback, useMemo, useState } from "react";
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

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({
  activeDemo,
}) => {
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);

  const handleToggleSection = useCallback((section: SectionKey) => {
    setActiveSection((current) => (current === section ? null : section));
  }, []);

  const toggles: SectionToggles = useMemo(
    () => ({
      ...EMPTY_SECTION_TOGGLES,
      ...(activeSection ? { [activeSection]: true } : {}),
    }),
    [activeSection],
  );

  if (!activeDemo) return null;

  return (
    <div className="onboarding-canvas">
      <div className="selfmod-layout">
        <StellaAppMock
          interactive
          toggles={toggles}
          onToggleSection={handleToggleSection}
        />
      </div>
    </div>
  );
};
