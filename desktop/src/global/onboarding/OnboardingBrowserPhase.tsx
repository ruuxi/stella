import { BROWSERS, type BrowserId } from "./onboarding-flow";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import { OnboardingDiscovery } from "./OnboardingDiscovery";
import { OnboardingReveal } from "./OnboardingReveal";
import { OnboardingSelectionTile } from "./OnboardingSelectionTile";

type BrowserPhaseProps = {
  availableProfiles: { id: string; name: string }[];
  browserEnabled: boolean;
  categoryStates: Record<DiscoveryCategory, boolean>;
  platform: string;
  selectedBrowser: BrowserId | null;
  selectedProfile: string | null;
  showNoneWarning: boolean;
  splitTransitionActive: boolean;
  onContinue: () => void;
  onSelectBrowser: (browserId: BrowserId) => void;
  onSelectProfile: (profileId: string) => void;
  onToggleBrowser: () => void;
  onToggleCategory: (id: DiscoveryCategory) => void;
};

export function OnboardingBrowserPhase({
  availableProfiles,
  browserEnabled,
  categoryStates,
  platform,
  selectedBrowser,
  selectedProfile,
  showNoneWarning,
  splitTransitionActive,
  onContinue,
  onSelectBrowser,
  onSelectProfile,
  onToggleBrowser,
  onToggleCategory,
}: BrowserPhaseProps) {
  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">What can I learn about you?</div>

      <OnboardingSelectionTile
        className="onboarding-discovery-row"
        labelClassName="onboarding-discovery-row-label"
        descriptionClassName="onboarding-discovery-row-desc"
        active={browserEnabled}
        onClick={onToggleBrowser}
        label={
          <>
            Your browser
            <span className="onboarding-discovery-recommended">
              Recommended
            </span>
          </>
        }
        description="I can browse the web for you, learn your favorite sites, and pick up on how you like things done"
      />

      <OnboardingReveal
        visible={browserEnabled}
        className="onboarding-browser-reveal"
        innerClassName="onboarding-browser-reveal-inner"
      >
        <div className="onboarding-pills onboarding-pill-stagger">
          {BROWSERS.filter((browser) =>
            platform !== "darwin" ? browser.id !== "safari" : true,
          ).map((browser) => (
            <button
              key={browser.id}
              className="onboarding-pill onboarding-pill--sm"
              data-active={selectedBrowser === browser.id}
              onClick={() => onSelectBrowser(browser.id)}
            >
              {browser.label}
            </button>
          ))}
        </div>

        <OnboardingReveal
          visible={availableProfiles.length > 1}
          className="onboarding-profiles-reveal"
          innerClassName="onboarding-profiles-reveal-inner"
        >
          <div className="onboarding-step-label">Profile</div>
          <div className="onboarding-pills onboarding-pill-stagger">
            {availableProfiles.map((profile) => (
              <button
                key={profile.id}
                className="onboarding-pill onboarding-pill--sm"
                data-active={selectedProfile === profile.id}
                onClick={() => onSelectProfile(profile.id)}
              >
                {profile.name}
              </button>
            ))}
          </div>
        </OnboardingReveal>
      </OnboardingReveal>

      <OnboardingDiscovery
        categoryStates={categoryStates}
        onToggleCategory={onToggleCategory}
      />

      <OnboardingReveal
        visible={showNoneWarning}
        className="onboarding-warning-reveal"
        innerClassName="onboarding-warning-reveal-inner"
      >
        <div className="onboarding-discovery-warning">
          <span className="onboarding-discovery-warning-badge">
            Not recommended
          </span>
          <p className="onboarding-discovery-warning-text">
            Without this, I'll learn about you over time through our
            conversations. But I won't be personal to you from the start.
          </p>
        </div>
      </OnboardingReveal>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
