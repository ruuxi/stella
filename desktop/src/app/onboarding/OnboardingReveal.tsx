import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

type OnboardingRevealProps = {
  visible: boolean;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
};

export function OnboardingReveal({
  visible,
  className,
  innerClassName,
  children,
}: OnboardingRevealProps) {
  return (
    <div
      className={cn("onboarding-reveal", className)}
      data-visible={visible || undefined}
    >
      <div className={cn("onboarding-reveal__inner", innerClassName)}>
        {children}
      </div>
    </div>
  );
}
