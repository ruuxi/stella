import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";

export type RadioGroupProps = React.ComponentPropsWithoutRef<
  typeof RadioGroupPrimitive.Root
>;

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  RadioGroupProps
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    data-component="radio-group"
    className={cn(className)}
    {...props}
  />
));
RadioGroup.displayName = "RadioGroup";

export interface RadioGroupItemProps
  extends React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  label?: string;
}

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupItemProps
>(({ className, label, children, ...props }, ref) => (
  <div data-slot="radio-group-item-wrapper" className={cn(className)}>
    <RadioGroupPrimitive.Item ref={ref} data-slot="radio-group-item" {...props}>
      <RadioGroupPrimitive.Indicator data-slot="radio-group-indicator">
        <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor">
          <circle cx="3" cy="3" r="3" />
        </svg>
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
    {(label || children) && (
      <label data-slot="radio-group-label">{label || children}</label>
    )}
  </div>
));
RadioGroupItem.displayName = "RadioGroupItem";
