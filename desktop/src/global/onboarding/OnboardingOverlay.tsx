/**
 * Onboarding flow: Start -> Auth -> Intro (center) -> split layout steps.
 *
 * This module is the heavy "view" half of the onboarding overlay. It is
 * lazy-loaded by FullShell as a single onboarding chunk that pulls in
 * every phase component, the StellaAnimation creature, the legal dialog,
 * and all onboarding CSS. Once the chunk has loaded, every transition
 * inside the flow is synchronous — there are no nested Suspense
 * boundaries below this point.
 *
 * The hook half (`useOnboardingOverlay`) lives in `use-onboarding-overlay.ts`
 * so FullShell can read onboarding state (`onboardingDone`, etc.) without
 * importing this view tree into the main bundle. Returning users — for
 * whom `appReady === true` at first paint — never fetch this chunk.
 */

import React, { useState } from "react";
import { OnboardingStep1 } from "@/global/onboarding/OnboardingStep1";
import {
  StellaAnimation,
  type StellaAnimationHandle,
} from "@/shell/ascii-creature/StellaAnimation";
import type { Phase } from "@/global/onboarding/onboarding-flow";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import type { LegalDocument } from "@/global/legal/legal-text";
import { LegalDialog } from "@/global/legal/LegalDialog";
import { CREATURE_INITIAL_SIZE } from "@/global/onboarding/use-onboarding-overlay";
import { useT } from "@/shared/i18n";

// IMPORTANT: this module is the lazy "onboarding chunk". Do NOT re-export
// the `useOnboardingOverlay` hook from here — FullShell needs to call
// the hook synchronously to read `onboardingDone`, and re-exporting from
// a heavy module risks pulling the view tree (StellaStep1, all phases,
// StellaAnimation, LegalDialog) into the main bundle. Always import the
// hook directly from `@/global/onboarding/use-onboarding-overlay`.

export type OnboardingOverlayProps = {
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
};

/**
 * Renders a localized "By using Stella, you agree to our {terms} and
 * {privacy}." line by splitting the translated template at the
 * `{terms}` / `{privacy}` placeholders so each becomes a real button.
 * Word order varies by locale (German moves verbs to the end, Hebrew
 * reads right-to-left, Japanese inserts particles), so we never
 * assume "agree to" + "and" + "." with linkified words appended.
 */
function LegalFooter({
  template,
  termsLabel,
  privacyLabel,
  onTermsClick,
  onPrivacyClick,
}: {
  template: string;
  termsLabel: string;
  privacyLabel: string;
  onTermsClick: () => void;
  onPrivacyClick: () => void;
}) {
  const slots: Record<string, React.ReactNode> = {
    terms: (
      <button
        type="button"
        className="onboarding-legal-link"
        onClick={onTermsClick}
      >
        {termsLabel}
      </button>
    ),
    privacy: (
      <button
        type="button"
        className="onboarding-legal-link"
        onClick={onPrivacyClick}
      >
        {privacyLabel}
      </button>
    ),
  };
  // Split into [literal, slotName, literal, slotName, …]; even indices
  // are literal text, odd indices are placeholder names.
  const parts = template.split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return <span key={index}>{part}</span>;
        return <span key={index}>{slots[part] ?? `{${part}}`}</span>;
      })}
    </>
  );
}

export function OnboardingView({
  hasExpanded,
  onboardingDone,
  onboardingExiting,
  isAuthenticated,
  isAuthLoading,
  isPreparingRuntime = false,
  runtimeError = null,
  splitMode,
  hasDiscoverySelections,
  hasStarted,
  stellaAnimationRef,
  onboardingKey,
  triggerFlash,
  startOnboarding,
  completeOnboarding,
  handleEnterSplit,
  onRetryRuntime,
  onDiscoveryConfirm,
  onSelectionChange,
  onDemoChange,
  onPhaseChange,
  activeDemo,
  discoveryWelcomeExpected = false,
  discoveryWelcomeReady = false,
  stellaAnimationPaused = false,
  stellaAnimationHidden = false,
}: {
  hasExpanded: boolean;
  onboardingDone: boolean;
  onboardingExiting?: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  isPreparingRuntime?: boolean;
  runtimeError?: string | null;
  splitMode: boolean;
  hasDiscoverySelections?: boolean;
  hasStarted: boolean;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  onboardingKey: number;
  triggerFlash: () => void;
  startOnboarding: () => void;
  completeOnboarding: () => void;
  handleEnterSplit: () => void;
  onRetryRuntime?: () => void;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  onDemoChange?: (demo: "default" | null) => void;
  onPhaseChange?: (phase: Phase) => void;
  activeDemo?: OnboardingDemo;
  discoveryWelcomeExpected?: boolean;
  discoveryWelcomeReady?: boolean;
  stellaAnimationPaused?: boolean;
  stellaAnimationHidden?: boolean;
}) {
  const showRuntimeGate = isPreparingRuntime || Boolean(runtimeError);
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(
    null,
  );
  const t = useT();

  return (
    <div
      className="new-session-view"
      data-split={splitMode}
      data-exiting={onboardingExiting || undefined}
    >
      <LegalDialog
        document={activeLegalDoc}
        onOpenChange={(open) => {
          if (!open) setActiveLegalDoc(null);
        }}
      />
      <div
        className="new-session-title"
        data-expanded={hasExpanded ? "true" : "false"}
      >
        Stella
      </div>
      {!stellaAnimationHidden ? (
        <div
          className="onboarding-stella-animation"
          onClick={triggerFlash}
          data-expanded={hasExpanded ? "true" : "false"}
          data-split={splitMode}
          data-has-selections={hasDiscoverySelections || undefined}
          data-demo-active={activeDemo || undefined}
          title="Click to sparkle"
        >
          <StellaAnimation
            ref={stellaAnimationRef}
            width={70}
            height={39}
            initialBirthProgress={onboardingDone ? 1 : CREATURE_INITIAL_SIZE}
            paused={stellaAnimationPaused || stellaAnimationHidden}
          />
        </div>
      ) : null}
      {(showRuntimeGate || !onboardingDone) &&
        (isPreparingRuntime || isAuthLoading ? (
          <div className="onboarding-moment onboarding-moment--auth">
            <div className="onboarding-text">{t("onboarding.ready")}</div>
          </div>
        ) : runtimeError ? (
          <div className="onboarding-moment onboarding-moment--start">
            <button
              className="onboarding-start-button"
              onClick={() => {
                onRetryRuntime?.();
              }}
            >
              {t("onboarding.retryStart")}
            </button>
          </div>
        ) : hasStarted ? (
          <OnboardingStep1
            key={onboardingKey}
            initialPhase="intro"
            onComplete={completeOnboarding}
            onInteract={triggerFlash}
            onDiscoveryConfirm={onDiscoveryConfirm}
            onEnterSplit={handleEnterSplit}
            onSelectionChange={onSelectionChange}
            onDemoChange={onDemoChange}
            onPhaseChange={onPhaseChange}
            isAuthenticated={isAuthenticated}
            discoveryWelcomeExpected={discoveryWelcomeExpected}
            discoveryWelcomeReady={discoveryWelcomeReady}
          />
        ) : (
          <>
            <div className="onboarding-moment onboarding-moment--start">
              <button
                className="onboarding-start-button"
                onClick={() => {
                  startOnboarding();
                  triggerFlash();
                }}
              >
                {t("onboarding.startStella")}
              </button>
            </div>
            <div className="onboarding-legal-footer onboarding-legal-footer--new-session">
              <LegalFooter
                template={t("onboarding.legalFooter")}
                termsLabel={t("onboarding.termsOfService")}
                privacyLabel={t("onboarding.privacyPolicy")}
                onTermsClick={() => setActiveLegalDoc("terms")}
                onPrivacyClick={() => setActiveLegalDoc("privacy")}
              />
            </div>
          </>
        ))}
    </div>
  );
}
