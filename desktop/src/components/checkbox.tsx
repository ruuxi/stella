import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@/lib/utils";

export interface CheckboxProps
  extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  label?: string;
  hideLabel?: boolean;
  description?: string;
}

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(({ className, label, hideLabel, description, children, ...props }, ref) => (
  <div data-component="checkbox" className={cn(className)}>
    <CheckboxPrimitive.Root ref={ref} data-slot="checkbox-checkbox-control" {...props}>
      <CheckboxPrimitive.Indicator data-slot="checkbox-checkbox-indicator">
        <svg viewBox="0 0 12 12" fill="none" width="10" height="10">
          <path
            d="M3 7.17905L5.02703 8.85135L9 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
    <div data-slot="checkbox-checkbox-content">
      {(label || children) && (
        <label data-slot="checkbox-checkbox-label" className={hideLabel ? "sr-only" : undefined}>
          {label || children}
        </label>
      )}
      {description && (
        <p data-slot="checkbox-checkbox-description">{description}</p>
      )}
    </div>
  </div>
));

Checkbox.displayName = "Checkbox";
