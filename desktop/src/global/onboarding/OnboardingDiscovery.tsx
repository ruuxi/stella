import React from "react";
import { Lock } from "lucide-react";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import { DISCOVERY_CATEGORIES } from "./onboarding-flow";
import { getPlatform } from "@/platform/electron/platform";
import { OnboardingSelectionTile } from "./OnboardingSelectionTile";
import { useT } from "@/shared/i18n";

interface OnboardingDiscoveryProps {
  categoryStates: Record<DiscoveryCategory, boolean>;
  onToggleCategory: (id: DiscoveryCategory) => void;
}

export const OnboardingDiscovery: React.FC<OnboardingDiscoveryProps> = ({
  categoryStates,
  onToggleCategory,
}) => {
  const t = useT();
  const platform = getPlatform();
  const hasFdaCategories = DISCOVERY_CATEGORIES.some(
    (cat) => cat.requiresFDA && categoryStates[cat.id],
  );
  const canShowFdaNote = platform === "darwin";
  const showFdaNote = canShowFdaNote && hasFdaCategories;
  const openFullDiskAccess = () =>
    window.electronAPI?.system.openFullDiskAccess?.();

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
            label={t(cat.labelKey)}
            description={t(cat.descriptionKey)}
          />
        ))}
      </div>
      {canShowFdaNote && (
        <div
          className="onboarding-fda-note"
          data-visible={showFdaNote || undefined}
          aria-hidden={!showFdaNote}
        >
          <span className="onboarding-fda-note-icon" aria-hidden="true">
            <Lock size={14} strokeWidth={2} />
          </span>
          <span className="onboarding-fda-note-text">
            {t("onboarding.discovery.fdaNote")}
          </span>
          <button
            className="onboarding-fda-link"
            onClick={openFullDiskAccess}
            tabIndex={showFdaNote ? 0 : -1}
          >
            {t("common.openPreferences")}
          </button>
        </div>
      )}
    </div>
  );
};
