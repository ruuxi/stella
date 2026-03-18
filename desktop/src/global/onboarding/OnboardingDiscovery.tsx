import React from "react";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import { DISCOVERY_CATEGORIES } from "./use-onboarding-state";
import { getPlatform } from "@/platform/electron/platform";
import { OnboardingSelectionTile } from "./OnboardingSelectionTile";

interface OnboardingDiscoveryProps {
  categoryStates: Record<DiscoveryCategory, boolean>;
  onToggleCategory: (id: DiscoveryCategory) => void;
}

export const OnboardingDiscovery: React.FC<OnboardingDiscoveryProps> = ({
  categoryStates,
  onToggleCategory,
}) => {
  const platform = getPlatform();
  const hasFDACategories = DISCOVERY_CATEGORIES.some(
    (cat) => cat.requiresFDA && categoryStates[cat.id],
  );

  return (
    <div className="onboarding-discovery" data-visible={true}>
      <div className="onboarding-discovery-list">
        {DISCOVERY_CATEGORIES.map((cat) => (
          <OnboardingSelectionTile
            key={cat.id}
            className="onboarding-discovery-row"
            labelClassName="onboarding-discovery-row-label"
            descriptionClassName="onboarding-discovery-row-desc"
            active={categoryStates[cat.id]}
            onClick={() => onToggleCategory(cat.id)}
            label={cat.label}
            description={cat.description}
          />
        ))}
      </div>
      {hasFDACategories && platform === "darwin" && (
        <div className="onboarding-fda-note">
          <span>Some options require Full Disk Access</span>
          <button
            className="onboarding-fda-link"
            onClick={() => window.electronAPI?.system.openFullDiskAccess?.()}
          >
            Open Preferences
          </button>
        </div>
      )}
    </div>
  );
};
