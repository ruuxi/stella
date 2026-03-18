import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hideLabel?: boolean;
}

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  NativeSelectProps
>(({ className, label, hideLabel, children, ...props }, ref) => (
  <div data-component="native-select">
    {label ? (
      <label
        data-slot="native-select-label"
        className={hideLabel ? "sr-only" : undefined}
      >
        {label}
      </label>
    ) : null}
    <div data-slot="native-select-wrapper">
      <select
        ref={ref}
        data-slot="native-select-input"
        className={cn(className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown size={14} data-slot="native-select-icon" />
    </div>
  </div>
));

NativeSelect.displayName = "NativeSelect";
