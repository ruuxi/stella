import React from "react";
import { type DiscoveryCategory, DISCOVERY_CATEGORIES } from "./use-onboarding-state";

interface OnboardingDiscoveryProps {
  categoryStates: Record<DiscoveryCategory, boolean>;
  onToggleCategory: (id: DiscoveryCategory) => void;
  onConfirm: () => void;
}

export const OnboardingDiscovery: React.FC<OnboardingDiscoveryProps> = ({
  categoryStates,
  onToggleCategory,
  onConfirm,
}) => {
  const platform = window.electronAPI?.platform ?? "unknown";
  const hasFDACategories = DISCOVERY_CATEGORIES.some(
    (cat) => cat.requiresFDA && categoryStates[cat.id]
  );

  return (
    <div className="onboarding-discovery" data-visible={true}>
      <div className="onboarding-pills">
        {DISCOVERY_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className="onboarding-pill"
            data-active={categoryStates[cat.id]}
            onClick={() => onToggleCategory(cat.id)}
            title={cat.description}
          >
            {cat.label}
          </button>
        ))}
      </div>
      {hasFDACategories && platform === "darwin" && (
        <div className="onboarding-fda-note">
          <span>Some options require Full Disk Access</span>
          <button
            className="onboarding-fda-link"
            onClick={() => window.electronAPI?.openFullDiskAccess?.()}
          >
            Open Preferences
          </button>
        </div>
      )}
      <button
        className="onboarding-confirm"
        data-visible={true}
        onClick={onConfirm}
      >
        Continue
      </button>
    </div>
  );
};
