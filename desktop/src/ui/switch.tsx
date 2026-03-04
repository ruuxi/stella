import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: string;
  hideLabel?: boolean;
  description?: string;
}

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, label, hideLabel, description, children, ...props }, ref) => (
  <div data-component="switch" className={cn(className)} data-checked={props.checked || undefined}>
    {(label || children) && (
      <label data-slot="switch-label" className={hideLabel ? "sr-only" : undefined}>
        {label || children}
      </label>
    )}
    {description && <p data-slot="switch-description">{description}</p>}
    <SwitchPrimitive.Root ref={ref} data-slot="switch-control" {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  </div>
));

Switch.displayName = "Switch";
