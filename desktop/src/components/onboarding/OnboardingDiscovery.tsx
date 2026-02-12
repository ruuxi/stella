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
  const noneSelected = Object.values(categoryStates).every((v) => !v);

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
      {noneSelected && (
        <div className="onboarding-discovery-warning">
          <span className="onboarding-discovery-warning-badge">Not recommended</span>
          <p className="onboarding-discovery-warning-text">
            Without this, I'll learn about you over time through our conversations. But I won't be personal to you from the start.
          </p>
        </div>
      )}
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
