import { useState } from "react";
import { ThirdPartyMigrationWizard } from "@/global/migration/ThirdPartyMigrationWizard";
import type { ThirdPartyMigrationReport } from "@/shared/contracts/migration";

type OnboardingMigrationPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
  onImported?: (report: ThirdPartyMigrationReport) => void;
};

export function OnboardingMigrationPhase({
  splitTransitionActive,
  onContinue,
  onImported,
}: OnboardingMigrationPhaseProps) {
  const [imported, setImported] = useState(false);

  return (
    <div className="onboarding-step-content onboarding-migration-step">
      <p className="onboarding-step-desc">
        Stella can bring over what matters from Hermes or OpenClaw, then run on
        Stella's own engine from here.
      </p>

      <div className="onboarding-migration-shell">
        <ThirdPartyMigrationWizard
          hideWhenEmpty
          onEmpty={onContinue}
          onImported={(report) => {
            setImported(true);
            onImported?.(report);
          }}
        />
      </div>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        {imported ? "Continue" : "Skip"}
      </button>
    </div>
  );
}
