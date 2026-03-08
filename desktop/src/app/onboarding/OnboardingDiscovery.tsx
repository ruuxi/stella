import React from "react";
import { type DiscoveryCategory, DISCOVERY_CATEGORIES } from "./use-onboarding-state";
import { getPlatform } from "@/platform/electron/platform";

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
    (cat) => cat.requiresFDA && categoryStates[cat.id]
  );

  return (
    <div className="onboarding-discovery" data-visible={true}>
      <div className="onboarding-discovery-list">
        {DISCOVERY_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className="onboarding-discovery-row"
            data-active={categoryStates[cat.id]}
            onClick={() => onToggleCategory(cat.id)}
          >
            <span className="onboarding-discovery-row-label">{cat.label}</span>
            <span className="onboarding-discovery-row-desc">{cat.description}</span>
          </button>
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

