import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

type OnboardingSelectionTileProps = {
  active: boolean;
  onClick: () => void;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  labelClassName?: string;
  descriptionClassName?: string;
};

export function OnboardingSelectionTile({
  active,
  onClick,
  label,
  description,
  className,
  labelClassName,
  descriptionClassName,
}: OnboardingSelectionTileProps) {
  return (
    <button
      type="button"
      className={cn("onboarding-selection-tile", className)}
      data-active={active}
      onClick={onClick}
    >
      <span className={cn("onboarding-selection-tile-label", labelClassName)}>
        {label}
      </span>
      {description ? (
        <span
          className={cn("onboarding-selection-tile-desc", descriptionClassName)}
        >
          {description}
        </span>
      ) : null}
    </button>
  );
}
