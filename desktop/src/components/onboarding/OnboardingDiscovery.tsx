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
      {DISCOVERY_CATEGORIES.map((cat) => (
        <div key={cat.id} className="onboarding-discovery-card">
          <div className="onboarding-discovery-card-text">
            <div className="onboarding-discovery-card-title">{cat.label}</div>
            <div className="onboarding-discovery-card-desc">{cat.description}</div>
            {cat.requiresFDA && platform === "darwin" && (
              <div className="onboarding-discovery-fda">requires full disk access</div>
            )}
          </div>
          <button
            className="onboarding-discovery-toggle"
            data-active={categoryStates[cat.id]}
            onClick={() => onToggleCategory(cat.id)}
          >
            <span className="onboarding-discovery-toggle-thumb" />
          </button>
        </div>
      ))}
      {hasFDACategories && platform === "darwin" && (
        <button
          className="onboarding-discovery-fda-button"
          onClick={() => window.electronAPI?.openFullDiskAccess?.()}
        >
          open system preferences
        </button>
      )}
      <button
        className="onboarding-confirm"
        data-visible={true}
        onClick={onConfirm}
      >
        continue
      </button>
    </div>
  );
};
